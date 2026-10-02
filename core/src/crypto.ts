// Client-side encryption. Drive only ever sees opaque, authenticated ciphertext.
//  - XChaCha20-Poly1305 for objects
//  - keyed BLAKE2b for content ids (dedup works inside a repo, leaks nothing outside)
//  - X25519 sealed boxes to wrap the repo key for each member
//  - Argon2id to wrap the repo key with a recovery passphrase
import sodium from 'libsodium-wrappers-sumo';

let ready: Promise<void> | undefined;
export function initCrypto(): Promise<void> {
  return (ready ??= sodium.ready);
}

export interface Keys {
  enc: Uint8Array;
  id: Uint8Array;
}

export const hex = (b: Uint8Array) => sodium.to_hex(b);
export const fromHex = (s: string) => sodium.from_hex(s);
export const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
export const fromB64 = (s: string) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
export const randomBytes = (n: number) => sodium.randombytes_buf(n);

export function generateRepoKey(): Uint8Array {
  return sodium.randombytes_buf(32);
}

export function deriveKeys(repoKey: Uint8Array): Keys {
  return {
    enc: sodium.crypto_kdf_derive_from_key(32, 1, 'vd-enc00', repoKey),
    id: sodium.crypto_kdf_derive_from_key(32, 2, 'vd-id000', repoKey),
  };
}

/** Keyed content id: same plaintext + same repo key => same id. */
export function contentId(keys: Keys, kind: string, data: Uint8Array): string {
  const prefix = new TextEncoder().encode(kind + '\0');
  const msg = new Uint8Array(prefix.length + data.length);
  msg.set(prefix, 0);
  msg.set(data, prefix.length);
  return hex(sodium.crypto_generichash(32, msg, keys.id));
}

export function seal(keys: Keys, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, keys.enc);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export function open(keys: Keys, sealed: Uint8Array, ad: Uint8Array): Uint8Array {
  const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed.subarray(n), ad, sealed.subarray(0, n), keys.enc);
}

// ---- identity & key wrapping ------------------------------------------------

export interface Identity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateIdentity(): Identity {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Rebuild a full identity from its private key (the public half is derived). */
export function identityFromPrivate(privateKey: Uint8Array): Identity {
  return { privateKey, publicKey: sodium.crypto_scalarmult_base(privateKey) };
}

export function wrapKeyFor(recipientPublic: Uint8Array, repoKey: Uint8Array): Uint8Array {
  return sodium.crypto_box_seal(repoKey, recipientPublic);
}

export function unwrapKey(id: Identity, wrapped: Uint8Array): Uint8Array {
  return sodium.crypto_box_seal_open(wrapped, id.publicKey, id.privateKey);
}

/** Short code both people compare out-of-band when someone joins a repo. */
export function safetyNumber(publicKey: Uint8Array): string {
  const h = sodium.crypto_generichash(10, publicKey, null);
  return hex(h).toUpperCase().match(/.{4}/g)!.join('-');
}

const PW_OPS = () => sodium.crypto_pwhash_OPSLIMIT_MODERATE;
const PW_MEM = () => sodium.crypto_pwhash_MEMLIMIT_MODERATE;

export function wrapWithPassphrase(repoKey: Uint8Array, passphrase: string): Uint8Array {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const k = sodium.crypto_pwhash(32, passphrase, salt, PW_OPS(), PW_MEM(), sodium.crypto_pwhash_ALG_ARGON2ID13);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(repoKey, nonce, k);
  const out = new Uint8Array(salt.length + nonce.length + ct.length);
  out.set(salt, 0);
  out.set(nonce, salt.length);
  out.set(ct, salt.length + nonce.length);
  return out;
}

export function unwrapWithPassphrase(blob: Uint8Array, passphrase: string): Uint8Array {
  const sl = sodium.crypto_pwhash_SALTBYTES;
  const nl = sodium.crypto_secretbox_NONCEBYTES;
  const k = sodium.crypto_pwhash(32, passphrase, blob.subarray(0, sl), PW_OPS(), PW_MEM(), sodium.crypto_pwhash_ALG_ARGON2ID13);
  return sodium.crypto_secretbox_open_easy(blob.subarray(sl + nl), blob.subarray(sl, sl + nl), k);
}

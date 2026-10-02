// Secrets (OAuth refresh token, repo keys, device identity) live in the OS credential
// store via Electron safeStorage (DPAPI / Keychain / libsecret), never in plain text.
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const file = () => join(app.getPath('userData'), 'secrets.json');

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

function save(data: Record<string, string>) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(file(), JSON.stringify(data), { mode: 0o600 });
}

export function getSecret(name: string): string | null {
  const v = load()[name];
  if (!v) return null;
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(v, 'base64').toString('utf8');
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch {
    return null;
  }
}

export function setSecret(name: string, value: string) {
  const data = load();
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  data[name] = buf.toString('base64');
  save(data);
}

export function deleteSecret(name: string) {
  const data = load();
  delete data[name];
  save(data);
}

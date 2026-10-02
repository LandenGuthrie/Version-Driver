// Near-real-time collaboration. Drive push notifications need a public HTTPS endpoint,
// which a desktop app doesn't have, so we poll the Drive change feed: ~3s while the
// window is focused, ~15s in the background, with backoff on errors.
import { EventEmitter } from 'node:events';
import type { Backend } from './storage.js';
import type { ObjectStore } from './objects.js';
import { RemoteClient, type LogItem } from './sync.js';
import { listLocks, listMembers, listPresence, type Lock, type Member, type Presence } from './sharing.js';

export interface WatcherEvents {
  /** Someone else pushed. */
  refs: (pushes: LogItem[]) => void;
  presence: (online: Presence[]) => void;
  members: (members: Member[]) => void;
  locks: (locks: Lock[]) => void;
  error: (err: Error) => void;
}

export interface RemoteWatcher {
  on<E extends keyof WatcherEvents>(event: E, fn: WatcherEvents[E]): this;
  off<E extends keyof WatcherEvents>(event: E, fn: WatcherEvents[E]): this;
}

export class RemoteWatcher extends EventEmitter {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private focused = true;
  private failures = 0;
  private last = { presence: '', members: '', locks: '' };
  private cursors = { presence: null as string | null, members: null as string | null, locks: null as string | null };

  constructor(
    private backend: Backend,
    private client: RemoteClient,
    private store: ObjectStore,
    private opts: { focusedMs?: number; backgroundMs?: number } = {},
  ) {
    super();
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  setFocused(focused: boolean) {
    this.focused = focused;
    if (this.running && focused) {
      clearTimeout(this.timer);
      void this.tick(); // catch up immediately when the window regains focus
    }
  }

  /** Poll once, right now. */
  async tick() {
    if (!this.running) return;
    try {
      await this.pollOnce();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.emit('error', e as Error);
    }
    if (!this.running) return;
    const base = this.focused ? (this.opts.focusedMs ?? 3000) : (this.opts.backgroundMs ?? 15000);
    const delay = Math.min(base * 2 ** this.failures, 120_000) + Math.random() * 400;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  async pollOnce() {
    const fresh = await this.client.refresh();
    const others = fresh.filter((r) => r.user !== this.client.me.id);
    if (others.length) this.emit('refs', others);

    for (const area of ['presence', 'members', 'locks'] as const) {
      const { files, cursor } = await this.backend.changes(this.cursors[area], `${area}/`);
      const changed = this.cursors[area] === null || files.some((f) => !this.seenFile(area, f.key, f.createdTime));
      this.cursors[area] = cursor;
      // Heartbeats age out and lock releases are deletions (invisible to a change feed),
      // so presence and locks are re-read every tick; members only when something changed.
      if (!changed && area === 'members') continue;
      const value =
        area === 'presence' ? await listPresence(this.backend) :
        area === 'members' ? await listMembers(this.backend) :
        await listLocks(this.backend, this.store);
      const sig = JSON.stringify(value);
      if (sig !== this.last[area]) {
        this.last[area] = sig;
        this.emit(area, value);
      }
    }
  }

  private seen = new Map<string, number>();
  private seenFile(area: string, key: string, t: number) {
    const k = `${area}:${key}`;
    const prev = this.seen.get(k);
    this.seen.set(k, t);
    return prev === t;
  }
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import logoUrl from './assets/logo.png';

// ---- icons (24px grid, 1.8 stroke) ---------------------------------------------------

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
  branch: 'M6 4v10M6 14a3 3 0 100 6 3 3 0 000-6zM18 4a3 3 0 100 6 3 3 0 000-6zM18 10c0 4-6 3-12 4',
  commit: 'M12 8a4 4 0 100 8 4 4 0 000-8zM2 12h6M16 12h6',
  merge: 'M6 4a2 2 0 100 4 2 2 0 000-4zM6 8v8M6 16a2 2 0 100 4 2 2 0 000-4zM18 12a2 2 0 100 4 2 2 0 000-4zM6 8c0 4 12 0 12 4',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  cloud: 'M7 18a4 4 0 01-.5-8 5.5 5.5 0 0110.7 1.2A3.4 3.4 0 0117 18H7z',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M17.5 14a6.5 6.5 0 014 6',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zM14 3v5h5',
  image: 'M4 5h16v14H4zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4 17l5-5 4 4 3-3 4 4',
  audio: 'M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM19 16a3 3 0 11-6 0 3 3 0 016 0z',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  folder: 'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  unlock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 016.7-1.4',
  undo: 'M4 9h10a6 6 0 010 12h-3M4 9l4-4M4 9l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M7 4.5v15l13-7.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  split: 'M4 4h7v16H4zM13 4h7v16h-7z',
  rows: 'M4 5h16M4 12h16M4 19h16',
  disk: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2',
  alert: 'M12 3l10 18H2L12 3zM12 10v5M12 18h.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  expand: 'M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4',
};

export function Icon({ n, s = 16, className, style }: { n: keyof typeof P | string; s?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d={P[n] ?? ''} />
    </svg>
  );
}

/** The app icon. Sized by its container (see .logo in styles.css). */
export function Logo({ alt = 'Version Driver' }: { s?: number; alt?: string }) {
  return <img src={logoUrl} alt={alt} draggable={false} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

export function GoogleG({ s = 18 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 11-3.4-12.9l5.7-5.7A20 20 0 1044 24c0-1.3-.1-2.7-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0124 12c3 0 5.8 1.1 7.9 3l5.7-5.7A20 20 0 006.3 14.7z" />
      <path fill="#4CAF50" d="M24 44a20 20 0 0013.5-5.2l-6.2-5.2A12 12 0 0112.7 28l-6.6 5.1A20 20 0 0024 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 01-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.7-.4-3.9z" />
    </svg>
  );
}

// ---- small helpers -------------------------------------------------------------------

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const AV = ['#ff7a1a', '#3fb950', '#4493f8', '#e3b341', '#9aa0aa', '#2dd4bf'];
export function Avatar({ name, src, online, lg }: { name: string; src?: string; online?: boolean; lg?: boolean }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const cls = `avatar${lg ? ' lg' : ''}`;
  if (src) return <img className={cls} src={src} alt="" referrerPolicy="no-referrer" title={name} />;
  return (
    <span className={cls} style={{ background: AV[h % AV.length] }} title={name}>
      {name.trim().slice(0, 1).toUpperCase() || '?'}
      {online && <span className="dot" />}
    </span>
  );
}

// ---- popover / menu -------------------------------------------------------------------

export function Popover({ trigger, children, align = 'left', width }: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className="popover" style={{ top: 'calc(100% + 6px)', [align]: 0, width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export interface MenuEntry {
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
}

export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuEntry[]; onClose: () => void }) {
  useEffect(() => {
    if (!at) return;
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [at, onClose]);
  if (!at) return null;
  return (
    <div className="popover" style={{ position: 'fixed', left: Math.min(at.x, window.innerWidth - 240), top: Math.min(at.y, window.innerHeight - items.length * 34 - 20) }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.sep ? <div key={i} className="menu-sep" /> : (
          <button key={i} className={`menu-item${it.danger ? ' danger' : ''}`} disabled={it.disabled} onClick={() => { onClose(); it.onClick(); }}>
            {it.icon && <Icon n={it.icon} s={15} />}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon n="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

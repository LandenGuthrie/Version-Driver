// User-customizable theme. A handful of base colors are stored; every other shade
// (borders, hover states, muted text…) is derived from them so any combination looks coherent.

export interface Theme {
  preset: string;
  bg: string;
  surface: string;
  accent: string;
  text: string;
  added: string;
  removed: string;
  background: 'solid' | 'gradient' | 'image';
  image?: string;
  imageDim: number; // 0-90 (% of bg color laid over the image)
  scale: number; // interface size, 0.9-1.25
  floating: boolean; // panels float as separate cards, with no bar behind the toolbar
  codeSize: number; // px
}

type Base = Pick<Theme, 'bg' | 'surface' | 'accent' | 'text' | 'added' | 'removed'>;

export const PRESETS: Record<string, Base> = {
  Midnight: { bg: '#0e0e10', surface: '#141416', accent: '#ff7a1a', text: '#ececef', added: '#3fb950', removed: '#f85149' },
  Graphite: { bg: '#17181a', surface: '#1f2124', accent: '#4493f8', text: '#e6e8eb', added: '#3fb950', removed: '#f85149' },
  Ocean: { bg: '#0b1220', surface: '#111b2e', accent: '#38a3ff', text: '#e5edf8', added: '#34d399', removed: '#fb7185' },
  Forest: { bg: '#0d1410', surface: '#131d17', accent: '#3fb950', text: '#e4eee7', added: '#3fb950', removed: '#f0665e' },
  Black: { bg: '#000000', surface: '#0a0a0a', accent: '#ff7a1a', text: '#f2f2f2', added: '#3fb950', removed: '#f85149' },
  Light: { bg: '#f6f6f7', surface: '#ffffff', accent: '#f26a00', text: '#17171a', added: '#1a7f37', removed: '#cf222e' },
  Paper: { bg: '#f3eee4', surface: '#fbf8f1', accent: '#d9480f', text: '#2b2620', added: '#2f7d32', removed: '#b3261e' },
};

export const DEFAULT_THEME: Theme = {
  preset: 'Midnight',
  ...PRESETS.Midnight!,
  background: 'solid',
  imageDim: 55,
  scale: 1,
  floating: true,
  codeSize: 12.5,
};

// ---- color math -------------------------------------------------------------------------

type RGB = [number, number, number];

export function parse(hex: string): RGB {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => {
  const A = parse(a);
  const B = parse(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
};
const rgba = (hex: string, a: number) => {
  const [r, g, b] = parse(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
export function luminance(hex: string) {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastText = (bg: string) => (luminance(bg) > 0.4 ? '#14110d' : '#ffffff');

// ---- apply ---------------------------------------------------------------------------------

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  const dark = luminance(t.bg) < 0.4;
  const v = (k: string, val: string) => root.style.setProperty(k, val);

  v('--bg', t.bg);
  v('--surface', t.surface);
  v('--raised', mix(t.surface, t.text, dark ? 0.05 : 0.04));
  v('--hover', mix(t.surface, t.text, dark ? 0.1 : 0.07));
  v('--active', mix(t.surface, t.text, dark ? 0.15 : 0.11));
  v('--border', mix(t.bg, t.text, dark ? 0.13 : 0.12));
  v('--border-strong', mix(t.bg, t.text, dark ? 0.22 : 0.22));
  v('--text', t.text);
  v('--muted', mix(t.surface, t.text, 0.62));
  v('--faint', mix(t.surface, t.text, 0.4));
  v('--accent', t.accent);
  v('--accent-hover', mix(t.accent, dark ? '#ffffff' : '#000000', 0.14));
  v('--accent-fg', contrastText(t.accent));
  v('--accent-soft', rgba(t.accent, dark ? 0.15 : 0.12));
  v('--green', t.added);
  v('--green-soft', rgba(t.added, dark ? 0.15 : 0.12));
  v('--green-strong', rgba(t.added, dark ? 0.38 : 0.3));
  v('--red', t.removed);
  v('--red-soft', rgba(t.removed, dark ? 0.15 : 0.11));
  v('--red-strong', rgba(t.removed, dark ? 0.4 : 0.28));
  v('--blue', dark ? '#4493f8' : '#0969da');
  v('--blue-soft', dark ? 'rgba(68,147,248,.14)' : 'rgba(9,105,218,.1)');
  v('--shadow', dark ? '0 12px 40px rgba(0,0,0,.5)' : '0 12px 40px rgba(0,0,0,.16)');
  v('--checker-a', mix(t.bg, t.text, 0.04));
  v('--checker-b', mix(t.bg, t.text, 0.09));
  v('--code-size', `${t.codeSize}px`);
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.zoom = String(t.scale);
  root.classList.toggle('floating', t.floating);

  // background style: panels become translucent so the wallpaper shows through
  if (t.background === 'solid') {
    v('--page-bg', t.bg);
    v('--content-bg', t.bg);
    v('--sidebar-bg', t.surface);
    v('--titlebar-bg', t.bg);
  } else if (t.background === 'gradient') {
    v('--page-bg', `radial-gradient(1100px 650px at 78% -8%, ${rgba(t.accent, dark ? 0.2 : 0.16)}, transparent 62%), radial-gradient(900px 600px at -5% 105%, ${rgba(t.accent, dark ? 0.1 : 0.08)}, transparent 60%), ${t.bg}`);
    v('--content-bg', 'transparent');
    v('--sidebar-bg', rgba(t.surface, 0.72));
    v('--titlebar-bg', 'transparent');
  } else {
    const dim = t.imageDim / 100;
    v('--page-bg', t.image ? `linear-gradient(${rgba(t.bg, dim)}, ${rgba(t.bg, dim)}), url("${t.image}") center / cover no-repeat fixed, ${t.bg}` : t.bg);
    v('--content-bg', rgba(t.bg, 0.35));
    v('--sidebar-bg', rgba(t.surface, 0.8));
    v('--titlebar-bg', rgba(t.bg, 0.5));
  }
  // keep the native window-control strip (Windows/Linux) matching
  void window.vd?.setTitleBar?.(t.background === 'solid' ? t.bg : mix(t.bg, t.surface, 0.3), dark ? mix(t.bg, t.text, 0.6) : mix(t.bg, t.text, 0.7));
}

// ---- persistence -----------------------------------------------------------------------------

const KEY = 'vd.theme.v2';

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<Theme>) };
  } catch {
    /* fall through */
  }
  return DEFAULT_THEME;
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* quota exceeded (large wallpaper) or storage blocked - the theme still applies this session */
  }
}

/** Downscale a picked wallpaper so it fits comfortably in local storage. */
export function loadWallpaper(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1920;
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}

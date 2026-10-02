import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiff } from '../../../shared/api';
import { Icon, fmtBytes } from '../ui';

function Delta({ a, b }: { a?: number; b?: number }) {
  if (a === undefined || b === undefined || a === b) return null;
  const d = b - a;
  return <span className={`badge ${d > 0 ? 'orange' : 'green'}`}>{d > 0 ? '+' : '−'}{fmtBytes(Math.abs(d))}</span>;
}

// ---- images ---------------------------------------------------------------------------

type ImgMode = '2-up' | 'swipe' | 'onion' | 'difference';

export function ImageView({ d }: { d: FileDiff }) {
  const both = !!d.oldUrl && !!d.newUrl;
  const [mode, setMode] = useState<ImgMode>('2-up');
  const [pos, setPos] = useState(50);
  const [op, setOp] = useState(50);
  const [dims, setDims] = useState<{ o?: [number, number]; n?: [number, number] }>({});
  const m: ImgMode = both ? mode : '2-up';

  useEffect(() => setDims({}), [d.oldUrl, d.newUrl]);

  const onLoad = (which: 'o' | 'n') => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const i = e.currentTarget;
    setDims((p) => ({ ...p, [which]: [i.naturalWidth, i.naturalHeight] }));
  };

  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (m !== 'swipe') return;
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setPos(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
    };
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="stage">
      <div className="stage-bar">
        {both && (
          <div className="seg" role="tablist">
            {(['2-up', 'swipe', 'onion', 'difference'] as ImgMode[]).map((x) => (
              <button key={x} className={mode === x ? 'on' : ''} onClick={() => setMode(x)}>{x === '2-up' ? '2-up' : x[0]!.toUpperCase() + x.slice(1)}</button>
            ))}
          </div>
        )}
        {m === 'onion' && (
          <label className="row stat">Before <input type="range" min={0} max={100} value={op} onChange={(e) => setOp(+e.target.value)} /> After</label>
        )}
        <span className="grow" />
        {dims.o && dims.n && (dims.o[0] !== dims.n[0] || dims.o[1] !== dims.n[1]) && (
          <span className="badge blue">{dims.o[0]}×{dims.o[1]} → {dims.n[0]}×{dims.n[1]}</span>
        )}
        <Delta a={d.oldSize} b={d.size} />
      </div>

      {m === '2-up' && (
        <div className={`twoup${both ? '' : ' one'}`}>
          {d.oldUrl && (
            <div className="img-card">
              <div className="cap"><span className="badge red">{both ? 'Before' : 'Removed'}</span><span className="stat">{dims.o ? `${dims.o[0]}×${dims.o[1]} · ` : ''}{fmtBytes(d.oldSize ?? 0)}</span></div>
              <div className="pic checker"><img src={d.oldUrl} alt="Before" onLoad={onLoad('o')} /></div>
            </div>
          )}
          {d.newUrl && (
            <div className="img-card">
              <div className="cap"><span className="badge green">{both ? 'After' : 'Added'}</span><span className="stat">{dims.n ? `${dims.n[0]}×${dims.n[1]} · ` : ''}{fmtBytes(d.size)}</span></div>
              <div className="pic checker"><img src={d.newUrl} alt="After" onLoad={onLoad('n')} /></div>
            </div>
          )}
        </div>
      )}

      {m === 'swipe' && both && (
        <div className="overlay-wrap checker" onPointerDown={drag} style={{ cursor: 'ew-resize', touchAction: 'none' }}>
          <img src={d.newUrl} alt="After" draggable={false} onLoad={onLoad('n')} />
          <div className="top" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}><img src={d.oldUrl} alt="Before" draggable={false} onLoad={onLoad('o')} /></div>
          <div className="swipe-line" style={{ left: `${pos}%` }} />
        </div>
      )}

      {m === 'onion' && both && (
        <div className="overlay-wrap checker">
          <img src={d.newUrl} alt="After" onLoad={onLoad('n')} />
          <div className="top" style={{ opacity: 1 - op / 100 }}><img src={d.oldUrl} alt="Before" onLoad={onLoad('o')} /></div>
        </div>
      )}

      {m === 'difference' && both && <DifferenceCanvas a={d.oldUrl!} b={d.newUrl!} />}
    </div>
  );
}

function DifferenceCanvas({ a, b }: { a: string; b: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
    Promise.all([load(a), load(b)]).then(([x, y]) => {
      if (dead || !ref.current) return;
      const c = ref.current;
      c.width = Math.max(x.naturalWidth, y.naturalWidth);
      c.height = Math.max(x.naturalHeight, y.naturalHeight);
      const g = c.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(y, 0, 0);
      g.globalCompositeOperation = 'difference';
      g.drawImage(x, 0, 0);
    }).catch(() => setErr(true));
    return () => { dead = true; };
  }, [a, b]);
  if (err) return <div className="muted">Could not compare these images.</div>;
  return (
    <>
      <div className="overlay-wrap"><canvas ref={ref} style={{ filter: 'brightness(4)' }} /></div>
      <span className="stat">Black means identical pixels. Brighter areas changed (amplified 4×).</span>
    </>
  );
}

// ---- audio ----------------------------------------------------------------------------

interface Wave {
  peaks: Float32Array;
  duration: number;
  sampleRate: number;
  channels: number;
}

function useWave(url?: string): { wave?: Wave; failed: boolean } {
  const [state, setState] = useState<{ wave?: Wave; failed: boolean }>({ failed: false });
  useEffect(() => {
    setState({ failed: false });
    if (!url) return;
    let dead = false;
    (async () => {
      const buf = await (await fetch(url)).arrayBuffer();
      const ctx = new AudioContext();
      try {
        const audio = await ctx.decodeAudioData(buf);
        const N = 900;
        const peaks = new Float32Array(N);
        const ch = audio.getChannelData(0);
        const per = Math.max(1, Math.floor(ch.length / N));
        for (let i = 0; i < N; i++) {
          let max = 0;
          for (let j = i * per; j < Math.min(ch.length, (i + 1) * per); j += Math.max(1, per >> 6)) max = Math.max(max, Math.abs(ch[j]!));
          peaks[i] = max;
        }
        if (!dead) setState({ wave: { peaks, duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels }, failed: false });
      } finally {
        void ctx.close();
      }
    })().catch(() => !dead && setState({ failed: true }));
    return () => { dead = true; };
  }, [url]);
  return state;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function AudioView({ d }: { d: FileDiff }) {
  const both = !!d.oldUrl && !!d.newUrl;
  const oldW = useWave(d.oldUrl);
  const newW = useWave(d.newUrl);
  const [active, setActive] = useState<'old' | 'new'>(d.newUrl ? 'new' : 'old');
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [vol, setVol] = useState(0.9);
  const els = useRef<{ old?: HTMLAudioElement; new?: HTMLAudioElement }>({});
  const maxDur = Math.max(oldW.wave?.duration ?? 0, newW.wave?.duration ?? 0) || 1;

  // one <audio> per version; both are kept at the same position so A/B switching is seamless
  useEffect(() => {
    const mk = (u?: string) => (u ? Object.assign(new Audio(u), { preload: 'auto' }) : undefined);
    els.current = { old: mk(d.oldUrl), new: mk(d.newUrl) };
    setActive(d.newUrl ? 'new' : 'old');
    setPlaying(false);
    setT(0);
    return () => {
      for (const e of Object.values(els.current)) {
        e?.pause();
        if (e) e.src = '';
      }
    };
  }, [d.oldUrl, d.newUrl]);

  useEffect(() => {
    for (const e of Object.values(els.current)) if (e) e.volume = vol;
  }, [vol, d.oldUrl, d.newUrl]);

  useEffect(() => {
    const e = els.current[active];
    if (!e) return;
    const end = () => setPlaying(false);
    e.addEventListener('ended', end);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 60) {
        setT(e.currentTime);
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      e.removeEventListener('ended', end);
    };
  }, [active, d.oldUrl, d.newUrl]);

  const seek = (time: number) => {
    for (const e of Object.values(els.current)) if (e) e.currentTime = Math.min(time, e.duration || time);
    setT(time);
  };
  const toggle = () => {
    const e = els.current[active];
    if (!e) return;
    if (playing) e.pause();
    else void e.play();
    setPlaying(!playing);
  };
  const switchTo = (v: 'old' | 'new') => {
    if (v === active || !els.current[v]) return;
    const cur = els.current[active]!;
    const next = els.current[v]!;
    const time = cur.currentTime;
    cur.pause();
    next.currentTime = Math.min(time, next.duration || time);
    if (playing) void next.play();
    setActive(v);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      if (e.key === 'Tab' && both) { e.preventDefault(); switchTo(active === 'old' ? 'new' : 'old'); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const failed = (d.oldUrl && oldW.failed) || (d.newUrl && newW.failed);

  return (
    <div className="stage">
      <div className="transport">
        <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon n={playing ? 'pause' : 'play'} s={18} /></button>
        <span className="mono stat" style={{ width: 92 }}>{mmss(t)} / {mmss(maxDur)}</span>
        <input type="range" className="grow" min={0} max={maxDur} step={0.01} value={t} onChange={(e) => seek(+e.target.value)} aria-label="Seek" />
        {both && (
          <div className="seg" role="tablist" title="Switch versions while playing (Tab)">
            <button className={active === 'old' ? 'on' : ''} onClick={() => switchTo('old')}>Before</button>
            <button className={active === 'new' ? 'on' : ''} onClick={() => switchTo('new')}>After</button>
          </div>
        )}
        <Icon n="audio" s={15} className="faint" />
        <input type="range" min={0} max={1} step={0.01} value={vol} onChange={(e) => setVol(+e.target.value)} style={{ width: 80 }} aria-label="Volume" />
      </div>
      {failed && <div className="badge orange" style={{ alignSelf: 'flex-start', padding: '5px 10px' }}><Icon n="alert" s={13} /> Waveform unavailable for this format. Playback still works.</div>}

      <div className="twoup" style={{ gridTemplateColumns: both ? '1fr' : 'minmax(0,1fr)' }}>
        {d.oldUrl && <WaveCard label={both ? 'Before' : 'Removed'} tone="red" wave={oldW.wave} size={d.oldSize} maxDur={maxDur} t={t} active={active === 'old'} onSeek={seek} onPick={both ? () => switchTo('old') : undefined} />}
        {d.newUrl && <WaveCard label={both ? 'After' : 'Added'} tone="green" wave={newW.wave} size={d.size} maxDur={maxDur} t={t} active={active === 'new'} onSeek={seek} onPick={both ? () => switchTo('new') : undefined} />}
      </div>
      {both && oldW.wave && newW.wave && (
        <div className="row stat" style={{ flexWrap: 'wrap' }}>
          <Delta a={d.oldSize} b={d.size} />
          {Math.abs(oldW.wave.duration - newW.wave.duration) > 0.01 && (
            <span className="badge blue">Length {mmss(oldW.wave.duration)} → {mmss(newW.wave.duration)}</span>
          )}
          {oldW.wave.sampleRate !== newW.wave.sampleRate && <span className="badge blue">{oldW.wave.sampleRate / 1000} kHz → {newW.wave.sampleRate / 1000} kHz</span>}
          {oldW.wave.channels !== newW.wave.channels && <span className="badge blue">{oldW.wave.channels} ch → {newW.wave.channels} ch</span>}
        </div>
      )}
    </div>
  );
}

function WaveCard({ label, tone, wave, size, maxDur, t, active, onSeek, onPick }: {
  label: string; tone: 'red' | 'green'; wave?: Wave; size?: number; maxDur: number; t: number; active: boolean;
  onSeek: (t: number) => void; onPick?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const base = css.getPropertyValue('--faint').trim() || '#666';
    const hot = css.getPropertyValue('--accent').trim() || '#ff7a1a';
    if (!wave) return;
    const usable = (wave.duration / maxDur) * w;
    const n = wave.peaks.length;
    const px = (t / maxDur) * w;
    for (let x = 0; x < usable; x += 2) {
      const p = wave.peaks[Math.min(n - 1, Math.floor((x / usable) * n))]!;
      const bar = Math.max(1, p * (h - 8));
      g.fillStyle = x < px && active ? hot : base;
      g.globalAlpha = active ? 1 : 0.7;
      g.fillRect(x, (h - bar) / 2, 1.4, bar);
    }
    g.globalAlpha = 1;
    g.fillStyle = hot;
    g.fillRect(px, 0, 1.5, h);
  }, [wave, maxDur, t, active]);

  return (
    <div className={`audio-card${active && onPick ? ' active' : ''}`} onClick={onPick}>
      <div className="row">
        <span className={`badge ${tone}`}>{label}</span>
        <span className="grow" />
        {wave && <span className="stat">{mmss(wave.duration)} · {wave.sampleRate / 1000} kHz · {wave.channels === 1 ? 'mono' : wave.channels === 2 ? 'stereo' : `${wave.channels} ch`} · <b>{fmtBytes(size ?? 0)}</b></span>}
        {!wave && <span className="stat">{fmtBytes(size ?? 0)}</span>}
      </div>
      <canvas ref={ref} onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * maxDur); }} aria-label={`${label} waveform`} />
    </div>
  );
}

// ---- video / binary ---------------------------------------------------------------------

export function VideoView({ d }: { d: FileDiff }) {
  const both = !!d.oldUrl && !!d.newUrl;
  return (
    <div className="stage">
      <div className={`twoup${both ? '' : ' one'}`}>
        {d.oldUrl && <div className="img-card"><div className="cap"><span className="badge red">{both ? 'Before' : 'Removed'}</span><span className="stat">{fmtBytes(d.oldSize ?? 0)}</span></div><video src={d.oldUrl} controls style={{ width: '100%' }} /></div>}
        {d.newUrl && <div className="img-card"><div className="cap"><span className="badge green">{both ? 'After' : 'Added'}</span><span className="stat">{fmtBytes(d.size)}</span></div><video src={d.newUrl} controls style={{ width: '100%' }} /></div>}
      </div>
    </div>
  );
}

export function BinaryView({ d }: { d: FileDiff }) {
  const rows = useMemo(() => [['Before', d.oldSize !== undefined ? fmtBytes(d.oldSize) : '-'], ['After', d.status === 'deleted' ? '-' : fmtBytes(d.size)]], [d]);
  return (
    <div className="empty">
      <div className="icon-wrap"><Icon n="file" s={22} /></div>
      <h3>Binary file</h3>
      <span>There's no inline preview for this type, but it's versioned like everything else.</span>
      <dl className="kv" style={{ textAlign: 'left', marginTop: 6 }}>{rows.map(([k, v]) => <><dt key={k}>{k}</dt><dd>{v}</dd></>)}</dl>
    </div>
  );
}

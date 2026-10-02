import { memo, useEffect, useMemo, useState } from 'react';
import { diffWordsWithSpace } from 'diff';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import java from 'highlight.js/lib/languages/java';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
import type { DiffRow } from '../../../shared/api';
import { Icon } from '../ui';

const LANGS: Record<string, any> = { javascript, typescript, json, css, xml, markdown, python, bash, yaml, cpp, csharp, java, rust, go, sql, ini };
for (const [k, v] of Object.entries(LANGS)) hljs.registerLanguage(k, v);
hljs.configure({ classPrefix: 'hl-' });

const EXT: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', scss: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', md: 'markdown',
  py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  java: 'java', rs: 'rust', go: 'go', sql: 'sql', ini: 'ini', toml: 'ini', gitignore: 'ini', vdignore: 'ini',
};

export const langOf = (path: string) => EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];

function Code({ s, lang, parts }: { s: string; lang?: string; parts?: { text: string; hl: boolean; kind: 'add' | 'del' }[] }) {
  if (parts) {
    return (
      <>
        {parts.map((p, i) => (p.hl ? <span key={i} className={p.kind === 'add' ? 'w-add' : 'w-del'}>{p.text}</span> : <span key={i}>{p.text}</span>))}
      </>
    );
  }
  if (lang && s.length < 400) {
    try {
      return <span dangerouslySetInnerHTML={{ __html: hljs.highlight(s, { language: lang, ignoreIllegals: true }).value || ' ' }} />;
    } catch {
      /* fall through */
    }
  }
  return <>{s || ' '}</>;
}

const CONTEXT = 3;

type Item = { k: 'row'; i: number } | { k: 'fold'; from: number; to: number };

function buildItems(rows: DiffRow[], expanded: Set<number>, all: boolean): Item[] {
  if (all) return rows.map((_, i) => ({ k: 'row', i }));
  const vis = new Uint8Array(rows.length);
  rows.forEach((r, i) => {
    if (r.t === 'ctx') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) vis[j] = 1;
  });
  const out: Item[] = [];
  for (let i = 0; i < rows.length; ) {
    if (vis[i] || expanded.has(i)) {
      out.push({ k: 'row', i });
      i++;
    } else {
      let j = i;
      while (j < rows.length && !vis[j] && !expanded.has(j)) j++;
      if (j - i <= 2) for (let x = i; x < j; x++) out.push({ k: 'row', i: x });
      else out.push({ k: 'fold', from: i, to: j });
      i = j;
    }
  }
  return out;
}

type Marks = Map<number, { text: string; hl: boolean; kind: 'add' | 'del' }[]>;

/** Word-level highlights for del/add blocks, pairing lines by position. */
function wordMarks(rows: DiffRow[]): Marks {
  const out: Marks = new Map();
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.t !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d]!.t === 'del') d++;
    let a = d;
    while (a < rows.length && rows[a]!.t === 'add') a++;
    const n = Math.min(d - i, a - d);
    for (let k = 0; k < n; k++) {
      const o = rows[i + k]!.s;
      const nw = rows[d + k]!.s;
      if (o.length > 500 || nw.length > 500) continue;
      const parts = diffWordsWithSpace(o, nw);
      const sim = parts.filter((p) => !p.added && !p.removed).reduce((t, p) => t + p.value.length, 0) / Math.max(o.length, nw.length, 1);
      if (sim < 0.3) continue; // mostly different: highlighting every word is just noise
      out.set(i + k, parts.filter((p) => !p.added).map((p) => ({ text: p.value, hl: !!p.removed, kind: 'del' as const })));
      out.set(d + k, parts.filter((p) => !p.removed).map((p) => ({ text: p.value, hl: !!p.added, kind: 'add' as const })));
    }
    i = a;
  }
  return out;
}

export const DiffView = memo(function DiffView({ rows, split, lang, whole }: { rows: DiffRow[]; split: boolean; lang?: string; whole: boolean }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => setExpanded(new Set()), [rows]);
  const items = useMemo(() => buildItems(rows, expanded, whole), [rows, expanded, whole]);
  const marks = useMemo(() => wordMarks(rows), [rows]);
  const hlLang = rows.length < 4000 ? lang : undefined;

  if (!rows.some((r) => r.t !== 'ctx')) {
    return <div className="empty"><div className="icon-wrap"><Icon n="check" s={22} /></div><h3>No content changes</h3><span>Only file metadata (like permissions) changed.</span></div>;
  }

  const expand = (from: number, to: number) => {
    const n = new Set(expanded);
    for (let i = from; i < to; i++) n.add(i);
    setExpanded(n);
  };

  const fold = (it: Extract<Item, { k: 'fold' }>, key: string) => (
    <button key={key} className="fold" onClick={() => expand(it.from, it.to)}><Icon n="expand" s={13} />Show {it.to - it.from} unchanged lines</button>
  );

  if (!split) {
    return (
      <div className="diff selectable">
        {items.map((it, x) => {
          if (it.k === 'fold') return fold(it, `f${x}`);
          const r = rows[it.i]!;
          return (
            <div key={it.i} className={`r ${r.t === 'ctx' ? '' : r.t}`}>
              <span className="no">{r.o ?? ''}</span>
              <span className="no">{r.n ?? ''}</span>
              <span className="sign">{r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</span>
              <span className="code"><Code s={r.s} lang={hlLang} parts={marks.get(it.i)} /></span>
            </div>
          );
        })}
      </div>
    );
  }

  // split: zip del/add runs side by side
  const out: React.ReactNode[] = [];
  const emitted = new Set<number>();
  items.forEach((it, x) => {
    if (it.k === 'fold') return void out.push(fold(it, `f${x}`));
    if (emitted.has(it.i)) return;
    const r = rows[it.i]!;
    if (r.t === 'ctx') {
      out.push(
        <div className="pair" key={it.i}>
          <Half no={r.o} s={r.s} lang={hlLang} />
          <Half no={r.n} s={r.s} lang={hlLang} />
        </div>,
      );
      return;
    }
    let d = it.i;
    const dels: number[] = [];
    while (d < rows.length && rows[d]!.t === 'del') dels.push(d++);
    const adds: number[] = [];
    while (d < rows.length && rows[d]!.t === 'add') adds.push(d++);
    [...dels, ...adds].forEach((i) => emitted.add(i));
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const L = dels[k] !== undefined ? rows[dels[k]!] : undefined;
      const R = adds[k] !== undefined ? rows[adds[k]!] : undefined;
      out.push(
        <div className="pair" key={`${it.i}-${k}`}>
          <Half no={L?.o} s={L?.s} kind={L ? 'del' : 'empty'} lang={hlLang} parts={L ? marks.get(dels[k]!) : undefined} />
          <Half no={R?.n} s={R?.s} kind={R ? 'add' : 'empty'} lang={hlLang} parts={R ? marks.get(adds[k]!) : undefined} />
        </div>,
      );
    }
  });
  return <div className="diff split selectable">{out}</div>;
});

function Half({ no, s, kind, lang, parts }: { no?: number; s?: string; kind?: 'add' | 'del' | 'empty'; lang?: string; parts?: { text: string; hl: boolean; kind: 'add' | 'del' }[] }) {
  return (
    <div className={`half ${kind ?? ''}`}>
      <span className="no" style={{ textAlign: 'right', paddingRight: 10, color: 'var(--faint)' }}>{no ?? ''}</span>
      <span className="code">{s === undefined ? '' : <Code s={s} lang={lang} parts={parts} />}</span>
    </div>
  );
}

export function FileText({ text, lang }: { text: string; lang?: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const hl = lines.length < 5000 ? lang : undefined;
  return (
    <div className="filetext selectable">
      {lines.map((l, i) => (
        <div key={i} className="ln"><i>{i + 1}</i><span><Code s={l} lang={hl} /></span></div>
      ))}
    </div>
  );
}

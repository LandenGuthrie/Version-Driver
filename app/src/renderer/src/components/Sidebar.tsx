import { useMemo, useRef, useState } from 'react';
import type { ChangeDTO, CommitDTO } from '../../../shared/api';
import { useStore } from '../store';
import { Avatar, ContextMenu, Icon, fmtBytes, splitPath, timeAgo, type MenuEntry } from '../ui';

export function Sidebar() {
  const { tab, setTab, changes, commits } = useStore();
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={`tab${tab === 'changes' ? ' on' : ''}`} onClick={() => setTab('changes')}>
          Changes {changes.length > 0 && <span className="count">{changes.length}</span>}
        </button>
        <button className={`tab${tab === 'history' ? ' on' : ''}`} onClick={() => setTab('history')}>
          History {commits.length > 0 && <span className="count">{commits.length}</span>}
        </button>
      </div>
      {tab === 'changes' ? <ChangesPanel /> : <HistoryPanel />}
    </aside>
  );
}

function StatusIcon({ s }: { s: ChangeDTO['status'] }) {
  return <span className={`st ${s}`} title={s}><Icon n={s === 'added' ? 'plus' : s === 'deleted' ? 'minus' : 'commit'} s={11} /></span>;
}

export function KindIcon({ k }: { k: ChangeDTO['kind'] }) {
  return <Icon n={k === 'image' ? 'image' : k === 'audio' ? 'audio' : k === 'video' ? 'video' : 'file'} s={14} className="faint" />;
}

function ChangesPanel() {
  const s = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number; file: ChangeDTO } | null>(null);
  const checked = s.changes.length - s.unchecked.size;
  const all = checked === s.changes.length && s.changes.length > 0;
  const some = checked > 0 && !all;
  const branch = s.sync.branch ?? 'main';

  const items: MenuEntry[] = menu
    ? [
        { label: 'Discard changes…', icon: 'undo', danger: true, onClick: () => confirmDiscard([menu.file.path]) },
        ...(menu.file.status === 'added' ? ignoreItems(menu.file.path) : []),
        { label: 'Reveal in folder', icon: 'folder', onClick: () => void window.vd.revealInFolder(s.repoId!, menu.file.path) },
        ...(s.sync.hasRemote ? [{ label: 'Lock file for editing', icon: 'lock', onClick: () => void lock(menu.file.path) } as MenuEntry] : []),
      ]
    : [];

  /** Offer to ignore this file, its extension, or its folder (only useful for files not yet committed). */
  function ignoreItems(path: string): MenuEntry[] {
    const [dir, name] = splitPath(path);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const add = (pattern: string) => () => void window.vd.ignoreAdd(s.repoId!, pattern).then(() => s.toast({ kind: 'ok', text: `Now ignoring ${pattern}` }));
    return [
      { label: 'Ignore this file', icon: 'eye', onClick: add(`/${path}`), sep: false },
      ...(ext ? [{ label: `Ignore all ${ext} files`, icon: 'eye', onClick: add(`*${ext}`) } as MenuEntry] : []),
      ...(dir ? [{ label: `Ignore folder ${dir}`, icon: 'eye', onClick: add(dir) } as MenuEntry] : []),
    ];
  }

  function confirmDiscard(paths: string[] | undefined) {
    s.openDialog({
      t: 'confirm', title: 'Discard changes?', danger: true, confirmLabel: 'Discard',
      body: paths ? `This permanently discards your changes to ${paths.length === 1 ? paths[0] : `${paths.length} files`}.` : 'This permanently discards all uncommitted changes.',
      run: async () => {
        await window.vd.discard(s.repoId!, paths);
        await s.refresh();
      },
    });
  }

  async function lock(path: string) {
    const r = await window.vd.lockFile(s.repoId!, path).catch((e) => ({ ok: false, heldBy: e.message }));
    s.toast(r.ok ? { kind: 'ok', text: `Locked ${path}. Teammates see it as being edited by you.` } : { kind: 'error', text: `${path} is being edited by ${r.heldBy}` });
  }

  const canCommit = checked > 0 && s.summary.trim().length > 0 && !s.busy;

  return (
    <>
      <div className="list-head">
        <input
          type="checkbox" className="check" checked={all} ref={(el) => { if (el) el.indeterminate = some; }}
          onChange={(e) => s.setAllChecked(e.target.checked)} disabled={s.changes.length === 0} aria-label="Select all changes"
        />
        <span className="grow">{s.changes.length === 0 ? 'No changed files' : `${s.changes.length} changed file${s.changes.length === 1 ? '' : 's'}`}</span>
        {s.changes.length > 0 && <button className="btn ghost sm" onClick={() => confirmDiscard(undefined)}>Discard all</button>}
      </div>

      <div className="files" role="listbox" aria-label="Changed files">
        {s.changes.map((c) => {
          const [dir, name] = splitPath(c.path);
          return (
            <div
              key={c.path} role="option" aria-selected={s.focusPath === c.path}
              className={`file${s.focusPath === c.path ? ' sel' : ''}`}
              onClick={() => s.focus(c.path)}
              onContextMenu={(e) => { e.preventDefault(); s.focus(c.path); setMenu({ x: e.clientX, y: e.clientY, file: c }); }}
            >
              <input type="checkbox" className="check" checked={!s.unchecked.has(c.path)} onChange={() => s.toggleChecked(c.path)} onClick={(e) => e.stopPropagation()} aria-label={`Include ${c.path}`} />
              <KindIcon k={c.kind} />
              <div className="name" title={c.path}><b className="ellipsis">{name}</b><span>{dir}</span></div>
              <StatusIcon s={c.status} />
            </div>
          );
        })}
        {s.changes.length === 0 && (
          <div className="empty">
            <div className="icon-wrap"><Icon n="check" s={22} /></div>
            <h3>Everything is committed</h3>
            <span>Edit a file in your project folder and it will show up here instantly.</span>
            <button className="btn sm" onClick={() => void window.vd.revealInFolder(s.repoId!, '')}><Icon n="folder" s={14} /> Open folder</button>
          </div>
        )}
      </div>

      <div className="commit-box">
        <div className="row">
          <Avatar name={s.profile?.name ?? 'Me'} src={s.profile?.picture} />
          <input
            className="field" placeholder="Summary (required)" value={s.summary} maxLength={120}
            onChange={(e) => s.setSummary(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit && void s.commit()}
          />
        </div>
        <textarea className="field" rows={3} placeholder="Description" value={s.description} onChange={(e) => s.setDescription(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit && void s.commit()} />
        <button className="btn primary block" disabled={!canCommit} onClick={() => void s.commit()}>
          Commit {checked > 0 ? `${checked} file${checked === 1 ? '' : 's'} ` : ''}to <b className="ellipsis" style={{ maxWidth: 120 }}>{branch}</b>
        </button>
      </div>
      <ContextMenu at={menu} items={items} onClose={() => setMenu(null)} />
    </>
  );
}

function HistoryPanel() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [topPct, setTopPct] = useState(() => {
    try { return Math.min(80, Math.max(20, Number(localStorage.getItem('vd.histSplit')) || 55)); } catch { return 55; }
  });
  const box = useRef<HTMLDivElement>(null);
  const tipByBranch = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of s.branches) m.set(b.tip, [...(m.get(b.tip) ?? []), b.name]);
    return m;
  }, [s.branches]);
  const unpushed = useMemo(() => new Set(s.sync.unpushed), [s.sync.unpushed]);
  const shown = q ? s.commits.filter((c) => (c.summary + c.author.name + c.id).toLowerCase().includes(q.toLowerCase())) : s.commits;

  const dragSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current!;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const pct = Math.min(80, Math.max(20, ((ev.clientY - r.top) / r.height) * 100));
      setTopPct(pct);
      try { localStorage.setItem('vd.histSplit', String(Math.round(pct))); } catch { /* ignore */ }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      <div className="list-head">
        <Icon n="search" s={14} />
        <input className="field plain" placeholder="Search commits" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div ref={box} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div className="files" style={{ flex: s.selectedCommit ? `0 0 ${topPct}%` : 1 }}>
          {s.changes.length > 0 && !q && (
            <div className="commit pending" onClick={() => s.setTab('changes')} title="Go to Changes to commit these">
              <div className="rail"><i /></div>
              <div className="grow">
                <div className="title">Uncommitted changes</div>
                <div className="meta"><span>{s.changes.length} file{s.changes.length === 1 ? '' : 's'} not saved to history yet</span></div>
              </div>
            </div>
          )}
          {shown.map((c, i) => (
            <CommitRow
              key={c.id} c={c} first={i === 0 && s.changes.length === 0} last={i === shown.length - 1} sel={s.selectedCommit === c.id}
              tags={tipByBranch.get(c.id)} isHead={s.branches.find((b) => b.current)?.tip === c.id}
              notPushed={s.sync.hasRemote && unpushed.has(c.id)} onClick={() => void s.selectCommit(c.id)}
            />
          ))}
          {shown.length === 0 && s.changes.length === 0 && (
            <div className="empty"><div className="icon-wrap"><Icon n="history" s={22} /></div><h3>{q ? 'No matching commits' : 'No commits yet'}</h3>{!q && <span>Commit your first changes and they'll appear here.</span>}</div>
          )}
        </div>
        {s.selectedCommit && (
          <>
            <div className="hsplit" role="separator" aria-orientation="horizontal" aria-label="Resize file list" onPointerDown={dragSplit}><i /></div>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="list-head">{s.commitFiles.length} file{s.commitFiles.length === 1 ? '' : 's'} changed</div>
              <div className="files">
                {s.commitFiles.map((c) => {
                  const [dir, name] = splitPath(c.path);
                  return (
                    <div key={c.path} className={`file${s.commitFile === c.path ? ' sel' : ''}`} onClick={() => s.setCommitFile(c.path)}>
                      <KindIcon k={c.kind} />
                      <div className="name" title={c.path}><b className="ellipsis">{name}</b><span>{dir}</span></div>
                      <span className="faint" style={{ fontSize: 11 }}>{c.status === 'deleted' ? '' : fmtBytes(c.size)}</span>
                      <StatusIcon s={c.status} />
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function CommitRow({ c, first, last, sel, tags, isHead, notPushed, onClick }: { c: CommitDTO; first: boolean; last: boolean; sel: boolean; tags?: string[]; isHead: boolean; notPushed: boolean; onClick: () => void }) {
  return (
    <div className={`commit${sel ? ' sel' : ''}${first ? ' first' : ''}${last ? ' last' : ''}${c.parents.length > 1 ? ' merge' : ''}${isHead ? ' head' : ''}`} onClick={onClick}>
      <div className="rail"><i /></div>
      <div className="grow">
        <div className="title ellipsis">{c.summary}</div>
        <div className="meta">
          <Avatar name={c.author.name} />
          <span className="ellipsis">{c.author.name}</span>
          <span>·</span>
          <span>{timeAgo(c.time)}</span>
          {notPushed && <span className="badge blue" title="This commit is only on this computer so far"><Icon n="up" s={10} />Not pushed</span>}
          <span className="mono faint" style={{ marginLeft: 'auto' }}>{c.id.slice(0, 7)}</span>
        </div>
        {tags && <div className="row" style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>{tags.map((t) => <span key={t} className="badge orange"><Icon n="branch" s={10} />{t}</span>)}</div>}
      </div>
    </div>
  );
}

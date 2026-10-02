import { useEffect, useState } from 'react';
import type { FileDiff } from '../../../shared/api';
import { useStore } from '../store';
import { Avatar, Icon, fmtBytes, splitPath, timeAgo } from '../ui';
import { DiffView, FileText, langOf } from './DiffView';
import { AudioView, BinaryView, ImageView, VideoView } from './MediaViews';

const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};

export function Viewer() {
  const s = useStore();
  const inHistory = s.tab === 'history' && !!s.selectedCommit;
  const commit = inHistory ? s.commits.find((c) => c.id === s.selectedCommit) : undefined;
  const headTip = s.branches.find((b) => b.current)?.tip ?? null;
  const path = inHistory ? s.commitFile : s.focusPath;
  const from = inHistory ? (commit?.parents[0] ?? null) : headTip;
  const to = inHistory ? commit?.id : 'working';
  // refetch a working-tree diff when that file's size/status changes
  const sig = !inHistory ? s.changes.find((c) => c.path === path) : undefined;
  const sigKey = sig ? `${sig.status}:${sig.size}` : '';

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'changes' | 'file'>('changes');
  const [split, setSplit] = useState(pref('vd.split', '0') === '1');
  const [whole, setWhole] = useState(false);
  const [fileText, setFileText] = useState<{ text: string; truncated: boolean } | null>(null);

  useEffect(() => {
    let dead = false;
    setView('changes');
    if (!s.repoId || !path || !to) {
      setDiff(null);
      return;
    }
    setLoading(true);
    window.vd.fileDiff(s.repoId, { path, from, to })
      .then((d) => !dead && setDiff(d))
      .catch((e) => !dead && s.toast({ kind: 'error', text: e.message }))
      .finally(() => !dead && setLoading(false));
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.repoId, path, from, to, sigKey]);

  useEffect(() => {
    if (view !== 'file' || !diff || !s.repoId) return;
    let dead = false;
    const rev = diff.status === 'deleted' ? from : to;
    if (!rev) return;
    window.vd.readText(s.repoId, { rev, path: diff.path }).then((t) => !dead && setFileText(t));
    return () => { dead = true; };
  }, [view, diff, s.repoId, from, to]);

  const setSplitPref = (v: boolean) => {
    setSplit(v);
    try { localStorage.setItem('vd.split', v ? '1' : '0'); } catch { /* ignore */ }
  };

  const [dir, name] = path ? splitPath(path) : ['', ''];
  const lang = path ? langOf(path) : undefined;

  return (
    <main className="content">
      {commit && <CommitBar />}
      {path && diff ? (
        <div className="viewer-head">
          <div className="path grow ellipsis" title={path}><span>{dir}</span><b>{name}</b></div>
          <span className={`badge ${diff.status === 'added' ? 'green' : diff.status === 'deleted' ? 'red' : 'orange'}`}>{diff.status}</span>
          <span className="stat">{diff.status === 'added' ? fmtBytes(diff.size) : diff.status === 'deleted' ? fmtBytes(diff.oldSize ?? 0) : `${fmtBytes(diff.oldSize ?? 0)} → ${fmtBytes(diff.size)}`}</span>
          {diff.kind === 'text' && !diff.tooLarge && (
            <>
              <div className="seg">
                <button className={view === 'changes' ? 'on' : ''} onClick={() => setView('changes')}>Changes</button>
                <button className={view === 'file' ? 'on' : ''} onClick={() => setView('file')}>File</button>
              </div>
              {view === 'changes' && (
                <>
                  <div className="seg" title="Diff layout">
                    <button className={!split ? 'on' : ''} onClick={() => setSplitPref(false)} aria-label="Unified"><Icon n="rows" s={13} /></button>
                    <button className={split ? 'on' : ''} onClick={() => setSplitPref(true)} aria-label="Side by side"><Icon n="split" s={13} /></button>
                  </div>
                  <button className="btn sm" onClick={() => setWhole(!whole)}>{whole ? 'Hide unchanged' : 'Whole file'}</button>
                </>
              )}
            </>
          )}
          <FileActions path={path} inHistory={inHistory} commitId={commit?.id} status={diff.status} />
        </div>
      ) : null}

      <div className="viewer-body">
        {!path && <Empty inHistory={inHistory} hasChanges={s.changes.length > 0} />}
        {path && loading && !diff && <div className="empty"><span className="spinner" /></div>}
        {path && diff && <Body d={diff} view={view} split={split} whole={whole} lang={lang} fileText={fileText} />}
      </div>
    </main>
  );
}

function Body({ d, view, split, whole, lang, fileText }: { d: FileDiff; view: 'changes' | 'file'; split: boolean; whole: boolean; lang?: string; fileText: { text: string; truncated: boolean } | null }) {
  if (d.kind === 'image') return <ImageView d={d} />;
  if (d.kind === 'audio') return <AudioView d={d} />;
  if (d.kind === 'video') return <VideoView d={d} />;
  if (d.kind === 'binary') return <BinaryView d={d} />;
  if (d.tooLarge) return <div className="empty"><div className="icon-wrap"><Icon n="file" s={22} /></div><h3>File too large to diff</h3><span>It's still versioned and can be restored.</span></div>;
  if (view === 'file') {
    return fileText
      ? <>{fileText.truncated && <div className="badge orange" style={{ margin: 12 }}>Showing the first 2 MB</div>}<FileText text={fileText.text} lang={lang} /></>
      : <div className="empty"><span className="spinner" /></div>;
  }
  return <DiffView rows={d.rows ?? []} split={split} lang={lang} whole={whole} />;
}

function Empty({ inHistory, hasChanges }: { inHistory: boolean; hasChanges: boolean }) {
  const { sync, doSync, openDialog } = useStore();
  return (
    <div className="empty" style={{ height: '100%' }}>
      <div className="icon-wrap"><Icon n={inHistory ? 'history' : 'check'} s={22} /></div>
      <h3>{inHistory ? 'Select a file to see what changed' : hasChanges ? 'Select a file to review' : 'No local changes'}</h3>
      {!inHistory && !hasChanges && (
        <>
          <span>Changes you make in your project folder show up here as you save them.</span>
          {!sync.hasRemote
            ? <button className="btn primary" onClick={() => openDialog({ t: 'publish' })}><Icon n="cloud" s={15} /> Publish to Google Drive</button>
            : sync.ahead > 0
              ? <button className="btn primary" onClick={() => void doSync('push')}><Icon n="up" s={15} /> Push {sync.ahead} commit{sync.ahead === 1 ? '' : 's'}</button>
              : <button className="btn" onClick={() => void doSync('fetch')}><Icon n="refresh" s={15} /> Fetch from Drive</button>}
        </>
      )}
    </div>
  );
}

function FileActions({ path, inHistory, commitId, status }: { path: string; inHistory: boolean; commitId?: string; status: FileDiff['status'] }) {
  const s = useStore();
  const id = s.repoId!;
  return (
    <>
      {inHistory && commitId && (
        <button className="btn sm" onClick={() => void window.vd.restoreFile(id, { path, commitId }).then(() => { s.toast({ kind: 'ok', text: `Restored ${path} from this version. Review it in Changes.` }); s.setTab('changes'); }).catch((e) => s.toast({ kind: 'error', text: e.message }))}>
          <Icon n="undo" s={13} /> {status === 'added' ? 'Restore' : 'Restore this version'}
        </button>
      )}
      <button className="btn ghost icon sm" title="Reveal in folder" onClick={() => void window.vd.revealInFolder(id, path)}><Icon n="folder" s={14} /></button>
    </>
  );
}

function CommitBar() {
  const s = useStore();
  const c = s.commits.find((x) => x.id === s.selectedCommit)!;
  const id = s.repoId!;
  const [comments, setComments] = useState<{ author: string; text: string; time: number }[]>([]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const canComment = s.sync.hasRemote;
  const isHead = s.branches.find((b) => b.current)?.tip === c.id;

  useEffect(() => {
    setOpen(false);
    setText('');
    if (!canComment) return setComments([]);
    window.vd.comments(id, c.id).then(setComments).catch(() => setComments([]));
  }, [id, c.id, canComment]);

  const revert = () => s.openDialog({
    t: 'confirm', title: 'Revert this commit?', confirmLabel: 'Revert',
    body: `This creates a new commit that undoes “${c.summary}”. Nothing is lost — you can always go back.`,
    run: async () => {
      try {
        await window.vd.revert(id, c.id);
        s.toast({ kind: 'ok', text: 'Reverted. A new commit was added.' });
        await s.refresh();
        s.setTab('changes');
      } catch (e: any) {
        if (e.code === 'conflict') s.openDialog({ t: 'conflict', op: 'revert', ref: c.id, paths: e.paths ?? [] });
        else throw e;
      }
    },
  });

  const reset = () => s.openDialog({
    t: 'confirm', title: 'Reset branch to this commit?', confirmLabel: 'Reset and discard later commits', danger: true,
    body: 'The branch moves back to this commit and your working files are rewritten to match. Later commits stay recoverable only until the next cleanup. Uncommitted changes will be lost.',
    run: async () => { await window.vd.resetTo(id, c.id, true); await s.refresh(); },
  });

  return (
    <div className="commit-bar selectable">
      <h2>{c.summary}</h2>
      {c.description && <div className="desc">{c.description}</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Avatar name={c.author.name} />
        <b>{c.author.name}</b>
        <span className="muted">committed {timeAgo(c.time)}</span>
        <span className="mono badge" title={c.id}>{c.id.slice(0, 10)}</span>
        {c.parents.length > 1 && <span className="badge blue"><Icon n="merge" s={11} /> merge</span>}
        <span className="grow" />
        {canComment && <button className="btn sm" onClick={() => setOpen(!open)}>Comments{comments.length ? ` · ${comments.length}` : ''}</button>}
        <button className="btn sm" onClick={revert}><Icon n="undo" s={13} /> Revert</button>
        <button className="btn sm danger" onClick={reset} disabled={isHead}>Reset here…</button>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comments.map((x, i) => <div key={i} className="row" style={{ alignItems: 'flex-start' }}><Avatar name={x.author} /><div><b>{x.author}</b> <span className="faint">{timeAgo(x.time)}</span><div>{x.text}</div></div></div>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; void window.vd.addComment(id, c.id, text.trim()).then(() => window.vd.comments(id, c.id)).then((l) => { setComments(l); setText(''); }); }}>
            <input className="field" placeholder="Add a comment for your team" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn primary" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}


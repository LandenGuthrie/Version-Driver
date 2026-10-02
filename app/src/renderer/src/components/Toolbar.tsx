import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Avatar, Icon, Popover } from '../ui';

export function Toolbar() {
  const s = useStore();
  const repo = s.repos.find((r) => r.id === s.repoId);

  return (
    <header className="titlebar">
      <Popover
        trigger={(open, toggle) => (
          <button className="btn" onClick={toggle} aria-expanded={open} style={{ minWidth: 150, justifyContent: 'space-between' }}>
            <span className="row"><Icon n="folder" s={15} /><b className="ellipsis" style={{ maxWidth: 160 }}>{repo?.name ?? 'Select repository'}</b></span>
            <Icon n="chevron" s={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu-head">Repositories</div>
            {s.repos.map((r) => (
              <button key={r.id} className="menu-item" onClick={() => { close(); void s.selectRepo(r.id); }}>
                <Icon n={r.remote?.kind === 'drive' ? 'cloud' : 'folder'} s={15} />
                <span className="grow ellipsis">{r.name}</span>
                {r.id === s.repoId && <Icon n="check" s={14} />}
              </button>
            ))}
            {s.repos.length === 0 && <div className="muted" style={{ padding: '6px 9px' }}>No repositories yet</div>}
            <div className="menu-sep" />
            {repo && <button className="menu-item" onClick={() => { close(); s.openDialog({ t: 'ignore' }); }}><Icon n="eye" s={15} />Ignore files…</button>}
            {repo && <button className="menu-item danger" onClick={() => { close(); s.openDialog({ t: 'removeRepo' }); }}><Icon n="trash" s={15} />Remove “{repo.name}”…</button>}
            <button className="menu-item" onClick={() => { close(); s.openDialog({ t: 'newRepo' }); }}><Icon n="plus" s={15} />New repository…</button>
            <button className="menu-item" onClick={() => { close(); s.openDialog({ t: 'clone' }); }}><Icon n="download" s={15} />Clone or join…</button>
          </>
        )}
      </Popover>

      {repo && <BranchMenu />}

      <div className="spacer" />

      {repo && s.online.length > 0 && (
        <div className="avatars" title={`${s.online.map((o) => o.name).join(', ')} online`}>
          {s.online.slice(0, 4).map((o) => <Avatar key={o.id} name={o.name} online />)}
        </div>
      )}
      {repo && (
        <button className="btn" onClick={() => (repo.remote ? s.openDialog({ t: 'share' }) : s.openDialog({ t: 'publish' }))}>
          <Icon n="users" s={15} /> Share
        </button>
      )}
      {repo && <SyncButton />}
      <AccountMenu />
    </header>
  );
}

function BranchMenu() {
  const s = useStore();
  const [q, setQ] = useState('');
  const current = s.branches.find((b) => b.current);
  const list = useMemo(() => s.branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())), [s.branches, q]);
  const repoId = s.repoId!;

  return (
    <Popover
      trigger={(open, toggle) => (
        <button className="btn" onClick={toggle} aria-expanded={open} style={{ minWidth: 130, justifyContent: 'space-between' }}>
          <span className="row"><Icon n="branch" s={15} /><span className="ellipsis" style={{ maxWidth: 140 }}>{current?.name ?? s.sync.branch ?? 'main'}</span></span>
          <Icon n="chevron" s={14} />
        </button>
      )}
      width={280}
    >
      {(close) => (
        <>
          <input className="field" placeholder="Filter branches" value={q} onChange={(e) => setQ(e.target.value)} autoFocus style={{ marginBottom: 5 }} />
          {list.map((b) => (
            <div key={b.name} className="row">
              <button className="menu-item grow" onClick={() => { close(); if (!b.current) void s.checkout(b.name); }}>
                <Icon n="branch" s={15} />
                <span className="grow ellipsis">{b.name}</span>
                {!b.remoteTip && <span className="badge">local</span>}
                {b.current && <Icon n="check" s={14} />}
              </button>
              {!b.current && (
                <Popover align="right" trigger={(_o, t) => <button className="btn ghost icon sm" onClick={t} aria-label={`Actions for ${b.name}`}><Icon n="more" s={14} /></button>}>
                  {(c2) => (
                    <>
                      <button className="menu-item" onClick={() => { c2(); close(); void mergeInto(repoId, b.name); }}><Icon n="merge" s={15} />Merge into {current?.name}</button>
                      <button className="menu-item danger" disabled={!!b.remoteTip && !s.branches.some((x) => x.name === b.name && !x.remoteTip)} onClick={() => { c2(); close(); void window.vd.deleteBranch(repoId, b.name).then(() => s.refresh()).catch((e) => s.toast({ kind: 'error', text: e.message })); }}><Icon n="trash" s={15} />Delete local branch</button>
                    </>
                  )}
                </Popover>
              )}
            </div>
          ))}
          {list.length === 0 && <div className="muted" style={{ padding: '6px 9px' }}>No matching branches</div>}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { close(); s.openDialog({ t: 'newBranch' }); }}><Icon n="plus" s={15} />New branch…</button>
        </>
      )}
    </Popover>
  );
}

async function mergeInto(repoId: string, ref: string) {
  const s = useStore.getState();
  try {
    const r = await window.vd.merge(repoId, ref);
    s.toast({ kind: 'ok', text: r.kind === 'up-to-date' ? 'Already up to date' : `Merged ${ref}` });
    await s.refresh();
  } catch (e: any) {
    if (e.code === 'conflict') s.openDialog({ t: 'conflict', op: 'merge', ref, paths: e.paths ?? [] });
    else s.toast({ kind: 'error', text: e.message });
  }
}

function SyncButton() {
  const { sync, busy, doSync, openDialog, progress } = useStore();
  if (!sync.hasRemote) {
    return <button className="btn primary" onClick={() => openDialog({ t: 'publish' })}><Icon n="cloud" s={15} /> Publish to Drive</button>;
  }
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  if (busy) {
    return (
      <button className="btn" disabled>
        <span className="spinner" /> {busy}{pct !== null ? ` ${pct}%` : '…'}
      </button>
    );
  }
  if (sync.ahead > 0 && sync.behind === 0) {
    return <button className="btn primary" onClick={() => void doSync('push')}><Icon n="up" s={15} /> Push {sync.ahead}</button>;
  }
  if (sync.behind > 0) {
    return (
      <button className="btn primary" onClick={() => void doSync('pull')}>
        <Icon n="down" s={15} /> Pull {sync.behind}{sync.ahead > 0 ? ` · ${sync.ahead} to push` : ''}
      </button>
    );
  }
  return <button className="btn" onClick={() => void doSync('fetch')}><Icon n="refresh" s={15} /> Fetch</button>;
}

function AccountMenu() {
  const { profile, signOut, openDialog, repoId } = useStore();
  if (!profile) return null;
  return (
    <Popover
      align="right"
      width={250}
      trigger={(_o, toggle) => (
        <button className="btn ghost icon" onClick={toggle} aria-label="Account" style={{ width: 34 }}>
          <Avatar name={profile.name} src={profile.picture} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div style={{ padding: '8px 9px 6px' }}>
            <div style={{ fontWeight: 600 }}>{profile.name}</div>
            <div className="muted ellipsis">{profile.email || (profile.mode === 'local' ? 'Local profile' : '')}</div>
            <span className={`badge ${profile.mode === 'google' ? 'green' : ''}`} style={{ marginTop: 6 }}>
              {profile.mode === 'google' ? 'Google Drive connected' : 'Local only'}
            </span>
          </div>
          <div className="menu-sep" />
          {repoId && <button className="menu-item" onClick={() => { close(); openDialog({ t: 'storage' }); }}><Icon n="disk" s={15} />Storage & compression</button>}
          <button className="menu-item" onClick={() => { close(); openDialog({ t: 'settings' }); }}><Icon n="settings" s={15} />Appearance</button>
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => { close(); void signOut(); }}><Icon n="logout" s={15} />Sign out</button>
        </>
      )}
    </Popover>
  );
}


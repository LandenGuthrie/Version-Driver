import { useEffect, useState } from 'react';
import type { MemberDTO, Role, StorageStats } from '../../../shared/api';
import { useStore } from '../store';
import { Avatar, Icon, Modal, fmtBytes } from '../ui';
import { DEFAULT_THEME, PRESETS, loadWallpaper } from '../theme';

export function Dialogs() {
  const d = useStore((s) => s.dialog);
  const close = () => useStore.getState().openDialog(null);
  if (!d) return null;
  switch (d.t) {
    case 'newRepo': return <NewRepo onClose={close} />;
    case 'clone': return <Clone onClose={close} link={d.link} />;
    case 'share': return <Share onClose={close} />;
    case 'storage': return <Storage onClose={close} />;
    case 'publish': return <Publish onClose={close} />;
    case 'newBranch': return <NewBranch onClose={close} />;
    case 'settings': return <Settings onClose={close} />;
    case 'conflict': return <Conflict onClose={close} {...d} />;
    case 'confirm': return <Confirm onClose={close} {...d} />;
  }
}

function Confirm({ title, body, confirmLabel, danger, run, onClose }: { title: string; body: string; confirmLabel: string; danger?: boolean; run: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => {
          setBusy(true);
          try { await run(); onClose(); } catch (e: any) { toast({ kind: 'error', text: e.message }); setBusy(false); }
        }}>{busy ? <span className="spinner" /> : null}{confirmLabel}</button>
      </>
    }>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>{body}</p>
    </Modal>
  );
}

function slug(n: string) {
  return n.trim().replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ');
}

function NewRepo({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [level, setLevel] = useState<'fast' | 'balanced' | 'max'>('balanced');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [busy, setBusy] = useState(false);
  const dir = mode === 'new' ? (parent ? `${parent.replace(/[\\/]$/, '')}${parent.includes('\\') ? '\\' : '/'}${slug(name)}` : '') : parent;
  const fname = mode === 'existing' ? parent.split(/[\\/]/).filter(Boolean).pop() ?? '' : name;

  return (
    <Modal title="New repository" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !dir || !(mode === 'existing' || name.trim())} onClick={async () => {
          setBusy(true);
          const r = await s.guard(null, () => window.vd.createRepo({ dir, name: mode === 'existing' ? fname : name.trim(), level }));
          if (r) { await s.reloadRepos(); await s.selectRepo(r.id); onClose(); } else setBusy(false);
        }}>Create repository</button>
      </>
    }>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>New folder</button>
        <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>Existing folder</button>
      </div>
      {mode === 'new' && (
        <div><label className="label">Name</label><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="My project" autoFocus /></div>
      )}
      <div>
        <label className="label">{mode === 'new' ? 'Create in' : 'Folder'}</label>
        <div className="row">
          <input className="field" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Choose a folder…" />
          <button className="btn" onClick={async () => { const p = await window.vd.pickFolder(); if (p) setParent(p); }}>Browse</button>
        </div>
        {mode === 'new' && dir && <div className="faint mono" style={{ marginTop: 6, fontSize: 11.5 }}>{dir}</div>}
      </div>
      <div>
        <label className="label">Compression</label>
        <div className="seg">
          {(['fast', 'balanced', 'max'] as const).map((l) => <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>{l[0]!.toUpperCase() + l.slice(1)}</button>)}
        </div>
        <div className="faint" style={{ marginTop: 6 }}>{{ fast: 'Quickest commits, larger repository.', balanced: 'Good size savings with quick commits.', max: 'Smallest possible. Best when Drive space is tight.' }[level]}</div>
      </div>
      <div className="row muted"><Icon n="shield" s={15} /> Everything is encrypted on this device before it's stored.</div>
    </Modal>
  );
}

function parseLink(link: string): string | null {
  const m = /^versiondriver:\/\/join\/([\w-]+)/i.exec(link.trim());
  return m ? m[1]! : /^[\w-]{20,}$/.test(link.trim()) ? link.trim() : null;
}

function Clone({ onClose, link: initial }: { onClose: () => void; link?: string }) {
  const s = useStore();
  const [tab, setTab] = useState<'link' | 'drive' | 'folder' | 'existing'>(initial ? 'link' : 'drive');
  const [link, setLink] = useState(initial ?? '');
  const [dirParent, setDirParent] = useState('');
  const [name, setName] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [list, setList] = useState<{ folderId: string; name: string }[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const google = s.profile?.mode === 'google';

  useEffect(() => {
    if (tab === 'drive' && google && list === null) window.vd.listDriveRepos().then(setList).catch(() => setList([]));
  }, [tab, google, list]);

  const target = (n: string) => (dirParent ? `${dirParent.replace(/[\\/]$/, '')}${dirParent.includes('\\') ? '\\' : '/'}${slug(n)}` : '');
  const folderId = tab === 'link' ? parseLink(link) : pick;
  const repoName = tab === 'drive' ? (list?.find((l) => l.folderId === pick)?.name ?? name) : name;

  const go = async () => {
    setBusy(true);
    setPending(false);
    try {
      let r;
      if (tab === 'existing') r = await window.vd.addExisting(dirParent);
      else if (tab === 'folder') r = await window.vd.cloneFromFolder({ path: remotePath, dir: target(name || remotePath.split(/[\\/]/).pop() || 'repository') });
      else r = await window.vd.cloneFromDrive({ folderId: folderId!, dir: target(repoName || 'repository') });
      await s.reloadRepos();
      await s.selectRepo(r.id);
      onClose();
    } catch (e: any) {
      if (e.code === 'pending') setPending(true);
      else s.toast({ kind: 'error', text: e.message });
      setBusy(false);
    }
  };

  const ready = tab === 'existing' ? !!dirParent : tab === 'folder' ? !!remotePath && !!dirParent : !!folderId && !!dirParent;

  return (
    <Modal title="Clone or join a repository" onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ready || busy} onClick={go}>{busy && <span className="spinner" />}{tab === 'existing' ? 'Add repository' : 'Clone'}</button>
      </>
    }>
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        <button className={tab === 'drive' ? 'on' : ''} onClick={() => setTab('drive')}>My Drive</button>
        <button className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>Invite link</button>
        <button className={tab === 'folder' ? 'on' : ''} onClick={() => setTab('folder')}>Folder</button>
        <button className={tab === 'existing' ? 'on' : ''} onClick={() => setTab('existing')}>On this computer</button>
      </div>

      {tab === 'drive' && (!google ? <div className="muted">Sign in with Google to see repositories in your Drive.</div> : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 190, overflow: 'auto' }}>
          {list === null && <div className="row" style={{ padding: 12 }}><span className="spinner" /> Looking in your Drive…</div>}
          {list?.length === 0 && <div className="muted" style={{ padding: 12 }}>No repositories found. If a teammate invited you, use the Invite link tab.</div>}
          {list?.map((l) => (
            <div key={l.folderId} className={`file${pick === l.folderId ? ' sel' : ''}`} onClick={() => { setPick(l.folderId); setName(l.name); }}>
              <Icon n="cloud" s={15} /><b className="grow">{l.name}</b>{pick === l.folderId && <Icon n="check" s={14} />}
            </div>
          ))}
        </div>
      ))}

      {tab === 'link' && (
        <div>
          <label className="label">Invite link or folder id</label>
          <input className="field mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="versiondriver://join/…" autoFocus />
          <div className="faint" style={{ marginTop: 6 }}>Your teammate can copy this from the Share dialog. After you join, an admin has to approve you before you can read anything.</div>
          <label className="label" style={{ marginTop: 12 }}>Name this repository locally</label>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
        </div>
      )}

      {tab === 'folder' && (
        <div>
          <label className="label">Remote folder (for example a synced Drive for Desktop folder)</label>
          <div className="row"><input className="field" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} /><button className="btn" onClick={async () => { const p = await window.vd.pickFolder(); if (p) setRemotePath(p); }}>Browse</button></div>
        </div>
      )}

      <div>
        <label className="label">{tab === 'existing' ? 'Project folder' : 'Clone into'}</label>
        <div className="row"><input className="field" value={dirParent} onChange={(e) => setDirParent(e.target.value)} placeholder="Choose a folder…" /><button className="btn" onClick={async () => { const p = await window.vd.pickFolder(); if (p) setDirParent(p); }}>Browse</button></div>
        {tab !== 'existing' && dirParent && <div className="faint mono" style={{ marginTop: 6, fontSize: 11.5 }}>{target(repoName || 'repository')}</div>}
      </div>

      {pending && (
        <div className="badge orange" style={{ whiteSpace: 'normal', padding: '10px 12px', borderRadius: 10, display: 'block', lineHeight: 1.5 }}>
          <b>Access requested.</b> An admin needs to approve you in the Share dialog. Press Clone again once they have. Your safety code is shown to them so they can verify it's you.
        </div>
      )}
    </Modal>
  );
}

function Publish({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const repo = s.repos.find((r) => r.id === s.repoId)!;
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState('');
  const google = s.profile?.mode === 'google';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    const ok = await s.guard(null, fn);
    if (ok !== undefined) { await s.reloadRepos(); await s.refresh(); onClose(); } else setBusy(false);
  };

  return (
    <Modal title="Publish repository" onClose={onClose}>
      <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
        Publishing creates a private <b>Version Driver / {repo.name}</b> folder in your Google Drive. Your files are compressed and encrypted here first; Google only ever stores unreadable data.
      </p>
      <button className="btn primary block" disabled={busy || !google} onClick={() => void run(() => window.vd.publishToDrive(repo.id))}>
        {busy ? <span className="spinner" /> : <Icon n="cloud" s={15} />} Publish to Google Drive
      </button>
      {!google && <div className="faint">You're in local mode. Sign out and sign in with Google to publish to Drive.</div>}
      <div className="menu-sep" />
      <div>
        <label className="label">Or use any folder as the remote (USB drive, network share, Drive for Desktop…)</label>
        <div className="row">
          <input className="field" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Choose a folder…" />
          <button className="btn" onClick={async () => { const p = await window.vd.pickFolder(); if (p) setFolder(p); }}>Browse</button>
          <button className="btn" disabled={!folder || busy} onClick={() => void run(() => window.vd.setRemoteFolder(repo.id, folder))}>Use</button>
        </div>
      </div>
    </Modal>
  );
}

function NewBranch({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [name, setName] = useState('');
  const current = s.branches.find((b) => b.current)?.name;
  const valid = /^[\w][\w./-]*$/.test(name) && !s.branches.some((b) => b.name === name);
  return (
    <Modal title="New branch" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!valid} onClick={async () => {
          const ok = await s.guard(null, async () => { await window.vd.createBranch(s.repoId!, name); await window.vd.checkout(s.repoId!, name); return true; });
          if (ok) { await s.refresh(); onClose(); }
        }}>Create branch</button>
      </>
    }>
      <div><label className="label">Branch name</label><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/new-idea" autoFocus onKeyDown={(e) => e.key === 'Enter' && valid && (e.currentTarget.closest('.modal')?.querySelector('.btn.primary') as HTMLElement)?.click()} /></div>
      <div className="muted">Starts from <b>{current}</b>.</div>
    </Modal>
  );
}

function Storage({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [st, setSt] = useState<StorageStats | null>(null);
  useEffect(() => { window.vd.storage(s.repoId!).then(setSt); }, [s.repoId]);
  const ratio = st && st.logicalBytes > 0 ? st.storedBytes / st.logicalBytes : 0;
  return (
    <Modal title="Storage & compression" onClose={onClose}>
      {!st ? <span className="spinner" /> : (
        <>
          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}><span className="muted">Your files (latest version)</span><b>{fmtBytes(st.logicalBytes)}</b></div>
            <div className="bar"><i style={{ width: '100%', background: 'var(--border-strong)' }} /></div>
          </div>
          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}><span className="muted">Stored, including all {st.commits} versions</span><b>{fmtBytes(st.storedBytes)}</b></div>
            <div className="bar green"><i style={{ width: `${Math.min(100, ratio * 100)}%` }} /></div>
          </div>
          <div className="row">
            {st.logicalBytes > 0 && <span className={`badge ${ratio <= 1 ? 'green' : 'orange'}`}>{ratio <= 1 ? `${Math.round((1 - ratio) * 100)}% smaller than the originals` : `${ratio.toFixed(1)}× the latest files (full history included)`}</span>}
            <span className="badge">{st.objects.toLocaleString()} objects</span>
          </div>
          <div>
            <label className="label">Compression level</label>
            <div className="seg">
              {(['fast', 'balanced', 'max'] as const).map((l) => (
                <button key={l} className={st.level === l ? 'on' : ''} onClick={async () => { await window.vd.setCompression(s.repoId!, l); setSt({ ...st, level: l }); }}>{l[0]!.toUpperCase() + l.slice(1)}</button>
              ))}
            </div>
            <div className="faint" style={{ marginTop: 6 }}>Applies to new commits. Already-compressed files (MP3, MP4, JPEG, ZIP) are stored as they are.</div>
          </div>
        </>
      )}
    </Modal>
  );
}

const ROLES: Role[] = ['admin', 'editor', 'viewer'];

function Share({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const repo = s.repos.find((r) => r.id === s.repoId)!;
  const [members, setMembers] = useState<MemberDTO[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [err, setErr] = useState('');
  const link = repo.remote?.folderId ? `versiondriver://join/${repo.remote.folderId}` : null;
  const me = members?.find((m) => m.me);
  const manage = me?.role === 'owner' || me?.role === 'admin';

  const load = () => window.vd.members(repo.id).then(setMembers).catch((e) => setErr(e.message));
  useEffect(() => { void load(); const off = window.vd.on('members:changed', () => void load()); return off; }, [repo.id]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); } catch (e: any) { s.toast({ kind: 'error', text: e.message }); }
  };

  const pending = members?.filter((m) => m.status === 'pending') ?? [];
  const active = members?.filter((m) => m.status === 'active') ?? [];

  return (
    <Modal title={`Share “${repo.name}”`} onClose={onClose} wide>
      {err && <div className="badge red" style={{ padding: 8 }}>{err}</div>}
      {!members && !err && <span className="spinner" />}

      {pending.length > 0 && manage && (
        <div>
          <div className="menu-head" style={{ padding: 0, marginBottom: 6 }}>Waiting for approval</div>
          {pending.map((m) => (
            <div key={m.id} className="member" style={{ alignItems: 'flex-start' }}>
              <Avatar name={m.name} lg />
              <div className="grow">
                <b>{m.name}</b> <span className="muted">{m.email}</span>
                <div className="faint" style={{ margin: '4px 0 6px' }}>Ask them to read this code to you before approving, so you know it's really them:</div>
                <span className="safety">{m.safety}</span>
              </div>
              <button className="btn primary sm" onClick={() => void act(() => window.vd.approveMember(repo.id, m.id, 'editor'))}>Approve</button>
              <button className="btn sm" onClick={() => void act(() => window.vd.removeMember(repo.id, m.id))}>Decline</button>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="menu-head" style={{ padding: 0, marginBottom: 6 }}>People with access</div>
        {active.map((m) => (
          <div key={m.id} className="member">
            <Avatar name={m.name} online={m.online} lg />
            <div className="grow"><b>{m.name}</b>{m.me && <span className="faint"> (you)</span>}<div className="muted">{m.email}</div></div>
            {m.role === 'owner' || !manage || m.me
              ? <span className="badge">{m.role}</span>
              : <select className="select" value={m.role} onChange={(e) => void act(() => window.vd.setMemberRole(repo.id, m.id, e.target.value as Role))}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>}
            {manage && m.role !== 'owner' && !m.me && (
              <button className="btn ghost icon sm" title="Remove and rotate the encryption key" onClick={() => s.openDialog({
                t: 'confirm', title: `Remove ${m.name}?`, confirmLabel: 'Remove', danger: true,
                body: 'They lose access to new versions and the encryption key is rotated. Anything they already downloaded stays on their device — that can’t be undone.',
                run: async () => { await window.vd.removeMember(repo.id, m.id); },
              })}><Icon n="x" s={14} /></button>
            )}
          </div>
        ))}
      </div>

      {manage && (
        <div>
          <div className="menu-head" style={{ padding: 0, marginBottom: 6 }}>Invite someone</div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (email.includes('@')) void act(async () => { await window.vd.inviteByEmail(repo.id, email.trim(), role); setEmail(''); s.toast({ kind: 'ok', text: `Invited ${email.trim()}. Send them the link below.` }); }); }}>
            <input className="field" placeholder="teammate@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="select" style={{ height: 32 }} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
            <button className="btn primary" disabled={!email.includes('@')}>Invite</button>
          </form>
        </div>
      )}

      {link && (
        <div>
          <label className="label">Invite link</label>
          <div className="row">
            <input className="field mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void navigator.clipboard.writeText(link).then(() => s.toast({ kind: 'ok', text: 'Link copied' }))}><Icon n="copy" s={14} /> Copy</button>
          </div>
          <div className="faint" style={{ marginTop: 6 }}>The link only points to the folder. Nobody can read your files without being approved by an admin.</div>
        </div>
      )}
      {repo.remote?.kind === 'fs' && <div className="muted">This repository uses a folder remote. Share that folder with teammates, then they can join using the Folder tab.</div>}
    </Modal>
  );
}

function Conflict({ op, ref, paths, onClose }: { op: 'merge' | 'revert'; ref: string; paths: string[]; onClose: () => void }) {
  const s = useStore();
  const keep = op === 'merge' ? 'ours' : 'keep';
  const take = op === 'merge' ? 'theirs' : 'revert';
  const [choice, setChoice] = useState<Record<string, string>>(() => Object.fromEntries(paths.map((p) => [p, keep])));
  const [busy, setBusy] = useState(false);
  const labels = op === 'merge' ? ['Keep mine', 'Take theirs'] : ['Keep current', 'Revert it'];
  return (
    <Modal title={op === 'merge' ? 'Resolve conflicts' : 'Revert conflicts'} onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            if (op === 'merge') await window.vd.merge(s.repoId!, ref === 'origin' ? (s.sync.branch ? `origin/${s.sync.branch}` : ref) : ref, choice as Record<string, 'ours' | 'theirs'>);
            else await window.vd.revert(s.repoId!, ref, choice as Record<string, 'keep' | 'revert'>);
            await s.refresh();
            onClose();
          } catch (e: any) { s.toast({ kind: 'error', text: e.message }); setBusy(false); }
        }}>{op === 'merge' ? 'Complete merge' : 'Complete revert'}</button>
      </>
    }>
      <p className="muted" style={{ margin: 0 }}>{op === 'merge' ? 'These files changed on both sides. Choose which version to keep for each.' : 'These files were changed after that commit. Choose what to do for each.'}</p>
      {paths.map((p) => (
        <div key={p} className="row" style={{ justifyContent: 'space-between' }}>
          <span className="mono ellipsis" title={p}>{p}</span>
          <div className="seg">
            <button className={choice[p] === keep ? 'on' : ''} onClick={() => setChoice({ ...choice, [p]: keep })}>{labels[0]}</button>
            <button className={choice[p] === take ? 'on' : ''} onClick={() => setChoice({ ...choice, [p]: take })}>{labels[1]}</button>
          </div>
        </div>
      ))}
    </Modal>
  );
}

// ---- appearance -------------------------------------------------------------------------------

function ColorRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontWeight: 550 }}>{label}</div>
        {hint && <div className="faint" style={{ fontSize: 12 }}>{hint}</div>}
      </div>
      <div className="row">
        <input
          className="field mono" style={{ width: 92, height: 28 }} value={text} spellCheck={false}
          onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase()); }}
          onBlur={() => setText(value)}
        />
        <input type="color" className="swatch" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} color`} />
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span style={{ fontWeight: 550 }}>{label}</span>
      <div className="row"><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} style={{ width: 160 }} /><span className="mono muted" style={{ width: 48, textAlign: 'right' }}>{format(value)}</span></div>
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, toast } = useStore();
  const custom = (patch: Partial<typeof theme>) => setTheme({ ...patch, preset: 'Custom' });

  return (
    <Modal title="Appearance" onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={() => setTheme({ ...DEFAULT_THEME })}>Reset to default</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </>
    }>
      <div>
        <div className="menu-head" style={{ padding: 0, marginBottom: 8 }}>Presets</div>
        <div className="presets">
          {Object.entries(PRESETS).map(([name, p]) => (
            <button key={name} className={`preset${theme.preset === name ? ' on' : ''}`} onClick={() => setTheme({ ...p, preset: name })} aria-pressed={theme.preset === name}>
              <span className="preview" style={{ background: p.bg, borderColor: p.text + '33' }}>
                <i style={{ background: p.surface }} />
                <b style={{ background: p.accent }} />
              </span>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="menu-head" style={{ padding: 0 }}>Colors</div>
        <ColorRow label="Background" hint="The main canvas" value={theme.bg} onChange={(bg) => custom({ bg })} />
        <ColorRow label="Secondary" hint="Sidebar, panels and dialogs" value={theme.surface} onChange={(surface) => custom({ surface })} />
        <ColorRow label="Accent" hint="Buttons, selection and highlights" value={theme.accent} onChange={(accent) => custom({ accent })} />
        <ColorRow label="Text" value={theme.text} onChange={(text) => custom({ text })} />
        <ColorRow label="Added" hint="New lines and files" value={theme.added} onChange={(added) => custom({ added })} />
        <ColorRow label="Removed" hint="Deleted lines and files" value={theme.removed} onChange={(removed) => custom({ removed })} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="menu-head" style={{ padding: 0 }}>Background style</div>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          {(['solid', 'gradient', 'image'] as const).map((b) => <button key={b} className={theme.background === b ? 'on' : ''} onClick={() => setTheme({ background: b })}>{b[0]!.toUpperCase() + b.slice(1)}</button>)}
        </div>
        {theme.background === 'solid' && <div className="faint">A flat color. Change it with Background above.</div>}
        {theme.background === 'gradient' && <div className="faint">A soft glow of your accent color over the background.</div>}
        {theme.background === 'image' && (
          <>
            <div className="row">
              <label className="btn" style={{ cursor: 'pointer' }}>
                <Icon n="image" s={15} /> {theme.image ? 'Change image' : 'Choose image'}
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try { setTheme({ image: await loadWallpaper(f), preset: 'Custom' }); } catch (err: any) { toast({ kind: 'error', text: err.message }); }
                }} />
              </label>
              {theme.image && <button className="btn ghost" onClick={() => setTheme({ image: undefined })}>Remove</button>}
            </div>
            <Slider label="Dim image" value={theme.imageDim} min={0} max={90} step={1} onChange={(imageDim) => setTheme({ imageDim })} format={(v) => `${v}%`} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="menu-head" style={{ padding: 0 }}>Interface</div>
        <Slider label="Interface size" value={theme.scale} min={0.85} max={1.25} step={0.05} onChange={(scale) => setTheme({ scale })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Code size" value={theme.codeSize} min={11} max={17} step={0.5} onChange={(codeSize) => setTheme({ codeSize })} format={(v) => `${v}px`} />
      </div>
    </Modal>
  );
}

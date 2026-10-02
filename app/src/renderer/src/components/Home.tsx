import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon, Logo } from '../ui';

/** The main menu: start something new, or open one of your projects. */
export function Home() {
  const { repos, profile, openDialog, selectRepo } = useStore();
  const first = profile?.name.split(' ')[0] ?? '';
  const [library, setLibrary] = useState<{ folderId: string; name: string }[] | null>(null);

  // Repositories saved in the "Version Driver" folder of this Google Drive, found by looking in it
  useEffect(() => {
    if (profile?.mode !== 'google') return;
    let dead = false;
    window.vd.listDriveRepos().then((l) => !dead && setLibrary(l)).catch(() => !dead && setLibrary([]));
    return () => { dead = true; };
  }, [profile?.mode, repos.length]);
  const here = new Set(repos.map((r) => r.remote?.folderId));
  const elsewhere = (library ?? []).filter((l) => !here.has(l.folderId));

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <div className="logo"><Logo /></div>
          <h1>{repos.length ? `Welcome back, ${first}` : `Welcome, ${first}`}</h1>
          <p className="muted">{repos.length ? 'Open a project, or start another.' : 'Create your first repository, join a teammate’s, or add a folder you already have.'}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => openDialog({ t: 'newRepo' })}><Icon n="plus" s={15} /> Create repository</button>
            <button className="btn" onClick={() => openDialog({ t: 'clone' })}><Icon n="download" s={15} /> Clone or join</button>
          </div>
        </div>

        {repos.length > 0 && (
          <div className="home-list">
            <div className="menu-head" style={{ padding: '0 4px 8px' }}>Your repositories</div>
            {repos.map((r) => (
              <button key={r.id} className="home-card" onClick={() => void selectRepo(r.id)}>
                <span className="home-icon"><Icon n={r.remote?.kind === 'drive' ? 'cloud' : 'folder'} s={18} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b className="ellipsis" style={{ display: 'block' }}>{r.name}</b>
                  <span className="faint mono ellipsis" style={{ display: 'block', fontSize: 11.5 }}>{r.dir}</span>
                </span>
                {r.remote?.kind === 'drive' && <span className="badge green">Drive</span>}
                {r.remote?.kind === 'fs' && <span className="badge">Folder remote</span>}
                {!r.remote && <span className="badge">Local only</span>}
                <Icon n="chevron" s={14} className="faint" style={{ transform: 'rotate(-90deg)' }} />
              </button>
            ))}
          </div>
        )}

        {elsewhere.length > 0 && (
          <div className="home-list">
            <div className="menu-head" style={{ padding: '0 4px 8px' }}>In your Google Drive</div>
            {elsewhere.map((l) => (
              <div key={l.folderId} className="home-card" style={{ cursor: 'default' }}>
                <span className="home-icon"><Icon n="cloud" s={18} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b className="ellipsis" style={{ display: 'block' }}>{l.name}</b>
                  <span className="faint" style={{ fontSize: 12 }}>Saved in your Drive, not on this computer yet</span>
                </span>
                <button className="btn sm" onClick={() => openDialog({ t: 'clone', folderId: l.folderId, name: l.name })}><Icon n="download" s={14} /> Clone here</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

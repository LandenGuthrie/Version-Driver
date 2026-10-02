import { useEffect } from 'react';
import { useStore } from './store';
import { Icon, Logo } from './ui';
import { Welcome } from './components/Welcome';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Viewer } from './components/Viewer';
import { Dialogs } from './components/Dialogs';

export function App() {
  const { ready, profile, repoId, repos, boot, toasts, dismissToast, progress, openDialog, busy } = useStore();
  useEffect(() => void boot(), [boot]);

  if (!ready) return <div className="welcome"><div className="logo"><Logo s={30} /></div></div>;
  if (!profile) return <Welcome />;

  const noRepo = !repoId;
  return (
    <div className="app">
      {progress && progress.total > 0 && <div className="progressbar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
      <Toolbar />
      {noRepo ? (
        <div className="empty" style={{ margin: 'auto' }}>
          <div className="logo" style={{ marginBottom: 6 }}><Logo s={28} /></div>
          <h3 style={{ fontSize: 20 }}>{repos.length ? 'Choose a repository' : `Welcome, ${profile.name.split(' ')[0]}`}</h3>
          <span>{repos.length ? 'Pick one from the menu above, or start another.' : 'Create your first repository, join a teammate’s, or add a folder you already have.'}</span>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => openDialog({ t: 'newRepo' })}><Icon n="plus" s={15} /> Create repository</button>
            <button className="btn" onClick={() => openDialog({ t: 'clone' })}><Icon n="download" s={15} /> Clone or join</button>
          </div>
        </div>
      ) : (
        <div className="main">
          <Sidebar />
          <Viewer />
        </div>
      )}
      <Dialogs />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="bar" />
            <span className="grow">{t.text}</span>
            {t.action && <button className="btn sm" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
            <button className="btn ghost icon sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon n="x" s={13} /></button>
          </div>
        ))}
      </div>
      {busy && !progress && <div className="progressbar"><i style={{ width: '35%', animation: 'none' }} /></div>}
    </div>
  );
}

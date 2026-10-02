import { useEffect } from 'react';
import { useStore } from './store';
import { Icon, Logo } from './ui';
import { Welcome } from './components/Welcome';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Viewer } from './components/Viewer';
import { Dialogs } from './components/Dialogs';
import { Home } from './components/Home';
import { Resizer } from './components/Resizer';

export function App() {
  const { ready, profile, repoId, boot, toasts, dismissToast, progress, busy, sidebarWidth } = useStore();
  useEffect(() => void boot(), [boot]);

  if (!ready) return <div className="welcome"><div className="logo"><Logo s={30} /></div></div>;
  if (!profile) return <Welcome />;

  const noRepo = !repoId;
  return (
    <div className="app">
      {progress && progress.total > 0 && <div className="progressbar"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
      <Toolbar />
      {noRepo ? (
        <Home />
      ) : (
        <div className="main" style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}>
          <Sidebar />
          <Resizer />
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

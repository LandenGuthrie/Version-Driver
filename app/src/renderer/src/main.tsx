import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useStore } from './store';

async function start() {
  // In a plain browser (UI development) there's no Electron bridge, so use the mock.
  if (!window.vd) {
    const { installMock } = await import('./mock');
    installMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary onHome={() => void useStore.getState().selectRepo(null)}>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void start();

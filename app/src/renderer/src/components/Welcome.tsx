import { useState } from 'react';
import { useStore } from '../store';
import { GoogleG, Icon, Logo } from '../ui';

type Phase = 'idle' | 'waiting' | 'error';

export function Welcome() {
  const { googleConfigured, signIn } = useStore();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  const start = async () => {
    setPhase('waiting');
    setError('');
    try {
      await signIn();
    } catch (e: any) {
      setPhase(/cancel/i.test(e.message) ? 'idle' : 'error');
      setError(e.message);
    }
  };

  const cancel = () => {
    void window.vd.cancelSignIn();
    setPhase('idle');
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="logo"><Logo s={30} /></div>
        <h1>Version Driver</h1>
        <p>Version control for everything you make, stored privately in your own Google Drive. Encrypted before it leaves your computer.</p>

        {phase === 'waiting' ? (
          <div className="steps" role="status">
            <div className="step done"><span className="n"><Icon n="check" s={12} /></span>Browser opened</div>
            <div className="step on"><span className="n"><span className="spinner" /></span>Sign in with Google in your browser</div>
            <div className="step"><span className="n">3</span>Come back here, we'll take it from there</div>
            <button className="btn ghost sm" onClick={cancel} style={{ alignSelf: 'flex-start', marginTop: 4 }}>Cancel</button>
          </div>
        ) : (
          <>
            <button className="google-btn" onClick={start} disabled={!googleConfigured}>
              <GoogleG /> Sign in with Google
            </button>
            {!googleConfigured && (
              <p className="faint" style={{ fontSize: 12 }}>
                Google sign-in isn't configured in this build yet. Add <span className="mono">GOOGLE_CLIENT_ID</span> to <span className="mono">app/.env.local</span>.
              </p>
            )}
            {phase === 'error' && (
              <div className="badge red" style={{ padding: '6px 10px', borderRadius: 8, whiteSpace: 'normal', textAlign: 'left' }}>
                <Icon n="alert" s={14} /> {error}
              </div>
            )}
            <p className="faint" style={{ fontSize: 12 }}>We'll open your browser to sign in, then bring you back to the app.</p>
          </>
        )}

      </div>
    </div>
  );
}

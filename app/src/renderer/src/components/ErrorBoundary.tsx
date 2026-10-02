import { Component, type ReactNode } from 'react';

/** Catches any rendering error so the app shows a message and a way out instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; onHome?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('UI error:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome">
        <div className="welcome-card">
          <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
          <p className="selectable" style={{ fontSize: 12.5 }}>{this.state.error.message}</p>
          <div className="row">
            <button className="btn primary" onClick={() => { this.setState({ error: null }); this.props.onHome?.(); }}>Back to main menu</button>
            <button className="btn" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('NewAmp UI error:', error);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
          style={{ color: 'var(--muted)' }}
        >
          <div className="text-[14px]" style={{ color: 'var(--accent)' }}>
            Something glitched in this view.
          </div>
          <pre className="bevel-in max-w-[520px] overflow-auto px-3 py-2 text-[11px]" style={{ fontFamily: 'var(--font-mono)' }}>
            {this.state.error.message}
          </pre>
          <button className="pxbtn" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

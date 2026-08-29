import { Component, type ErrorInfo, type ReactNode } from 'react';
import { appendDiagnostic } from '../core/diagnostics';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    appendDiagnostic(`${error.stack || error.message}\n${info.componentStack || ''}`, 'error');
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-recovery" role="alert">
        <section>
          <h1>MHTalk recovered from a display error</h1>
          <p>Your local messages and unfinished transfers were preserved. Reload the interface to continue.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload MHTalk</button>
          <details>
            <summary>Technical details</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </section>
      </main>
    );
  }
}

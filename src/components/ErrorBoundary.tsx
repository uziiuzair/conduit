import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Catches render-time errors so one bad component can't blank the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Conduit UI error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <h2>Something went wrong</h2>
          <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

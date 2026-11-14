import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Keeps a failure inside the site panel from blanking the whole map. */
export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The site panel failed:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="site-panel" data-open="true" role="alert">
        <p className="site-panel__place">This place's details didn't load. Go back to the map and try again.</p>
      </aside>
    );
  }
}

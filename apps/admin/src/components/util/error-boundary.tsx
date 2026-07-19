import * as React from 'react';
import { ErrorFallback } from './error-fallback.js';

interface AdminErrorBoundaryProps {
  readonly children: React.ReactNode;
}

interface AdminErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
}

/**
 * Root React error boundary for the admin SPA. A render throw OUTSIDE a
 * TanStack route (a shell or provider fault) bypasses the router's
 * per-route error component, so this catches it and degrades to a readable
 * fallback instead of blanking the console. No telemetry: the admin plane
 * runs no client-side error SDK (CODE-RULES).
 */
export class AdminErrorBoundary extends React.Component<
  AdminErrorBoundaryProps,
  AdminErrorBoundaryState
> {
  constructor(props: AdminErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { hasError: true, error };
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.JSX.Element {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          title="Something went wrong"
          detail={this.state.error?.message}
          onRetry={this.handleReset}
        />
      );
    }
    return <>{this.props.children}</>;
  }
}

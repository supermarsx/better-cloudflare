/**
 * React Error Boundary component.
 *
 * Catches JavaScript errors in child component subtrees and displays
 * a graceful fallback UI instead of crashing the entire application.
 * Supports error reporting callbacks and per-section boundaries.
 */
import React, { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  /** Child components to wrap */
  children: ReactNode;
  /** Custom fallback UI. Receives the error and a reset function. */
  fallback?: (props: { error: Error; reset: () => void }) => ReactNode;
  /** Called when an error is caught (for logging/telemetry) */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Optional label for identifying which boundary caught the error */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Generic error boundary that wraps child components and catches render errors.
 *
 * @example
 * ```tsx
 * <ErrorBoundary label="analytics" fallback={({ error, reset }) => (
 *   <div>
 *     <p>Something went wrong: {error.message}</p>
 *     <button onClick={reset}>Try again</button>
 *   </div>
 * )}>
 *   <AnalyticsPanel />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const label = this.props.label ?? "unknown";
    console.error(`[ErrorBoundary:${label}]`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, reset: this.reset });
      }
      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-center"
        >
          <svg
            className="h-8 w-8 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <div>
            <h3 className="text-sm font-semibold text-destructive">
              Something went wrong
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {this.state.error.message}
            </p>
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Lightweight functional wrapper that suspends children behind an error boundary.
 * Useful for wrapping lazy-loaded panels.
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  label?: string,
): React.FC<P> {
  const Wrapper: React.FC<P> = (props) => (
    <ErrorBoundary label={label ?? WrappedComponent.displayName ?? "component"}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );
  Wrapper.displayName = `WithErrorBoundary(${WrappedComponent.displayName ?? "Component"})`;
  return Wrapper;
}

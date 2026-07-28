/**
 * React Error Boundary component.
 *
 * Catches JavaScript errors in child component subtrees and displays
 * a graceful fallback UI instead of crashing the entire application.
 * Supports error reporting callbacks and per-section boundaries.
 */
import React, { Component, type ErrorInfo, type ReactNode } from "react";
import {
  createRuntimeDiagnostic,
  reportRuntimeError,
  type RuntimeDiagnostic,
} from "@/lib/errors/runtime-reporting";
import { RuntimeDiagnosticDetails } from "./RuntimeDiagnosticDetails";

export interface ErrorBoundaryProps {
  /** Child components to wrap */
  children: ReactNode;
  /** Custom fallback UI. Receives the error and a reset function. */
  fallback?: (props: {
    error: Error;
    diagnostic: RuntimeDiagnostic;
    reset: () => void;
  }) => ReactNode;
  /** Called when an error is caught (for logging/telemetry) */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Optional label for identifying which boundary caught the error */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  diagnostic: RuntimeDiagnostic | null;
  resetNonce: number;
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
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, diagnostic: null, resetNonce: 0 };
  }

  static getDerivedStateFromError(
    error: Error,
  ): Pick<ErrorBoundaryState, "error" | "diagnostic"> {
    return { error, diagnostic: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const label = this.props.label ?? "unknown";
    const { diagnostic } = reportRuntimeError(error, {
      source: "react-boundary",
      label,
      componentStack: errorInfo.componentStack ?? undefined,
    });
    this.setState({ diagnostic });
    try {
      this.props.onError?.(error, errorInfo);
    } catch (callbackError) {
      reportRuntimeError(callbackError, {
        source: "runtime",
        label: `${label}:onError`,
      });
    }
  }

  private reset = () => {
    this.setState((state) => ({
      error: null,
      diagnostic: null,
      resetNonce: state.resetNonce + 1,
    }));
  };

  render() {
    if (this.state.error) {
      const diagnostic =
        this.state.diagnostic ??
        createRuntimeDiagnostic(this.state.error, {
          source: "react-boundary",
          label: this.props.label ?? "unknown",
        });
      if (this.props.fallback) {
        try {
          return this.props.fallback({
            error: this.state.error,
            diagnostic,
            reset: this.reset,
          });
        } catch (fallbackError) {
          const fallbackDiagnostic = createRuntimeDiagnostic(fallbackError, {
            source: "react-boundary",
            label: `${this.props.label ?? "unknown"}:fallback`,
          });
          return this.defaultFallback(fallbackDiagnostic);
        }
      }
      return this.defaultFallback(diagnostic);
    }
    return (
      <React.Fragment key={this.state.resetNonce}>
        {this.props.children}
      </React.Fragment>
    );
  }

  private defaultFallback(diagnostic: RuntimeDiagnostic): ReactNode {
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
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        </svg>
        <div>
          <h3 className="text-sm font-semibold text-destructive">
            This section stopped unexpectedly
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {diagnostic.message}
          </p>
        </div>
        <RuntimeDiagnosticDetails diagnostic={diagnostic} compact />
        <button
          type="button"
          onClick={this.reset}
          className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Retry section
        </button>
      </div>
    );
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

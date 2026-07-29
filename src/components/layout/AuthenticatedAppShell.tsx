import type { ReactNode } from "react";

interface AuthenticatedAppShellProps {
  commandBar: ReactNode;
  workspaceTabs: ReactNode;
  children: ReactNode;
}

export function AuthenticatedAppShell({
  commandBar,
  workspaceTabs,
  children,
}: AuthenticatedAppShellProps) {
  return (
    <section
      data-testid="authenticated-app-shell"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.07),transparent_52%)] text-foreground"
    >
      <header
        data-app-shell-bar="secondary"
        data-testid="app-command-bar"
        className="app-no-drag sticky top-0 z-30 shrink-0 border-b border-border/70 bg-background/94 backdrop-blur-xl"
      >
        {commandBar}
      </header>
      <nav
        aria-label="DNS workspace navigation"
        data-app-shell-bar="tertiary"
        data-testid="dns-workspace-tab-bar"
        className="app-no-drag sticky top-0 z-20 shrink-0 border-b border-border/60 bg-card/92 shadow-sm backdrop-blur-xl"
      >
        {workspaceTabs}
      </nav>
      <div
        data-app-shell-scroll-region="body"
        data-testid="dns-workspace-scroll-region"
        className="scrollbar-themed min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth"
      >
        {children}
      </div>
    </section>
  );
}

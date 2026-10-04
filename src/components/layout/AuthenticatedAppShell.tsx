import type { ReactNode } from "react";

interface AuthenticatedAppShellProps {
  commandBar: ReactNode;
  workspaceTabs: ReactNode;
  connectionBar: ReactNode;
  /**
   * A persistent dock rendered beside the workspace, outside the body scroll
   * region.
   *
   * Outside is the point: anything in `children` is re-rendered by whichever
   * workspace tab is active and scrolls away with its content, so a surface
   * that has to survive a tab switch and stay put cannot live there. It is a
   * flex sibling of the scroll region rather than an overlay, because a dock
   * has to take part in the layout it docks into — the dock itself decides what
   * to do when the window is too narrow for that.
   */
  sidebar?: ReactNode;
  children: ReactNode;
}

export function AuthenticatedAppShell({
  commandBar,
  workspaceTabs,
  connectionBar,
  sidebar,
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
      {/* The row exists whether or not a dock is mounted. Introducing it only
          when `sidebar` is non-empty would change the shape of the tree on a
          preference change and remount the whole workspace to do it. */}
      <div data-testid="dns-workspace-body-row" className="flex min-h-0 flex-1">
        <div
          data-app-shell-scroll-region="body"
          data-testid="dns-workspace-scroll-region"
          className="app-shell-workspace-scroll scrollbar-themed min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth"
        >
          {children}
        </div>
        {sidebar}
      </div>
      <footer
        aria-label="DNS session and workspace context"
        data-app-shell-bar="bottom"
        data-testid="dns-connection-bar"
        className="app-no-drag sticky bottom-0 z-20 shrink-0 border-t border-border/70 bg-background/94 backdrop-blur-xl"
      >
        {connectionBar}
      </footer>
    </section>
  );
}

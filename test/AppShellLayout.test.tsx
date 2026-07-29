import assert from "node:assert/strict";
import React, { useState } from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DnsAppCommandBar } from "../src/components/dns/DnsAppCommandBar";
import {
  DnsWorkspaceTabs,
  getDnsWorkspacePanelId,
  getDnsWorkspaceTabId,
  getNextActiveTabIdAfterClose,
  type DnsWorkspaceTabItem,
} from "../src/components/dns/DnsWorkspaceTabs";
import { AuthenticatedAppShell } from "../src/components/layout/AuthenticatedAppShell";
import i18n from "../src/i18n";

async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, 5_000);
    const onInitialized = () => {
      clearTimeout(timeout);
      i18n.off("initialized", onInitialized);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

beforeEach(async () => {
  await waitForI18nInitialization();
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
  globalThis.localStorage.removeItem("theme");
});

test("authenticated shell keeps command bar, tabs, and one body scroll region in order", () => {
  render(
    <AuthenticatedAppShell
      commandBar={<button type="button">Command</button>}
      workspaceTabs={<div role="tablist">Tabs</div>}
    >
      <div role="tabpanel">Workspace</div>
    </AuthenticatedAppShell>,
  );

  const shell = screen.getByTestId("authenticated-app-shell");
  const children = Array.from(shell.children);
  assert.deepEqual(
    children.map((element) => element.tagName),
    ["HEADER", "NAV", "DIV"],
  );

  const commandBar = screen.getByTestId("app-command-bar");
  const tabBar = screen.getByTestId("dns-workspace-tab-bar");
  const scrollRegion = screen.getByTestId("dns-workspace-scroll-region");

  for (const bar of [commandBar, tabBar]) {
    assert.match(bar.className, /\bsticky\b/);
    assert.match(bar.className, /\btop-0\b/);
    assert.match(bar.className, /\bshrink-0\b/);
    assert.match(bar.className, /\bapp-no-drag\b/);
    assert.equal(bar.querySelector("[data-tauri-drag-region]"), null);
  }
  assert.equal(
    shell.querySelectorAll('[data-app-shell-scroll-region="body"]').length,
    1,
  );
  assert.match(scrollRegion.className, /\bmin-h-0\b/);
  assert.match(scrollRegion.className, /\bflex-1\b/);
  assert.match(scrollRegion.className, /\boverflow-y-auto\b/);
  assert.doesNotMatch(scrollRegion.className, /fade/);
});

test("authenticated command-bar controls remain labelled and clickable", () => {
  const clicks: string[] = [];
  const recordClick = (name: string) => () => clicks.push(name);

  render(
    <DnsAppCommandBar
      zoneSelector={<button type="button">Choose domain</button>}
      accountLabel="operator@example.com"
      sessionLabel="Primary session"
      activeContext="example.com"
      activeStatus="active"
      recordCount={8}
      visibleCount={5}
      showAudit
      onOpenAudit={recordClick("audit")}
      onOpenRegistry={recordClick("registry")}
      onOpenSettings={recordClick("settings")}
      onOpenTags={recordClick("tags")}
      onLogout={recordClick("logout")}
    />,
  );

  assert.ok(
    screen.getByRole("toolbar", { name: "Global application controls" }),
  );
  assert.ok(screen.getByRole("heading", { name: "DNS Manager" }));
  assert.ok(screen.getByText("Connected"));
  assert.ok(screen.getByText("operator@example.com"));
  assert.ok(screen.getByText("Primary session"));
  assert.ok(screen.getByText("example.com"));

  for (const name of [
    "Audit log",
    "Registry Monitoring",
    "Settings",
    "Tags",
    "Logout",
  ]) {
    fireEvent.click(screen.getByRole("button", { name }));
  }

  assert.deepEqual(clicks, ["audit", "registry", "settings", "tags", "logout"]);
});

const INITIAL_TABS: DnsWorkspaceTabItem[] = [
  { id: "alpha", label: "Alpha", kind: "zone", status: "active" },
  { id: "beta", label: "Beta", kind: "zone", status: "pending" },
  { id: "settings", label: "Settings", kind: "settings" },
];

function StatefulTabs({
  initialItems = INITIAL_TABS,
  initialActiveId = "alpha",
}: {
  initialItems?: readonly DnsWorkspaceTabItem[];
  initialActiveId?: string | null;
} = {}) {
  const [items, setItems] = useState<DnsWorkspaceTabItem[]>(() => [
    ...initialItems,
  ]);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);

  const closeTab = (id: string) => {
    setItems((currentItems) => {
      const nextItems = currentItems.filter((item) => item.id !== id);
      setActiveId((currentActiveId) =>
        getNextActiveTabIdAfterClose(currentItems, currentActiveId, id),
      );
      return nextItems;
    });
  };

  return (
    <>
      <DnsWorkspaceTabs
        items={items}
        activeId={activeId}
        closeOnMiddleClick
        onActivate={setActiveId}
        onClose={closeTab}
        onReorder={() => {}}
        onMoveToEnd={() => {}}
      />
      {activeId ? (
        <div
          id={getDnsWorkspacePanelId(activeId)}
          role="tabpanel"
          aria-labelledby={getDnsWorkspaceTabId(activeId)}
        >
          Panel {activeId}
        </div>
      ) : null}
    </>
  );
}

test("closing selection prefers the right neighbor, then the previous tab", () => {
  assert.equal(
    getNextActiveTabIdAfterClose(INITIAL_TABS, "alpha", "alpha"),
    "beta",
  );
  assert.equal(
    getNextActiveTabIdAfterClose(INITIAL_TABS, "beta", "beta"),
    "settings",
  );
  assert.equal(
    getNextActiveTabIdAfterClose(INITIAL_TABS, "settings", "settings"),
    "beta",
  );
  assert.equal(
    getNextActiveTabIdAfterClose(INITIAL_TABS.slice(0, 1), "alpha", "alpha"),
    null,
  );
  assert.equal(
    getNextActiveTabIdAfterClose(INITIAL_TABS, "alpha", "beta"),
    "alpha",
  );
});

test("workspace tabs switch with pointer and roving keyboard focus", () => {
  render(<StatefulTabs />);

  const alpha = screen.getByRole("tab", { name: /Alpha/ });
  const beta = screen.getByRole("tab", { name: /Beta/ });
  assert.equal(alpha.getAttribute("aria-selected"), "true");
  assert.equal(alpha.tabIndex, 0);
  assert.equal(beta.tabIndex, -1);

  fireEvent.click(beta);
  assert.equal(beta.getAttribute("aria-selected"), "true");
  assert.equal(screen.getByRole("tabpanel").id, getDnsWorkspacePanelId("beta"));

  fireEvent.keyDown(beta, { key: "ArrowRight" });
  const settings = screen.getByRole("tab", { name: /Settings/ });
  assert.equal(settings.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, settings);

  fireEvent.keyDown(settings, { key: "Home" });
  assert.equal(alpha.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, alpha);

  fireEvent.keyDown(alpha, { key: "End" });
  assert.equal(settings.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, settings);
});

test("Delete closes the focused first tab and focuses its right neighbor", () => {
  render(<StatefulTabs initialActiveId="alpha" />);

  const alpha = screen.getByRole("tab", { name: /Alpha/ });
  alpha.focus();
  fireEvent.keyDown(alpha, { key: "Delete" });

  assert.equal(screen.queryByRole("tab", { name: /Alpha/ }), null);
  const beta = screen.getByRole("tab", { name: /Beta/ });
  assert.equal(beta.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, beta);
});

test("the close button closes the active middle tab and focuses right", () => {
  render(<StatefulTabs initialActiveId="beta" />);

  const closeBeta = screen.getByRole("button", { name: /Close tab: Beta/ });
  closeBeta.focus();
  fireEvent.click(closeBeta);

  assert.equal(screen.queryByRole("tab", { name: /Beta/ }), null);
  const settings = screen.getByRole("tab", { name: /Settings/ });
  assert.equal(settings.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, settings);
});

test("middle-click closes the focused last tab and focuses the previous tab", () => {
  render(<StatefulTabs initialActiveId="settings" />);

  const settings = screen.getByRole("tab", { name: /Settings/ });
  settings.focus();
  fireEvent.mouseDown(settings, { button: 1 });

  assert.equal(screen.queryByRole("tab", { name: /Settings/ }), null);
  const beta = screen.getByRole("tab", { name: /Beta/ });
  assert.equal(beta.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, beta);
});

test("closing the only tab leaves no active tab or stale focus target", () => {
  render(
    <StatefulTabs
      initialItems={INITIAL_TABS.slice(0, 1)}
      initialActiveId="alpha"
    />,
  );

  const closeAlpha = screen.getByRole("button", {
    name: /Close tab: Alpha/,
  });
  closeAlpha.focus();
  fireEvent.click(closeAlpha);

  assert.equal(screen.queryByRole("tab"), null);
  assert.equal(screen.queryByRole("tabpanel"), null);
});

test("closing a focused inactive tab preserves and focuses the active tab", () => {
  render(<StatefulTabs initialActiveId="alpha" />);

  const closeBeta = screen.getByRole("button", { name: /Close tab: Beta/ });
  closeBeta.focus();
  fireEvent.click(closeBeta);

  assert.equal(screen.queryByRole("tab", { name: /Beta/ }), null);
  const alpha = screen.getByRole("tab", { name: /Alpha/ });
  assert.equal(alpha.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, alpha);
});

function createDataTransfer(): DataTransfer {
  let value = "";
  return {
    dropEffect: "none",
    effectAllowed: "none",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: () => {
      value = "";
    },
    getData: () => value,
    setData: (_format: string, nextValue: string) => {
      value = nextValue;
    },
    setDragImage: () => {},
  };
}

test("workspace tabs keep horizontal overflow and drag reorder actions", () => {
  const reorders: Array<[string, string]> = [];
  const movedToEnd: string[] = [];

  render(
    <DnsWorkspaceTabs
      items={INITIAL_TABS}
      activeId="alpha"
      closeOnMiddleClick
      onActivate={() => {}}
      onClose={() => {}}
      onReorder={(sourceId, targetId) => reorders.push([sourceId, targetId])}
      onMoveToEnd={(sourceId) => movedToEnd.push(sourceId)}
    />,
  );

  const tablist = screen.getByRole("tablist", { name: "DNS workspaces" });
  assert.equal(tablist.getAttribute("data-responsive-overflow"), "horizontal");
  assert.match(tablist.className, /\boverflow-x-auto\b/);
  assert.match(tablist.className, /\bwhitespace-nowrap\b/);

  const alphaContainer = screen
    .getByRole("tab", { name: /Alpha/ })
    .closest('[draggable="true"]');
  const betaContainer = screen
    .getByRole("tab", { name: /Beta/ })
    .closest('[draggable="true"]');
  assert.ok(alphaContainer);
  assert.ok(betaContainer);
  assert.match(alphaContainer.className, /\bshrink-0\b/);

  const reorderTransfer = createDataTransfer();
  fireEvent.dragStart(alphaContainer, { dataTransfer: reorderTransfer });
  fireEvent.drop(betaContainer, { dataTransfer: reorderTransfer });
  assert.deepEqual(reorders, [["alpha", "beta"]]);

  const moveTransfer = createDataTransfer();
  fireEvent.dragStart(alphaContainer, { dataTransfer: moveTransfer });
  fireEvent.drop(tablist, { dataTransfer: moveTransfer });
  assert.deepEqual(movedToEnd, ["alpha"]);
});

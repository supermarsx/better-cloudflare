import assert from "node:assert/strict";
import React from "react";
import { afterEach, test, beforeEach, mock } from "node:test";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

import { AuditLogDialog } from "../src/components/audit/AuditLogDialog";
import { TauriClient } from "../src/lib/api/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalExport = TauriClient.exportAuditEntries;
const originalGet = TauriClient.getAuditEntries;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.exportAuditEntries = originalExport;
  TauriClient.getAuditEntries = originalGet;
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.exportAuditEntries = originalExport;
  TauriClient.getAuditEntries = originalGet;
});

test("AuditLogDialog shows desktop-only message when not in Tauri", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  TauriClient.getAuditEntries = async () => [];
  TauriClient.exportAuditEntries = async () => "{}";
  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByText(/desktop app/i));
  });
});

test("AuditLogDialog loads entries in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  TauriClient.exportAuditEntries = async () => "{}";
  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(
      screen.getByText((content, element) =>
        Boolean(
          element?.tagName === "DIV" &&
          element.classList.contains("font-medium") &&
          /dns:create/.test(content),
        ),
      ),
    );
    const entryTimestamp = screen.getByText((content, element) =>
      Boolean(
        element?.tagName === "DIV" &&
        element.classList.contains("text-muted-foreground") &&
        /2026-01-01/i.test(content),
      ),
    );
    assert.ok(entryTimestamp);
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
    assert.ok(screen.getByRole("button", { name: "Export CSV" }));
  });
});

test("AuditLogDialog calls backend export", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  const called: string[] = [];
  TauriClient.exportAuditEntries = async (format = "json") => {
    called.push(format);
    return "{}";
  };
  mock.method(HTMLAnchorElement.prototype, "click", () => {});

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
    assert.ok(screen.getByRole("button", { name: "Export CSV" }));
  });

  const exportJson = screen.getByRole("button", { name: "Export JSON" });
  const exportCsv = screen.getByRole("button", { name: "Export CSV" });
  await act(async () => {
    fireEvent.click(exportJson);
    fireEvent.click(exportCsv);
  });
  await waitFor(() => {
    assert.deepEqual(called, ["json", "csv"]);
  });
});

test("AuditLogDialog handles load errors", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => {
    throw new Error("boom");
  };
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByText(/boom/i));
  });
});

test("AuditLogDialog ignores stale loads across close and reopen", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let resolveFirst: ((entries: unknown[]) => void) | undefined;
  let calls = 0;
  TauriClient.getAuditEntries = async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise<unknown[]>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return [{ operation: "fresh-entry", timestamp: "2026-01-02T00:00:00Z" }];
  };

  const view = render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  view.rerender(<AuditLogDialog open={false} onOpenChange={() => {}} />);
  view.rerender(<AuditLogDialog open={true} onOpenChange={() => {}} />);

  await waitFor(() => {
    assert.ok(screen.getByText("fresh-entry"));
  });

  await act(async () => {
    resolveFirst?.([
      { operation: "stale-entry", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    await Promise.resolve();
  });

  assert.ok(
    screen.queryByText("stale-entry") === null,
    "a resolved load from a closed dialog must not reach the list",
  );
  assert.ok(screen.getByText("fresh-entry"));
});

/**
 * A log that mixes all three writers, which is the state the filter exists
 * for: the first entry predates the actor field and has to read as the human
 * who wrote it.
 */
const mixedTrail = () => [
  { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  {
    operation: "dns:delete",
    timestamp: "2026-01-02T00:00:00Z",
    actor: "user",
    outcome: "succeeded",
  },
  {
    operation: "mcp:tool_call",
    timestamp: "2026-01-03T00:00:00Z",
    actor: "mcp_client",
    outcome: "succeeded",
    resource: "cf_update_dns_record",
  },
  {
    operation: "assistant:tool_call",
    timestamp: "2026-01-04T00:00:00Z",
    actor: "assistant",
    outcome: "denied",
    resource: "cf_delete_dns_record",
    denied_by: "mcp_grants",
  },
];

test("AuditLogDialog counts each actor, treating an entry with no actor as the user", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => mixedTrail();
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Everything (4)" }));
  });
  assert.ok(
    screen.getByRole("button", { name: "You (2)" }),
    "the entry written before the actor field counts as the user's",
  );
  assert.ok(screen.getByRole("button", { name: "MCP client (1)" }));
  assert.ok(screen.getByRole("button", { name: "Assistant (1)" }));
  assert.ok(screen.getByRole("button", { name: "Denied (1)" }));
});

test("AuditLogDialog filters by actor so the human record can be read alone", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => mixedTrail();
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "You (2)" }));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "You (2)" }));
  });

  await waitFor(() => {
    assert.ok(screen.getByText(/Showing 2 of 4 entries/));
  });
  assert.ok(screen.getByText("dns:create"));
  assert.ok(screen.getByText("dns:delete"));
  assert.ok(
    screen.queryByText("mcp:tool_call") === null,
    "a tool call is not the human record",
  );
  assert.ok(
    screen.queryByText("assistant:tool_call") === null,
    "nor is the assistant's",
  );
  assert.equal(
    screen
      .getByRole("button", { name: "You (2)" })
      .getAttribute("aria-pressed"),
    "true",
  );

  // Clicking the active filter again clears it.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "You (2)" }));
  });
  await waitFor(() => {
    assert.ok(screen.getByText("mcp:tool_call"));
  });
});

test("AuditLogDialog filters by outcome so refused attempts can be read alone", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => mixedTrail();
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Denied (1)" }));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Denied (1)" }));
  });

  await waitFor(() => {
    assert.ok(screen.getByText(/Showing 1 of 4 entries/));
  });
  assert.ok(screen.getByText("assistant:tool_call"));
  assert.ok(
    screen.queryByText("dns:create") === null,
    "a succeeded entry is not in the denied view",
  );

  // Actor and outcome compose rather than replacing each other.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "You (2)" }));
  });
  await waitFor(() => {
    assert.ok(screen.getByText(/No entries match this filter/));
  });
});

test("AuditLogDialog revokes export URLs and removes links when click fails", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  TauriClient.exportAuditEntries = async () => "{}";
  const revoked: string[] = [];
  mock.method(URL, "createObjectURL", () => "blob:audit-export");
  mock.method(URL, "revokeObjectURL", (url: string) => {
    revoked.push(url);
  });
  mock.method(HTMLAnchorElement.prototype, "click", () => {
    throw new Error("download click failed");
  });

  render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
  });

  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

  await waitFor(() => {
    assert.ok(screen.getByText("download click failed"));
  });
  assert.deepEqual(revoked, ["blob:audit-export"]);
  assert.ok(
    document.querySelector("a[download='audit-log.json']") === null,
    "a failed click still removes the link it created",
  );
});

/**
 * What the dialog has to make legible: a record edit, with the fields that
 * changed and both sides of each. `dns:update` naming only a record id answers
 * "something happened" and not "what", which is the question the log is
 * opened for.
 */
test("AuditLogDialog shows which fields a record edit changed", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    {
      timestamp: "2026-10-07T09:00:00Z",
      operation: "dns:update",
      resource: "record-1",
      actor: "user",
      outcome: "succeeded",
      zone_id: "zone-1",
      record_type: "A",
      record_name: "www.example.com",
      changes: {
        content: { from: "203.0.113.1", to: "203.0.113.9" },
        ttl: { from: 300, to: 1 },
        comment: { from: "old note", to: null },
      },
    },
  ];
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByText("A www.example.com"));
  });
  assert.ok(screen.getByText("203.0.113.1 → 203.0.113.9"));
  assert.ok(screen.getByText("300 → 1"));
  assert.ok(
    screen.getByText("old note → —"),
    "a field that was cleared reads as unset, not as missing",
  );
});

test("AuditLogDialog shows what a deletion removed", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    {
      timestamp: "2026-10-07T09:00:00Z",
      operation: "dns:delete",
      resource: "record-1",
      actor: "user",
      outcome: "succeeded",
      record_type: "MX",
      record_name: "example.com",
      record: { content: "mx1.example.com", ttl: 300, priority: 10 },
    },
  ];
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByText("MX example.com"));
  });
  // Matched on the `<dd>` rather than on the text, because the raw entry is
  // also dumped into a `<pre>` further down: an assertion on the string alone
  // would pass with the rendered rows gone entirely.
  const cell = (value: string) =>
    screen.queryByText(
      (content, element) =>
        element?.tagName === "DD" && content.trim() === value,
    );
  // A record snapshot has one side, so it renders as the value alone: there is
  // no "before" for a record that is simply gone.
  assert.ok(cell("mx1.example.com"), "the removed record's content is shown");
  assert.ok(cell("300"));
  assert.ok(cell("10"));
  assert.ok(
    cell("mx1.example.com → —") === null,
    "a snapshot must not be rendered as a change from nothing",
  );
});

test("AuditLogDialog says why an attempt was refused and what it left out", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    {
      timestamp: "2026-10-07T09:00:00Z",
      operation: "dns:create",
      actor: "user",
      outcome: "denied",
      denied_by: "record_validation",
      record_type: "A",
      record_name: "www.example.com",
      record: { content: "not-an-ip" },
      record_omitted: 2,
    },
    {
      timestamp: "2026-10-07T09:01:00Z",
      operation: "dns:update",
      resource: "record-2",
      actor: "user",
      outcome: "succeeded",
      changes: {},
    },
  ];
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByText("record_validation"));
  });
  assert.ok(screen.getByText("2 further fields were not recorded."));
  assert.ok(
    screen.getByText("No fields changed."),
    "an empty change set is a fact about the action, not a gap in the log",
  );
});

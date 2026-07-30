import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  boundParsedImportItems,
  IMPORT_LIMITS,
  ImportExportDialog,
  preflightImportText,
} from "../src/components/dns/ImportExportDialog";
import {
  IMPORT_PREVIEW_VISIBLE_ROW_LIMIT,
  ImportPreviewDialog,
} from "../src/components/dns/ImportPreviewDialog";
import {
  appendBoundedTopologyAnnotation,
  escapeMermaidLabel,
  populateTopologyPrintDocument,
  sanitizeTopologySvg,
  TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES,
  TOPOLOGY_ANNOTATION_LIMIT,
  TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES,
  TOPOLOGY_CANVAS_MAX_AXIS,
  TOPOLOGY_CANVAS_MAX_PIXELS,
  TOPOLOGY_MERMAID_HTML_LABELS,
  TOPOLOGY_MERMAID_SECURITY_LEVEL,
  withBoundedTopologyCanvas,
  withTopologyObjectUrl,
} from "../src/components/dns/ZoneTopologyTab";
import type { DNSRecord } from "../src/types/dns";
import { utf8ByteLengthUpTo } from "../src/components/dns/rendererSafety";
import { TauriClient } from "../src/lib/api/tauri-client";

afterEach(() => {
  cleanup();
});

function importItem(index: number): Partial<DNSRecord> {
  return {
    type: "A",
    name: `host-${index}.example.com`,
    content: `192.0.2.${index % 255}`,
    ttl: 300,
  };
}

test("rejects oversized raw imports before parsing or retaining textarea state", () => {
  const oversized = "x".repeat(IMPORT_LIMITS.inputBytes + 1);
  assert.match(
    preflightImportText(oversized, "json") ?? "",
    /refused before parsing.*exceeds 2 MiB/i,
  );
  assert.match(
    preflightImportText(
      `type,name,content\nA,example.com,${"x".repeat(
        IMPORT_LIMITS.fieldBytes + 1,
      )}`,
      "csv",
    ) ?? "",
    /field.*exceeds.*UTF-8 bytes/i,
  );
  assert.match(
    preflightImportText(
      Array.from({ length: IMPORT_LIMITS.lines + 1 }, () => ";").join("\n"),
      "bind",
    ) ?? "",
    /more than 20,000 lines/i,
  );

  let retainedValue = "";
  render(
    <ImportExportDialog
      open
      onOpenChange={() => undefined}
      importData=""
      importFormat="json"
      onImportDataChange={(value) => {
        retainedValue = value;
      }}
      onImportFormatChange={() => undefined}
      onImport={() => undefined}
      onExport={() => undefined}
    />,
  );
  fireEvent.change(
    screen.getByPlaceholderText("Paste your JSON data here..."),
    {
      target: { value: oversized },
    },
  );
  assert.equal(retainedValue, "");
  assert.match(
    screen.getByTestId("import-limit-diagnostic").textContent ?? "",
    /not retained/i,
  );

  cleanup();
  let jsonParseCalls = 0;
  render(
    <ImportExportDialog
      open
      onOpenChange={() => undefined}
      importData={oversized}
      importFormat="json"
      onImportDataChange={() => undefined}
      onImportFormatChange={() => undefined}
      onImport={() => undefined}
      onExport={() => undefined}
    />,
  );
  const originalJsonParse = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    jsonParseCalls += 1;
    return originalJsonParse(...args);
  }) as typeof JSON.parse;
  try {
    fireEvent.click(screen.getByRole("button", { name: "Import Records" }));
  } finally {
    JSON.parse = originalJsonParse;
  }
  assert.equal(jsonParseCalls, 0);

  cleanup();
  const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
  const originalTauriDescriptor = Object.getOwnPropertyDescriptor(
    tauriWindow,
    "__TAURI_INTERNALS__",
  );
  Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const originalParseCsvRecords = TauriClient.parseCsvRecords;
  let ipcCalls = 0;
  TauriClient.parseCsvRecords = async () => {
    ipcCalls += 1;
    return [];
  };
  try {
    render(
      <ImportExportDialog
        open
        onOpenChange={() => undefined}
        importData={oversized}
        importFormat="csv"
        onImportDataChange={() => undefined}
        onImportFormatChange={() => undefined}
        onImport={() => undefined}
        onExport={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import Records" }));
    assert.equal(ipcCalls, 0);
  } finally {
    TauriClient.parseCsvRecords = originalParseCsvRecords;
    if (originalTauriDescriptor) {
      Object.defineProperty(
        tauriWindow,
        "__TAURI_INTERNALS__",
        originalTauriDescriptor,
      );
    } else {
      delete tauriWindow.__TAURI_INTERNALS__;
    }
  }
});

test("bounds parsed import records, fields, and aggregate retained data with diagnostics", () => {
  const sourceRecord = importItem(1);
  const hugeSource = Array.from({ length: 100_000 }, () => sourceRecord);
  const bounded = boundParsedImportItems(hugeSource);
  assert.equal(bounded.items.length, IMPORT_LIMITS.records);
  assert.equal(bounded.rejectedCount, 90_000);
  assert.match(bounded.diagnostics.join(" "), /90,000 records were rejected/i);

  const oversizedField = boundParsedImportItems([
    {
      type: "TXT",
      name: "example.com",
      content: "x".repeat(4 * 1024 * 1024),
    },
  ]);
  assert.equal(oversizedField.items.length, 0);
  assert.equal(oversizedField.rejectedCount, 1);
  assert.match(
    oversizedField.diagnostics.join(" "),
    /field.*exceeded.*rejected/i,
  );

  const tooManyFields = Object.fromEntries(
    Array.from({ length: IMPORT_LIMITS.fieldsPerRecord + 1 }, (_, index) => [
      `field${index}`,
      "value",
    ]),
  );
  const excessive = boundParsedImportItems([tooManyFields]);
  assert.equal(excessive.items.length, 0);
  assert.match(excessive.diagnostics.join(" "), /exceeded 32 fields/i);

  const aggregate = boundParsedImportItems(
    Array.from({ length: IMPORT_LIMITS.records }, (_, index) => ({
      type: "TXT",
      name: `host-${index}.example.com`,
      content: "x".repeat(512),
    })),
  );
  assert.ok(aggregate.items.length < IMPORT_LIMITS.records);
  assert.match(aggregate.diagnostics.join(" "), /retained-data budget/i);
});

test("preview renders at most 200 rows while selection spans every retained page", () => {
  const items = Array.from({ length: 450 }, (_, index) => importItem(index));
  let confirmed: Partial<DNSRecord>[] = [];
  render(
    <ImportPreviewDialog
      open
      onOpenChange={() => undefined}
      items={items}
      sourceItemCount={100_000}
      rejectedItemCount={99_550}
      diagnostics={["99,550 records exceeded the retained record limit."]}
      onConfirm={(selected) => {
        confirmed = selected;
      }}
      onCancel={() => undefined}
    />,
  );

  assert.equal(
    screen.getAllByTestId("import-preview-row").length,
    IMPORT_PREVIEW_VISIBLE_ROW_LIMIT,
  );
  assert.match(
    screen.getByTestId("import-preview-rejection").textContent ?? "",
    /cannot be selected or imported/i,
  );

  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select retained record 1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  assert.equal(
    screen.getAllByTestId("import-preview-row").length,
    IMPORT_PREVIEW_VISIBLE_ROW_LIMIT,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select retained record 201" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import Selected" }));

  assert.deepEqual(
    confirmed.map((item) => item.name),
    ["host-0.example.com", "host-200.example.com"],
  );
});

test("hostile DNS, Mermaid, SVG, and print annotation markup remains inert", () => {
  const hostile = `</text><script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">`;
  const escaped = escapeMermaidLabel(hostile);
  assert.doesNotMatch(escaped, /<script|<img|href="/i);
  assert.match(escaped, /&lt;script&gt;/i);
  assert.doesNotMatch(escaped, /"\]\s*$/);
  assert.equal(TOPOLOGY_MERMAID_SECURITY_LEVEL, "strict");
  assert.equal(TOPOLOGY_MERMAID_HTML_LABELS, false);

  const sanitized = sanitizeTopologySvg(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(2)">bad</div></foreignObject>
      <image href="javascript:alert(3)" />
      <style>@import url(https://attacker.invalid/x.css); .x { fill: red; }</style>
      <rect class="x" onclick="alert(4)" style="fill:url(javascript:alert(5))" width="10" height="10" />
      <path d="M0 0 L1 1" marker-end="url(#safe-marker)" />
    </svg>
  `);
  assert.doesNotMatch(
    sanitized,
    /<script|foreignObject|<image|onload|onclick|javascript:|@import/i,
  );
  assert.match(sanitized, /marker-end="url\(#safe-marker\)"/);

  const printDocument = document.implementation.createHTMLDocument();
  populateTopologyPrintDocument(printDocument, sanitized, hostile, [
    { text: hostile, x: 1, y: 2 },
  ]);
  assert.equal(printDocument.querySelector("script"), null);
  assert.equal(printDocument.querySelector("img"), null);
  assert.equal(printDocument.querySelector("[onerror]"), null);
  assert.match(printDocument.querySelector("h1")?.textContent ?? "", /script/);
  assert.match(printDocument.querySelector("li")?.textContent ?? "", /script/);

  render(
    <ImportPreviewDialog
      open
      onOpenChange={() => undefined}
      items={[{ type: "TXT", name: hostile, content: hostile }]}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
  assert.equal(document.querySelector("script"), null);
  assert.equal(document.querySelector("img"), null);
});

test("huge SVG dimensions are downscaled before assignment and canvas cleanup always runs", async () => {
  let width = 300;
  let height = 150;
  const assignedWidths: number[] = [];
  const assignedHeights: number[] = [];
  const canvas = {} as HTMLCanvasElement;
  Object.defineProperties(canvas, {
    width: {
      configurable: true,
      get: () => width,
      set: (value: number) => {
        assignedWidths.push(value);
        width = value;
      },
    },
    height: {
      configurable: true,
      get: () => height,
      set: (value: number) => {
        assignedHeights.push(value);
        height = value;
      },
    },
  });

  await assert.rejects(
    () =>
      withBoundedTopologyCanvas(
        canvas,
        `<svg xmlns="http://www.w3.org/2000/svg" width="1e100" height="1e90" viewBox="0 0 1e100 1e90"></svg>`,
        2,
        async (_boundedCanvas, allocation) => {
          assert.ok(allocation.width <= TOPOLOGY_CANVAS_MAX_AXIS);
          assert.ok(allocation.height <= TOPOLOGY_CANVAS_MAX_AXIS);
          assert.ok(
            allocation.width * allocation.height <= TOPOLOGY_CANVAS_MAX_PIXELS,
          );
          throw new Error("forced raster failure");
        },
      ),
    /forced raster failure/,
  );
  assert.equal(width, 0);
  assert.equal(height, 0);
  assert.ok(
    assignedWidths.every(
      (value) => value === 0 || value <= TOPOLOGY_CANVAS_MAX_AXIS,
    ),
  );
  assert.ok(
    assignedHeights.every(
      (value) => value === 0 || value <= TOPOLOGY_CANVAS_MAX_AXIS,
    ),
  );
});

test("object URLs and annotations are bounded and cleaned up on failure", async () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:topology-test";
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  try {
    await assert.rejects(
      () =>
        withTopologyObjectUrl(new Blob(["safe"]), async () => {
          throw new Error("forced URL failure");
        }),
      /forced URL failure/,
    );
    assert.deepEqual(revoked, ["blob:topology-test"]);
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }

  const hugeAnnotation = appendBoundedTopologyAnnotation([], {
    id: "huge",
    x: 0,
    y: 0,
    text: "😀".repeat(1_000_000),
  });
  assert.equal(hugeAnnotation.annotations.length, 1);
  assert.ok(
    utf8ByteLengthUpTo(hugeAnnotation.annotations[0].text) <=
      TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES,
  );
  assert.match(hugeAnnotation.diagnostic ?? "", /truncated/i);

  const fullAggregate = Array.from(
    {
      length:
        TOPOLOGY_ANNOTATION_TOTAL_MAX_BYTES /
        TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES,
    },
    (_, index) => ({
      id: `note-${index}`,
      x: 0,
      y: 0,
      text: "x".repeat(TOPOLOGY_ANNOTATION_ENTRY_MAX_BYTES),
    }),
  );
  const aggregateRefusal = appendBoundedTopologyAnnotation(fullAggregate, {
    id: "extra",
    x: 0,
    y: 0,
    text: "extra",
  });
  assert.equal(aggregateRefusal.annotations.length, fullAggregate.length);
  assert.match(aggregateRefusal.diagnostic ?? "", /budget is full/i);

  const countRefusal = appendBoundedTopologyAnnotation(
    Array.from({ length: TOPOLOGY_ANNOTATION_LIMIT }, (_, index) => ({
      id: `short-${index}`,
      x: 0,
      y: 0,
      text: "note",
    })),
    { id: "extra", x: 0, y: 0, text: "extra" },
  );
  assert.equal(countRefusal.annotations.length, TOPOLOGY_ANNOTATION_LIMIT);
  assert.match(countRefusal.diagnostic ?? "", /remove an existing note/i);
});

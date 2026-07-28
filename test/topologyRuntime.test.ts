import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  copyTopologyText,
  runTopologyRefresh,
} from "../src/components/dns/ZoneTopologyTab";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

afterEach(() => {
  resetRuntimeReportingForTests();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test("topology refresh rejection is contained and reported", async () => {
  const result = await runTopologyRefresh(async () => {
    throw new Error("refresh failed token=topology-secret");
  });

  assert.equal(result, false);
  assert.match(getRuntimeDiagnostics()[0]?.label ?? "", /Refresh DNS topology/);
  assert.doesNotMatch(
    getRuntimeDiagnostics()[0]?.message ?? "",
    /topology-secret/,
  );
});

test("clipboard rejection returns a graceful failure without escaping", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new DOMException("clipboard blocked", "NotAllowedError");
      },
    },
  });

  assert.equal(
    await copyTopologyText("safe text", "Copy test topology"),
    false,
  );
  assert.match(getRuntimeDiagnostics()[0]?.label ?? "", /Copy test topology/);
});

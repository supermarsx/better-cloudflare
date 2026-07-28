import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  loadExportSchedules,
  saveExportSchedules,
  type ExportSchedule,
} from "../src/lib/dns/export-scheduler";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

class SchedulerStorage {
  value: string | null = null;
  readError: Error | null = null;
  writeError: Error | null = null;

  getItem() {
    if (this.readError) throw this.readError;
    return this.value;
  }

  setItem(_key: string, value: string) {
    if (this.writeError) throw this.writeError;
    this.value = value;
  }

  removeItem() {
    this.value = null;
  }
}

const storage = new SchedulerStorage();

beforeEach(() => {
  storage.value = null;
  storage.readError = null;
  storage.writeError = null;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
  resetRuntimeReportingForTests();
});

test("corrupt export schedules fall back to an empty list and report context", () => {
  storage.value = "{broken";

  assert.deepEqual(loadExportSchedules(), []);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Load DNS export schedules: corrupt schedule data/,
  );
});

test("quota and security failures are contained and classified", () => {
  const schedules: ExportSchedule[] = [
    {
      id: "schedule-1",
      zoneId: "zone-1",
      zoneName: "example.com",
      format: "json",
      intervalMs: 60_000,
      enabled: true,
    },
  ];
  storage.writeError = new DOMException("full", "QuotaExceededError");

  assert.doesNotThrow(() => saveExportSchedules(schedules));
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Save DNS export schedules: quota exceeded/,
  );

  resetRuntimeReportingForTests();
  storage.writeError = null;
  storage.readError = new DOMException("blocked", "SecurityError");

  assert.deepEqual(loadExportSchedules(), []);
  assert.match(
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Load DNS export schedules: access denied/,
  );
});

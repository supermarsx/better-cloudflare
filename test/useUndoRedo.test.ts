import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUndoRedo } from "../src/hooks/dns/use-undo-redo";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

interface TestOperation {
  kind: "create" | "delete";
}

const historyEntry = {
  description: "Create A record",
  forward: { kind: "create" as const },
  reverse: { kind: "delete" as const },
};

afterEach(() => {
  cleanup();
  resetRuntimeReportingForTests();
});

test("failed undo keeps history retryable and reports a sanitized actionable diagnostic", async () => {
  let rejectUndo = true;
  let undoAttempts = 0;
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      onUndo: async () => {
        undoAttempts += 1;
        if (rejectUndo) {
          throw new Error("undo rejected api_key=undo-secret");
        }
      },
      onRedo: async () => {},
    }),
  );

  act(() => result.current.push(historyEntry));
  const entryId = result.current.undoStack[0]?.id;

  await act(async () => result.current.undo());

  assert.equal(undoAttempts, 1);
  assert.equal(result.current.canUndo, true);
  assert.equal(result.current.canRedo, false);
  assert.equal(result.current.undoStack[0]?.id, entryId);
  assert.equal(result.current.redoStack.length, 0);

  const diagnostic = getRuntimeDiagnostics()[0];
  assert.match(diagnostic?.label ?? "", /Undo DNS history operation/);
  assert.match(diagnostic?.message ?? "", /history was left unchanged/i);
  assert.match(diagnostic?.message ?? "", /retry/i);
  assert.doesNotMatch(diagnostic?.message ?? "", /undo-secret/);
  assert.match(diagnostic?.message ?? "", /\[redacted\]/);

  rejectUndo = false;
  await act(async () => result.current.undo());

  assert.equal(undoAttempts, 2);
  assert.equal(result.current.canUndo, false);
  assert.equal(result.current.canRedo, true);
  assert.equal(result.current.redoStack[0]?.id, entryId);
});

test("failed redo stays on the redo stack and succeeds on retry", async () => {
  let rejectRedo = true;
  let redoAttempts = 0;
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      onUndo: async () => {},
      onRedo: async () => {
        redoAttempts += 1;
        if (rejectRedo) {
          throw new Error("redo rejected password=redo-secret");
        }
      },
    }),
  );

  act(() => result.current.push(historyEntry));
  await act(async () => result.current.undo());
  const entryId = result.current.redoStack[0]?.id;

  await act(async () => result.current.redo());

  assert.equal(redoAttempts, 1);
  assert.equal(result.current.canUndo, false);
  assert.equal(result.current.canRedo, true);
  assert.equal(result.current.redoStack[0]?.id, entryId);
  assert.equal(result.current.undoStack.length, 0);
  assert.match(getRuntimeDiagnostics()[0]?.message ?? "", /retry/i);
  assert.doesNotMatch(getRuntimeDiagnostics()[0]?.message ?? "", /redo-secret/);

  rejectRedo = false;
  await act(async () => result.current.redo());

  assert.equal(redoAttempts, 2);
  assert.equal(result.current.canUndo, true);
  assert.equal(result.current.canRedo, false);
  assert.equal(result.current.undoStack[0]?.id, entryId);
});

test("push clears redo history and maxHistory retains only newest entries", async () => {
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      maxHistory: 2,
      onUndo: async () => {},
      onRedo: async () => {},
    }),
  );

  act(() => {
    result.current.push({ ...historyEntry, description: "First" });
    result.current.push({ ...historyEntry, description: "Second" });
    result.current.push({ ...historyEntry, description: "Third" });
  });

  assert.deepEqual(
    result.current.undoStack.map((entry) => entry.description),
    ["Third", "Second"],
  );

  await act(async () => result.current.undo());
  assert.equal(result.current.canRedo, true);

  act(() =>
    result.current.push({ ...historyEntry, description: "New branch" }),
  );
  assert.equal(result.current.canRedo, false);
  assert.equal(result.current.redoStack.length, 0);
});

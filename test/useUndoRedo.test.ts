import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUndoRedo } from "../src/hooks/dns/use-undo-redo";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import { RESOURCE_LIMITS } from "../src/lib/resource-limits";

interface TestOperation {
  kind: "create" | "delete";
}

const historyEntry = {
  description: "Create A record",
  forward: { kind: "create" as const },
  reverse: { kind: "delete" as const },
};

function deferredPromise(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

test("caps history at limit-1, limit, and limit+1 and clears it", () => {
  const hardLimit = RESOURCE_LIMITS.undoRedo.hardEntries;
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      maxHistory: hardLimit + 1000,
      onUndo: async () => {},
      onRedo: async () => {},
    }),
  );

  act(() => {
    for (let index = 0; index < hardLimit - 1; index += 1) {
      result.current.push({
        ...historyEntry,
        description: `Operation ${index}`,
      });
    }
  });
  assert.equal(result.current.undoStack.length, hardLimit - 1);

  act(() =>
    result.current.push({
      ...historyEntry,
      description: `Operation ${hardLimit - 1}`,
    }),
  );
  assert.equal(result.current.undoStack.length, hardLimit);

  act(() =>
    result.current.push({
      ...historyEntry,
      description: `Operation ${hardLimit}`,
    }),
  );
  assert.equal(result.current.undoStack.length, hardLimit);
  assert.equal(result.current.undoStack.at(-1)?.description, "Operation 1");

  act(() => result.current.clear());
  assert.equal(result.current.undoStack.length, 0);
  assert.equal(result.current.redoStack.length, 0);
});

test("locks every history mutation during deferred undo and commits one branch on success", async () => {
  const pending = deferredPromise();
  let undoAttempts = 0;
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      onUndo: async () => {
        undoAttempts += 1;
        await pending.promise;
      },
      onRedo: async () => {},
    }),
  );

  act(() => {
    result.current.push({ ...historyEntry, description: "First" });
    result.current.push({ ...historyEntry, description: "Second" });
  });
  const secondId = result.current.undoStack[0]?.id;
  let undoPromise!: Promise<void>;
  act(() => {
    undoPromise = result.current.undo();
    result.current.push({ ...historyEntry, description: "Ignored branch" });
    result.current.clear();
    void result.current.undo();
    void result.current.redo();
  });

  assert.equal(undoAttempts, 1);
  assert.deepEqual(
    result.current.undoStack.map((entry) => entry.description),
    ["Second", "First"],
  );
  assert.equal(result.current.redoStack.length, 0);

  await act(async () => {
    pending.resolve();
    await undoPromise;
  });

  assert.equal(undoAttempts, 1);
  assert.deepEqual(
    result.current.undoStack.map((entry) => entry.description),
    ["First"],
  );
  assert.equal(result.current.redoStack[0]?.id, secondId);
});

test("locks every history mutation during deferred redo and preserves the branch on rejection", async () => {
  const pending = deferredPromise();
  let redoAttempts = 0;
  const { result } = renderHook(() =>
    useUndoRedo<TestOperation>({
      onUndo: async () => {},
      onRedo: async () => {
        redoAttempts += 1;
        await pending.promise;
      },
    }),
  );

  act(() => result.current.push(historyEntry));
  await act(async () => result.current.undo());
  const redoId = result.current.redoStack[0]?.id;

  let redoPromise!: Promise<void>;
  act(() => {
    redoPromise = result.current.redo();
    result.current.push({ ...historyEntry, description: "Ignored branch" });
    result.current.clear();
    void result.current.undo();
    void result.current.redo();
  });
  assert.equal(redoAttempts, 1);

  await act(async () => {
    pending.reject(new Error("deferred password=redo-secret"));
    await redoPromise;
  });

  assert.equal(redoAttempts, 1);
  assert.equal(result.current.undoStack.length, 0);
  assert.equal(result.current.redoStack[0]?.id, redoId);
  assert.doesNotMatch(getRuntimeDiagnostics()[0]?.message ?? "", /redo-secret/);
});

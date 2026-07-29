import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render } from "@testing-library/react";

import { RuntimeErrorListener } from "../src/components/layout/RuntimeErrorListener";
import {
  getToastRuntimeSnapshot,
  resetToastRuntimeForTests,
  toast,
  TOAST_LIMIT,
  useToast,
} from "../src/hooks/use-toast";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import {
  createTrackedRuntimeResources,
  type RuntimeResourceHost,
  withObjectUrl,
} from "../src/lib/runtime/resource-scope";

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  resetRuntimeReportingForTests();
});

function createFakeRuntimeHost() {
  let nextId = 1;
  const timeouts = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const host: RuntimeResourceHost = {
    setTimeout(callback) {
      const id = nextId++;
      timeouts.set(id, callback as () => void);
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };

  return {
    host,
    timeouts,
    frames,
    runTimeout(id: number) {
      const callback = timeouts.get(id);
      assert.ok(callback);
      timeouts.delete(id);
      callback();
    },
    runFrame(id: number) {
      const callback = frames.get(id);
      assert.ok(callback);
      frames.delete(id);
      callback(0);
    },
  };
}

test("tracked timers and animation frames do not survive repeated disposal", () => {
  const fake = createFakeRuntimeHost();

  for (let cycle = 0; cycle < 25; cycle += 1) {
    const resources = createTrackedRuntimeResources(fake.host);
    resources.setTimeout(() => {}, 1000);
    resources.requestAnimationFrame(() => {});

    assert.deepEqual(resources.snapshot(), {
      timeouts: 1,
      animationFrames: 1,
    });
    resources.dispose();
    resources.dispose();

    assert.deepEqual(resources.snapshot(), {
      timeouts: 0,
      animationFrames: 0,
    });
    assert.equal(fake.timeouts.size, 0);
    assert.equal(fake.frames.size, 0);
  }

  const resources = createTrackedRuntimeResources(fake.host);
  const timeoutId = resources.setTimeout(() => {}, 1000);
  const frameId = resources.requestAnimationFrame(() => {});
  fake.runTimeout(timeoutId);
  fake.runFrame(frameId);
  assert.deepEqual(resources.snapshot(), {
    timeouts: 0,
    animationFrames: 0,
  });
});

function ToastSubscriber() {
  useToast();
  return null;
}

test("toast subscribers and removal timers stay bounded across lifecycles", () => {
  for (let cycle = 0; cycle < 25; cycle += 1) {
    const view = render(<ToastSubscriber />);
    assert.equal(getToastRuntimeSnapshot().listeners, 1);
    view.unmount();
    assert.equal(getToastRuntimeSnapshot().listeners, 0);
  }

  const evicted = toast({ title: "evicted" });
  evicted.dismiss();
  assert.equal(getToastRuntimeSnapshot().removalTimers, 1);

  for (let index = 0; index <= TOAST_LIMIT; index += 1) {
    toast({ title: `replacement ${index}` });
  }

  assert.equal(getToastRuntimeSnapshot().toasts, TOAST_LIMIT);
  assert.equal(getToastRuntimeSnapshot().removalTimers, 0);
  resetToastRuntimeForTests();
  assert.deepEqual(getToastRuntimeSnapshot(), {
    listeners: 0,
    removalTimers: 0,
    toasts: 0,
  });
});

test("runtime listener subscriptions are removed on every unmount", () => {
  for (let cycle = 0; cycle < 25; cycle += 1) {
    const view = render(<RuntimeErrorListener />);
    view.unmount();
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error(`post-unmount ${cycle}`),
        message: `post-unmount ${cycle}`,
      }),
    );
    assert.equal(getRuntimeDiagnostics().length, 0);
  }
});

test("object URLs are revoked even when their consumer throws", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const urlApi = {
    createObjectURL() {
      const url = `blob:test-${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL(url: string) {
      revoked.push(url);
    },
  };

  for (let cycle = 0; cycle < 25; cycle += 1) {
    assert.throws(
      () =>
        withObjectUrl(
          new Blob([String(cycle)]),
          () => {
            throw new Error("download failed");
          },
          urlApi,
        ),
      /download failed/,
    );
  }

  assert.deepEqual(revoked, created);
});

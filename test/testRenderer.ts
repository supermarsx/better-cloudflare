import type { ReactElement } from "react";
import { act, create as createRenderer } from "react-test-renderer";

const nodeMockLog: { count: number } = {
  count: 0,
};

type HostNodeMock = {
  children: unknown[];
  appendChild?: (child: unknown) => void;
  removeChild?: (child: unknown) => void;
  nodeType?: number;
};

function createNodeMock({ type }: { type: unknown }) {
  nodeMockLog.count += 1;
  const mockNode = document.createElement(
    typeof type === "string" && type.length > 0 ? type : "div",
  );
  (mockNode as Record<string, unknown>).__testMockId = nodeMockLog.count;

  try {
    Object.defineProperty(mockNode, "children", {
      value: [],
      writable: true,
      configurable: true,
    });
  } catch {
    // Keep a best effort shim for environments that do not allow overriding.
  }

  return mockNode as unknown as HostNodeMock;
}

type CreateOptions = Parameters<typeof createRenderer>[1];

function createWithDefaults<T>(options?: T): T {
  if (options && (options as { createNodeMock?: unknown }).createNodeMock) {
    return options;
  }
  return {
    ...(options as Record<string, unknown>),
    createNodeMock,
  } as T;
}

export { act };
export const create = (node: ReactElement, options?: CreateOptions) => {
  let renderer: ReturnType<typeof createRenderer>;
  act(() => {
    renderer = createRenderer(node, createWithDefaults(options));
  });
  return renderer!;
};

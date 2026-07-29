import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedResourceCount,
  readBoundedResponseText,
  RESOURCE_LIMITS,
  ResponseBodyLimitError,
  truncateUtf8,
  utf8ByteLength,
} from "../src/lib/resource-limits";

function streamingResponse(
  text: string,
  onCancel: () => void,
  headers?: HeadersInit,
): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(bytes);
      },
      cancel() {
        onCancel();
      },
    }),
    { headers },
  );
}

test("bounded response reading accepts limit-1 and exact limit, then cancels at limit+1", async () => {
  let cancellations = 0;
  assert.equal(
    await readBoundedResponseText(
      streamingResponse("1234", () => {
        cancellations += 1;
      }),
      5,
    ),
    "1234",
  );
  assert.equal(
    await readBoundedResponseText(
      streamingResponse("12345", () => {
        cancellations += 1;
      }),
      5,
    ),
    "12345",
  );
  await assert.rejects(
    () =>
      readBoundedResponseText(
        streamingResponse("123456", () => {
          cancellations += 1;
        }),
        5,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResponseBodyLimitError);
      assert.equal(error.limitBytes, 5);
      assert.equal(error.observedBytes, 6);
      return true;
    },
  );
  assert.equal(cancellations, 1);
});

test("rejects Content-Length before reading and cancels the reader", async () => {
  let cancellations = 0;
  const response = streamingResponse(
    "small",
    () => {
      cancellations += 1;
    },
    { "content-length": "6" },
  );

  await assert.rejects(
    () => readBoundedResponseText(response, 5),
    (error: unknown) => {
      assert.ok(error instanceof ResponseBodyLimitError);
      assert.equal(error.declaredBytes, 6);
      return true;
    },
  );
  assert.equal(cancellations, 1);
});

test("rejects a non-streamable response-like body before calling unbounded text()", async () => {
  let textCalls = 0;
  const responseLike = {
    body: undefined,
    headers: new Headers({ "content-length": "5" }),
    text: async () => {
      textCalls += 1;
      return "x".repeat(1_000_000);
    },
  } as unknown as Response;

  await assert.rejects(
    () => readBoundedResponseText(responseLike, 5),
    (error: unknown) => {
      assert.ok(error instanceof ResponseBodyLimitError);
      assert.equal(error.limitBytes, 5);
      assert.equal(error.observedBytes, undefined);
      assert.equal(error.declaredBytes, undefined);
      return true;
    },
  );
  assert.equal(textCalls, 0);
});

test("UTF-8 truncation respects byte boundaries without splitting Unicode", () => {
  assert.equal(truncateUtf8("abcd", 5), "abcd");
  assert.equal(truncateUtf8("abcde", 5), "abcde");
  assert.equal(truncateUtf8("abcdef", 5), "abcde");
  assert.equal(truncateUtf8("A😀B", 5), "A😀");
  assert.equal(truncateUtf8("A😀B", 4), "A");
  assert.equal(utf8ByteLength(truncateUtf8("é😀tail", 5)), 2);
});

test("resource-limit helpers reject invalid byte limits and normalize counts", async () => {
  assert.throws(() => truncateUtf8("value", Number.NaN), RangeError);
  assert.throws(() => truncateUtf8("value", 1.5), RangeError);

  for (const invalidLimit of [
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    RESOURCE_LIMITS.responseBody.hardBytes + 1,
  ]) {
    await assert.rejects(
      () => readBoundedResponseText(new Response("value"), invalidLimit),
      RangeError,
    );
  }

  assert.equal(boundedResourceCount(undefined, 50, 100), 50);
  assert.equal(boundedResourceCount(Number.NaN, 50, 100), 50);
  assert.equal(boundedResourceCount(Number.POSITIVE_INFINITY, 50, 100), 50);
  assert.equal(boundedResourceCount(-1, 50, 100), 0);
  assert.equal(boundedResourceCount(99.9, 50, 100), 99);
  assert.equal(boundedResourceCount(101, 50, 100), 100);
  assert.throws(() => boundedResourceCount(1, 101, 100), RangeError);
});

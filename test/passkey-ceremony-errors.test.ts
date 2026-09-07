/**
 * What the user is told when a passkey ceremony fails.
 *
 * This carries more weight than it used to. The client probe no longer
 * withholds the buttons when it cannot see an authenticator, so a user with
 * only a security key — or on a webview that under-reports Windows Hello —
 * now reaches a real ceremony, and this message is the whole of what they
 * learn from it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  webauthnCeremonyMessage,
  webauthnErrorName,
} from "../src/lib/auth/passkey-error";

/**
 * The shape the browser actually throws.
 *
 * Node's `DOMException` is used rather than a hand-rolled object precisely so
 * this cannot pass against an implementation that reads the wrong field.
 */
function domException(name: string, message = "something went wrong") {
  return new DOMException(message, name);
}

test("a DOMException is identified by its name, which its message never contains", () => {
  // The bug this guards. Chromium's NotAllowedError message is "The operation
  // either timed out or was not allowed." — the name appears nowhere in it, so
  // the substring matching that used to do this job could never have fired.
  const error = domException(
    "NotAllowedError",
    "The operation either timed out or was not allowed.",
  );
  assert.equal(error.message.includes("NotAllowedError"), false);
  assert.equal(webauthnErrorName(error), "NotAllowedError");
});

test("a backend string or record has no name to read", () => {
  // These arrive over IPC and carry the backend's own explanation, which must
  // not be replaced by a guess.
  assert.equal(webauthnErrorName("challenge expired"), null);
  assert.equal(webauthnErrorName({ message: "challenge expired" }), null);
  assert.equal(webauthnErrorName(null), null);
  assert.equal(webauthnErrorName({ name: "not-an-error-name" }), null);
});

test("a dismissed prompt is not reported as the user cancelling", () => {
  // Chromium reports a dismissed prompt, an expired one, and one that never
  // appeared identically, so the message has to cover all three rather than
  // accusing the user of something they may not have done.
  for (const ceremony of ["register", "authenticate"] as const) {
    const message = webauthnCeremonyMessage(
      domException("NotAllowedError"),
      ceremony,
    );
    assert.match(message ?? "", /dismissed, timed out, or refused/i);
    assert.match(message ?? "", /if no prompt appeared/i);
  }
});

test("registration names the already-enrolled case that only it can hit", () => {
  // InvalidStateError is reachable only through excludeCredentials, so it means
  // exactly one thing and only during registration.
  assert.match(
    webauthnCeremonyMessage(domException("InvalidStateError"), "register") ??
      "",
    /already has a passkey for this API key/i,
  );
  assert.equal(
    webauthnCeremonyMessage(domException("InvalidStateError"), "authenticate"),
    null,
  );
});

test("each remaining client failure gets its own message", () => {
  const messages = new Map<string, string>();
  for (const name of [
    "NotSupportedError",
    "SecurityError",
    "AbortError",
    "ConstraintError",
    "UnknownError",
  ]) {
    const message = webauthnCeremonyMessage(domException(name), "register");
    assert.ok(message, `${name} produced no message`);
    messages.set(name, message);
  }

  assert.equal(
    new Set(messages.values()).size,
    messages.size,
    "two client failures share a message, which makes one of them unactionable",
  );
  assert.match(messages.get("ConstraintError") ?? "", /user-verification/i);
  assert.match(messages.get("SecurityError") ?? "", /secure context/i);
});

test("an unrecognised failure falls through to the backend's own explanation", () => {
  // Returning a generic string here would bury the one message that knows what
  // actually happened.
  assert.equal(
    webauthnCeremonyMessage(domException("SomeFutureError"), "register"),
    null,
  );
  assert.equal(
    webauthnCeremonyMessage("the challenge expired", "authenticate"),
    null,
  );
  assert.equal(
    webauthnCeremonyMessage({ message: "no credentials on file" }, "register"),
    null,
  );
});

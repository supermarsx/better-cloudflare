import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { LoginPasskeySection } from "../src/components/auth/login-form/LoginPasskeySection";
import type { PasskeyStatusState } from "../src/lib/auth/passkey-status";

const unavailableStatus: PasskeyStatusState = {
  kind: "unavailable",
  cause: "backend",
  registration: false,
  legacyRecoveryAvailable: true,
  reason: "The passkey relying party has not been configured for this session.",
};

afterEach(() => {
  cleanup();
});

test("LoginPasskeySection hides when no keys", () => {
  const { container } = render(
    <LoginPasskeySection
      onRegisterPasskey={() => {}}
      onUsePasskey={() => {}}
      registerLoading={false}
      authLoading={false}
      selectedKeyId=""
      password=""
      hasKeys={false}
      status={unavailableStatus}
    />,
  );
  assert.equal(container.firstChild, null);
});

test("LoginPasskeySection shows the unavailable notice and withholds both ceremonies", () => {
  render(
    <LoginPasskeySection
      onRegisterPasskey={() => {}}
      onUsePasskey={() => {}}
      registerLoading={false}
      authLoading={false}
      selectedKeyId=""
      password=""
      hasKeys={true}
      status={unavailableStatus}
    />,
  );
  assert.ok(screen.getByRole("alert"));
  assert.ok(screen.getByText(/relying party has not been configured/i));
  assert.equal(
    screen.queryByRole("button", { name: /register passkey/i }),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
});

test("LoginPasskeySection still explains a status IPC failure", () => {
  // Legacy recovery itself now lives in the settings dialog, but the reason it
  // is on offer has to reach the user somewhere, and this is the surface they
  // are looking at when a ceremony they expected is missing.
  render(
    <LoginPasskeySection
      onRegisterPasskey={() => {}}
      onUsePasskey={() => {}}
      registerLoading={false}
      authLoading={false}
      selectedKeyId="key1"
      password="pw"
      hasKeys={true}
      status={{
        kind: "error",
        legacyRecoveryAvailable: true,
        reason:
          "get_passkey_status failed: legacy credential recovery remains available.",
      }}
    />,
  );

  assert.ok(screen.getByRole("alert"));
  assert.ok(screen.getByText(/legacy credential recovery remains available/i));
});

test("LoginPasskeySection stops claiming unavailability once passkeys are available", () => {
  render(
    <LoginPasskeySection
      onRegisterPasskey={() => {}}
      onUsePasskey={() => {}}
      registerLoading={false}
      authLoading={false}
      selectedKeyId="key1"
      password="pw"
      hasKeys={true}
      status={{
        kind: "available",
        registration: true,
        authentication: true,
        legacyRecoveryAvailable: false,
        native: false,
        advisory: null,
      }}
    />,
  );

  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.queryByRole("status"), null);
  assert.equal(screen.queryByText(/passkeys temporarily unavailable/i), null);
});

// ── The available branch, and the causes that are not the backend's ─────────
//
// The point of the status union is that these situations have different
// remedies. A test that only asserted "some alert is shown" would pass just as
// well against the single generic message the union replaced, so each of these
// pins the specific wording its own state produces.

const availableStatus: PasskeyStatusState = {
  kind: "available",
  registration: true,
  authentication: true,
  legacyRecoveryAvailable: false,
  native: false,
  advisory: null,
};

function renderSection(
  overrides: Partial<React.ComponentProps<typeof LoginPasskeySection>> = {},
) {
  const props: React.ComponentProps<typeof LoginPasskeySection> = {
    onRegisterPasskey: () => {},
    onUsePasskey: () => {},
    registerLoading: false,
    authLoading: false,
    selectedKeyId: "key1",
    password: "pw",
    hasKeys: true,
    status: availableStatus,
    ...overrides,
  };
  return render(<LoginPasskeySection {...props} />);
}

test("LoginPasskeySection offers both ceremonies when passkeys are available", () => {
  let registered = 0;
  let used = 0;
  renderSection({
    onRegisterPasskey: () => {
      registered += 1;
    },
    onUsePasskey: () => {
      used += 1;
    },
  });

  const register = screen.getByRole("button", { name: /register passkey/i });
  const use = screen.getByRole("button", { name: /use passkey/i });
  assert.equal(register.hasAttribute("disabled"), false);
  assert.equal(use.hasAttribute("disabled"), false);

  register.click();
  use.click();
  assert.equal(registered, 1);
  assert.equal(used, 1);
});

test("LoginPasskeySection requires a password to register but not to sign in", () => {
  renderSection({ password: "" });

  assert.equal(
    screen
      .getByRole("button", { name: /register passkey/i })
      .hasAttribute("disabled"),
    true,
  );
  assert.equal(
    screen
      .getByRole("button", { name: /use passkey/i })
      .hasAttribute("disabled"),
    false,
  );
});

test("LoginPasskeySection disables both ceremonies while one is in flight", () => {
  renderSection({ authLoading: true });

  assert.equal(
    screen
      .getByRole("button", { name: /register passkey/i })
      .hasAttribute("disabled"),
    true,
  );
  const use = screen.getByRole("button", { name: /signing in/i });
  assert.equal(use.hasAttribute("disabled"), true);
});

test("LoginPasskeySection shows registration progress on the register button", () => {
  renderSection({ registerLoading: true });

  const register = screen.getByRole("button", { name: /registering/i });
  assert.equal(register.hasAttribute("disabled"), true);
});

test("LoginPasskeySection hides sign-in but keeps registration for legacy credentials", () => {
  renderSection({
    status: {
      kind: "unavailable",
      cause: "legacy-credentials",
      registration: true,
      legacyRecoveryAvailable: true,
      reason:
        "Your existing passkeys were enrolled before verified registration and can no longer be used to sign in. Register a new passkey to replace them.",
    },
  });

  // Registering is the way out of this state, so it must not be gated by it.
  assert.ok(screen.getByRole("button", { name: /register passkey/i }));
  assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
  assert.ok(screen.getByText(/need re-registering/i));
});

test("LoginPasskeySection names the platform limitation rather than a generic fault", () => {
  renderSection({
    status: {
      kind: "unavailable",
      cause: "webview",
      registration: false,
      legacyRecoveryAvailable: false,
      reason:
        "This platform's webview does not provide WebAuthn, so passkeys cannot be used in this app. Sign in with your password instead.",
    },
  });

  assert.ok(screen.getByText(/not supported on this platform/i));
  assert.equal(screen.queryByText(/temporarily unavailable/i), null);
  assert.equal(
    screen.queryByRole("button", { name: /register passkey/i }),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
});

test("LoginPasskeySection separates an insecure origin from an absent WebAuthn build", () => {
  renderSection({
    status: {
      kind: "unavailable",
      cause: "insecure-origin",
      registration: false,
      legacyRecoveryAvailable: false,
      reason:
        "This window is not a secure context, so the browser withholds WebAuthn entirely. Passkeys cannot be used here. Sign in with your password instead.",
    },
  });

  assert.ok(screen.getByText(/passkeys need a secure context/i));
  assert.equal(screen.queryByText(/not supported on this platform/i), null);
});

test("LoginPasskeySection keeps both ceremonies live under the no-authenticator advisory", () => {
  // The regression this pins. An undetected authenticator used to remove both
  // buttons; a security key or a phone passkey works regardless, so the state
  // is now advice printed beside two live controls.
  renderSection({
    status: {
      kind: "available",
      registration: true,
      authentication: true,
      legacyRecoveryAvailable: false,
      native: false,
      advisory: {
        cause: "no-platform-authenticator",
        reason:
          "No built-in authenticator was detected on this device. You can still register and sign in with a security key, or with a passkey on your phone.",
        detail: "built-in authenticator: no; phone over hybrid: not reported",
      },
    },
  });

  assert.ok(screen.getByText(/no built-in authenticator detected/i));
  assert.ok(screen.getByText(/security key/i));
  assert.ok(screen.getByText(/phone over hybrid: not reported/i));

  // Advice, not an alarm: the controls beside it work.
  assert.equal(screen.queryByRole("alert"), null);
  assert.ok(screen.getByRole("status"));
  assert.equal(
    screen
      .getByRole("button", { name: /register passkey/i })
      .hasAttribute("disabled"),
    false,
  );
  assert.equal(
    screen
      .getByRole("button", { name: /use passkey/i })
      .hasAttribute("disabled"),
    false,
  );
});

test("LoginPasskeySection says when the system, not the browser, will prompt", () => {
  // Worth saying out loud: on the native path the user is about to see the
  // system credential picker, which reaches security keys and phone passkeys
  // that this webview's own client could not.
  renderSection({
    status: {
      kind: "available",
      registration: true,
      authentication: true,
      legacyRecoveryAvailable: false,
      native: true,
      advisory: null,
    },
  });

  assert.match(
    document.body.textContent ?? "",
    /your system handles the prompt/i,
  );
  // And nothing is withheld or warned about.
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.queryByRole("status"), null);
  assert.ok(screen.getByRole("button", { name: /register passkey/i }));
  assert.ok(screen.getByRole("button", { name: /use passkey/i }));
});

test("LoginPasskeySection keeps the plain wording for the webview path", () => {
  renderSection();

  const text = document.body.textContent ?? "";
  assert.match(text, /instead of typing this key's password/i);
  assert.doesNotMatch(text, /your system handles the prompt/i);
});

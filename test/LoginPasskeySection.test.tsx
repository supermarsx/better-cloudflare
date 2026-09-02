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
      onManagePasskeys={() => {}}
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

test("LoginPasskeySection shows the unavailable notice and disables only legacy recovery without a key", () => {
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {}}
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
  assert.equal(
    screen
      .getByRole("button", { name: /review legacy passkeys/i })
      .hasAttribute("disabled"),
    true,
  );
});

test("LoginPasskeySection keeps legacy recovery reachable when a key is selected", () => {
  let managed = false;
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {
        managed = true;
      }}
      onRegisterPasskey={() => {}}
      onUsePasskey={() => {}}
      registerLoading={false}
      authLoading={false}
      selectedKeyId="key1"
      password="pw"
      hasKeys={true}
      status={unavailableStatus}
    />,
  );
  const recovery = screen.getByRole("button", {
    name: /review legacy passkeys/i,
  });
  assert.equal(recovery.hasAttribute("disabled"), false);
  recovery.click();
  assert.equal(managed, true);
});

test("LoginPasskeySection keeps legacy management available after status IPC failure", () => {
  let managed = false;
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {
        managed = true;
      }}
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
  const recovery = screen.getByRole("button", {
    name: /review legacy passkeys/i,
  });
  assert.equal(recovery.hasAttribute("disabled"), false);
  recovery.click();
  assert.equal(managed, true);
});

test("LoginPasskeySection stops claiming unavailability once passkeys are available", () => {
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {}}
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
      }}
    />,
  );

  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.queryByText(/passkeys temporarily unavailable/i), null);
});

// ── The available branch, and the three unavailable causes that are not the
// backend's ───────────────────────────────────────────────────────────────────
//
// The point of the status union is that these four situations have four
// different remedies. A test that only asserted "some alert is shown" would
// pass just as well against the single generic message the union replaced, so
// each of these pins the specific wording its own state produces.

const availableStatus: PasskeyStatusState = {
  kind: "available",
  registration: true,
  authentication: true,
  legacyRecoveryAvailable: false,
};

function renderSection(
  overrides: Partial<React.ComponentProps<typeof LoginPasskeySection>> = {},
) {
  const props: React.ComponentProps<typeof LoginPasskeySection> = {
    onManagePasskeys: () => {},
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
  assert.ok(screen.getByRole("button", { name: /review legacy passkeys/i }));
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

test("LoginPasskeySection tells an unenrolled device what to enrol", () => {
  renderSection({
    status: {
      kind: "unavailable",
      cause: "no-authenticator",
      registration: false,
      legacyRecoveryAvailable: false,
      reason:
        "No passkey authenticator is set up on this device. Enrol Windows Hello, Touch ID, or a device passcode, then try again.",
    },
  });

  assert.ok(screen.getByText(/no passkey authenticator on this device/i));
  assert.ok(screen.getByText(/enrol windows hello/i));
  assert.equal(
    screen.queryByRole("button", { name: /register passkey/i }),
    null,
  );
});

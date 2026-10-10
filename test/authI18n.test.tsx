/**
 * The auth dialogs actually show the translations this project paid for.
 *
 * `EditKeyDialog` was 127 lines with zero `t()` calls, rendering nine English
 * literals — every one of which was *already* a key in `en-US.json` and
 * already translated into all eleven other locales across six rounds of
 * translation work. The translations existed; the dialog rendered English.
 * `AddKeyDialog` and `EncryptionSettingsDialog` were in the same state.
 *
 * Nothing caught it, and nothing could have. `auditCoverage` in
 * `scripts/i18n-coverage.mjs` reports strings in code that are missing from
 * the catalogue, never the reverse, so a catalogued key with no call site is
 * invisible to every existing gate. The only thing that distinguishes "wired
 * up" from "hard-coded English" is rendering the component under a locale that
 * is not English and looking at what comes out, which is what this file does.
 *
 * A test that counted `t(` call sites instead would re-implement the scanner
 * and could not dissent: it would have passed on the day these dialogs shipped
 * in English if the strings had merely been listed somewhere.
 *
 * ## Why the expected French is read from `fr-FR.json` rather than inlined
 *
 * Pinning "Modifier la clé API" in this file would make the suite a hostage to
 * the translators: any reword of a French value — routine work, and in flight
 * right now — would fail a test that has nothing to say about wording. So the
 * catalogue supplies the expectation and this file supplies the claim, which is
 * the one the component controls: *whatever* French the catalogue holds is the
 * French that reaches the screen, and the English does not.
 *
 * ## Why the English-leak check throws keys away
 *
 * That shape can go vacuous, in two ways that both really occur here:
 *
 * - **A French value equal to its key.** "Benchmark" is "Benchmark" in French,
 *   so rendering it proves nothing about which of the two produced it.
 * - **A French value containing its key.** "Algorithm" is "Algorithme", so a
 *   leak check for the substring "Algorithm" fires on correct output. Nine
 *   keys' worth of a naive check passed and this one failed, which is how the
 *   rule below got written.
 *
 * So each suite counts the keys that can actually tell the two apart and
 * refuses to pass on too few of them, rather than quietly asserting nothing.
 *
 * Absence is asserted on strings (`assert.ok(!text.includes(…))`), never with
 * `assert.equal(queryBy…, null)` — the latter serialises the whole jsdom tree
 * to build its diff and takes the worker down instead of failing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";

import { AddKeyDialog } from "../src/components/auth/AddKeyDialog";
import { EditKeyDialog } from "../src/components/auth/EditKeyDialog";
import { EncryptionSettingsDialog } from "../src/components/auth/EncryptionSettingsDialog";
import { LoginForm } from "../src/components/auth/LoginForm";
import { Toaster } from "../src/components/ui/toaster";
import { useLoginForm } from "../src/hooks/auth/use-login-form";
import { ServerClient } from "../src/lib/api/server-client";
import { TauriClient } from "../src/lib/api/tauri-client";
import type { EncryptionConfig } from "../src/types/dns";
import i18n from "../src/i18n";
import { waitForI18nInitialization } from "./i18n-ready";

/**
 * A `URL` rather than a joined path: `readFileSync` takes one directly, so
 * there is no separator to get wrong and no Windows backslash to escape.
 */
const FRENCH: Record<string, string> = JSON.parse(
  readFileSync(new URL("../src/locales/fr-FR.json", import.meta.url), "utf8"),
);

interface Subject {
  /** Component name, for assertion messages. */
  name: string;
  render: () => void;
  /**
   * Strings this component renders that are already in `en-US.json` and
   * already translated in all eleven other locales. Wiring them cost no
   * translation work, which is why they are the priority.
   */
  catalogued: readonly string[];
  /**
   * Strings this component renders that reach `t()` but have **no** entry in
   * `en-US.json`, so i18next serves the default in every locale. Listed apart
   * because each one costs eleven translations.
   */
  uncatalogued: readonly string[];
  /**
   * How many catalogued keys must survive the vacuity filter. Set below the
   * current count so a translator reword does not fail this file, but high
   * enough that a wholesale regression does.
   */
  minDistinguishing: number;
}

const ENCRYPTION_SETTINGS: EncryptionConfig = {
  iterations: 100_000,
  keyLength: 256,
  algorithm: "AES-GCM",
};

const SUBJECTS: readonly Subject[] = [
  {
    name: "EditKeyDialog",
    render: () =>
      void render(
        <EditKeyDialog
          open
          onOpenChange={() => {}}
          label=""
          onLabelChange={() => {}}
          email=""
          onEmailChange={() => {}}
          currentPassword=""
          onCurrentPasswordChange={() => {}}
          newPassword=""
          onNewPasswordChange={() => {}}
          onSave={() => {}}
        />,
      ),
    catalogued: [
      "Edit API Key",
      "Update key details or change its encryption password",
      "Label",
      "Account Email (optional)",
      "Current Password",
      "New Password (optional)",
      "Save Changes",
      // Placeholders. They live in an attribute, so `textContent` alone does
      // not see them and an early version of this test passed while two of
      // them were still hard-coded.
      "Required to change password",
      "Leave blank to keep current",
    ],
    // Were `uncatalogued` until round 7 translated them. Moved here by the
    // mechanism this test was built to provide: the fr-FR assertion below
    // noticed they had acquired a French value and said so by name.
    uncatalogued: [],
    minDistinguishing: 7,
  },
  {
    name: "AddKeyDialog",
    render: () =>
      void render(
        <AddKeyDialog
          open
          onOpenChange={() => {}}
          label=""
          onLabelChange={() => {}}
          apiKey=""
          onApiKeyChange={() => {}}
          email=""
          onEmailChange={() => {}}
          password=""
          onPasswordChange={() => {}}
          onAdd={() => {}}
        />,
      ),
    catalogued: [
      "Add New API Key",
      "Add a new Cloudflare API key with a custom label",
      "Label",
      "API Key",
      "Account Email (optional for global keys)",
      "Encryption Password",
      "Add API Key",
      "Your Cloudflare API key",
      "Password to encrypt this key",
    ],
    // Were `uncatalogued` until round 7 translated them. Moved here by the
    // mechanism this test was built to provide: the fr-FR assertion below
    // noticed they had acquired a French value and said so by name.
    uncatalogued: [],
    minDistinguishing: 7,
  },
  {
    name: "EncryptionSettingsDialog",
    render: () =>
      void render(
        <EncryptionSettingsDialog
          open
          onOpenChange={() => {}}
          settings={ENCRYPTION_SETTINGS}
          onSettingsChange={() => {}}
          onBenchmark={() => {}}
          onUpdate={() => {}}
          benchmarkResult={null}
          vaultEnabled
          onVaultEnabledChange={() => {}}
          onRemoveVaultSecret={() => {}}
          onManagePasskeys={() => {}}
          legacyRecoveryAvailable
          canUseSelectedKey
        />,
      ),
    catalogued: [
      "Encryption Settings",
      "Configure encryption parameters for security and performance",
      "PBKDF2 Iterations",
      "Key Length (bits)",
      // "Algorithm" and "Benchmark" are deliberately here even though the
      // vacuity filter will drop both — "Algorithme" contains the English and
      // "Benchmark" *is* the English. Listing them keeps this the full set of
      // catalogued strings on the screen rather than the subset that happens
      // to be convenient to assert.
      "Algorithm",
      "Benchmark",
      "Update",
      "Enable OS Vault",
      "Store decrypted keys in the system vault for passkey login.",
      "Remove Vault Secret",
    ],
    // Only the three that render with these props. "Select a key and enter its
    // password to enable these." needs `canUseSelectedKey: false`, the vault
    // warning needs `vaultEnabled: false`, and the two interpolated keys carry
    // `{{…}}` slots that no fixed string can match.
    // Also emptied by round 7. The three that were here — "Key maintenance",
    // "These act on the key selected…" and "Review legacy passkeys" — are
    // catalogued and translated now, and the comment above still explains why
    // they cannot join `catalogued`: two need props this fixture does not set
    // and the interpolated pair carry `{{…}}` slots no fixed string matches.
    // So they are checked by the coverage gate rather than here.
    uncatalogued: [],
    minDistinguishing: 6,
  },
];

beforeEach(async () => {
  await waitForI18nInitialization();
});

afterEach(async () => {
  cleanup();
  mock.restoreAll();
  // Leave the locale as the rest of the suite expects to find it; a stray
  // fr-FR here surfaces as an unrelated file's assertions reading French.
  await i18n.changeLanguage("en-US");
});

/**
 * Everything the component puts in front of someone: rendered text plus every
 * `placeholder` attribute, joined into one haystack.
 *
 * Reads `document.body` rather than the subtree `render` returns, because a
 * dialog portals out of it.
 */
function visibleText(): string {
  const parts = [document.body.textContent ?? ""];
  for (const node of document.body.querySelectorAll("[placeholder]")) {
    parts.push(node.getAttribute("placeholder") ?? "");
  }
  return parts.join("\n");
}

/**
 * The keys whose English and French are actually distinguishable — see the
 * file header. A key the filter drops is not evidence of anything either way.
 */
function distinguishingKeys(keys: readonly string[]): string[] {
  const frenchText = keys.map((key) => FRENCH[key] ?? "").join("\n");
  return keys.filter(
    (key) => FRENCH[key] !== undefined && !frenchText.includes(key),
  );
}

for (const subject of SUBJECTS) {
  test(`${subject.name} renders every catalogued string in French under fr-FR`, async () => {
    await i18n.changeLanguage("fr-FR");
    subject.render();
    const text = visibleText();

    const missing: string[] = [];
    for (const key of subject.catalogued) {
      const expected = FRENCH[key];
      assert.ok(
        typeof expected === "string" && expected.length > 0,
        `fr-FR.json has no value for ${JSON.stringify(key)}, so this test cannot check it. Either the key was renamed in the catalogue or the French file regressed.`,
      );
      if (!text.includes(expected)) {
        missing.push(`${JSON.stringify(key)} -> ${JSON.stringify(expected)}`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `${subject.name} did not render the French value for these keys, which means the string is hard-coded English rather than going through t():\n  ${missing.join("\n  ")}`,
    );
  });

  test(`no catalogued English leaks into ${subject.name} under fr-FR`, async () => {
    await i18n.changeLanguage("fr-FR");
    subject.render();
    const text = visibleText();

    const distinguishing = distinguishingKeys(subject.catalogued);
    assert.ok(
      distinguishing.length >= subject.minDistinguishing,
      `only ${distinguishing.length} of ${subject.catalogued.length} ${subject.name} keys have a French value that can be told apart from the English, which is below the floor of ${subject.minDistinguishing} and too few for this test to prove anything. Dropped: ${subject.catalogued.filter((key) => !distinguishing.includes(key)).join(", ")}`,
    );

    const leaked = distinguishing.filter((key) => text.includes(key));
    assert.deepEqual(
      leaked,
      [],
      `these strings appeared in English while the locale was fr-FR, so they are hard-coded in ${subject.name}:\n  ${leaked.map((key) => JSON.stringify(key)).join("\n  ")}`,
    );
  });

  test(`${subject.name} still renders its English defaults under en-US`, async () => {
    await i18n.changeLanguage("en-US");
    subject.render();
    const text = visibleText();

    // Guards the second argument of every `t()` call, including the strings
    // with no catalogue entry, which have nothing but the default to fall back
    // on in any locale.
    const missing = [...subject.catalogued, ...subject.uncatalogued].filter(
      (english) => !text.includes(english),
    );
    assert.deepEqual(
      missing,
      [],
      `${subject.name} lost these English strings. A t() call with a missing or mistyped default renders empty rather than falling back:\n  ${missing.join("\n  ")}`,
    );
  });

  test(`${subject.name}'s uncatalogued strings fall back to English under fr-FR`, async () => {
    await i18n.changeLanguage("fr-FR");
    subject.render();
    const text = visibleText();

    // Not an endorsement — a record. These reach `t()` but have no entry in
    // `en-US.json`, so i18next serves the default in every locale. When the
    // translators pick them up, the second assertion is what will notice, and
    // the key should then move into `catalogued` to be checked like the rest.
    for (const english of subject.uncatalogued) {
      // Translated-check first, deliberately. These two assertions were the
      // other way round, and in the case this test exists to catch — a
      // translator picking the string up — the `includes` one fired first and
      // reported "It rendered as neither", which describes the symptom and
      // names no action. The informative failure has to come first or the
      // actionable message is never reached. Pointed out by the fr-FR
      // translator, whose round tripped exactly this path for five keys.
      assert.ok(
        FRENCH[english] === undefined,
        `${JSON.stringify(english)} now has a French translation. Move it from ${subject.name}'s uncatalogued list into its catalogued list so it is checked like every other string instead of being pinned as untranslated here.`,
      );
      assert.ok(
        text.includes(english),
        `${JSON.stringify(english)} is not in en-US.json, so fr-FR cannot translate it and t() must serve the English default. It rendered as neither.`,
      );
    }
  });
}

/* ------------------------------------------------------------------------- *
 * src/hooks/auth/use-login-form.ts
 *
 * The widest instance of this defect in the codebase, and the one that
 * survived six translation rounds because every heuristic passes on it: the
 * file imports i18next, binds its own `t` at line 38, and *uses* it — in three
 * handlers. So "Vault secret removed" was translated while "Logged in
 * successfully" and 34 other catalogued, already-translated strings rendered
 * English in all twelve locales, through the same `t`, in the same file.
 *
 * ## Why the French claims are driven through the hook rather than clicked
 *
 * The tests below are deliberately split, because neither claim can be made by
 * the other and collapsing them would hide which one is actually proven.
 *
 * The first mounts the **real `LoginForm`** and proves the whole chain:
 * component mounts hook, hook calls `t()`, toast reaches the DOM. It cannot
 * prove translation — the only toast that fires on mount with no interaction
 * is a bootstrap failure, whose key is new in this commit and so reads English
 * in every locale until the translators land.
 *
 * The French claims are made against the hook directly, which is the idiom
 * `test/LoginForm.test.tsx` already uses for it. That is not a convenience:
 * every catalogued toast in this hook sits behind a guard the UI cannot reach.
 * `handleLogin`'s empty-state guard is the clearest case — the Login button is
 * `disabled={isLoading || !selectedKeyId || !password}`, the *same* condition
 * as the guard, so no click can ever produce that toast. The others need a
 * Radix `Select` driven through a portal with pointer events. The hook is
 * where these strings live and where the `t` binding under test is, so it is
 * what gets exercised.
 * ------------------------------------------------------------------------- */

/** One key present, nothing else available — enough for the hook to settle. */
function mockDesktopBootstrap() {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100_000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({
    vault_enabled: false,
  }));
  mock.method(TauriClient, "getApiKeys", async () => [
    { id: "desktop-key", label: "Desktop key", encrypted_key: "ciphertext" },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));
  mock.method(ServerClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none" as const,
  }));
}

test("a use-login-form toast reaches the screen from the real LoginForm", async () => {
  // The chain, not the translation — see the block comment above.
  await i18n.changeLanguage("fr-FR");
  mockDesktopBootstrap();
  mock.method(TauriClient, "getEncryptionSettings", async () => {
    throw new Error("no settings");
  });

  render(
    <>
      <LoginForm onLogin={() => {}} desktop />
      <Toaster />
    </>,
  );

  // Asserted against the **French** value, not the English. This looked for
  // "Encryption settings unavailable" and passed only because fr-FR had no
  // translation of that key — so the assertion was really checking that the
  // string was untranslated, under a name that says it checks the chain. Round
  // 7 translated it and the test went red while the code it covers was
  // correct. Diagnosed by the fr-FR and hi-IN translators, who both baselined
  // it and said it was not about any locale file.
  //
  // Reading the expected text out of `FRENCH` makes the assertion stronger
  // than the English one was: it proves the toast reaches the screen *and*
  // that it arrives translated, so a `t()` returning its key — the other way
  // this chain breaks — now fails here too rather than passing.
  const expected = FRENCH["Encryption settings unavailable"];
  assert.ok(
    expected !== undefined && expected !== "Encryption settings unavailable",
    "this test reads the French value to avoid asserting that a string is untranslated; fr-FR no longer having a distinct translation for this key means the assertion below has stopped testing what it claims",
  );

  await waitFor(() => {
    assert.ok(
      visibleText().includes(expected),
      `mounting LoginForm should surface the hook's bootstrap-failure toast in French (${JSON.stringify(expected)}). An empty title means the hook's t() returned an empty string; the English title means it returned its key instead of the translation`,
    );
  });
});

/**
 * Each case is one guard in the hook and the catalogued keys its toast is
 * built from. All are translated in all eleven locales, so no French
 * assertion below is vacuous.
 */
const GUARD_CASES: readonly {
  name: string;
  fire: (hook: ReturnType<typeof useLoginForm>) => void;
  keys: readonly string[];
}[] = [
  {
    name: "handleLogin with nothing selected",
    fire: (hook) => void hook.handleLogin(),
    keys: ["Error", "Please select an API key and enter your password"],
  },
  {
    name: "handleAddKey with empty fields",
    fire: (hook) => void hook.handleAddKey(),
    keys: ["Error", "Please fill in all fields"],
  },
  {
    name: "handleRegisterPasskey with no key",
    fire: (hook) => void hook.handleRegisterPasskey(),
    keys: ["Error", "Select a key before registering a passkey"],
  },
  {
    name: "handleUsePasskey with no key",
    fire: (hook) => void hook.handleUsePasskey(),
    keys: ["Error", "Select a key to authenticate"],
  },
];

for (const guard of GUARD_CASES) {
  test(`${guard.name} toasts in French under fr-FR`, async () => {
    await i18n.changeLanguage("fr-FR");
    render(<Toaster />);
    const view = renderHook(() => useLoginForm(() => {}, false));

    await act(async () => {
      guard.fire(view.result.current);
    });

    const text = visibleText();
    for (const key of guard.keys) {
      const expected = FRENCH[key];
      assert.ok(
        typeof expected === "string" && expected.length > 0,
        `fr-FR.json has no value for ${JSON.stringify(key)}, so this test cannot check it.`,
      );
      assert.ok(
        text.includes(expected),
        `${guard.name} did not render the French for ${JSON.stringify(key)} (expected ${JSON.stringify(expected)}). The string is hard-coded English rather than going through t().`,
      );
    }

    // The English must be gone. Skip any key the French text contains anyway,
    // which is the substring trap the file header describes.
    const frenchText = guard.keys.map((key) => FRENCH[key]).join("\n");
    for (const key of guard.keys) {
      if (frenchText.includes(key)) continue;
      assert.ok(
        !text.includes(key),
        `${JSON.stringify(key)} appeared in English while the locale was fr-FR, so it is hard-coded in use-login-form.ts.`,
      );
    }
  });
}

test("a successful login toasts its confirmation in French", async () => {
  // "Logged in successfully" is the string this defect was named for:
  // catalogued and translated into all eleven locales for six rounds while
  // this very toast rendered English.
  await i18n.changeLanguage("fr-FR");
  mockDesktopBootstrap();
  mock.method(TauriClient, "decryptApiKey", async () => "desktop-secret");
  mock.method(TauriClient, "verifyToken", async () => true);

  render(<Toaster />);
  const view = renderHook(() => useLoginForm(() => {}, true));
  await waitFor(() => assert.equal(view.result.current.apiKeys.length, 1));

  act(() => {
    view.result.current.setSelectedKeyId("desktop-key");
    view.result.current.setPassword("password");
  });
  await act(async () => {
    await view.result.current.handleLogin();
  });

  const text = visibleText();
  for (const key of ["Success", "Logged in successfully"] as const) {
    assert.ok(
      text.includes(FRENCH[key]),
      `the success toast did not render the French for ${JSON.stringify(key)} (expected ${JSON.stringify(FRENCH[key])}).`,
    );
    assert.ok(
      !text.includes(key),
      `${JSON.stringify(key)} appeared in English while the locale was fr-FR.`,
    );
  }
});

test("use-login-form's guard toasts still render English under en-US", async () => {
  await i18n.changeLanguage("en-US");
  render(<Toaster />);
  const view = renderHook(() => useLoginForm(() => {}, false));

  await act(async () => {
    void view.result.current.handleLogin();
  });

  // The one-argument `t("…")` this file uses has no default to fall back to,
  // so a mistyped key renders the typo rather than the English. Unlike the
  // two-argument form, that failure is visible — and this is what sees it.
  const text = visibleText();
  for (const english of [
    "Error",
    "Please select an API key and enter your password",
  ]) {
    assert.ok(
      text.includes(english),
      `${JSON.stringify(english)} is missing under en-US, which with a one-argument t() means the key itself was mistyped.`,
    );
  }
});

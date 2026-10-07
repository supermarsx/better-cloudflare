/**
 * The About card: the version it shows, and when it pays for the manifest.
 *
 * Two claims are worth a test here, because both are easy to break by being
 * helpful:
 *
 *  1. **`bundleVersion` is never the version.** `tauri.conf.json` carries
 *     `0.0.0` and always will; the release a build carries is the `YY.N` tag
 *     stamped into the binary. A card that fell back to the bundle version
 *     when nothing was stamped would show every local build as "0.0.0", which
 *     looks like a real version and is not one.
 *  2. **The 175 KB dependency manifest is not loaded until it is asked for.**
 *     That is the entire reason `loadDependencyManifest` is a dynamic import,
 *     and a single static import at the top of the component would undo it
 *     silently — the UI would look identical.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, before, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { AboutAppInfoCard } from "../src/components/about/AboutAppInfoCard";
import { DEPENDENCY_TOTALS } from "../src/lib/about/dependency-totals.generated";

import { useEnglishLocale } from "./i18n-ready";

const SOURCE = readFileSync(
  new URL("../src/components/about/AboutAppInfoCard.tsx", import.meta.url),
  "utf8",
);

/** `app_host_facts`, answered the way a stamped release build answers it. */
function installHost(facts: Record<string, unknown> | null): void {
  mockIPC((command) => {
    if (command !== "app_host_facts") {
      throw new Error(`unexpected command: ${command}`);
    }
    if (facts === null) throw new Error("no host");
    return facts;
  });
}

before(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
  clearMocks();
});

test("a stamped build shows its release tag as the version", async () => {
  installHost({
    releaseTag: "26.14",
    bundleVersion: "0.0.0",
    buildProfile: "release",
    os: "windows",
    arch: "x86_64",
    tauriVersion: "2.11.5",
    webviewVersion: "131.0.2903.70",
  });
  render(<AboutAppInfoCard />);

  await waitFor(() =>
    assert.equal(screen.getByTestId("about-version").textContent, "26.14"),
  );
  // The bundle placeholder is still shown — a user who goes looking will find
  // it anyway — but only under a label that says what it is.
  const placeholder = screen.getByText("Bundle version").parentElement;
  assert.ok(placeholder);
  assert.match(placeholder.textContent ?? "", /0\.0\.0/u);
  assert.match(placeholder.textContent ?? "", /placeholder, not the release/u);
});

test("an unstamped build says so instead of showing 0.0.0", async () => {
  // Every build made from a checkout reports this, and it is not a failure.
  installHost({ releaseTag: null, bundleVersion: "0.0.0" });
  render(<AboutAppInfoCard />);

  await waitFor(() =>
    assert.equal(
      screen.getByTestId("about-version").textContent,
      "local build (no release tag stamped)",
    ),
  );
  assert.doesNotMatch(
    screen.getByTestId("about-version").textContent ?? "",
    /0\.0\.0/u,
    "the bundle placeholder must never stand in for the version",
  );
});

test("a host that cannot answer still renders the card", async () => {
  installHost(null);
  render(<AboutAppInfoCard />);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("about-version").textContent,
      "local build (no release tag stamped)",
    ),
  );
  assert.ok(screen.getByTestId("about-app-info"));
});

test("the dependency counts are shown without the dependency list", async () => {
  installHost({ releaseTag: "26.14" });
  render(<AboutAppInfoCard />);

  const toggle = await screen.findByTestId("about-dependencies-toggle");
  // The totals come from the generated counts file, which is a few bytes.
  assert.match(
    toggle.textContent ?? "",
    new RegExp(
      `${DEPENDENCY_TOTALS.npm.total} npm packages, ${DEPENDENCY_TOTALS.rust.total} crates`,
      "u",
    ),
  );
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  // `assert.ok` on the comparison, never `assert.equal` on a DOM node: a
  // failing node comparison deep-inspects a jsdom element and exhausts the
  // test process instead of printing a diff.
  assert.ok(
    screen.queryByTestId("about-dependency-lists") === null,
    "nothing from the manifest may render before the disclosure is opened",
  );
});

test("opening the disclosure loads the manifest and shows direct packages first", async () => {
  installHost({ releaseTag: "26.14" });
  render(<AboutAppInfoCard />);

  fireEvent.click(await screen.findByTestId("about-dependencies-toggle"));
  const lists = await waitFor(() =>
    screen.getByTestId("about-dependency-lists"),
  );
  assert.match(lists.textContent ?? "", /Direct npm dependencies/u);
  assert.match(lists.textContent ?? "", /Direct crates/u);
  // A package `package.json` actually names, so the list is the direct one
  // rather than everything.
  assert.match(lists.textContent ?? "", /\breact\b/u);

  // The full 565 + 712 set stays behind its own disclosure.
  assert.ok(screen.queryByTestId("about-full-dependencies") === null);
  fireEvent.click(screen.getByTestId("about-full-dependencies-toggle"));
  const full = await waitFor(() =>
    screen.getByTestId("about-full-dependencies"),
  );
  assert.match(full.textContent ?? "", /Licences present/u);
});

test("the manifest is reached only through the lazy loader", () => {
  // The UI looks identical either way, so this is the only thing that catches
  // a static import putting 175 KB back into the main bundle.
  assert.doesNotMatch(
    SOURCE,
    /dependency-manifest\.generated/u,
    "AboutAppInfoCard must not name the manifest artefact; loadDependencyManifest() imports it",
  );
  assert.match(SOURCE, /loadDependencyManifest\(\)/u);
});

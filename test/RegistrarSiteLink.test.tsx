/**
 * The renewal hand-off. What matters here is where the click goes and how it
 * gets there: the web build must open a new context with `noopener,noreferrer`
 * and nothing but the table's own `https:` URL, and the control must name the
 * domain it renews so a screen reader user is not choosing between several
 * buttons all called "Renew".
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RegistrarSiteLink } from "../src/components/registrar/RegistrarSiteLink";
import i18n from "../src/i18n";
import { registrarSite } from "../src/lib/registrar/registrar-site";

async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, 5_000);
    const onInitialized = () => {
      clearTimeout(timeout);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

const originalOpen = window.open;

beforeEach(async () => {
  await waitForI18nInitialization();
});

afterEach(() => {
  cleanup();
  window.open = originalOpen;
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/** Records `window.open` arguments; the web path is what jsdom can exercise. */
function captureOpens(): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  window.open = ((...args: unknown[]) => {
    calls.push(args);
    return null;
  }) as typeof window.open;
  return { calls };
}

function site() {
  const resolved = registrarSite("porkbun");
  assert.ok(resolved, "porkbun must resolve for this test to mean anything");
  return resolved;
}

test("the web path opens the registrar URL with noopener and noreferrer", async () => {
  const opens = captureOpens();
  render(<RegistrarSiteLink domain="labs.test" site={site()} />);

  fireEvent.click(
    screen.getByRole("button", {
      name: "Renew labs.test at Porkbun (porkbun.com)",
    }),
  );
  // `openExternalUrl` validates before opening, so the call is a microtask away.
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(opens.calls, [
    ["https://porkbun.com/", "_blank", "noopener,noreferrer"],
  ]);
});

test("the control is a real button named for the domain and the host", () => {
  render(<RegistrarSiteLink domain="labs.test" site={site()} />);
  const button = screen.getByRole("button", {
    name: "Renew labs.test at Porkbun (porkbun.com)",
  });
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  // The visible text stays short; the name carries the detail.
  assert.equal(button.textContent, "Renew at Porkbun");
  assert.equal(
    button.getAttribute("data-registrar-url"),
    "https://porkbun.com/",
  );
});

test("the URL it opens is the validated one, not any string handed in", async () => {
  const opens = captureOpens();
  // A caller that bypassed `registrarSite` and smuggled in a script URL: the
  // opener rejects it rather than handing it to the browser or the shell.
  render(
    <RegistrarSiteLink
      domain="labs.test"
      site={{
        provider: "porkbun",
        label: "Porkbun",
        url: "javascript:alert(1)",
        host: "porkbun.com",
      }}
    />,
  );

  fireEvent.click(screen.getAllByRole("button")[0]);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(opens.calls, [], "nothing should have been opened");
});

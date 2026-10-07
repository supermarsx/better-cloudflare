/**
 * The Expiry sub-section's "Keeping notices current" controls.
 *
 * Three settings landed in `expiry` with no way to reach them:
 * `refreshCountdown`, `recheckDate` and `onDateChange`. This suite is about
 * the two things a settings control has to get right beyond rendering — that
 * it writes the key it names, and that what it says about the choice is true.
 *
 * `onDateChange: "update"` gets its own test because it is the one option with
 * a cost. `bc_notify::settings::StaleExpiryAction::Update` documents it: a
 * date that moved *earlier* still crosses a nearer milestone, so keeping the
 * notice can leave one row per threshold for a single domain where the other
 * two leave one. A dropdown that offers three options as if they were
 * interchangeable would be hiding that.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, before, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NotificationsSettingsExpiry } from "../src/components/dns/NotificationsSettingsExpiry";
import {
  clampNotificationSettings,
  mergeNotificationSettings,
  STALE_EXPIRY_ACTIONS,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "../src/lib/notifications/notification-settings";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
  themedSelectValue,
  themedSelectValues,
} from "./radix-select";

before(async () => {
  await useEnglishLocale();
  enableThemedSelectEnvironment();
});

afterEach(() => {
  cleanup();
});

/**
 * The section, driven by real state.
 *
 * `update` merges and re-renders the way `useNotificationSettings` does, which
 * is what lets a test assert on something that only appears once a value is
 * chosen. The writes are recorded as the partials the component passed, so an
 * assertion can say "it wrote exactly this key" rather than "the merged
 * object happens to look right".
 */
function renderExpiry(initial: NotificationSettingsInput = {}): {
  writes: NotificationSettingsInput[];
  settings: () => NotificationSettings;
} {
  const writes: NotificationSettingsInput[] = [];
  let current = clampNotificationSettings(initial);

  function Harness() {
    const [settings, setSettings] = React.useState(current);
    return (
      <NotificationsSettingsExpiry
        settings={settings}
        update={(partial) => {
          writes.push(partial);
          const next = mergeNotificationSettings(settings, partial);
          current = next;
          setSettings(next);
          return next;
        }}
      />
    );
  }

  render(<Harness />);
  return { writes, settings: () => current };
}

function switchFor(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

test("the defaults are the ones the Rust mirror declares", async () => {
  renderExpiry();
  // Both refresh halves are on by default and the action is `archive`; a UI
  // that rendered them the other way round would be lying about the state of
  // a running install before the user touched anything.
  assert.equal(
    switchFor("Refresh the countdown").getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    switchFor("Re-read the date").getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    await themedSelectValue(
      screen.getByRole("combobox", { name: "When the date has changed" }),
    ),
    "archive",
  );
});

test("the countdown switch writes expiry.refreshCountdown and nothing else", () => {
  const view = renderExpiry();
  fireEvent.click(switchFor("Refresh the countdown"));
  assert.deepEqual(view.writes, [{ expiry: { refreshCountdown: false } }]);
  assert.equal(view.settings().expiry.refreshCountdown, false);
  // The expensive half must not have been dragged along with the free one.
  assert.equal(view.settings().expiry.recheckDate, true);
});

test("the re-read switch writes expiry.recheckDate and nothing else", () => {
  const view = renderExpiry();
  fireEvent.click(switchFor("Re-read the date"));
  assert.deepEqual(view.writes, [{ expiry: { recheckDate: false } }]);
  assert.equal(view.settings().expiry.recheckDate, false);
  assert.equal(view.settings().expiry.refreshCountdown, true);
});

test("the action dropdown offers exactly STALE_EXPIRY_ACTIONS", async () => {
  renderExpiry();
  const trigger = screen.getByRole("combobox", {
    name: "When the date has changed",
  });
  // Generated from the array the clamp validates against, so an action added
  // to the mirror cannot end up unreachable in the UI.
  assert.deepEqual(await themedSelectValues(trigger), [
    ...STALE_EXPIRY_ACTIONS,
  ]);
});

test("choosing an action writes expiry.onDateChange", async () => {
  const view = renderExpiry();
  await chooseThemedSelectValue(
    screen.getByRole("combobox", { name: "When the date has changed" }),
    "resolve",
  );
  assert.deepEqual(view.writes, [{ expiry: { onDateChange: "resolve" } }]);
  assert.equal(view.settings().expiry.onDateChange, "resolve");
});

test("keeping a stale notice states its cost, and only when it is chosen", async () => {
  renderExpiry();
  // Nothing about extra rows while the default is archive: the cost is not a
  // property of the setting, it is a property of one of its values.
  // `assert.ok` on the comparison, never `assert.equal` on a DOM node: a
  // failing node comparison deep-inspects a jsdom element and exhausts the
  // test process instead of printing a diff.
  assert.ok(screen.queryByTestId("ntf-on-date-change-cost") === null);

  await chooseThemedSelectValue(
    screen.getByRole("combobox", { name: "When the date has changed" }),
    "update",
  );

  const note = screen.getByTestId("ntf-on-date-change-cost");
  assert.match(
    note.textContent ?? "",
    /one notice per threshold/u,
    "the row must say that keeping a notice can multiply rows for one domain",
  );
  assert.match(
    note.textContent ?? "",
    /moved earlier/u,
    "and why — a nearer milestone is still crossed",
  );
});

test("the cost note goes away again when another action is chosen", async () => {
  renderExpiry({ expiry: { onDateChange: "update" } });
  assert.ok(screen.getByTestId("ntf-on-date-change-cost"));

  await chooseThemedSelectValue(
    screen.getByRole("combobox", { name: "When the date has changed" }),
    "archive",
  );
  assert.ok(
    screen.queryByTestId("ntf-on-date-change-cost") === null,
    "a warning about a choice the user has backed out of is stale advice",
  );
});

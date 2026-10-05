/**
 * How settings search matches.
 *
 * The companion suite (`settingsSearch.registry.test.ts`) proves the index
 * lists the right settings; this one proves the matcher finds them. Both
 * matter: an index nobody can search is as useless as a search over a stale
 * index.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTINGS_SEARCH_ENTRIES,
  SETTINGS_SUBTABS,
  findSettingsEntry,
  searchSettings,
  settingsAnchorSelector,
  settingsSearchTokens,
  settingsSubtabLabel,
  type SettingsTranslate,
} from "../src/components/dns/settings-search";

/** Only the ids, best first, which is all most of these assertions need. */
function ids(query: string, desktop = true): string[] {
  return searchSettings(query, { desktop }).map((result) => result.entry.id);
}

test("an empty query matches nothing", () => {
  assert.deepEqual(searchSettings("", { desktop: true }), []);
  assert.deepEqual(searchSettings("   ", { desktop: true }), []);
  assert.deepEqual(settingsSearchTokens("  "), []);
});

test("a setting is found by its label", () => {
  assert.equal(ids("auto refresh")[0], "auto-refresh");
  assert.equal(ids("loader timeout")[0], "loader-timeout");
  assert.equal(ids("bind host")[0], "mcp-bind-host");
});

test("punctuation does not have to match on either side", () => {
  // Typed with a separator the label does not have: "Auto refresh" and
  // "Bind host" are two words, and a user who writes them as one hyphenated
  // or slashed term still finds them. These are the assertions that fail if
  // the folding stops flattening punctuation to spaces.
  assert.ok(ids("auto-refresh").includes("auto-refresh"));
  assert.ok(ids("bind/host").includes("mcp-bind-host"));
  // And the other way round: a label and a hint whose punctuation the query
  // leaves out.
  assert.ok(ids("per page").includes("default-per-page"));
  assert.ok(ids("auto logout idle").includes("auto-logout-idle"));
  assert.ok(ids("1.1.1.1").includes("topology-dns-server"));
});

test("a setting is found by a word only its hint contains", () => {
  // Deliberately words that appear in no label and no keyword list, so this
  // fails if the hints stop being indexed.
  assert.ok(ids("pauses").includes("auto-refresh"));
  assert.ok(ids("intermediate").includes("topology-skip-resolution-chain"));
  assert.ok(ids("enrichment").includes("topology-disable-geo"));
});

test("a setting is found by a keyword it never displays", () => {
  // Neither the label nor the hint says "geoip" or "fullscreen".
  assert.ok(ids("geoip").includes("topology-disable-geo"));
  assert.ok(ids("fullscreen").includes("topology-disable-full-window"));
  assert.ok(ids("sign out").includes("confirm-logout"));
});

test("every token has to match, so extra words narrow the list", () => {
  const broad = ids("export");
  const narrow = ids("export folder preset");
  assert.ok(broad.length > narrow.length);
  assert.ok(narrow.includes("audit-export-folder-preset"));
  assert.ok(!ids("export qqqq").length);
});

test("a label hit outranks a hint hit", () => {
  const results = searchSettings("annotations", { desktop: true });
  assert.equal(results[0]?.entry.id, "topology-disable-annotations");

  // "timeout" is in two labels and several hints; both labelled ones come
  // first.
  const timeout = ids("timeout").slice(0, 2);
  assert.deepEqual(timeout.slice().sort(), [
    "loader-timeout",
    "topology-lookup-timeout",
  ]);
});

test("desktop-only settings are hidden from a browser build", () => {
  assert.ok(ids("bind host", true).includes("mcp-bind-host"));
  assert.deepEqual(ids("bind host", false), []);

  const browser = searchSettings("confirm", { desktop: false });
  assert.ok(browser.some((result) => result.entry.id === "confirm-logout"));
  assert.ok(
    !browser.some((result) => result.entry.id === "confirm-window-close"),
    "a browser build has no window to close",
  );

  // Nothing desktop-only leaks through any query.
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (!entry.desktopOnly) continue;
    assert.ok(
      !ids(entry.label, false).includes(entry.id),
      `${entry.id} is offered to browser users`,
    );
  }
});

test("the translated label is matched, and so is the English one", () => {
  // A stand-in locale that renames one setting and leaves the rest alone.
  const translate: SettingsTranslate = (key, defaultValue) =>
    key === "Auto refresh" ? "Actualisation automatique" : defaultValue;

  const byTranslation = searchSettings("actualisation", {
    desktop: true,
    translate,
  });
  assert.equal(byTranslation[0]?.entry.id, "auto-refresh");
  assert.equal(byTranslation[0]?.label, "Actualisation automatique");

  // The English key still works — it is what the docs and the changelog call
  // the setting, and a translated UI should not hide it.
  const byKey = searchSettings("auto refresh", { desktop: true, translate });
  assert.ok(byKey.some((result) => result.entry.id === "auto-refresh"));
});

test("accents in a translated label do not have to be typed", () => {
  const translate: SettingsTranslate = (key, defaultValue) =>
    key === "Confirm logout" ? "Déconnexion confirmée" : defaultValue;
  const results = searchSettings("deconnexion", { desktop: true, translate });
  assert.equal(results[0]?.entry.id, "confirm-logout");
});

test("a result carries the strings its row should show", () => {
  const [result] = searchSettings("auto logout", { desktop: true });
  assert.ok(result);
  assert.equal(result.label, "Auto logout (idle)");
  assert.equal(result.breadcrumb, settingsSubtabLabel("general"));
  assert.equal(result.description, "Logs out automatically after inactivity.");
});

test("a column toggle's breadcrumb names its table", () => {
  const [result] = searchSettings("proxy column", { desktop: true });
  assert.ok(result);
  assert.equal(result.entry.subtab, "columns");
  assert.equal(result.breadcrumb, "Columns › DNS records");
  assert.equal(
    settingsAnchorSelector(result.entry),
    '[data-testid="column-group-dnsRecords"] [data-column-id="proxied"]',
  );
});

test("the subtab name is searchable, so a subtab lists its settings", () => {
  // "Profiles" is in no label, hint or keyword — only in the subtab name — so
  // these fail if the subtab stops being part of the haystack.
  const profiles = ids("profiles");
  assert.ok(profiles.includes("profiles-export"));
  assert.ok(profiles.includes("profiles-import"));
  const entries = profiles.map((id) => findSettingsEntry(id));
  assert.ok(entries.every((entry) => entry?.subtab === "profiles"));

  // And a large subtab lists more than a handful of its settings.
  const topology = ids("topology");
  assert.ok(topology.length > 5);
  assert.ok(
    topology
      .map((id) => findSettingsEntry(id))
      .every((entry) => entry?.subtab === "topology"),
  );
});

test("limit caps the list without reordering it", () => {
  const all = searchSettings("export", { desktop: true });
  const capped = searchSettings("export", { desktop: true, limit: 3 });
  assert.equal(capped.length, 3);
  assert.deepEqual(
    capped.map((result) => result.entry.id),
    all.slice(0, 3).map((result) => result.entry.id),
  );
});

test("results are ordered by score, then subtab, then label", () => {
  const order = new Map(SETTINGS_SUBTABS.map((subtab, i) => [subtab.id, i]));
  const results = searchSettings("export", { desktop: true });
  assert.ok(results.length > 3);
  for (let index = 1; index < results.length; index += 1) {
    const previous = results[index - 1];
    const current = results[index];
    assert.ok(
      previous.score >= current.score,
      `${current.entry.id} scored higher than ${previous.entry.id} but came after it`,
    );
    if (previous.score !== current.score) continue;
    const previousRank = order.get(previous.entry.subtab) ?? 0;
    const currentRank = order.get(current.entry.subtab) ?? 0;
    assert.ok(
      previousRank < currentRank ||
        (previousRank === currentRank &&
          previous.label.localeCompare(current.label) <= 0),
      `equal scores must fall back to subtab then label: ${previous.entry.id} before ${current.entry.id}`,
    );
  }
  // And the whole thing is stable across calls.
  assert.deepEqual(
    ids("export"),
    results.map((r) => r.entry.id),
  );
});

test("entries are listed in subtab order", () => {
  const order = new Map(SETTINGS_SUBTABS.map((subtab, i) => [subtab.id, i]));
  let previous = -1;
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const rank = order.get(entry.subtab) ?? 0;
    assert.ok(rank >= previous, `${entry.id} is out of subtab order`);
    previous = rank;
  }
});

test("an unknown id has no entry and no selector", () => {
  assert.equal(findSettingsEntry("not-a-setting"), undefined);
  assert.equal(
    settingsAnchorSelector({
      id: "x",
      subtab: "profiles",
      label: "x",
      anchor: { kind: "subtab" },
    }),
    null,
  );
});

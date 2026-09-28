import assert from "node:assert/strict";
import { test } from "node:test";

import { StorageManager } from "../src/lib/storage/storage.ts";
import { CryptoManager } from "../src/lib/auth/crypto.ts";
import {
  DEFAULT_TAG_COLOR_ID,
  TAG_COLOR_IDS,
  TAG_COLOR_LABELS,
  resolveTagColorId,
  tagColorStyle,
  tagSwatchStyle,
} from "../src/components/tags/tag-colors.ts";

class LocalStorageMock {
  protected store: Record<string, string> = {};
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

const STORAGE_KEY = "cloudflare-dns-manager";

function manager(storage: LocalStorageMock = new LocalStorageMock()) {
  return new StorageManager(storage, new CryptoManager({}, storage));
}

const ZONE = "zone-1";

test("every palette id resolves, and anything else falls back to the default", () => {
  for (const id of TAG_COLOR_IDS) assert.equal(resolveTagColorId(id), id);
  assert.ok(TAG_COLOR_IDS.includes(DEFAULT_TAG_COLOR_ID));
  for (const rejected of [
    undefined,
    null,
    "",
    "  ",
    "chartreuse",
    "#ff0000",
    "toString",
    "__proto__",
    42,
    { id: "red" },
  ]) {
    assert.equal(
      resolveTagColorId(rejected),
      DEFAULT_TAG_COLOR_ID,
      `${JSON.stringify(rejected)} must resolve to the default colour`,
    );
  }
});

test("every palette id has a label and renders theme-derived colours", () => {
  for (const id of TAG_COLOR_IDS) {
    assert.equal(typeof TAG_COLOR_LABELS[id], "string");
    assert.ok(TAG_COLOR_LABELS[id].length > 0);

    const style = tagColorStyle(id);
    // The ink, tint and border are all mixed against the *theme's* tokens, so
    // one stored id stays legible in the light theme and the three dark ones.
    assert.match(String(style.color), /^color-mix\(in srgb, hsl\(/);
    assert.ok(String(style.color).includes("hsl(var(--foreground))"));
    assert.ok(String(style.background).includes("hsl(var(--card))"));
    assert.ok(String(style.borderColor).includes("transparent"));
    assert.match(String(tagSwatchStyle(id).background), /^hsl\(/);
  }
});

test("a tag with no stored colour reads as unset and renders the default", () => {
  const mgr = manager();
  mgr.addZoneTag(ZONE, "ops");

  assert.equal(mgr.getTagColor(ZONE, "ops"), undefined);
  assert.deepEqual(mgr.getTagColors(ZONE), {});
  assert.equal(
    resolveTagColorId(mgr.getTagColor(ZONE, "ops")),
    DEFAULT_TAG_COLOR_ID,
  );
});

test("creating a tag with a colour persists both, and survives a restart", () => {
  const storage = new LocalStorageMock();
  manager(storage).addZoneTag(ZONE, "prod", "blue");

  const restarted = manager(storage);
  assert.deepEqual(restarted.getZoneTags(ZONE), ["prod"]);
  assert.equal(restarted.getTagColor(ZONE, "prod"), "blue");
  assert.deepEqual(restarted.getTagColors(ZONE), { prod: "blue" });
});

test("recolouring an existing tag replaces the colour without touching the catalog", () => {
  const mgr = manager();
  mgr.addZoneTag(ZONE, "prod", "blue");

  mgr.setTagColor(ZONE, "prod", "green");
  assert.equal(mgr.getTagColor(ZONE, "prod"), "green");
  assert.deepEqual(mgr.getZoneTags(ZONE), ["prod"]);

  // Re-adding an existing tag through the add form is also a recolour.
  mgr.addZoneTag(ZONE, "prod", "pink");
  assert.equal(mgr.getTagColor(ZONE, "prod"), "pink");
  assert.deepEqual(mgr.getZoneTags(ZONE), ["prod"]);
});

test("an empty colour clears the choice and prunes the zone entry", () => {
  const storage = new LocalStorageMock();
  const mgr = manager(storage);
  mgr.addZoneTag(ZONE, "prod", "blue");

  mgr.setTagColor(ZONE, "prod", "");
  assert.equal(mgr.getTagColor(ZONE, "prod"), undefined);
  assert.deepEqual(mgr.getZoneTags(ZONE), ["prod"]);
  // The zone's whole entry goes, not just the one tag, so a cleared zone leaves
  // nothing behind to grow.
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as {
    tagColors?: Record<string, unknown>;
  };
  assert.deepEqual(persisted.tagColors ?? {}, {});
  assert.deepEqual(manager(storage).getTagColors(ZONE), {});
});

test("recolouring does not invent a tag the catalog never had", () => {
  const mgr = manager();
  mgr.setTagColor(ZONE, "ghost", "red");
  assert.deepEqual(mgr.getZoneTags(ZONE), []);
});

test("renaming a tag carries its colour and its record references", () => {
  const mgr = manager();
  mgr.addZoneTag(ZONE, "ops", "teal");
  mgr.setRecordTags(ZONE, "rec-1", ["ops", "keep"]);

  mgr.renameTag(ZONE, "ops", "operations");

  assert.deepEqual(mgr.getZoneTags(ZONE), ["keep", "operations"]);
  assert.equal(mgr.getTagColor(ZONE, "ops"), undefined);
  assert.equal(mgr.getTagColor(ZONE, "operations"), "teal");
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1").sort(), [
    "keep",
    "operations",
  ]);
});

test("renaming onto an existing tag merges into it and keeps that tag's colour", () => {
  const mgr = manager();
  mgr.addZoneTag(ZONE, "ops", "teal");
  mgr.addZoneTag(ZONE, "production", "violet");
  mgr.setRecordTags(ZONE, "rec-1", ["ops"]);
  mgr.setRecordTags(ZONE, "rec-2", ["production"]);

  mgr.renameTag(ZONE, "ops", "production");

  assert.deepEqual(mgr.getZoneTags(ZONE), ["production"]);
  // The surviving name keeps the colour it already had; nothing is left behind
  // under the old name.
  assert.equal(mgr.getTagColor(ZONE, "production"), "violet");
  assert.equal(mgr.getTagColor(ZONE, "ops"), undefined);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["production"]);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-2"), ["production"]);
});

test("deleting a tag drops its colour and its record references, leaving others", () => {
  const mgr = manager();
  mgr.addZoneTag(ZONE, "ops", "teal");
  mgr.addZoneTag(ZONE, "keep", "amber");
  mgr.setRecordTags(ZONE, "rec-1", ["ops", "keep"]);

  mgr.deleteTag(ZONE, "ops");

  assert.deepEqual(mgr.getZoneTags(ZONE), ["keep"]);
  assert.equal(mgr.getTagColor(ZONE, "ops"), undefined);
  assert.equal(mgr.getTagColor(ZONE, "keep"), "amber");
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["keep"]);
  assert.deepEqual(mgr.getTagUsageCounts(ZONE), { keep: 1 });
});

test("colours are per zone, so the same tag name can differ between zones", () => {
  const mgr = manager();
  mgr.addZoneTag("zone-a", "shared", "red");
  mgr.addZoneTag("zone-b", "shared", "blue");

  mgr.deleteTag("zone-a", "shared");

  assert.equal(mgr.getTagColor("zone-a", "shared"), undefined);
  assert.equal(mgr.getTagColor("zone-b", "shared"), "blue");
});

test("a reserved zone id and tag name stay own data instead of hitting the prototype", () => {
  const storage = new LocalStorageMock();
  manager(storage).addZoneTag("__proto__", "__proto__", "orange");

  const restarted = manager(storage);
  assert.deepEqual(restarted.getZoneTags("__proto__"), ["__proto__"]);
  assert.equal(restarted.getTagColor("__proto__", "__proto__"), "orange");
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(({} as Record<string, unknown>).orange, undefined);
});

// --- migration of data written before tag colours existed -------------------

/**
 * Exactly what a pre-colour build persisted: a tag catalog and record
 * associations, with no `tagColors` key anywhere.
 */
function legacyPayload() {
  return {
    apiKeys: [],
    lastZone: ZONE,
    tagCatalog: { [ZONE]: ["legacy-a", "legacy-b"] },
    recordTags: { [ZONE]: { "rec-1": ["legacy-a"] } },
  };
}

test("tags saved before colours existed load unchanged and render the default", () => {
  const storage = new LocalStorageMock();
  storage.setItem(STORAGE_KEY, JSON.stringify(legacyPayload()));

  const mgr = manager(storage);

  assert.deepEqual(mgr.getZoneTags(ZONE), ["legacy-a", "legacy-b"]);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["legacy-a"]);
  assert.deepEqual(mgr.getTagColors(ZONE), {});
  for (const tag of mgr.getZoneTags(ZONE)) {
    assert.equal(mgr.getTagColor(ZONE, tag), undefined);
    assert.equal(
      resolveTagColorId(mgr.getTagColor(ZONE, tag)),
      DEFAULT_TAG_COLOR_ID,
    );
  }
});

test("colouring a legacy tag leaves its siblings and its records alone", () => {
  const storage = new LocalStorageMock();
  storage.setItem(STORAGE_KEY, JSON.stringify(legacyPayload()));
  const mgr = manager(storage);

  mgr.setTagColor(ZONE, "legacy-a", "green");

  assert.equal(mgr.getTagColor(ZONE, "legacy-a"), "green");
  assert.equal(mgr.getTagColor(ZONE, "legacy-b"), undefined);
  assert.deepEqual(mgr.getZoneTags(ZONE), ["legacy-a", "legacy-b"]);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["legacy-a"]);
  assert.equal(manager(storage).getTagColor(ZONE, "legacy-a"), "green");
});

test("a malformed stored tagColors is dropped without taking the tags with it", () => {
  const storage = new LocalStorageMock();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...legacyPayload(),
      // Every shape a hand-edited or corrupted store could hold.
      tagColors: {
        [ZONE]: {
          "legacy-a": "green",
          "legacy-b": 42,
          "": "blue",
          "  ": "blue",
          spaced: "   ",
          nested: { id: "red" },
          oversized: "x".repeat(64),
        },
        "bad-zone": "not-an-object",
        "array-zone": ["green"],
      },
    }),
  );

  const mgr = manager(storage);

  // The tags themselves are never collateral damage.
  assert.deepEqual(mgr.getZoneTags(ZONE), ["legacy-a", "legacy-b"]);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["legacy-a"]);
  // Only the well-formed entry survives; the rest fall back to the default.
  assert.deepEqual(mgr.getTagColors(ZONE), { "legacy-a": "green" });
  assert.equal(
    resolveTagColorId(mgr.getTagColor(ZONE, "legacy-b")),
    DEFAULT_TAG_COLOR_ID,
  );
  assert.deepEqual(mgr.getTagColors("bad-zone"), {});
  assert.deepEqual(mgr.getTagColors("array-zone"), {});
});

test("a colour id this build does not ship is kept as data but rendered as the default", () => {
  const storage = new LocalStorageMock();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...legacyPayload(),
      tagColors: { [ZONE]: { "legacy-a": "chartreuse" } },
    }),
  );

  const mgr = manager(storage);

  // Storage keeps the opaque id, so a future build that ships the colour picks
  // it up again; the renderer is what falls back.
  assert.equal(mgr.getTagColor(ZONE, "legacy-a"), "chartreuse");
  assert.equal(
    resolveTagColorId(mgr.getTagColor(ZONE, "legacy-a")),
    DEFAULT_TAG_COLOR_ID,
  );
});

test("importing a payload with no tagColors keeps its tags and adds no colours", () => {
  const mgr = manager();
  mgr.importData(JSON.stringify(legacyPayload()));

  assert.deepEqual(mgr.getZoneTags(ZONE), ["legacy-a", "legacy-b"]);
  assert.deepEqual(mgr.getRecordTags(ZONE, "rec-1"), ["legacy-a"]);
  assert.deepEqual(mgr.getTagColors(ZONE), {});
});

test("importing a payload with tagColors sanitizes it and keeps the good entries", () => {
  const mgr = manager();
  mgr.importData(
    JSON.stringify({
      ...legacyPayload(),
      tagColors: { [ZONE]: { " legacy-a ": " green ", "legacy-b": null } },
    }),
  );

  assert.equal(mgr.getTagColor(ZONE, "legacy-a"), "green");
  assert.equal(mgr.getTagColor(ZONE, "legacy-b"), undefined);
});

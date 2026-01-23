import assert from "node:assert/strict";
import { test } from "node:test";
import { getTTLPresets } from "../src/types/dns";

test("getTTLPresets reads JSON array overrides", () => {
  const prev = process.env.TTL_PRESETS;
  process.env.TTL_PRESETS = '["auto",120,300]';
  try {
    assert.deepEqual(getTTLPresets(), ["auto", 120, 300]);
  } finally {
    if (prev === undefined) delete process.env.TTL_PRESETS;
    else process.env.TTL_PRESETS = prev;
  }
});

test("getTTLPresets reads comma-separated list", () => {
  const prev = process.env.TTL_PRESETS;
  process.env.TTL_PRESETS = "auto, 600, 900";
  try {
    assert.deepEqual(getTTLPresets(), ["auto", 600, 900]);
  } finally {
    if (prev === undefined) delete process.env.TTL_PRESETS;
    else process.env.TTL_PRESETS = prev;
  }
});

import assert from "node:assert/strict";
import React from "react";
import { create } from "react-test-renderer";
import { test } from "node:test";

import { LanguageSelector } from "../src/components/ui/LanguageSelector";

test("LanguageSelector renders select with aria-label", () => {
  const r = create(React.createElement(LanguageSelector));
  const select = r.root.findByType("select");
  assert.ok(select.props["aria-label"]);
  // default translation should be present (English key)
  assert.equal(select.props["aria-label"], "Select language");
});

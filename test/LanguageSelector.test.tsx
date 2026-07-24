import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LanguageSelector } from "../src/components/layout/LanguageSelector";

afterEach(() => {
  cleanup();
});

test("LanguageSelector renders trigger and can open language menu", () => {
  render(<LanguageSelector />);

  const trigger = screen.getByRole("button");
  assert.ok(trigger);

  fireEvent.click(trigger);
  assert.ok(trigger.getAttribute("aria-haspopup"));
});

import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { LoginForm } from "../src/components/auth/LoginForm";

afterEach(() => {
  cleanup();
});

test("LoginForm renders login button", () => {
  render(<LoginForm onLogin={() => {}} />);
  const loginButton = screen
    .getAllByRole("button")
    .find(
      (btn) =>
        btn.className.includes("h-12") && btn.className.includes("text-lg"),
    );
  assert.ok(loginButton);
});

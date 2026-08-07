import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

// Files still exempted from `lint:src:baseline`. The ratchet only requires
// clearing entries for files a change touches; the list is empty because every
// former entry has been fixed and retired.
/** @type {string[]} */
export const legacySourceLintDebt = [];

const generatedArtifacts = [
  ".next/**",
  "dist/**",
  "out/**",
  "playwright-report/**",
  "test-results/**",
  "target/**",
  "src-tauri/target/**",
];

const sourceBaselineDebt =
  process.env.ESLINT_SRC_BASELINE === "true" ? legacySourceLintDebt : [];

export default tseslint.config([
  globalIgnores(
    [...generatedArtifacts, ...sourceBaselineDebt],
    "Generated artifacts and explicit source baseline debt",
  ),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      {
        plugins: {
          "react-hooks": reactHooks,
        },
        rules: {
          "react-hooks/rules-of-hooks": "error",
          "react-hooks/exhaustive-deps": "warn",
        },
      },
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
]);

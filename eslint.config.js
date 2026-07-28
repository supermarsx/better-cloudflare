import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export const legacySourceLintDebt = [
  "src/components/dns/AddRecordDialog.tsx",
  "src/components/dns/RecordRow.tsx",
  "src/components/dns/ZoneTopologyTab.tsx",
  "src/components/dns/builders/DkimBuilder.tsx",
  "src/components/dns/builders/DmarcBuilder.tsx",
  "src/components/dns/builders/HinfoBuilder.tsx",
  "src/components/dns/builders/SpfBuilder.tsx",
  "src/components/dns/builders/SvcbBuilder.tsx",
  "src/components/layout/ThemeToggle.tsx",
  "src/components/layout/WindowControls.tsx",
  "src/components/layout/WindowTitleBar.tsx",
  "src/lib/audit/audit.ts",
  "src/lib/audit/domain-audit.ts",
  "src/lib/auth/credential-store.ts",
  "src/lib/auth/crypto.ts",
  "src/lib/dns/spf.ts",
  "src/lib/storage/sqlite-driver.ts",
];

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
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
]);

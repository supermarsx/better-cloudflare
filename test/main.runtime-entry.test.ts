import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("legacy entry mounts App inside the shared runtime boundary and listener", () => {
  const mainSource = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8",
  );
  const boundarySource = readFileSync(
    new URL(
      "../src/components/layout/RuntimeRootBoundary.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    mainSource,
    /import\s+\{\s*RuntimeRootBoundary\s*\}\s+from\s+"\.\/components\/layout\/RuntimeRootBoundary"/,
  );
  assert.match(
    mainSource,
    /<StrictMode>\s*<RuntimeRootBoundary>\s*<App\s*\/>\s*<\/RuntimeRootBoundary>\s*<\/StrictMode>/s,
  );
  assert.match(boundarySource, /<RuntimeErrorListener\s*\/>/);
  assert.match(boundarySource, /<ErrorBoundary/);
});

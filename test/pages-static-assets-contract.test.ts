import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url));

test("Next metadata icon is a valid exact copy of the repository icon", () => {
  const rootIcon = readRepositoryFile("icon.png");
  const metadataIcon = readRepositoryFile("app/icon.png");
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  assert.deepEqual(metadataIcon.subarray(0, 8), pngSignature);
  assert.equal(metadataIcon.readUInt32BE(16), 1024);
  assert.equal(metadataIcon.readUInt32BE(20), 1024);
  assert.equal(
    createHash("sha256").update(metadataIcon).digest("hex"),
    createHash("sha256").update(rootIcon).digest("hex"),
  );
  assert.deepEqual(metadataIcon, rootIcon);
});

test("Pages workflow enables or fails clearly, then deploys main unconditionally", () => {
  const workflow = readRepositoryFile(".github/workflows/pages.yml").toString(
    "utf8",
  );

  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /uses: actions\/configure-pages@v5/);
  assert.match(workflow, /token: \$\{\{ secrets\.PAGES_ADMIN_TOKEN \}\}/);
  assert.match(workflow, /enablement: true/);
  assert.match(workflow, /Settings > Pages > Build and deployment > Source/);
  assert.match(workflow, /Pages: write and Administration: write/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /path: \.\/out/);
  assert.match(workflow, /deploy:\s*\n\s+needs: build/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /name: github-pages/);
  assert.match(
    workflow,
    /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/,
  );
  assert.match(
    workflow,
    /id: deployment\s*\n\s+uses: actions\/deploy-pages@v4/,
  );

  assert.doesNotMatch(workflow, /pages_enabled|check-pages/);
  assert.doesNotMatch(workflow, /Skipping deployment/);
  assert.doesNotMatch(workflow, /enablement: false/);
  assert.doesNotMatch(
    workflow,
    /name: Build export\s*\n\s+if:/,
    "the static export must not be green-skipped",
  );
  assert.doesNotMatch(
    workflow,
    /name: Upload artifact\s*\n\s+if:/,
    "the Pages artifact must not be green-skipped",
  );
});

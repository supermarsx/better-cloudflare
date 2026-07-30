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

test("Pages workflow verifies the project export before deploying main", () => {
  const workflow = readRepositoryFile(".github/workflows/pages.yml").toString(
    "utf8",
  );
  const configurePagesPin =
    "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0";
  const buildStart = workflow.indexOf("  build:");
  const deployStart = workflow.indexOf("  deploy:");

  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.notEqual(buildStart, -1);
  assert.notEqual(deployStart, -1);
  const build = workflow.slice(buildStart, deployStart);
  const deploy = workflow.slice(deployStart);
  assert.equal(
    workflow.split(`uses: ${configurePagesPin}`).length - 1,
    1,
    "the deployment path must use exactly one current immutable v6 pin",
  );
  assert.match(build, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(build, /pages:\s*write|id-token:\s*write/);
  assert.match(build, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /PAGES_ADMIN_TOKEN|enablement:/);
  assert.match(deploy, /permissions:\s*\n\s+contents: read/);
  assert.match(deploy, /pages:\s*write/);
  assert.match(deploy, /id-token:\s*write/);
  assert.ok(deploy.includes(`uses: ${configurePagesPin}`));
  assert.match(
    workflow,
    /name: Build project-path export\s*\n\s+env:\s*\n\s+NODE_OPTIONS: --max-old-space-size=3072\s*\n\s+run: npm run build:pages:ci/,
  );
  assert.match(
    workflow,
    /name: Install Playwright Chromium\s*\n\s+env:\s*\n\s+NODE_OPTIONS: --max-old-space-size=1536\s*\n\s+run: npx playwright install --with-deps chromium/,
  );
  assert.match(
    workflow,
    /name: Verify project-path static export\s*\n\s+env:\s*\n\s+NODE_OPTIONS: --max-old-space-size=1536\s*\n\s+run: npm run test:e2e:pages/,
  );
  assert.match(
    workflow,
    /uses: actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/,
  );
  assert.match(workflow, /path: \.\/out/);
  assert.ok(
    workflow.indexOf("name: Verify project-path static export") <
      workflow.indexOf("name: Upload artifact"),
    "the Pages browser check must complete before artifact upload",
  );
  assert.match(workflow, /deploy:\s*\n\s+needs: build/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /name: github-pages/);
  assert.match(
    workflow,
    /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/,
  );
  assert.match(
    workflow,
    /id: deployment\s*\n\s+uses: actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5\.0\.0/,
  );

  assert.doesNotMatch(workflow, /pages_enabled|check-pages/);
  assert.doesNotMatch(workflow, /Skipping deployment/);
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

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const testDir = path.resolve(process.cwd(), "test");
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
console.log("Running tests sequentially:", files.length, "files");
for (const f of files) {
  console.log("\n--- RUN", f, "---");
  const full = path.join("test", f);
  const res = spawnSync("npx", ["tsx", "--test", full], {
    stdio: "inherit",
    shell: true,
    windowsHide: false,
  });
  if (res.status !== 0) {
    console.error(
      `Test ${f} failed or returned non-zero exit status ${res.status}. Stopping.`,
    );
    process.exit(res.status ?? 1);
  }
}
console.log("\nAll tests passed sequentially.");

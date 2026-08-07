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

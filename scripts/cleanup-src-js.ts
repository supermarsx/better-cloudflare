#!/usr/bin/env tsx
/*
 * Cleanup compiled JS files under src/.
 * Deletes .js and .js.map files from src recursively.
 */
import fs from 'fs/promises';
import path from 'path';

async function deleteJSFiles(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await deleteJSFiles(full);
      // remove empty directory? No, leave directory structure intact
    } else if (entry.isFile()) {
      if (full.endsWith('.js') || full.endsWith('.js.map')) {
        try {
          await fs.unlink(full);
          console.log('deleted', full);
        } catch (e) {
          console.error('failed to delete', full, e);
        }
      }
    }
  }
}

async function main() {
  const src = path.resolve(process.cwd(), 'src');
  try {
    await fs.access(src);
  } catch {
    console.error('src directory not found');
    process.exit(1);
  }
  await deleteJSFiles(src);
}

main().catch((e) => {
  console.error('error cleaning js files', e);
  process.exit(1);
});

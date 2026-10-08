/**
 * Every `#[tauri::command]` is in the handler list, and every entry in that
 * list is a real command.
 *
 * A command the renderer calls but `generate_handler!` does not name compiles
 * on both sides and fails only when a user reaches the feature: the host
 * answers "command not found" at the moment of use. Nothing else in this
 * repository notices, because the two halves never refer to each other by a
 * symbol — the renderer passes a string.
 *
 * This is not hypothetical. When this file was written, four commands were
 * defined and unregistered: `audit_trail_summary`, which the diagnostics
 * report invokes by name through `AUDIT_SUMMARY_COMMAND`, plus
 * `ai_set_conversation_persona`, `ai_set_conversation_provider` and
 * `set_registry_monitoring_enabled`. Each had a renderer caller already
 * written against it.
 *
 * The reverse direction is checked too. An entry naming a function that is no
 * longer a command is a compile error rather than a silent failure, so this
 * half is a guard on the parsing below: if it ever reports an orphan, the
 * extraction has drifted and the first half's result cannot be trusted either.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../src-tauri/src", import.meta.url));

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(path, out);
    else if (entry.name.endsWith(".rs")) out.push(path);
  }
  return out;
}

/**
 * Command name to the file that defines it.
 *
 * The attribute and the signature are not always adjacent — a `#[cfg(...)]`
 * or a doc comment can sit between them — so this takes the next `fn` within a
 * short window rather than the next line.
 */
function definedCommands(): Map<string, string> {
  const commands = new Map<string, string>();
  for (const path of rustFiles(SRC)) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!/^\s*#\[tauri::command/.test(line)) continue;
      for (
        let scan = index + 1;
        scan < Math.min(index + 8, lines.length);
        scan += 1
      ) {
        const match =
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-z0-9_]+)/.exec(
            lines[scan],
          );
        if (match) {
          commands.set(
            match[1],
            path.slice(SRC.length + 1).replace(/\\/g, "/"),
          );
          break;
        }
      }
    }
  }
  return commands;
}

/** The names inside `generate_handler![ … ]`, module paths stripped. */
function registeredCommands(): Set<string> {
  const main = readFileSync(join(SRC, "main.rs"), "utf8");
  const start = main.indexOf("generate_handler!");
  assert.ok(start >= 0, "main.rs should invoke generate_handler!");

  // Balance brackets rather than matching to the first `]`, so a nested
  // bracket in the list cannot end the scan early.
  let depth = 0;
  let end = -1;
  for (let index = main.indexOf("[", start); index < main.length; index += 1) {
    if (main[index] === "[") depth += 1;
    else if (main[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(
    end > start,
    "the generate_handler! list should be bracket-balanced",
  );

  const block = main.slice(start, end);
  return new Set(
    [...block.matchAll(/(?:^|\s|,)(?:[a-z0-9_]+::)*([a-z0-9_]+)\s*,/g)].map(
      (match) => match[1],
    ),
  );
}

test("every tauri command is registered in the handler list", () => {
  const defined = definedCommands();
  const registered = registeredCommands();
  const missing = [...defined.keys()]
    .filter((name) => !registered.has(name))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `these commands are defined but not in generate_handler!, so calling one fails at runtime:\n${missing
      .map((name) => `  ${name} (${defined.get(name)})`)
      .join("\n")}`,
  );
});

test("the handler list names no command that does not exist", () => {
  // A guard on the extraction above as much as on the list: an orphan here
  // means the parsing has drifted, and then the missing-command check is
  // measuring the wrong thing.
  const defined = definedCommands();
  const orphans = [...registeredCommands()]
    .filter((name) => !defined.has(name))
    .sort();

  assert.deepEqual(
    orphans,
    [],
    `the handler list names these, but no #[tauri::command] defines them:\n${orphans
      .map((name) => `  ${name}`)
      .join("\n")}`,
  );
});

test("the extraction finds the commands it is meant to", () => {
  // Both checks are only as good as the parsing, so the floor is pinned
  // directly: a regex that quietly stopped matching would otherwise report an
  // empty set of commands, and "nothing is unregistered" is exactly what an
  // extraction that found nothing also says.
  const defined = definedCommands();
  assert.ok(
    defined.has("app_host_facts"),
    "app_host_facts should be found as a command",
  );
  assert.ok(
    defined.size > 100,
    `expected well over a hundred commands, found ${defined.size}`,
  );
  assert.ok(
    registeredCommands().size > 100,
    "expected the handler list to name well over a hundred commands",
  );
});

/**
 * Loaded into every test process (`--import` in the package.json test aliases and scripts/test-fast.ts). Each process gets
 * its own temporary AGENTBROS_MEMORY_ROOT, inherited by the commands it spawns, so no test writes this checkout's memory/.
 * At exit the folder is removed, and a file that appeared in, changed in or left the checkout's memory/ fails the test file.
 * It also switches the studio console's auto-start, journal and hooks off unless a test sets them (RFC 0004).
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REAL = path.resolve(import.meta.dirname, "..", "..", "memory");

/** Every file under dir (but the lock and the tracked AGENTS.md, which agents edit) with its size and modification time. */
function files(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return files(path.join(dir, entry.name), relative);
    if (entry.name === ".lock" || relative === "AGENTS.md") return [];
    try {
      const stat = statSync(path.join(dir, entry.name));
      return [`${relative} ${stat.size} ${stat.mtimeMs}`];
    } catch {
      return [];
    }
  });
}

// Child CLIs must never load this checkout's .env (real API keys); runScript honours this opt-out.
process.env.AGENTBROS_NO_DOTENV = "1";

// Studio console (RFC 0004): no test auto-starts the console server, writes an event journal, runs a hook role or sends
// a notification, unless it turns the switch back on itself. Spawned children inherit these; a child given its own minimal env does not.
for (const name of ["AGENTBROS_CONSOLE", "AGENTBROS_EVENTS", "AGENTBROS_HOOKS", "AGENTBROS_NOTIFY"])
  if (process.env[name] === undefined) process.env[name] = "off";

const before = new Set(files(REAL));
const root = mkdtempSync(path.join(tmpdir(), "avc-test-memory-"));
process.env.AGENTBROS_MEMORY_ROOT = root;
if (!process.env.AGENTBROS_MODEL_SLOTS) {
  process.env.AGENTBROS_MODEL_SLOTS = path.join(root, "model-slots.json");
  copyFileSync(
    path.resolve(import.meta.dirname, "../fixtures/model-slots/minimal.json"),
    process.env.AGENTBROS_MODEL_SLOTS,
  );
}
if (!process.env.AGENTBROS_MODEL_USE_CASES) {
  process.env.AGENTBROS_MODEL_USE_CASES = path.join(root, "model-use-cases.json");
  copyFileSync(
    path.resolve(import.meta.dirname, "../fixtures/model-slots/use-cases.json"),
    process.env.AGENTBROS_MODEL_USE_CASES,
  );
}
// The tracked fal-prices.json holds real synced prices; tests quote against an empty file unless they set their own.
if (!process.env.AGENTBROS_FAL_PRICES) {
  process.env.AGENTBROS_FAL_PRICES = path.join(root, "fal-prices.json");
  writeFileSync(process.env.AGENTBROS_FAL_PRICES, `${JSON.stringify({ version: 1, syncedAt: null, prices: [] })}\n`);
}
if (!process.env.AGENTBROS_HF_PRICES) {
  process.env.AGENTBROS_HF_PRICES = path.join(root, "hf-prices.json");
  copyFileSync(
    path.resolve(import.meta.dirname, "../../src/lib/models/hf-prices.json"),
    process.env.AGENTBROS_HF_PRICES,
  );
}

if (!process.env.AGENTBROS_FAL_HISTORICAL_PRICES) {
  process.env.AGENTBROS_FAL_HISTORICAL_PRICES = path.join(root, "fal-historical-prices.json");
  writeFileSync(
    process.env.AGENTBROS_FAL_HISTORICAL_PRICES,
    JSON.stringify({ version: 1, syncedAt: null, records: [] }),
  );
}

if (!process.env.AGENTBROS_FAL_UNIT_SEMANTICS) {
  process.env.AGENTBROS_FAL_UNIT_SEMANTICS = path.join(root, "fal-unit-semantics.json");
  writeFileSync(process.env.AGENTBROS_FAL_UNIT_SEMANTICS, JSON.stringify({ version: 1, syncedAt: null, records: [] }));
}

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
  const after = new Set(files(REAL));
  const changed = [...after]
    .filter((file) => !before.has(file))
    .concat([...before].filter((file) => !after.has(file)).map((file) => `${file} (gone)`));
  if (changed.length) {
    process.stderr.write(`[memory-root] a test changed the checkout's memory/: ${changed.join(", ")}\n`);
    process.exitCode = 1;
  }
});

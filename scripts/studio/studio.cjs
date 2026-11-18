/**
 * `pnpm studio`: Remotion Studio for development, under the same loopback preload as `studio:open`
 * (`loopback.cjs`, RFC 0004 §17). Plain `remotion studio` listens on every network interface and has unauthenticated
 * endpoints that write files, so it is never started without the preload. The preload is passed with `--require` and,
 * for Node children Studio starts, in NODE_OPTIONS. Arguments are forwarded; the exit code is Studio's.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const preload = path.join(__dirname, "loopback.cjs");

/** Node's argument list for Studio: preload first, then Remotion's CLI and the forwarded arguments. */
function studioArgv(cli, args) {
  return ["--require", preload, cli, "studio", ...args];
}

/** NODE_OPTIONS with the preload appended (quoted, as `nodeOptionsWith` in src/lib/console/studio.ts does). */
function studioNodeOptions(existing) {
  const quoted = `"${preload.replace(/(["\\])/g, "\\$1")}"`;
  return [(existing || "").trim(), `--require ${quoted}`].filter(Boolean).join(" ");
}

function main() {
  const cli = path.join(root, "node_modules", "@remotion", "cli", "remotion-cli.js");
  const result = spawnSync(process.execPath, studioArgv(cli, process.argv.slice(2)), {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: studioNodeOptions(process.env.NODE_OPTIONS) },
  });
  if (result.error) {
    process.stderr.write(`Could not start Remotion Studio: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

module.exports = { studioArgv, studioNodeOptions, preload };

if (require.main === module) main();

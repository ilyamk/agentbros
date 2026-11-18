/**
 * RUN_HARNESS_LIVE_TESTS=1: the installed harness CLIs see the agentbros server in this checkout
 * (after `pnpm harness:setup --apply`). `mcp list` reads configs and health-checks servers; no model call.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const live = process.env.RUN_HARNESS_LIVE_TESTS === "1";
const installed = (bin: string) => spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin]).status === 0;

for (const bin of ["claude", "codex"])
  test(
    `${bin} lists the agentbros MCP server`,
    { skip: !live ? "RUN_HARNESS_LIVE_TESTS unset" : !installed(bin) ? `${bin} not installed` : false },
    () => {
      const result = spawnSync(bin, ["mcp", "list"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.error, undefined);
      assert.match(`${result.stdout}${result.stderr}`, /agentbros/);
    },
  );

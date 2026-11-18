/** MCP uses JSON-RPC on stdout; intentionally outside the one-envelope scripts contract. */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { runtimeStatus } from "../lib/runtime";
import { validateProjectId } from "../lib/cli";
import { createVideoMcpServer } from "./server";
import { parseToolsets, type Toolset } from "./toolsets";
const args = process.argv.slice(2);
const codeRoot = path.resolve(import.meta.dirname, "../..");
try {
  const runtime = runtimeStatus();
  if (runtime.role === "unsupported")
    throw new Error(
      `Unsupported Node ${runtime.actual}; use ${runtime.primary} or reserve ${runtime.fallback} before starting MCP.`,
    );
  // The workspace root: --root, else AGENTBROS_ROOT, else this checkout (harnesses start servers from varying cwds).
  let root = process.env.AGENTBROS_ROOT || codeRoot,
    projectScope: string | undefined,
    toolsets: Toolset[] = parseToolsets(process.env.AGENTBROS_MCP_TOOLSETS || "all"),
    allowPaid = false,
    timeoutMs = 60000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--allow-paid") {
      allowPaid = true;
      continue;
    }
    if (arg === "--help") {
      process.stderr.write(
        "Agent Bros. Pictures MCP stdio: [--root PATH] [--project SLUG] [--toolsets all|core|<section>,...] [--allow-paid] [--timeout-ms N]\n--root defaults to AGENTBROS_ROOT, else this checkout; --toolsets to AGENTBROS_MCP_TOOLSETS, else all (unlisted tools stay reachable through avc_call).\nstdout is reserved for SDK JSON-RPC. Paid-capable tools are blocked or forced to dry-run by default.\n",
      );
      process.exit(0);
    }
    if (!["--root", "--project", "--timeout-ms", "--toolsets"].includes(arg))
      throw new Error(`Unknown server option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--root") root = path.resolve(value);
    else if (arg === "--project") projectScope = value;
    else if (arg === "--toolsets") toolsets = parseToolsets(value);
    else timeoutMs = Number(value);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Server root must be an existing directory.");
  if (projectScope) validateProjectId(projectScope);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7200000)
    throw new Error("Timeout must be an integer between 1000 and 7200000 milliseconds.");
  serveStdio(
    () => createVideoMcpServer({ root: realpathSync(root), codeRoot, projectScope, allowPaid, timeoutMs, toolsets }),
    {
      onerror: (error) => process.stderr.write(`MCP transport error: ${error.message}\n`),
    },
  );
} catch (error) {
  process.stderr.write(`MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

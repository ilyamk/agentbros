/**
 * Start or reuse the studio console server on 127.0.0.1 and print its URL (RFC 0004 §9.2, D15, D16).
 * The server runs detached (log: out/console/server.log); one server serves every project. `--stop` stops it.
 * The console token is long-lived (per checkout), so the token URL is printed only to a terminal or with
 * `--print-token` (as review:ui); otherwise stdout carries a one-use pairing URL (`tokenInUrl: false`), and `--open`
 * opens the token URL in the browser without printing it. The harness guard denies `--print-token` to agents.
 */
import { openConsoleBrowser } from "../src/lib/console/browser";
import { CliErrorObject, emitProgress, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { codeRoot } from "../src/lib/console/bundle";
import { startOrReuseConsoleServer, stopConsoleServer } from "../src/lib/console/start";
import { issuePairingCode, pairingUrl } from "../src/lib/console/pairing";
import { printableConsoleUrl } from "../src/lib/console/urls";
import { credentialBrowserUrl } from "../src/lib/console/credential-session";
import { DEFAULT_CONSOLE_PORT, SERVER_LOG_FILE } from "../src/types/console";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Open the console at this project" },
    { name: "port", type: "number", description: "Port (default 4317; falls back to a free port and says so)" },
    { name: "open", type: "boolean", description: "Open the console in the default browser" },
    {
      name: "print-token",
      type: "boolean",
      description: "Print the token URL even when stdout is not a terminal (keep it private)",
    },
    { name: "stop", type: "boolean", description: "Stop the running server" },
  ] as const);
  const rootDir = codeRoot();
  if (args.stop) {
    const stopped = await stopConsoleServer({ rootDir });
    if (stopped.reason) emitProgress(stopped.reason);
    return { metadata: { ...stopped } };
  }
  const project = args.project === undefined ? undefined : String(args.project);
  if (project) validateProjectId(project);
  const port = args.port === undefined ? DEFAULT_CONSOLE_PORT : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--port must be an integer from 0 to 65535." });
  const started = await startOrReuseConsoleServer({ rootDir, project, port });
  if ("error" in started)
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `The console server could not start: ${started.error}`,
      details: { log: SERVER_LOG_FILE },
    });
  if (started.fellBack) emitProgress(`Port ${port} is busy; the console listens on ${started.port} instead.`);
  emitProgress(
    started.reused
      ? `Reusing the console server on port ${started.port}.`
      : `Console server started (${SERVER_LOG_FILE}).`,
  );
  const { url, tokenInUrl } = printableConsoleUrl(started, {
    project,
    printToken: Boolean(args["print-token"]),
    isTTY: process.stdout.isTTY === true,
    pairUrl: () => pairingUrl(started.baseUrl, issuePairingCode(rootDir), project),
  });
  process.stderr.write(
    tokenInUrl
      ? "Keep the console URL private: it carries this machine's console token.\n"
      : "The URL has no token: it is a one-use pairing link (10 minutes), or open the console with pnpm console --open.\n",
  );
  if (args.open)
    await openConsoleBrowser(credentialBrowserUrl(rootDir, started.url)).catch(() =>
      emitProgress("Could not open the default browser."),
    );
  return {
    metadata: {
      url,
      tokenInUrl,
      baseUrl: started.baseUrl,
      port: started.port,
      reused: started.reused,
      fellBack: started.fellBack,
      pid: started.pid,
      version: started.version,
      ...(project ? { project } : {}),
    },
  };
});

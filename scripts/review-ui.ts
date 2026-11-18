import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { parseArgs, isCampaignContainer, validateProjectId, CliErrorObject } from "../src/lib/cli";
import path from "node:path";
import { issuePairingCode, pairingUrl } from "../src/lib/console/pairing";
import { ensureConsoleServer } from "../src/lib/console/start";
import { consoleReviewUrl } from "../src/lib/console/review/url";
import { DEFAULT_CONSOLE_PORT, SERVER_LOG_FILE } from "../src/types/console";
const started = Date.now();

/** Opens the URL in the default browser without a shell. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => process.stderr.write("Could not open a browser; open the URL yourself.\n"));
  child.unref();
}

/**
 * `pnpm review:ui` is the console's review alias (RFC 0004 D2, WP13): it starts or reuses the studio console (detached)
 * and prints its URL at the project's Timeline page; a campaign container opens the campaign view there. The command
 * returns at once. The console token is long-lived (per checkout), so the token URL is printed only to a terminal or
 * with `--print-token`; otherwise stdout carries the token-free page URL and `--open` opens the token URL in the
 * browser without printing it.
 */
async function consoleReview(project: string, port: number | undefined, open: boolean, printToken: boolean) {
  const directory = path.resolve("public/projects", project);
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project ${project} not found` });
  const server = await ensureConsoleServer({
    rootDir: process.cwd(),
    project,
    port: port ?? DEFAULT_CONSOLE_PORT,
  });
  if ("error" in server)
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `The console could not start: ${server.error} See ${SERVER_LOG_FILE}.`,
      details: { log: SERVER_LOG_FILE },
    });
  const tokenUrl = consoleReviewUrl(server, project);
  const withToken = printToken || process.stdout.isTTY === true;
  // Not a terminal: a one-use pairing link (pairing.ts) instead of the token, else the bare page URL.
  let url = tokenUrl;
  if (!withToken)
    try {
      url = pairingUrl(server.baseUrl, issuePairingCode(process.cwd()), project, "timeline");
    } catch {
      url = `${server.baseUrl}#/projects/${project}/timeline`;
    }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      metadata: {
        projectId: project,
        url,
        origin: server.baseUrl.replace(/\/$/, ""),
        paidActions: false,
        ui: "console",
        campaign: isCampaignContainer(directory),
        reused: server.reused,
        port: server.port,
        pid: server.pid,
        tokenInUrl: withToken,
      },
      elapsedMs: Date.now() - started,
    }) + "\n",
  );
  if (server.fellBack)
    process.stderr.write(`Port ${port ?? DEFAULT_CONSOLE_PORT} is busy; the console uses ${server.port}.\n`);
  process.stderr.write(
    `Console review ready (${server.reused ? "reused" : "started"}). ` +
      (withToken
        ? "Keep the URL private: it carries this checkout's console token. "
        : `The URL has no token (a one-use pairing link, 10 minutes): open it, or open the console with pnpm review:ui --project ${project} --open (or pnpm console --open). `) +
      "Stop it with pnpm console --stop.\n",
  );
  if (open) openInBrowser(tokenUrl);
}

async function main() {
  const args = parseArgs([
    { name: "project", required: true, description: "Project to review" },
    {
      name: "port",
      type: "number",
      description: "Console port when it starts (default 4317; a running console keeps its own)",
    },
    { name: "open", type: "boolean", description: "Open the review page in the default browser" },
    {
      name: "print-token",
      type: "boolean",
      description: "Print the token URL even when stdout is not a terminal (keep it private)",
    },
  ]);
  if (args.port !== undefined && (!Number.isInteger(args.port) || Number(args.port) < 0 || Number(args.port) > 65535))
    throw new Error("Invalid port");
  // Validate the ID before it names any directory on disk.
  validateProjectId(String(args.project));
  await consoleReview(
    String(args.project),
    args.port as number | undefined,
    Boolean(args.open),
    Boolean(args["print-token"]),
  );
}
main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof CliErrorObject ? error.code : "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    }) + "\n",
  );
  process.exitCode = 1;
});

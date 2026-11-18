/**
 * The detached console server process (RFC 0004 D16), spawned by `start.ts` with tsx:
 * `daemon.ts --root <dir> --port <n> --version <v> [--no-build] [--idle-ms <ms>]`.
 * Listens (falling back to a free port), writes the lock, builds a stale bundle in the background, exits after 12 h
 * without requests or on SIGTERM/SIGINT, and removes its own lock. Logs go to stdout/stderr (the server log); the
 * token is never logged.
 */
import { CONSOLE_IDLE_SHUTDOWN_MS, DEFAULT_CONSOLE_PORT } from "../../types/console";
import { realpathSync } from "node:fs";
import { controlActions } from "./control-actions";
import { stopConsoleStudios } from "./studio";
import { studioActions } from "./studio-actions";
import { notImplementedActions } from "./data";
import { liveServer, removeLockIfOwned, writeLock } from "./lock";
import { loadOrCreateSessionToken } from "./session";
import { startConsoleServer, type ConsoleServer } from "./server";
import { consoleActionsWith } from "./apply";
import { cardAnswerer } from "./cards";
import { deriveWaiting } from "./view/waiting";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

const log = (line: string) => process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);

async function main() {
  const rootDir = flag("root") ?? process.cwd();
  const port = Number(flag("port") ?? DEFAULT_CONSOLE_PORT);
  const version = flag("version") ?? "dev";
  const idleMs = Number(flag("idle-ms") ?? CONSOLE_IDLE_SHUTDOWN_MS);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port ${flag("port")}`);
  let server: ConsoleServer | undefined;
  let stopping = false;
  const stop = async (why: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    if (server) removeLockIfOwned(server.rootDir, process.pid);
    try {
      // The Remotion Studios started from the console for the user stop with it (§17, D21 as amended).
      if (server) {
        const stopped = await stopConsoleStudios(server.rootDir).catch(() => 0);
        if (stopped) log(`stopped ${stopped} Remotion Studio process(es) started from the console`);
      }
      await server?.close();
    } finally {
      process.exit(code);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => void stop(signal));
  process.on("uncaughtException", (error) => {
    log(`uncaught: ${error.stack ?? error.message}`);
    void stop("uncaught exception", 1);
  });
  // Two starters can race past a stale start lock: the second daemon finds the first one live and leaves.
  const token = loadOrCreateSessionToken(realpathSync(rootDir));
  const existing = await liveServer(realpathSync(rootDir), token, 2);
  if (existing && existing.lock.pid !== process.pid) {
    log(`another console server (pid ${existing.lock.pid}) already serves this checkout; exiting`);
    process.exit(0);
  }
  server = await startConsoleServer({
    rootDir,
    port,
    version,
    // Decisions (WP5), control (WP8) and card answers (WP11) over the real checkout.
    actions: consoleActionsWith(
      realpathSync(rootDir),
      {
        ...notImplementedActions,
        answerCard: cardAnswerer(realpathSync(rootDir)),
        ...controlActions(realpathSync(rootDir)),
        ...studioActions(realpathSync(rootDir)),
      },
      { deriveWaiting },
    ),
    build: !process.argv.includes("--no-build"),
    // Notifications (WP14): off until the user enables them; AGENTBROS_NOTIFY=off holds them off.
    notify: {},
    idleMs,
    onIdle: () => void stop(`idle for ${Math.round(idleMs / 60000)} min`),
    log,
  });
  writeLock(server.rootDir, {
    v: 1,
    pid: process.pid,
    port: server.port,
    version,
    startedAt: server.startedAt,
    url: `${server.origin}/`,
  });
  log(
    `console server ${version} listening on ${server.origin}/ (pid ${process.pid})` +
      (server.fellBack ? `; port ${port} was busy, using ${server.port}` : ""),
  );
  await server.bundle.ready;
  log(`bundle: ${server.bundle.state.kind}`);
}

main().catch((error: unknown) => {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

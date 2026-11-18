/** Listening and closing of loopback HTTP servers: 127.0.0.1 only, bounded request and header timeouts. */
import type { Server } from "node:http";

export const REQUEST_TIMEOUT_MS = 10_000;

/** Requests and headers each time out (10 s by default); response streams such as SSE are not affected. */
export function applyTimeouts(server: Server, ms = REQUEST_TIMEOUT_MS): void {
  server.requestTimeout = ms;
  server.headersTimeout = ms;
}

const listenOnce = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Missing loopback address"));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

/**
 * Listens on 127.0.0.1:`port`. With `fallback`, a busy port (EADDRINUSE or EACCES) falls back to a random free port
 * and `fellBack` says so.
 */
export async function listenLoopback(
  server: Server,
  port: number,
  options: { fallback?: boolean } = {},
): Promise<{ port: number; fellBack: boolean }> {
  try {
    return { port: await listenOnce(server, port), fellBack: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!options.fallback || port === 0 || (code !== "EADDRINUSE" && code !== "EACCES")) throw error;
    return { port: await listenOnce(server, 0), fellBack: true };
  }
}

/** Closes the server: idle sockets at once, the rest forced after `forceMs`, rejecting after `deadlineMs`. */
export function closeServer(server: Server, options: { forceMs?: number; deadlineMs?: number } = {}): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), options.forceMs ?? 250);
    const deadline = setTimeout(() => reject(new Error("Owned HTTP shutdown deadline")), options.deadlineMs ?? 1500);
    server.close((error) => {
      clearTimeout(force);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

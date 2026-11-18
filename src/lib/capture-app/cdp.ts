import { spawn, type ChildProcess } from "node:child_process";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; method: string };
type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

export type CdpConnection = {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  once: (event: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  on: (event: string, listener: Listener) => () => void;
  version: string;
  close: () => void;
};

/** Starts a headless Chromium with a debugging socket and connects to its browser target over raw CDP. */
export const launchChrome = async (
  executable: string,
  profileDir: string,
  timeoutMs = 20_000,
): Promise<CdpConnection> => {
  const child: ChildProcess = spawn(
    executable,
    [
      "--no-sandbox",
      "--remote-debugging-port=0",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-checker-imaging",
      "--run-all-compositor-stages-before-draw",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chromium did not open a debugging socket within ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited with code ${code} before the debugging socket opened`));
    });
    let log = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = /DevTools listening on (ws:\S+)/.exec(log);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  child.removeAllListeners("exit");

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed to open")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Listener>>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (message.id === undefined) {
      if (message.method)
        for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
      return;
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter?.resolve(message.result ?? {});
  });

  const on = (event: string, listener: Listener) => {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(event, set);
    return () => {
      set.delete(listener);
    };
  };
  const send: CdpConnection["send"] = (method, params = {}, sessionId, ms = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method} took longer than ${ms} ms`));
      }, ms);
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const once: CdpConnection["once"] = (event, ms = 30_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout: no ${event} within ${ms} ms`));
      }, ms);
      const off = on(event, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });

  const { product } = (await send("Browser.getVersion")) as { product: string };
  return {
    send,
    once,
    on,
    version: product,
    close: () => {
      socket.close();
      child.kill("SIGKILL");
    },
  };
};

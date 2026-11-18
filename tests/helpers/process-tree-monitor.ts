import { spawn } from "node:child_process";
import path from "node:path";

/** Independent child observes synchronous FFmpeg phases as well as async renders. */
export function startProcessTreeMonitor(output: string) {
  const monitor = spawn(
    process.execPath,
    [path.resolve("tests/fixtures/process-tree-monitor.mjs"), String(process.pid), output],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let error = "";
  monitor.stderr.on("data", (data) => {
    error = (error + data.toString()).slice(-4096);
  });
  const finished = new Promise<void>((resolve, reject) => {
    monitor.on("error", reject);
    monitor.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Memory monitor failed: ${error}`))));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      monitor.kill("SIGTERM");
      reject(new Error("Memory sampler startup timed out"));
    }, 10000);
    monitor.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    monitor.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    monitor.once("close", () => {
      clearTimeout(timeout);
      reject(new Error("Memory sampler closed before ready"));
    });
  });
  monitor.stdin.on("error", () => {}); // finished reports early exits; avoid masking that error with EPIPE.
  return {
    ready,
    stop: async () => {
      monitor.stdin.end("stop\n");
      await finished;
    },
  };
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { CliErrorObject } from "../../cli";

const scripts = new Set(["render-project.ts", "film-render.ts", "generate-model.ts"]);
let commandInterrupted = false;
export async function campaignCommand(
  root: string,
  script: string,
  args: string[],
  timeoutMs = 30 * 60_000,
): Promise<{ outputs: string[]; metadata: Record<string, unknown> }> {
  if (commandInterrupted) throw new Error("Campaign command execution was interrupted");
  if (!scripts.has(script)) throw new Error("Unregistered campaign command");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli"),
    codeRoot = path.resolve(import.meta.dirname, "../../../..");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, path.join(codeRoot, "scripts", script), ...args], {
      cwd: root,
      shell: false,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      timedOut = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const interrupted = () => {
      commandInterrupted = true;
      process.exitCode = 130;
      kill();
    };
    process.once("exit", kill);
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) kill();
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      process.off("exit", kill);
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
      kill();
      try {
        if (timedOut || bytes > 32 * 1024 * 1024)
          throw new Error(timedOut ? "Campaign command timed out" : "Campaign command output exceeded limit");
        const envelope = JSON.parse(stdout.trim()) as {
          ok?: boolean;
          outputs?: string[];
          metadata?: Record<string, unknown>;
          message?: string;
          error?: string;
        };
        if (code !== 0 || !envelope.ok)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `${script}: ${envelope.message ?? envelope.error ?? "Command failed"}${stderr && ["render-project.ts", "film-render.ts"].includes(script) ? `; diagnostic: ${stderr.slice(-2400)}` : ""}`,
          });
        resolve({ outputs: envelope.outputs ?? [], metadata: envelope.metadata ?? {} });
      } catch (error) {
        reject(error);
      }
    });
  });
}

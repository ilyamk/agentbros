import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { assertPathWithin, CliErrorObject } from "../../cli";
import type { BackendProbe, ResolveAdapter } from "../handoff";

export const defaultResolveSdk =
  process.platform === "darwin"
    ? "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    : process.platform === "win32"
      ? path.join(
          process.env.PROGRAMDATA ?? "C:\\ProgramData",
          "Blackmagic Design",
          "DaVinci Resolve",
          "Support",
          "Developer",
          "Scripting",
        )
      : "/opt/resolve/Developer/Scripting";
export type ResolveWorkerOptions = {
  python?: string;
  timeoutMs?: number;
  sdkDirectory?: string;
  /** Test-only local fake SDK state. Not exposed by CLI and never inherits caller secrets. */
  fixtureState?: string;
};
/** All requests run the repository worker; neither request nor handoff can name code. */
export class LocalResolveAdapter implements ResolveAdapter {
  readonly directory: string;
  constructor(
    directory: string,
    private readonly options: ResolveWorkerOptions = {},
  ) {
    this.directory = realpathSync(directory);
    assertPathWithin(this.directory, path.join(this.directory, "handoff.json"));
  }
  private async request<T>(action: string, fields: Record<string, unknown> = {}): Promise<T> {
    const worker = path.resolve(__dirname, "../../../../workers/resolve_worker.py");
    const sdk = this.options.sdkDirectory ?? defaultResolveSdk;
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: path.join(sdk, "Modules"),
      RESOLVE_SCRIPT_API: sdk,
    };
    if (process.platform === "darwin")
      environment.RESOLVE_SCRIPT_LIB =
        "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so";
    if (process.platform === "linux") environment.RESOLVE_SCRIPT_LIB = "/opt/resolve/libs/Fusion/fusionscript.so";
    if (this.options.fixtureState) environment.RESOLVE_WORKER_FIXTURE = this.options.fixtureState;
    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.options.python ?? "python3", [worker], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(
          new CliErrorObject({
            code: "TIMEOUT",
            message: "Resolve worker timeout; mutation acknowledgement may be lost: reconcile, never replay",
          }),
        );
      }, this.options.timeoutMs ?? 30000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 2_000_000) {
          child.kill();
          fail(new Error("Resolve worker output limit exceeded"));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        clearTimeout(timer);
        try {
          const lines = stdout.trim().split("\n");
          if (lines.length !== 1) throw new Error("Resolve worker did not return exactly one JSON response");
          const envelope = JSON.parse(lines[0]);
          if (code !== 0 || envelope.ok !== true)
            throw new Error(envelope.message ?? `Resolve worker failed: ${stderr}`);
          settled = true;
          resolve(envelope.result as T);
        } catch (error) {
          fail(error as Error);
        }
      });
      child.stdin.on("error", (error) => fail(error));
      child.stdin.end(JSON.stringify({ directory: this.directory, action, ...fields }));
    });
  }
  async probe(): Promise<BackendProbe> {
    if (!existsSync(path.join(this.options.sdkDirectory ?? defaultResolveSdk, "Modules/DaVinciResolveScript.py")))
      return {
        backend: "resolve",
        available: false,
        capabilities: [],
        liveVerified: false,
        reason: "Local Resolve scripting SDK not installed; no installation attempted",
      };
    try {
      return await this.request<BackendProbe>("probe");
    } catch (error) {
      return {
        backend: "resolve",
        available: false,
        capabilities: [],
        liveVerified: false,
        reason: (error as Error).message,
      };
    }
  }
  async fingerprintOriginal(timelineId: string) {
    return (await this.request<{ fingerprint: string }>("fingerprint", { timelineId })).fingerprint;
  }
  async cloneTimeline(timelineId: string, cloneName: string) {
    return this.request<{ timelineId: string }>("clone", {
      timelineId,
      cloneName,
    });
  }
  async importIntoClone(timelineId: string, exportFile: string) {
    exportFile = realpathSync(exportFile);
    assertPathWithin(this.directory, exportFile);
    await this.request("import", {
      timelineId,
      exportFile: path.resolve(exportFile),
    });
  }
  async readback(timelineId: string) {
    return this.request<Record<string, unknown>>("readback", { timelineId });
  }
}

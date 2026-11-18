import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliErrorObject } from "../cli";
import { NativePreparationOwnership } from "../backends/native-process-ownership";

/** Internal literal argv only; never exposed as a CLI/MCP executable option. */
export function runIconWorker(
  argv: string[],
  timeoutMs = 15000,
  createOwnership: () => Pick<NativePreparationOwnership, "register" | "capture" | "kill"> = () =>
    new NativePreparationOwnership(),
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      shell: false,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    });
    const ownership = createOwnership();
    let stderr = "",
      failure: Error | undefined;
    const abort = (error: Error) => {
      failure ??= error;
      try {
        ownership.kill();
      } catch (cleanup) {
        failure = new Error(`${error.message}; cleanup: ${String(cleanup)}`);
      } finally {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => abort(new CliErrorObject({ code: "TIMEOUT", message: "Icon raster export timed out" })),
      timeoutMs,
    );
    const watch = setInterval(() => {
      try {
        ownership.capture();
      } catch (error) {
        abort(new Error(String(error)));
      }
    }, 100);
    const cancel = () => abort(new Error("Icon export cancelled"));
    process.once("SIGTERM", cancel);
    child.once("spawn", () => {
      try {
        ownership.register(child.pid!, process.pid);
      } catch (error) {
        abort(new Error(String(error)));
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      process.removeListener("SIGTERM", cancel);
      try {
        ownership.kill();
      } catch (error) {
        failure ??= new Error(`Icon export cleanup failed: ${String(error)}`);
      }
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new CliErrorObject({ code: "VALIDATION", message: `Icon raster export failed: ${stderr}` }));
    });
  });
}
export function rasterise(input: string, output: string, format: string) {
  const worker = fileURLToPath(new URL("./export-worker.ts", import.meta.url));
  return runIconWorker(["--import", "tsx", worker, input, output, format]);
}

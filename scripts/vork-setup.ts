import path from "node:path";
import { parseArgs, runScript } from "../src/lib/cli";
import {
  installVork,
  probeVork,
  requireVork,
  runProcess,
  runtimePins,
  toolDirectory,
  writeNew,
} from "../src/lib/vork/runtime";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["status", "install", "verify"],
      default: "status",
      description: "Inspect, explicitly install the pinned runtime, or verify tools/GPU",
    },
    { name: "executable", description: "Complete external Vork 0.5.1 runtime executable" },
    { name: "output", description: "Fresh verification report JSON" },
  ] as const);
  if (args.action === "install") return { outputs: [toolDirectory()], metadata: await installVork() };
  if (args.action === "status") return { outputs: [], metadata: probeVork(args.executable) };
  const executable = requireVork(args.executable),
    pins = runtimePins(executable);
  const result = await runProcess(executable, ["setup", "--skip-warmup"], { timeoutSec: 600 });
  const report = {
    ...probeVork(executable),
    toolsVerified: true,
    liveVerified: false,
    runtimeFiles: pins.length,
    elapsedMs: result.elapsedMs,
    report: result.stdout,
    next: "Render and inspect a recipe; setup is not a picture qualification",
  };
  return { outputs: args.output ? [writeNew(path.resolve(args.output), report)] : [], metadata: report };
});

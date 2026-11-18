import { readFileSync, realpathSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject, assertPathWithin } from "../src/lib/cli";
import {
  listOptionalBackends,
  probeBlender,
  probeHyperframesCli,
  probeResolve,
  probeHtml,
  probeYtDlp,
  probeVork,
} from "../src/lib/backends/probe";
import { prepareHandoff } from "../src/lib/backends/handoff";
import { captureBlender } from "../src/lib/backends/blender";
import type { ExportAssets } from "../src/lib/backends/export";
runScript(async () => {
  const args = parseArgs([
    { name: "action", default: "capabilities", description: "capabilities | probe | export | blender" },
    { name: "backend", description: "blender | vork | resolve | hyperframes-html | hyperframes-cli | yt-dlp" },
    { name: "timeline", description: "Canonical IR JSON" },
    { name: "assets", description: "ExportAssets JSON with absolute original paths and source metadata" },
    { name: "original-timeline-id", description: "Original Resolve timeline ID, never modified" },
    { name: "output", description: "Fresh handoff/capture directory" },
    { name: "request", description: "Blender procedural capture JSON" },
    { name: "executable", description: "Optional local executable path" },
    {
      name: "scope-root",
      description: "Trusted MCP workspace boundary: every export asset path must resolve inside it",
    },
  ] as const);
  if (args.action === "capabilities") return { outputs: [], metadata: { backends: listOptionalBackends() } };
  if (args.action === "probe")
    return {
      outputs: [],
      metadata:
        args.backend === "vork"
          ? probeVork(args.executable)
          : args.backend === "blender"
            ? probeBlender(args.executable)
            : args.backend === "resolve"
              ? probeResolve(args.executable)
              : args.backend === "hyperframes-html" || args.backend === "html"
                ? await probeHtml()
                : args.backend === "yt-dlp"
                  ? probeYtDlp()
                  : args.backend === "hyperframes-cli"
                    ? probeHyperframesCli()
                    : { available: false, reason: "No verified versioned local adapter", backend: args.backend },
    };
  if (args.action === "export" && args.timeline && args.assets && args.output && args["original-timeline-id"]) {
    const assets = JSON.parse(readFileSync(args.assets, "utf8")) as ExportAssets;
    // Export assets name absolute original paths that are hashed; under MCP they must stay in the workspace.
    if (args["scope-root"]) {
      const scope = realpathSync(args["scope-root"]);
      for (const asset of Object.values(assets ?? {})) {
        if (typeof asset?.path !== "string")
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "Export asset path missing." });
        assertPathWithin(scope, realpathSync(asset.path));
      }
    }
    const result = prepareHandoff(
      JSON.parse(readFileSync(args.timeline, "utf8")),
      assets,
      args.output,
      args["original-timeline-id"],
    );
    return {
      outputs: result.exports.map((item) => `${args.output}/${item.name}`),
      metadata: {
        manifest: `${args.output}/handoff.json`,
        handoffId: result.handoffId,
        state: "prepared",
        nextAction: "review-export-then-configure-isolated-Resolve-adapter",
      },
    };
  }
  if (args.action === "blender" && args.request && args.output) {
    const result = captureBlender(JSON.parse(readFileSync(args.request, "utf8")), args.output, {
      executable: args.executable,
    });
    return { outputs: Array.isArray(result.outputs) ? (result.outputs as string[]) : [], metadata: result };
  }
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message: "Use capabilities/probe/export/blender with required local paths.",
  });
});

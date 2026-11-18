import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, CliErrorObject, assertPathWithin } from "../src/lib/cli";
import { runPlatformAudioHandoff, HandoffWorkerError } from "../src/lib/delivery/platform-audio-handoff-supervisor";
import { DeliveryRequestSchema } from "../src/types/delivery";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import { noteDelivered } from "../src/lib/memory/capture";
/** Local-only script: failed QA still returns the persisted report as an output. */
async function main() {
  const startedAt = Date.now();
  try {
    const args = parseArgs([
      {
        name: "action",
        default: "check",
        description: "snapshot before render | check after render | handoff pending manual",
      },
      { name: "request", required: true, description: "Strict DeliveryRequest JSON with profile/review evidence" },
      { name: "snapshot", description: "Immutable source snapshot from action=snapshot" },
      { name: "project", description: "Optional exact project pin for handoff" },
      { name: "recover", description: "Read-only handoff recovery by exact content ID" },
    ] as const);
    if (args.action === "handoff") {
      if (!args.snapshot) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Handoff requires --snapshot." });
      const result = await runPlatformAudioHandoff({
        request: args.request!,
        snapshot: args.snapshot,
        ...(args.project ? { project: args.project } : {}),
        ...(args.recover ? { recover: args.recover } : {}),
      });
      console.log(
        JSON.stringify({ ok: true, outputs: [result.marker], metadata: result, elapsedMs: Date.now() - startedAt }),
      );
      return;
    }
    const request = DeliveryRequestSchema.parse(JSON.parse(readFileSync(args.request!, "utf8")));
    if (args.action === "snapshot") {
      const result = captureDeliverySnapshot(request);
      console.log(
        JSON.stringify({
          ok: true,
          outputs: [result.file],
          metadata: { snapshot: result.snapshot, nextAction: "render-each-requested-variant-then-review-and-check" },
          elapsedMs: Date.now() - startedAt,
        }),
      );
      return;
    }
    if (args.action !== "check" || !args.snapshot)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Check requires --snapshot from capture before render.",
      });
    assertPathWithin(path.resolve("public/projects", request.projectId), path.resolve(args.snapshot));
    const result = checkDelivery(request, JSON.parse(readFileSync(args.snapshot, "utf8")));
    const memoryWarning = result.productionReady
      ? noteDelivered(request.projectId, result.manifest.outputs.length, request.formats, result.manifest.snapshotId)
      : undefined;
    if (memoryWarning) console.error(memoryWarning);
    console.log(
      JSON.stringify({
        ok: result.ok,
        outputs: result.outputs,
        metadata: {
          state: result.manifest.state,
          ...(memoryWarning ? { memoryWarning } : {}),
          productionReady: result.productionReady,
          ...(result.blockers.some((item) => item.code === "REPLICA_STUDY_ONLY")
            ? { publication: "study only, not for publication" }
            : {}),
          report: result.report,
          blockers: result.blockers,
          warnings: result.manifest.findings.filter((f) => f.severity === "warning"),
        },
        ...(result.ok ? {} : { error: "VALIDATION", message: "Delivery blocked by QA/review/rights/budget findings" }),
        elapsedMs: Date.now() - startedAt,
      }),
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        outputs: [],
        error:
          error instanceof CliErrorObject
            ? error.code
            : error instanceof HandoffWorkerError
              ? error.code
              : "VALIDATION",
        ...(error instanceof HandoffWorkerError
          ? {
              metadata: {
                state: "draft-needs-review",
                productionReady: false,
                status: "pending-manual",
                publication: error.publication,
              },
            }
          : {}),
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 1;
  }
}
void main();

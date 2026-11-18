import { parseArgs, runScript } from "../src/lib/cli";
import { inspectReviewPack } from "../src/lib/vision/review-pack";
void runScript(async () => {
  const args = parseArgs([
    { name: "manifest", required: true, description: "Review manifest JSON" },
    { name: "frame", type: "number", description: "Exact source frame filter" },
    { name: "limit", type: "number", default: 12, description: "Maximum frames returned (1..100)" },
    { name: "scope-root", description: "Trusted filesystem boundary (supplied by MCP)" },
    { name: "project", description: "MCP project scope" },
  ] as const);
  const inspected = inspectReviewPack(args.manifest!, {
    scopeRoot: args["scope-root"],
    frame: args.frame,
    limit: args.limit,
  });
  const { request, omitted, frames, ...summary } = inspected;
  return {
    metadata: {
      ...summary,
      request: {
        profile: request.profile,
        fields: request.fields,
        startFrame: request.startFrame,
        endFrame: request.endFrame,
        step: request.step,
      },
      omittedCount: omitted.length,
      omitted: omitted.slice(0, args.limit).map((event) => ({
        frame: event.frame,
        basis: event.basis,
        reasons: event.reasons.slice(0, 8).map((reason) => reason.slice(0, 200)),
        reasonsTotal: event.reasons.length,
      })),
      metadataBounded: true,
      frames: frames.map((frame) => ({
        ...frame,
        reasons: frame.reasons.slice(0, 8).map((reason) => reason.slice(0, 200)),
        reasonEvidence: frame.reasonEvidence
          ?.slice(0, 8)
          .map((fact) => ({ ...fact, reason: fact.reason.slice(0, 200) })),
        reasonsTotal: frame.reasons.length,
        reasonsTruncated: frame.reasons.length > 8 || frame.reasons.some((reason) => reason.length > 200),
        ...(frame.text ? { text: frame.text.slice(0, 1000), textTruncated: frame.text.length > 1000 } : {}),
        measurements: frame.measurements.slice(0, 12).map((m) => ({
          ...m,
          value: typeof m.value === "string" ? m.value.slice(0, 1000) : m.value,
          evidence: m.evidence.slice(0, 500),
        })),
        measurementsTotal: frame.measurements.length,
        measurementsTruncated:
          frame.measurements.length > 12 ||
          frame.measurements.some((m) => typeof m.value === "string" && m.value.length > 1000),
      })),
    },
  };
});

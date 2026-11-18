import { readFileSync } from "node:fs";
import path from "node:path";
import { pausedControl, submitPauseMessage } from "../src/lib/console/control";
import { parseArgs, requireEnv, CliErrorObject, validateProjectId } from "../src/lib/cli";
import { createFalRealtimeTokenProvider } from "../src/lib/providers/fal-realtime-token";
import { applyManagedCredentials } from "../src/lib/setup/credential-store";
import { planRealtimeSession, runRealtimeSession } from "../src/lib/realtime/session";
/** Default is a pure offline plan; explicit execute uses externally supplied short-lived token. */
async function main() {
  const started = Date.now();
  try {
    const args = parseArgs([
      { name: "project", description: "Optional MCP scoped project; must match request projectId" },
      {
        name: "request",
        required: true,
        description: "Strict RealtimeSessionRequest JSON",
      },
      {
        name: "dry-run",
        type: "boolean",
        description: "Force offline plan even with execute; MCP paid guard",
      },
      {
        name: "execute",
        type: "boolean",
        description: "Explicit future paid execution (default offline plan)",
      },
      {
        name: "token-env",
        default: "FAL_REALTIME_TOKEN",
        description: "Environment name containing externally obtained short-lived token",
      },
    ] as const);
    const input = JSON.parse(readFileSync(String(args.request), "utf8"));
    if (args.project) {
      validateProjectId(String(args.project));
      if (input.projectId !== args.project)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Request projectId must match scoped --project" });
    }
    const plan = planRealtimeSession(input);
    if (!args.execute || args["dry-run"] === true) {
      console.log(
        JSON.stringify({
          ok: true,
          outputs: [],
          metadata: {
            dryRun: true,
            endpoint: plan.plan.endpoint,
            sessionId: plan.request.sessionId,
            revisionId: plan.request.revisionId,
            inputHash: plan.inputHash,
            inputBytes: plan.wire.byteLength,
            expectedFrames: plan.expectedFrames,
            quote: plan.request.quote,
            limits: plan.request.limits,
            providerAck: false,
            recovery: "no automatic reconnect or replay",
            liveVerified: false,
          },
          elapsedMs: Date.now() - started,
        }),
      );
      return;
    }
    // This command does not run through runScript: the pause (RFC 0004 D12) is checked here before any paid session,
    // and again by the job store at reserve and submit.
    const paused = pausedControl(path.join("public", "projects", plan.request.projectId));
    if (paused)
      throw new CliErrorObject({
        code: "PAUSED",
        message: submitPauseMessage(plan.request.projectId, paused),
      });
    applyManagedCredentials(process.env);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const result = await runRealtimeSession(input, {
      signal: controller.signal,
      tokenProvider: async (endpoint) =>
        process.env[String(args["token-env"])]?.trim() ||
        createFalRealtimeTokenProvider(() => requireEnv("FAL_KEY"))(endpoint),
    }).finally(() => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    });
    console.log(
      JSON.stringify({
        ok: true,
        ...result,
        elapsedMs: Date.now() - started,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        outputs: [],
        error: error instanceof CliErrorObject ? error.code : "VALIDATION",
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      }),
    );
    process.exitCode = 1;
  }
}
void main();

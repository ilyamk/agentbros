/**
 * The console's control actions (RFC 0004 D12, §8): pause, resume and stop spawn `console:control`, a per-job cancel
 * spawns `job:cancel`, both as the user (`AGENTBROS_ACTOR=user`, `AGENTBROS_CHANNEL=console`) with the user's words,
 * so every write is a CLI run with its journal lines. Literal argument arrays, no shell.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CliEnvelopeSchema,
  ControlFileSchema,
  ControlResponseSchema,
  HooksInstallResponseSchema,
  HooksStatusSchema,
  JobCancelResponseSchema,
  JobSummarySchema,
  type CliEnvelope,
  type ControlRequest,
  type ControlResponse,
  type HooksInstallResponse,
  type JobCancelRequest,
  type JobCancelResponse,
} from "../../types/console";
import { HttpError } from "../local-server/errors";
import { codeRoot } from "./bundle";
import { projectsFromArgv } from "./control";
import { consoleGrantEnv } from "./grant";
import type { ConsoleActions } from "./data";

export type CliRunner = (rootDir: string, script: string, args: string[], timeoutMs: number) => Promise<CliEnvelope>;

/** Runs `scripts/<script>` in the checkout with tsx and returns its one JSON line. */
export const spawnCli: CliRunner = (rootDir, script, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    let tsx: string;
    try {
      tsx = pathToFileURL(createRequire(path.join(codeRoot(), "package.json")).resolve("tsx")).href;
    } catch {
      reject(new HttpError(500, "INTERNAL", "tsx is not installed; run pnpm install."));
      return;
    }
    // The user's command: signed with the console grant so it runs while the project is paused (grant.ts).
    const [project] = projectsFromArgv(args);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBROS_ACTOR: "user",
      AGENTBROS_CHANNEL: "console",
      ...(project ? consoleGrantEnv(rootDir, project, args) : {}),
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", tsx, path.join(codeRoot(), "scripts", script), ...args], {
      cwd: rootDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HttpError(500, "INTERNAL", `Could not run ${script}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = CliEnvelopeSchema.parse(JSON.parse(stdout.trim()));
        if (code !== (result.ok ? 0 : 1)) throw new Error("Exit code disagrees with the CLI result.");
        resolve(result);
      } catch {
        reject(new HttpError(500, "INTERNAL", `${script} did not return a valid CLI result.`));
      }
    });
  });

const STATUS: Record<string, number> = { PROJECT_NOT_FOUND: 404, INVALID_INPUT: 400, VALIDATION: 400 };

function refused(envelope: CliEnvelope): HttpError {
  return new HttpError(
    STATUS[envelope.error ?? ""] ?? 500,
    envelope.error ?? "INTERNAL",
    envelope.message ?? "Refused",
  );
}

/** `control`, `cancelJob` and `installHooks` for the console server; `run` is injectable for tests. */
export function controlActions(
  rootDir: string,
  run: CliRunner = spawnCli,
): Pick<ConsoleActions, "control" | "cancelJob" | "installHooks"> {
  return {
    /** H3: the user's yes in the console runs the same command an agent would after asking. */
    async installHooks(): Promise<HooksInstallResponse> {
      const envelope = await run(rootDir, "harness-setup.ts", ["--hooks", "--apply"], 60_000);
      const metadata = envelope.metadata ?? {};
      const status = HooksStatusSchema.safeParse(metadata.status);
      const trust = Array.isArray(metadata.trust)
        ? metadata.trust
            .filter((item): item is string => typeof item === "string" && !!item)
            .map((item) => item.slice(0, 1000))
        : [];
      return HooksInstallResponseSchema.parse({
        ok: envelope.ok,
        ...(status.success ? { status: status.data } : {}),
        ...(trust.length ? { trust: trust.slice(0, 8) } : {}),
        ...(envelope.message ? { message: envelope.message.slice(0, 4000) } : {}),
        // The plan's full file contents stay out of the reply: the status and trust steps say what changed.
        result: { ...envelope, metadata: { ...metadata, hooks: undefined } },
      });
    },
    async control(project: string, request: ControlRequest): Promise<ControlResponse> {
      const envelope = await run(
        rootDir,
        "console-control.ts",
        [
          "--project",
          project,
          "--state",
          request.state,
          // `--flag=value`: the user's words may start with "-" (parseArgs refuses a dash-led separate value).
          `--answer=${request.answer}`,
          ...(request.reason ? [`--reason=${request.reason}`] : []),
        ],
        30_000,
      );
      if (!envelope.ok) throw refused(envelope);
      const metadata = envelope.metadata ?? {};
      return ControlResponseSchema.parse({
        ok: true,
        control: ControlFileSchema.parse(metadata.control),
        ...(Array.isArray(metadata.runningJobs)
          ? { runningJobs: metadata.runningJobs.map((job) => JobSummarySchema.parse(job)) }
          : {}),
        result: envelope,
      });
    },
    async cancelJob(project: string, jobId: string, request: JobCancelRequest): Promise<JobCancelResponse> {
      const envelope = await run(
        rootDir,
        "job-cancel.ts",
        ["--project", project, "--operation-id", jobId, `--answer=${request.answer}`],
        120_000,
      );
      if (!envelope.ok) {
        if (envelope.details?.unknownJob === true)
          throw new HttpError(404, "NOT_FOUND", envelope.message ?? `No job ${jobId}`);
        if (envelope.error === "PROJECT_NOT_FOUND") throw refused(envelope);
        return JobCancelResponseSchema.parse({
          ok: false,
          ...(envelope.message ? { message: envelope.message.slice(0, 4000) } : {}),
          result: envelope,
        });
      }
      const metadata = envelope.metadata ?? {};
      return JobCancelResponseSchema.parse({
        ok: true,
        outcome: metadata.outcome,
        job: metadata.job,
        ...(typeof metadata.message === "string" ? { message: metadata.message.slice(0, 4000) } : {}),
        result: envelope,
      });
    },
  };
}

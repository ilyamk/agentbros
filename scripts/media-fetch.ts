import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, runScript, emitResult } from "../src/lib/cli";
import { MediaFetchOptionsSchema } from "../src/types/media-fetch";
import { createJob, jobBase, preview, publicReport, runJob } from "../src/lib/media-fetch/runner";
import { inspectPricing } from "../src/lib/media-fetch/pricing";
import { atomicJson } from "../src/lib/media-fetch/storage";
import { doctor, PROVIDERS } from "../src/lib/media-fetch/catalogue";
import { scopedPath, readJob } from "../src/lib/media-fetch/storage";
import { issue, MediaFetchError } from "../src/lib/media-fetch/errors";

runScript(async () => {
  const args = parseArgs([
    { name: "url", description: "Public media URL; use input for a batch of up to 100 links" },
    { name: "input", description: "JSON array of URLs or object {urls,...options}" },
    { name: "project", description: "Existing project ID" },
    { name: "output-dir", description: "Git-ignored workspace directory when no project is supplied" },
    { name: "provider", description: "auto, rapidapi, apify-easyapi or apify-wilcode" },
    { name: "kind", description: "auto, all, video, audio or image" },
    { name: "preset", description: "original or edit (MP4 H.264/AAC)" },
    { name: "height", type: "number", description: "Maximum video height, without upscaling" },
    { name: "audio-format", description: "original, mp3 or wav" },
    { name: "include-associated-audio", type: "boolean", description: "Include video soundtracks as separate audio" },
    { name: "concurrency", type: "number", description: "Parallel source tasks, 1–16 (default 4)" },
    { name: "max-file-mb", type: "number", description: "File limit MiB (default 2048)" },
    { name: "max-total-mb", type: "number", description: "Batch download limit MiB (default 10240)" },
    { name: "timeout-sec", type: "number", description: "Operation deadline seconds (default 600)" },
    {
      name: "max-cost-usd",
      type: "number",
      description: "Explicit per-provider-call planning bound, not a billing cap",
    },
    { name: "max-total-cost-usd", type: "number", description: "Explicit aggregate job planning bound" },
    { name: "dry-run", type: "boolean", description: "Offline plan; never submit or download" },
    { name: "status", description: "Read saved job UUID; supply the same project or output-dir" },
    { name: "resume", description: "Resume saved job UUID; never repeats unknown submissions" },
    { name: "capabilities", type: "boolean", description: "Read provider/platform capabilities" },
    {
      name: "refresh-pricing",
      type: "boolean",
      description: "Read current public Actor prices and save dated evidence; never starts Actors",
    },
    { name: "doctor", type: "boolean", description: "Offline key and subscription setup instructions" },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
    { name: "wait-sec", type: "number", description: "Wait for worker before returning status (default 30)" },
    { name: "worker", description: "Internal durable worker UUID" },
  ] as const);
  const started = Date.now();
  try {
    if (args["refresh-pricing"]) {
      const prices = await inspectPricing();
      const evidence = scopedPath(process.cwd(), path.resolve(".cache/media-fetch/pricing.json"));
      atomicJson(evidence, prices);
      return { outputs: [evidence], metadata: { prices } };
    }
    if (args.doctor) return { metadata: { providers: doctor() } };
    if (args.capabilities)
      return {
        metadata: {
          providers: PROVIDERS,
          defaults: { preset: "original", kind: "auto", concurrency: 4 },
          coverage: "Documented support, not live acceptance; unknown domains try EasyAPI.",
        },
      };
    const root = args["scope-root"] ? path.resolve(args["scope-root"]) : process.cwd();
    if (root !== process.cwd())
      throw new MediaFetchError("UNSAFE_PATH", "Workspace boundary differs from working directory.");
    const id = args.status ?? args.resume ?? args.worker;
    let job;
    if (id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new MediaFetchError("INVALID_INPUT", "Invalid job ID.");
      const directory = scopedPath(
        root,
        path.join(jobBase({ project: args.project, outputDir: args["output-dir"] }, root), id),
      );
      job = readJob(directory);
      if (job.directory !== directory || job.options.project !== args.project)
        throw new MediaFetchError("UNSAFE_PATH", "Job identity or project differs from request.");
      if (args.worker) {
        await runJob(job, root);
        return { metadata: publicReport(job) };
      }
      if (args.status) return { metadata: publicReport(job) };
      if (args["dry-run"]) return { metadata: { ...publicReport(job), status: "planned", network: false } };
    } else {
      let input: unknown = {};
      if (args.input) {
        const file = scopedPath(root, path.resolve(args.input));
        if (readFileSync(file).length > 1024 * 1024)
          throw new MediaFetchError("SIZE_LIMIT", "Input JSON exceeds 1 MiB.");
        input = JSON.parse(readFileSync(file, "utf8"));
      }
      const record = Array.isArray(input) ? { urls: input } : (input as Record<string, unknown>);
      if (args.url && record.urls) throw new MediaFetchError("INVALID_INPUT", "Choose url or input URLs.");
      const flags = Object.fromEntries(
        Object.entries({
          urls: args.url ? [args.url] : undefined,
          project: args.project,
          outputDir: args["output-dir"],
          provider: args.provider,
          kind: args.kind,
          preset: args.preset,
          height: args.height,
          audioFormat: args["audio-format"],
          includeAssociatedAudio: args["include-associated-audio"] || undefined,
          concurrency: args.concurrency,
          maxFileMb: args["max-file-mb"],
          maxTotalMb: args["max-total-mb"],
          timeoutSec: args["timeout-sec"],
          maxCostUsd: args["max-cost-usd"],
          maxTotalCostUsd: args["max-total-cost-usd"],
        }).filter(([, v]) => v !== undefined),
      );
      const options = MediaFetchOptionsSchema.parse({ ...record, ...flags });
      if (args["scope-root"] && options.project !== args.project)
        throw new MediaFetchError("UNSAFE_PATH", "Input cannot override MCP project scope.");
      if (options.outputDir) scopedPath(root, path.resolve(options.outputDir));
      if (args["dry-run"]) return { metadata: preview(options) };
      job = createJob(options, root);
    }
    const wait = args["wait-sec"] ?? 30;
    if (!Number.isFinite(wait) || wait < 0 || wait > 300)
      throw new MediaFetchError("INVALID_INPUT", "wait-sec must be between 0 and 300.");
    const lock = path.join(job.directory, "worker.lock");
    {
      const log = openSync(path.join(job.directory, "worker.log"), "a", 0o600);
      const argv = [
        "--import",
        path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs"),
        path.resolve(import.meta.dirname, "media-fetch.ts"),
        "--worker",
        job.id,
        ...(job.options.project ? ["--project", job.options.project] : ["--output-dir", job.options.outputDir!]),
      ];
      const worker = spawn(process.execPath, argv, {
        cwd: root,
        detached: true,
        stdio: ["ignore", log, log],
        shell: false,
      });
      worker.on("error", () => {});
      worker.unref();
      closeSync(log);
    }
    const until = Date.now() + wait * 1000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      job = readJob(job.directory);
      if (["completed", "partial", "failed"].includes(job.state)) break;
    }
    job = readJob(job.directory);
    if (job.state === "partial" || job.state === "failed")
      emitResult({
        ok: false,
        error: "PARTIAL_FAILURE",
        message: "Some sources were not acquired; inspect item issues.",
        metadata: publicReport(job),
        elapsedMs: Date.now() - started,
      });
    return { outputs: job.items.flatMap((item) => item.files.map((file) => file.path)), metadata: publicReport(job) };
  } catch (error) {
    const problem = issue(error);
    emitResult({
      ok: false,
      error: "VALIDATION",
      message: problem.message,
      metadata: { issue: problem },
      elapsedMs: Date.now() - started,
    });
  }
});

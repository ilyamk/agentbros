import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  MediaFetchJobSchema,
  type MediaFetchOptions,
  type MediaFetchJob,
  type MediaFetchItem,
} from "../../types/media-fetch";
import { requireProject } from "../cli";
import { PROVIDERS, routes, platformFor, isShortUrl, doctor } from "./catalogue";
import { publicUrl, resolveShortUrl } from "./http";
import { submit, inspectRun, normalise, selectVariants, requestInput } from "./providers";
import { MediaFetchError, issue } from "./errors";
import { atomicJson, scopedPath, saveJob, saveReport, publicReport, lock } from "./storage";
import { admit, operationStore } from "./budget";
import { retryRead } from "./retry";
import { publish } from "./publish";

export function jobBase(options: Pick<MediaFetchOptions, "project" | "outputDir">, root = process.cwd()): string {
  if (options.project) {
    requireProject(options.project);
    return scopedPath(root, path.join(root, "public/projects", options.project, "pipeline/media-fetch"));
  }
  if (!options.outputDir) throw new MediaFetchError("INVALID_INPUT", "A project or output directory is required.");
  const destination = scopedPath(root, path.resolve(root, options.outputDir));
  if (existsSync(path.join(root, ".git"))) {
    const ignored = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", `${destination}/media-fetch-placeholder`],
      { cwd: root },
    );
    if (ignored.status !== 0)
      throw new MediaFetchError(
        "UNSAFE_PATH",
        "Output directory must be git-ignored.",
        "Use out/media-inbox or an existing ignored project footprint.",
      );
  }
  return path.join(destination, "media-fetch");
}
export function createJob(options: MediaFetchOptions, root = process.cwd()): MediaFetchJob {
  options.urls.forEach(publicUrl);
  const id = randomUUID(),
    directory = scopedPath(root, path.join(jobBase(options, root), id));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString(),
    seen = new Map<string, number>();
  const items = options.urls.map((url, index) => {
    const key = publicUrl(url).href,
      duplicateOf = seen.get(key);
    seen.set(key, duplicateOf ?? index);
    return {
      url,
      state: "pending" as const,
      candidates: [],
      files: [],
      attempt: 0,
      ...(duplicateOf !== undefined ? { duplicateOf } : {}),
    };
  });
  const job = MediaFetchJobSchema.parse({
    schemaVersion: 1,
    id,
    createdAt: now,
    updatedAt: now,
    options,
    directory,
    state: "pending",
    items,
  });
  saveJob(job);
  saveReport(job);
  return job;
}
export function preview(options: MediaFetchOptions) {
  return {
    status: "planned",
    network: false,
    settings: options,
    credentials: doctor(),
    items: options.urls.map((url) => ({
      platform: platformFor(url),
      providers: routes(url, options),
      requiresAuthorisation: !options.maxCostUsd || !options.maxTotalCostUsd,
    })),
    note: "No provider calls. Key presence does not authorise spending; configure quota or explicit budget bounds.",
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runJob(
  job: MediaFetchJob,
  root = process.cwd(),
  services: { submit?: typeof submit; inspect?: typeof inspectRun; publish?: typeof publish } = {},
): Promise<void> {
  const submitSource = services.submit ?? submit,
    inspectSource = services.inspect ?? inspectRun,
    publishSource = services.publish ?? publish;
  const release = lock(path.join(job.directory, "worker.lock"));
  job.pid = process.pid;
  job.state = "running";
  saveJob(job);
  saveReport(job);
  const heartbeat = setInterval(() => saveJob(job), 5000);
  heartbeat.unref();
  const blocked = new Set<string>();
  async function work(item: MediaFetchItem): Promise<void> {
    if (item.state === "completed" || item.duplicateOf !== undefined || item.state === "unknown") return;
    try {
      if (item.state === "submitting") {
        const cached = path.join(job.directory, `${job.items.indexOf(item)}-${item.attempt}.private.json`),
          store = operationStore(job);
        const durable =
          existsSync(store.file) && item.operationId ? store.snapshot().jobs[item.operationId] : undefined;
        if (existsSync(cached)) {
          item.state = "downloading";
          if (durable?.state === "submitting")
            store.transitionJob(item.operationId!, "result-ready", {
              result: {
                acquisitionProof: {
                  responseSha256: createHash("sha256").update(readFileSync(cached)).digest("hex"),
                  complete: true,
                  providerRequestIdKnown: false,
                },
                privateResultFile: cached,
              },
            });
        } else if (durable?.providerRequestId) {
          item.runId = durable.providerRequestId;
          item.state = "running";
        } else {
          item.state = "unknown";
          throw new MediaFetchError(
            "SUBMIT_UNKNOWN",
            "Worker stopped during provider submission.",
            "Inspect provider usage and the saved operation; do not resubmit automatically.",
          );
        }
      }
      if (!item.resolvedUrl) {
        item.state = "resolving";
        saveJob(job);
        item.resolvedUrl = isShortUrl(item.url) ? await resolveShortUrl(item.url) : publicUrl(item.url).href;
        item.platform = platformFor(item.resolvedUrl);
      }
      if (!item.candidates.length) item.candidates = routes(item.resolvedUrl, job.options);
      if (!item.candidates.length)
        throw new MediaFetchError(
          "CREDENTIALS_REQUIRED",
          "No configured provider supports this URL and media kind.",
          "Run media:fetch --doctor for key and subscription setup; use EasyAPI for broad coverage.",
        );
      for (; item.attempt < item.candidates.length; item.attempt++) {
        const provider = item.candidates[item.attempt];
        if (blocked.has(provider)) continue;
        item.provider = provider;
        item.operationId ??= `media-${job.id}-${job.items.indexOf(item)}-${item.attempt}`;
        const resultFile = path.join(job.directory, `${job.items.indexOf(item)}-${item.attempt}.private.json`);
        try {
          let result: unknown;
          if (existsSync(resultFile)) result = JSON.parse(readFileSync(scopedPath(job.directory, resultFile), "utf8"));
          else {
            const input = requestInput(provider, item.resolvedUrl, job.options),
              admission = admit(root, job, item, provider, input);
            saveJob(job);
            const store = admission.store;
            if (!item.runId) {
              item.state = "submitting";
              saveJob(job);
              store?.transitionJob(item.operationId, "submitting");
              let submitted: Awaited<ReturnType<typeof submit>>;
              try {
                submitted = await submitSource(provider, input, job.options.timeoutSec * 1000);
              } catch (error) {
                // A response can conclusively reject a call; a transport failure cannot.
                if (
                  error instanceof MediaFetchError &&
                  [
                    "AUTH_INVALID",
                    "SUBSCRIPTION_REQUIRED",
                    "RATE_LIMIT",
                    "SOURCE_UNAVAILABLE",
                    ...(provider === "rapidapi" ? ["PROVIDER_UNAVAILABLE"] : []),
                  ].includes(error.code)
                ) {
                  store?.transitionJob(item.operationId, "failed", { error: error.code });
                  throw error;
                }
                store?.transitionJob(item.operationId, "unknown", { error: "Provider submission outcome unknown" });
                item.state = "unknown";
                saveJob(job);
                throw new MediaFetchError(
                  "SUBMIT_UNKNOWN",
                  "Provider response was lost or invalid.",
                  "Inspect provider usage before authorising another attempt.",
                );
              }
              if (submitted.runId) {
                item.runId = submitted.runId;
                item.state = "running";
                store?.transitionJob(item.operationId, "queued", { providerRequestId: item.runId });
                saveJob(job);
              } else {
                result = submitted.result;
                atomicJson(resultFile, result);
                store?.transitionJob(item.operationId, "result-ready", {
                  result: {
                    acquisitionProof: {
                      responseSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
                      complete: true,
                      providerRequestIdKnown: false,
                    },
                    privateResultFile: resultFile,
                  },
                });
              }
            }
            if (item.runId) {
              const deadline = Date.now() + job.options.timeoutSec * 1000;
              while (true) {
                const inspected = await retryRead(() => inspectSource(item.runId!));
                if (inspected.state === "completed") {
                  result = inspected.result;
                  atomicJson(resultFile, result);
                  if (store) {
                    const state = store.snapshot().jobs[item.operationId].state;
                    if (state === "queued" || state === "running")
                      store.transitionJob(item.operationId, "result-ready", {
                        result: { privateResultFile: resultFile },
                      });
                    if (inspected.usageUsd !== undefined)
                      store.reconcileBilling(item.operationId, {
                        receiptId: `apify-${item.runId}`,
                        actualUsd: inspected.usageUsd,
                        source: `Apify actor-run ${item.runId} usageTotalUsd`,
                        confirmedAt: new Date().toISOString(),
                      });
                  }
                  break;
                }
                if (Date.now() >= deadline)
                  throw new MediaFetchError(
                    "RUN_PENDING",
                    "Apify run is still active.",
                    "Resume this job to poll the same run.",
                    true,
                  );
                await pause(2000);
              }
            }
          }
          item.state = "downloading";
          saveJob(job);
          const variants = selectVariants(normalise(provider, result, job.options), job.options);
          const store = operationStore(job);
          const accounted = existsSync(store.file) ? store.snapshot().jobs[item.operationId!] : undefined;
          if (accounted && ["queued", "running", "submitting"].includes(accounted.state))
            store.transitionJob(item.operationId!, "result-ready", {
              result:
                provider === "rapidapi"
                  ? {
                      acquisitionProof: {
                        responseSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
                        complete: true,
                        providerRequestIdKnown: false,
                      },
                      privateResultFile: resultFile,
                    }
                  : { privateResultFile: resultFile },
            });
          const publicationState = accounted ? store.snapshot().jobs[item.operationId!].state : undefined;
          if (publicationState === "result-ready" || (publicationState === "failed" && accounted?.result))
            store.transitionJob(item.operationId!, "downloading");
          await publishSource(job, item, variants, root);
          if (accounted) {
            const state = store.snapshot().jobs[item.operationId!].state;
            if (state === "downloading") store.transitionJob(item.operationId!, "validated");
            if (store.snapshot().jobs[item.operationId!].state === "validated")
              store.transitionJob(item.operationId!, "published");
          }
          item.state = "completed";
          delete item.issue;
          saveJob(job);
          return;
        } catch (error) {
          const problem = issue(error);
          item.issue = problem;
          if (["AUTH_INVALID", "SUBSCRIPTION_REQUIRED", "RATE_LIMIT"].includes(problem.code)) blocked.add(provider);
          const fallback =
            job.options.provider === "auto" &&
            [
              "AUTH_INVALID",
              "SUBSCRIPTION_REQUIRED",
              "SOURCE_UNAVAILABLE",
              "FORMAT_UNAVAILABLE",
              "BUDGET_REQUIRED",
            ].includes(problem.code) &&
            !item.runId &&
            String(item.state) !== "unknown" &&
            !item.files.length;
          if (!fallback) throw error;
          delete item.operationId;
          delete item.runId;
          item.state = "pending";
          saveJob(job);
        }
      }
      throw new MediaFetchError(
        "NO_ROUTE",
        "No authorised route remains.",
        "Run --doctor and inspect provider issues.",
      );
    } catch (error) {
      item.issue = issue(error);
      if (item.state !== "unknown") item.state = item.issue.code === "RUN_PENDING" ? "running" : "failed";
      saveJob(job);
    }
  }
  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(job.options.concurrency, job.items.length) }, async () => {
        while (next < job.items.length) {
          const item = job.items[next++];
          await work(item);
          saveReport(job);
        }
      }),
    );
    for (const item of job.items)
      if (item.duplicateOf !== undefined) {
        const original = job.items[item.duplicateOf];
        item.state = original.state;
        item.files = original.files;
        item.issue = original.issue;
        item.provider = original.provider;
      }
    const completed = job.items.filter((x) => x.state === "completed").length;
    job.state = job.items.some((x) => x.state === "running")
      ? "running"
      : completed === job.items.length
        ? "completed"
        : completed
          ? "partial"
          : "failed";
  } finally {
    clearInterval(heartbeat);
    delete job.pid;
    saveJob(job);
    saveReport(job);
    release();
  }
}
export { publicReport };

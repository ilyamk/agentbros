import { workflowEvidenceExists } from "../workflows/local-evidence";
import { ChapterInspectionInputs } from "./inspection-inputs";
import { parseTimelineEditDocument } from "../timeline-ir/store";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  realpathSync,
  lstatSync,
  mkdtempSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateFontRoleModule } from "../font-resources/manifest";
import { displayedFontText } from "../font-resources/render-context";
import { createHash, randomUUID } from "node:crypto";
import { runBoundedRenderWorker, type WorkerBounds } from "./bounded-worker";
import type { ChapterWorkerRequest } from "./chapter-worker";
import { planProjectRender, validatePublicAsset } from "../render-plan";
import { TimelineEditStore } from "../timeline-ir/store";
import { renderBoundary, freezeRenderData } from "../timeline-ir/render";
import { planChapters, payloadMediaPaths, type ChapterCache } from "./plans";
import { hashFile } from "../assets/registry";
import { mediaProbe } from "../audio/analysis";
const fileHash = hashFile;
function safeOutput(base: string, file: string) {
  const relative = path.relative(path.resolve(base), path.resolve(file));
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Chapter output/cache escapes selected directory");
  let current = path.resolve(file),
    boundary = path.resolve(base);
  while (current !== boundary) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("Chapter output/cache cannot be a symlink");
    current = path.dirname(current);
  }
  if (existsSync(boundary) && lstatSync(boundary).isSymbolicLink())
    throw new Error("Chapter output directory cannot be a symlink");
  return file;
}
function sourceCheckout(rootDir: string, codeDir?: string) {
  const candidate = realpathSync(codeDir ?? (existsSync(path.join(rootDir, "src/index.ts")) ? rootDir : process.cwd()));
  if (!existsSync(path.join(candidate, "src/index.ts")) || !existsSync(path.join(candidate, "package.json")))
    throw new Error("Configured renderer checkout requires src/index.ts and package.json");
  return candidate;
}

export function projectChapterPlan(
  projectId: string,
  manifest: unknown,
  {
    rootDir = process.cwd(),
    format = "landscape",
    audioMaster,
    codeDir,
    fontContext,
    captions = "on",
    readonlyInspection = false,
  }: {
    rootDir?: string;
    format?: "vertical" | "square" | "landscape";
    audioMaster?: string;
    codeDir?: string;
    fontContext?: string;
    captions?: "on" | "off";
    readonlyInspection?: boolean | ChapterInspectionInputs;
  } = {},
) {
  if (audioMaster)
    throw new Error(
      "Whole-project audio masters cannot be reused for chapters; mix audio from each chapter timeline instead",
    );
  if (readonlyInspection && fontContext)
    throw Error("Readonly chapter inspection does not support font-context module writes");
  const inputs =
    readonlyInspection instanceof ChapterInspectionInputs
      ? readonlyInspection
      : readonlyInspection
        ? new ChapterInspectionInputs()
        : undefined;
  rootDir = realpathSync(rootDir);
  const codeRoot = sourceCheckout(rootDir, codeDir);
  const original = planProjectRender(projectId, format, rootDir, {
    timeline: true,
    captions,
    readonlyInspection: inputs,
  }).jobs[0];
  // Validate in a disposable directory: planning never writes workspace caches.
  let fontCapture: { contextFile: string; hashes: Record<string, string> } | undefined;
  if (fontContext) {
    const temporary = mkdtempSync(path.join(tmpdir(), "chapter-font-plan-"));
    try {
      const checked = generateFontRoleModule(
        projectId,
        path.resolve(rootDir, fontContext),
        path.join(temporary, "fonts.ts"),
        {
          rootDir,
          requiredText: displayedFontText(original.props, rootDir, projectId),
        },
      );
      fontCapture = {
        contextFile: path.resolve(rootDir, fontContext),
        hashes: Object.fromEntries(
          checked.captureFiles
            .filter((file) => !file.startsWith(temporary + path.sep))
            .map((file) => [file, fileHash(file)]),
        ),
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const journal = path.join(rootDir, "public/projects", projectId, "pipeline/timeline-edit.json");
  const ir = inputs
    ? parseTimelineEditDocument(inputs.json(journal, rootDir, 4 * 1024 * 1024)).timeline
    : new TimelineEditStore(journal).read().timeline;
  const checkedHash = (file: string, scope = rootDir) => (inputs ? inputs.hash(file, scope) : fileHash(file));
  const hashes: Record<string, string> = {};
  for (const [id, asset] of Object.entries(original.props.timelineAssets ?? {}))
    if (!/^https?:\/\//.test(asset.source)) hashes[id] = checkedHash(path.resolve(rootDir, "public", asset.source));
  for (const file of new Set(
    ir.tracks.flatMap((track) => track.clips.flatMap((clip) => payloadMediaPaths(clip.payload))),
  )) {
    if (!/^https?:\/\//.test(file)) {
      validatePublicAsset(file, rootDir);
      hashes[`path:${file}`] = checkedHash(path.resolve(rootDir, "public", file));
    }
  }
  const cacheFile = path.join(
    rootDir,
    "out",
    projectId,
    "chapters",
    format,
    ...(captions === "off" ? ["clean"] : []),
    "cache.json",
  );
  const cacheDirectory = path.dirname(cacheFile);
  safeOutput(rootDir, cacheFile);
  safeOutput(cacheDirectory, cacheFile);
  const cachePresent = inputs ? workflowEvidenceExists(cacheFile) : existsSync(cacheFile);
  if (inputs && !cachePresent) inputs.absent(cacheFile, rootDir);
  const cache: ChapterCache = cachePresent
    ? inputs
      ? inputs.json(cacheFile, rootDir, 256 * 1024)
      : JSON.parse(readFileSync(cacheFile, "utf8"))
    : {};
  if (
    inputs &&
    (typeof cache !== "object" || cache === null || Array.isArray(cache) || Object.keys(cache).length > 128)
  )
    throw Error("Invalid bounded chapter cache");
  if (inputs)
    for (const [id, entry] of Object.entries(cache)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ||
        !entry ||
        typeof entry.output !== "string" ||
        entry.output.length > 4096 ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
        !/^[a-f0-9]{64}$/.test(entry.outputHash) ||
        path.resolve(entry.output) !== path.join(cacheDirectory, `${id}-${entry.fingerprint}.mp4`)
      )
        throw Error("Invalid bounded chapter cache entry");
    }
  const verified: ChapterCache = {};
  for (const [id, entry] of Object.entries(cache))
    if (
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) &&
      typeof entry?.output === "string" &&
      /^[a-f0-9]{64}$/.test(entry.fingerprint) &&
      path.resolve(entry.output) === path.join(cacheDirectory, `${id}-${entry.fingerprint}.mp4`)
    ) {
      safeOutput(cacheDirectory, entry.output);
      if (
        (inputs ? workflowEvidenceExists(entry.output) : existsSync(entry.output)) &&
        checkedHash(entry.output) === entry.outputHash
      )
        verified[id] = entry;
    }
  const { timeline: _, timelineAssets: __, scenes: ___, ...renderConfig } = original.props;
  // Include transitive components/templates/styles, not only the composition entrypoint.
  const rendererFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? rendererFiles(file) : /\.(tsx?|css)$/.test(file) ? [file] : [];
      })
      .sort();
  const rendererVersion = createHash("sha256")
    .update(
      [
        ...(inputs
          ? inputs.sourceFiles(path.join(codeRoot, "src"), codeRoot)
          : rendererFiles(path.join(codeRoot, "src"))),
        ...["package.json", "pnpm-lock.yaml", "remotion.config.ts"]
          .map((file) => path.join(codeRoot, file))
          .filter((file) => {
            if (!inputs) return existsSync(file);
            const present = workflowEvidenceExists(file);
            if (!present) inputs.absent(file, codeRoot);
            return present;
          }),
      ]
        .map((file) => path.relative(codeRoot, file) + ":" + checkedHash(file, codeRoot))
        .join("\n"),
    )
    .digest("hex");
  const plan = planChapters(ir, manifest, {
    assetHashes: hashes,
    cache: verified,
    renderConfig: { ...renderConfig, fontCapture },
    rendererVersion,
  });
  inputs?.assertUnchanged();
  return {
    ...plan,
    ...(readonlyInspection ? { readonlyInspection: true as const } : {}),
    cacheFile,
    ...({ captions } as { captions?: "on" | "off" }),
    jobs: plan.jobs.map((job) => ({
      ...job,
      ...(readonlyInspection ? { readonlyInspection: true as const } : {}),
      format,
      ...({ fontCapture } as { fontCapture?: typeof fontCapture }),
      compositionId: original.compositionId,
      durationInFrames: renderBoundary(job.snapshot.duration, job.snapshot.timebase, 30),
      output: path.join(
        rootDir,
        "out",
        projectId,
        "chapters",
        format,
        ...(captions === "off" ? ["clean"] : []),
        `${job.chapterId}-${job.fingerprint}.mp4`,
      ),
      props: freezeRenderData({ ...original.props, timeline: job.timeline }),
    })),
  };
}
export async function renderChapters(
  plan: ReturnType<typeof projectChapterPlan>,
  {
    dryRun = true,
    render,
  }: {
    dryRun?: boolean;
    render?: (job: ReturnType<typeof projectChapterPlan>["jobs"][number], temporary: string) => Promise<void>;
  } = {},
) {
  if (plan.readonlyInspection) throw Error("Readonly inspection plans cannot execute chapter rendering");
  if (dryRun) return { dryRun: true, outputs: [], plan };
  if (!render) throw new Error("A local render backend is required");
  const cacheDirectory = path.dirname(plan.cacheFile);
  safeOutput(cacheDirectory, plan.cacheFile);
  for (const job of plan.jobs) safeOutput(cacheDirectory, job.output);
  const cache: ChapterCache = {};
  const persistCache = () => {
    mkdirSync(path.dirname(plan.cacheFile), { recursive: true });
    const next = plan.cacheFile + "." + randomUUID() + ".tmp";
    writeFileSync(next, JSON.stringify(cache, null, 2) + "\n");
    renameSync(next, plan.cacheFile);
  };
  const outputs: string[] = [];
  for (const job of plan.jobs) {
    for (const [file, hash] of Object.entries(job.fontCapture?.hashes ?? {}))
      if (!existsSync(file) || fileHash(file) !== hash) throw new Error("Chapter font source changed after planning");
    if (
      job.action === "reuse" &&
      job.previousOutput &&
      (() => {
        try {
          safeOutput(cacheDirectory, job.previousOutput);
          return true;
        } catch {
          return false;
        }
      })() &&
      existsSync(job.previousOutput) &&
      fileHash(job.previousOutput) === job.previousOutputHash
    ) {
      cache[job.chapterId] = {
        fingerprint: job.fingerprint,
        output: job.previousOutput,
        outputHash: fileHash(job.previousOutput),
      };
      outputs.push(job.previousOutput);
      persistCache();
      continue;
    }
    mkdirSync(path.dirname(job.output), { recursive: true });
    const temporary = job.output + "." + randomUUID() + ".mp4";
    try {
      await render(job, temporary);
      const probe = mediaProbe(temporary);
      if (
        !probe.streams.some((stream) => stream.codec_type === "video") ||
        Math.abs(Number(probe.format.duration) - job.durationInFrames / 30) > 0.08
      )
        throw new Error(`Chapter render verification failed: ${job.chapterId}`);
      renameSync(temporary, job.output);
      cache[job.chapterId] = {
        fingerprint: job.fingerprint,
        output: job.output,
        outputHash: fileHash(job.output),
      };
      outputs.push(job.output);
    } finally {
      rmSync(temporary, { force: true });
    }
    persistCache();
  }
  return { dryRun: false, outputs, cache };
}
export const remotionChapterBackend =
  (
    rootDir = process.cwd(),
    options: WorkerBounds & { codeDir?: string; serveUrl?: string; concurrency?: number } = {},
  ) =>
  async (job: ReturnType<typeof projectChapterPlan>["jobs"][number], temporary: string) => {
    if (job.readonlyInspection) throw Error("Readonly inspection jobs cannot execute chapter rendering");
    const codeRoot = sourceCheckout(rootDir, options.codeDir);
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16)
    )
      throw new Error("Chapter concurrency must be an integer from 1 to 16");
    const requestFile = temporary + ".worker.json";
    const request: ChapterWorkerRequest = {
      job,
      temporary,
      rootDir: realpathSync(rootDir),
      codeRoot,
      serveUrl: options.serveUrl,
      concurrency: options.concurrency,
    };
    writeFileSync(requestFile, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    try {
      await runBoundedRenderWorker(
        process.execPath,
        [
          "--import",
          path.join(codeRoot, "node_modules/tsx/dist/loader.mjs"),
          path.join(codeRoot, "src/lib/longform/chapter-worker.ts"),
          requestFile,
        ],
        codeRoot,
        options,
      );
    } finally {
      rmSync(requestFile, { force: true });
    }
  };

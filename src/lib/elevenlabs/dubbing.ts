import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { DubbingRequestSchema } from "../../types/elevenlabs";
import { inspectAsset } from "../assets/inspect";
import { importAsset } from "../assets/registry";
import { immutableWrite, digest } from "../jobs/model-artifacts";
import { runGenerationStep, generationInputHash, type JobProvider } from "../jobs/runner";
import { claimOperationWork } from "../jobs/work-lease";
import { CliErrorObject, assertPathWithin } from "../cli";
import { ElevenLabsClient, remoteId, appendFile } from "./client";
import { projectOutput, readStudioRequest, regularInput, studioPath, logicalJson } from "./files";
import {
  configuredStore,
  retainedStudioQuote,
  operationQuote,
  paidStudioResponse,
  studioOperationIdentity,
  type StudioExecution,
} from "./operations";
import { dubbingTranscript, dubbingTranslations } from "./dubbing-inputs";

const TargetSchema = z
  .object({
    languageId: z.string().optional(),
    operationId: z.string(),
    output: z.string(),
    revision: z.number().int().nonnegative().optional(),
    outputRevision: z.number().int().nonnegative().nullable().optional(),
    selectedRevision: z.number().int().nonnegative().optional(),
    selectedSourceRevision: z.number().int().nonnegative().optional(),
    status: z.enum(["planned", "queued", "processing", "completed", "stale", "failed", "unknown"]).default("planned"),
    sha256: z.string().optional(),
  })
  .strict();
export const DubbingBindingSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    operationId: z.string(),
    inputHash: z.string(),
    remoteProjectId: z.string().optional(),
    source: z.object({ file: z.string(), sha256: z.string(), durationSec: z.number().positive() }).strict(),
    sourceRevision: z.number().int().nonnegative().default(0),
    prepaidLanguage: z.string(),
    targets: z.record(z.string(), TargetSchema),
    liveVerified: z.literal(false),
  })
  .strict();
type DubbingBinding = z.infer<typeof DubbingBindingSchema>;

function writeBinding(file: string, value: DubbingBinding) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(DubbingBindingSchema.parse(value), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}
function readBinding(root: string, file: string, scopeRoot?: string) {
  const value = DubbingBindingSchema.parse(readStudioRequest(root, file, scopeRoot));
  const location = studioPath(root, file, scopeRoot);
  assertPathWithin(path.join(root, "public/projects", value.projectId), location);
  return value;
}
function targetDetails(data: Record<string, any>) {
  return {
    languageId: remoteId(data.language_id),
    revision: z.number().int().nonnegative().parse(data.revision),
    outputRevision: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .parse(data.output_revision ?? null),
    status: z.enum(["queued", "processing", "completed", "stale", "failed"]).parse(data.status),
  };
}
async function languageFor(client: ElevenLabsClient, projectId: string, language: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ page_size: "100", ...(cursor ? { cursor } : {}) });
    const result = await client.json(`/v1/dubbing/project/${remoteId(projectId)}/language?${params}`);
    const found = z
      .array(z.record(z.string(), z.any()))
      .parse(result.languages)
      .find((row) => row.target_language === language);
    if (found) return targetDetails(found);
    if (!result.next_cursor) return undefined;
    cursor = z.string().min(1).max(500).parse(result.next_cursor);
  }
  throw Error("Dubbing language pagination exceeds its bound");
}

/** Explicit sync updates current bindings; published files remain immutable reviewed snapshots. */
export async function syncDubbingBinding(file: string, execution: StudioExecution = {}) {
  const root = path.resolve(execution.rootDir ?? process.cwd()),
    binding = readBinding(root, file, execution.scopeRoot);
  if (!binding.remoteProjectId)
    return { ...binding, note: "Remote project creation is pending or ambiguous; reconcile the original operation" };
  const location = studioPath(root, file, execution.scopeRoot);
  const release = claimOperationWork({ file: location }, "dubbing-binding");
  if (!release)
    throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: "Dubbing binding has another live owner" });
  try {
    const current = readBinding(root, file, execution.scopeRoot),
      client = new ElevenLabsClient(execution);
    const project = await client.json(`/v1/dubbing/project/${remoteId(current.remoteProjectId!)}`);
    const revision = z.number().int().nonnegative().parse(project.revision);
    for (const [language, target] of Object.entries(current.targets)) {
      const data = target.languageId
        ? targetDetails(
            await client.json(
              `/v1/dubbing/project/${remoteId(current.remoteProjectId!)}/language/${remoteId(target.languageId)}`,
            ),
          )
        : await languageFor(client, current.remoteProjectId!, language);
      if (data) Object.assign(target, data);
      if (
        revision !== current.sourceRevision ||
        (target.outputRevision !== undefined && target.revision !== target.outputRevision) ||
        (target.sha256 &&
          (target.selectedRevision !== target.outputRevision || target.selectedSourceRevision !== revision))
      )
        target.status = "stale";
    }
    current.sourceRevision = revision;
    writeBinding(location, current);
    return current;
  } finally {
    release();
  }
}

export function assertDubbingSnapshot(root: string, file: string, language: string, scopeRoot?: string) {
  const binding = readBinding(root, file, scopeRoot),
    target = binding.targets[language];
  if (
    !target ||
    target.status !== "completed" ||
    target.revision !== target.outputRevision ||
    target.selectedRevision !== target.outputRevision ||
    target.selectedSourceRevision !== binding.sourceRevision ||
    !target.sha256
  )
    throw Error("Dubbing output is pending or stale; sync and review the selected revision");
  const audio = regularInput(root, target.output, scopeRoot ?? root);
  if (audio.sha256 !== target.sha256) throw Error("Selected dubbing output changed");
  if (regularInput(root, binding.source.file, scopeRoot ?? root, 3 * 1024 ** 3).sha256 !== binding.source.sha256)
    throw Error("Dubbing source changed");
  return target;
}

export async function executeDubbing(raw: unknown, execution: StudioExecution = {}) {
  const request = DubbingRequestSchema.parse(raw),
    root = path.resolve(execution.rootDir ?? process.cwd());
  const output = projectOutput(root, request.projectId, request.output),
    scope = execution.scopeRoot ?? root;
  if (path.extname(output.file) !== ".wav") throw Error("Dubbing selects lossless audio into a new .wav file");
  const source = request.source ? regularInput(root, request.source, scope, 3 * 1024 ** 3) : undefined;
  const sourceInfo = source ? inspectAsset(source.file) : undefined;
  if (sourceInfo && !sourceInfo.media.hasAudio) throw Error("Dubbing source has no audio");
  const bindingFile = request.binding ? studioPath(root, request.binding, scope) : `${output.file}.dubbing.json`;
  assertPathWithin(output.project, bindingFile);
  let binding = existsSync(bindingFile) ? readBinding(root, bindingFile, scope) : undefined;
  const bindingSnapshot = binding ? JSON.stringify(binding) : undefined;
  if (binding && binding.projectId !== request.projectId) throw Error("Dubbing binding belongs to another project");
  if (request.task !== "create" && !binding?.remoteProjectId)
    throw Error("The existing remote project is not ready; resume or reconcile creation");
  const transcript = request.transcript ? regularInput(root, request.transcript, scope, 4 * 1024 * 1024) : undefined;
  const translations = request.translations
    ? regularInput(root, request.translations, scope, 4 * 1024 * 1024)
    : undefined;
  const suppliedTranscript = transcript
    ? dubbingTranscript(JSON.parse(readFileSync(transcript.file, "utf8")), {
        sha256: source!.sha256,
        durationSec: sourceInfo!.media.durationSec!,
      })
    : undefined;
  const suppliedTranslations = translations
    ? dubbingTranslations(JSON.parse(readFileSync(translations.file, "utf8")))
    : undefined;
  const logical = logicalJson({
    ...request,
    operationId: undefined,
    maxCostUsd: undefined,
    output: output.relative,
    source: source?.sha256 ?? binding?.source.sha256,
    binding: request.task === "create" ? undefined : binding?.remoteProjectId,
    transcript: transcript?.sha256,
    translations: translations?.sha256,
  });
  const remote = binding?.remoteProjectId,
    target = binding?.targets[request.targetLanguage];
  const endpoint =
    request.task === "create"
      ? "/v1/dubbing/project"
      : request.task === "add-language"
        ? `/v1/dubbing/project/${remote}/language`
        : request.task === "regenerate"
          ? `/v1/dubbing/project/${remote}/language/${target?.languageId}/transcript/regenerate`
          : request.task === "edit-source"
            ? `/v1/dubbing/project/${remote}/transcript/segment/${request.segmentId}`
            : `/v1/dubbing/project/${remote}/language/${target?.languageId}/transcript/segment/${request.segmentId}`;
  const { inputHash, operationId } = studioOperationIdentity(request.projectId, root, execution.store, {
    input: request.task.startsWith("edit-") ? { ...logical, destination: output.relative } : logical,
    idInput: logical,
    operationId:
      request.operationId ??
      (request.task === "create" && binding?.inputHash === generationInputHash(logical)
        ? binding.operationId
        : undefined),
    endpoint,
    provider: "elevenlabs",
    assetId: output.relative,
    id: (hash) => `el:dub:${hash.slice(0, 40)}`,
  });
  if (request.task === "create" && binding && (binding.inputHash !== inputHash || binding.operationId !== operationId))
    throw Error("Dubbing creation binding belongs to different inputs");
  const model = `elevenlabs:dubbing-${request.task}`;
  const reservation =
    retainedStudioQuote(request.projectId, root, operationId, execution.store) ??
    operationQuote(model, request.maxCostUsd);
  if (execution.dryRun !== false)
    return {
      outputs: [],
      metadata: {
        state: "planned",
        operationId,
        task: request.task,
        request: logical,
        quote: reservation,
        executable: reservation !== null,
        liveVerified: false,
        billing:
          request.task === "create"
            ? "Create prepays the explicitly selected first language; no separate first-target submit"
            : "Additional targets and regeneration have separate operations",
        binding: bindingFile,
      },
    };
  const store = configuredStore(request.projectId, root, execution.store),
    client = new ElevenLabsClient(execution);
  if (existsSync(output.file) && !store.snapshot().jobs[operationId])
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Choose a new immutable dubbed audio output" });
  const release = claimOperationWork({ file: bindingFile }, "dubbing-binding");
  if (!release)
    throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: "Dubbing binding has another live owner" });
  try {
    binding = existsSync(bindingFile) ? readBinding(root, bindingFile, scope) : undefined;
    if ((binding ? JSON.stringify(binding) : undefined) !== bindingSnapshot)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Dubbing binding changed during planning; retry against the current binding.",
      });
    if (
      request.task === "create" &&
      binding &&
      (binding.inputHash !== inputHash || binding.operationId !== operationId)
    )
      throw Error("Dubbing creation binding belongs to different inputs");
    if (!binding) {
      if (request.task !== "create" || !source || !sourceInfo) throw Error("Dubbing binding is missing");
      binding = {
        version: 1,
        projectId: request.projectId,
        operationId,
        inputHash,
        source: {
          file: path.relative(root, source.file),
          sha256: source.sha256,
          durationSec: sourceInfo.media.durationSec!,
        },
        prepaidLanguage: request.targetLanguage,
        sourceRevision: 0,
        targets: {},
        liveVerified: false,
      };
    }
    const existing = binding.targets[request.targetLanguage];
    const previous = store.snapshot().jobs[operationId];
    if (["create", "add-language"].includes(request.task) && existing && existing.operationId !== operationId)
      throw Error("This language already has an operation; resume it or explicitly regenerate a reviewed revision");
    if (
      request.task === "regenerate" &&
      (!existing?.languageId ||
        (!previous && (existing.revision !== request.expectedRevision || existing.status !== "stale")))
    )
      throw Error("Regeneration requires the current stale target revision");
    const remoteProject = binding.remoteProjectId;
    if (request.task.startsWith("edit-")) {
      if (request.task === "edit-translation" && !existing?.languageId) throw Error("Translation target is missing");
      const revisionRoute =
        request.task === "edit-source"
          ? `/v1/dubbing/project/${remoteProject}/transcript`
          : `/v1/dubbing/project/${remoteProject}/language/${existing!.languageId}/transcript`;
      if (!previous?.result) {
        const current = await client.json(revisionRoute);
        if (current.revision !== request.expectedRevision)
          throw Error("Remote transcript revision changed; review before editing");
      }
      const result = await paidStudioResponse({
        projectId: request.projectId,
        root,
        task: request.task,
        endpoint,
        identity: logical,
        output: output.relative,
        model,
        bound: request.maxCostUsd,
        operationId,
        execution,
        perform: () =>
          client.post(
            endpoint,
            request.task === "edit-source" ? { text: request.text } : { translation: request.text },
            "PATCH",
          ),
      });
      const data = z
        .object({ revision: z.number().int().nonnegative() })
        .passthrough()
        .parse(await result.response.json());
      if (request.task === "edit-source") {
        binding.sourceRevision = Math.max(binding.sourceRevision, data.revision);
        for (const target of Object.values(binding.targets)) target.status = "stale";
      } else {
        existing!.revision = Math.max(existing!.revision ?? 0, data.revision);
        existing!.status = "stale";
      }
      writeBinding(bindingFile, binding);
      return {
        outputs: [bindingFile],
        metadata: { state: "edited", operationId, revision: data.revision, alignmentRequired: true },
      };
    }
    const bound = previous?.quote ?? reservation;
    if (!bound) throw Error("Dubbing requires an authorised positive maxCostUsd");
    if (!previous || previous.state === "reserved") {
      if (request.task === "regenerate") {
        const current = await client.json(`/v1/dubbing/project/${remoteProject}/language/${existing!.languageId}`);
        if (current.revision !== request.expectedRevision || current.status !== "stale")
          throw Error("Target revision changed before regeneration");
      }
      if (suppliedTranslations) {
        const canonical = await client.json(`/v1/dubbing/project/${remoteProject}/transcript`);
        if (canonical.revision !== request.expectedRevision)
          throw Error("Source revision changed before adding translations");
        dubbingTranslations(
          suppliedTranslations,
          z
            .array(z.object({ id: z.string().optional(), external_id: z.string().optional() }).passthrough())
            .parse(canonical.segments),
        );
      }
    }
    if (!existing || (request.task === "regenerate" && !previous))
      binding.targets[request.targetLanguage] = {
        ...existing,
        operationId,
        output: path.relative(root, output.file),
        status: "planned",
      };
    const selected = binding.targets[request.targetLanguage]!;
    writeBinding(bindingFile, binding);
    const recheckSource = () => {
      const original = regularInput(root, binding!.source.file, scope, 3 * 1024 ** 3);
      if (original.sha256 !== binding!.source.sha256) throw Error("Dubbing source bytes changed");
      for (const input of [transcript, translations])
        if (input && regularInput(root, input.file, scope, 4 * 1024 * 1024).sha256 !== input.sha256)
          throw Error("Supplied dubbing text changed");
    };
    const provider: JobProvider = {
      submit: async () => {
        recheckSource();
        if (request.task === "create") {
          const form = new FormData();
          await appendFile(form, "file", source!.file);
          form.set("target_language", request.targetLanguage);
          if (request.sourceLanguage) form.set("source_language", request.sourceLanguage);
          if (suppliedTranscript)
            form.set(
              "transcript",
              new Blob([JSON.stringify(suppliedTranscript)], { type: "application/json" }),
              "transcript.json",
            );
          const data = await client.mutation(endpoint, form);
          return { requestId: remoteId(data.project_id) };
        }
        if (request.task === "add-language") {
          const data = await client.mutation(endpoint, {
            target_language: request.targetLanguage,
            ...(suppliedTranslations ? { translations: suppliedTranslations } : {}),
          });
          return { requestId: remoteId(data.language_id) };
        }
        await client.mutation(endpoint);
        return { requestId: selected.languageId! };
      },
      inspect: async (_endpoint, id) => {
        const projectId = request.task === "create" ? id : remoteProject!;
        const project = await client.json(`/v1/dubbing/project/${remoteId(projectId)}`);
        if (project.status === "failed")
          return { state: "failed", message: "Dubbing source preparation failed; no refund assumed" };
        if (project.status !== "ready") return { state: "running" };
        const language =
          request.task === "create"
            ? await languageFor(client, projectId, request.targetLanguage)
            : targetDetails(await client.json(`/v1/dubbing/project/${projectId}/language/${remoteId(id)}`));
        if (!language) return { state: "running" };
        if (
          language.status === "failed" ||
          language.status === "stale" ||
          (language.status === "completed" && language.revision !== language.outputRevision)
        )
          return { state: "failed", message: `Dubbing language is ${language.status} or has a stale output revision` };
        return language.status === "completed"
          ? {
              state: "completed",
              result: { remoteProjectId: projectId, sourceRevision: project.revision, ...language },
            }
          : { state: "running" };
      },
    };
    recheckSource();
    const job = await runGenerationStep({
      store,
      input: logical,
      operation: {
        operationId,
        provider: "elevenlabs",
        endpoint,
        assetId: output.relative,
        stage: "localization",
        quote: bound,
      },
      provider,
      publish: async (result) => {
        recheckSource();
        const current = await client.json(
          `/v1/dubbing/project/${remoteId(String(result.remoteProjectId))}/language/${remoteId(String(result.languageId))}`,
        );
        const currentProject = await client.json(`/v1/dubbing/project/${remoteId(String(result.remoteProjectId))}`);
        if (currentProject.revision !== result.sourceRevision)
          throw Error("Dubbing source revision changed before publication");
        const detail = targetDetails(current);
        if (
          detail.status !== "completed" ||
          detail.revision !== detail.outputRevision ||
          detail.outputRevision !== result.outputRevision
        )
          throw Error("Dubbing output became stale before download");
        const downloaded = await client.download(z.string().url().parse(current.outputs?.lossless_audio));
        const directory = mkdtempSync(path.join(tmpdir(), "el-dub-"));
        try {
          const original = path.join(directory, "download.bin"),
            temporary = path.join(directory, "dub.wav");
          writeFileSync(original, downloaded);
          const media = inspectAsset(original);
          if (media.kind !== "audio" || !media.media.hasAudio) throw Error("Dubbing result is not valid audio");
          const conform = spawnSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-nostdin",
              "-protocol_whitelist",
              "file,pipe",
              "-i",
              original,
              "-vn",
              "-c:a",
              "pcm_s24le",
              "-ar",
              "48000",
              "-f",
              "wav",
              temporary,
            ],
            { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
          );
          if (conform.error || conform.status !== 0)
            throw Error("Could not conform the lossless dubbing result to WAV");
          const bytes = readFileSync(temporary);
          inspectAsset(temporary);
          const parent = importAsset({
            projectId: request.projectId,
            rootDir: root,
            sourceFile: path.resolve(root, binding!.source.file),
            provenance: { origin: "manual" },
          });
          const imported = importAsset({
            projectId: request.projectId,
            rootDir: root,
            sourceFile: temporary,
            provenance: {
              origin: "provider",
              tool: "elevenlabs:dubbing",
              generationJobId: operationId,
              referenceAssetIds: [parent.asset.id],
            },
          });
          immutableWrite(output.file, bytes);
          let subtitles: string | undefined;
          if (current.outputs?.subtitles) {
            const subtitleBytes = await client.download(
              z.string().url().parse(current.outputs.subtitles),
              4 * 1024 * 1024,
            );
            const content = new TextDecoder("utf-8", { fatal: true }).decode(subtitleBytes);
            if (!/^\uFEFF?WEBVTT(?:\s|$)/.test(content)) throw Error("Provider subtitle is not WebVTT");
            subtitles = `${output.file}.source-timed.vtt`;
            immutableWrite(subtitles, subtitleBytes);
          }
          const receipt = {
            version: 1,
            provider: "elevenlabs",
            operationId,
            inputHash,
            sourceSha256: binding!.source.sha256,
            ...result,
            sha256: digest(bytes),
            assetId: imported.asset.id,
            binding: path.relative(root, bindingFile),
            language: request.targetLanguage,
            ...(subtitles
              ? { subtitles: path.relative(root, subtitles), subtitleTiming: "source-speech-not-dubbed-word-timing" }
              : {}),
            alignmentRequired: true,
            humanReviewRequired: true,
            liveVerified: false,
          };
          immutableWrite(`${output.file}.take.json`, `${JSON.stringify(receipt, null, 2)}\n`);
          return {
            outputs: [output.file, `${output.file}.take.json`],
            hashes: [digest(bytes), digest(readFileSync(`${output.file}.take.json`))],
            ...receipt,
          };
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    });
    if (request.task === "create" && job.providerRequestId) binding.remoteProjectId = remoteId(job.providerRequestId);
    if (request.task === "add-language" && job.providerRequestId) selected.languageId = remoteId(job.providerRequestId);
    const recoverSnapshot = job.state === "published" && selected.operationId === operationId && !selected.sha256;
    if (job.result && (previous?.state !== "published" || recoverSnapshot)) {
      const details = job.result as Record<string, any>;
      if (details.languageId) selected.languageId = remoteId(details.languageId);
      if (details.revision !== undefined) selected.revision = Math.max(selected.revision ?? 0, details.revision);
      if (details.outputRevision !== undefined)
        selected.outputRevision = Math.max(selected.outputRevision ?? 0, details.outputRevision);
      if (details.sourceRevision !== undefined)
        binding.sourceRevision = Math.max(binding.sourceRevision, details.sourceRevision);
      const published = details.published;
      if (published?.sha256) {
        selected.sha256 = published.sha256;
        selected.selectedRevision = details.outputRevision;
        selected.selectedSourceRevision = details.sourceRevision;
      }
    }
    if (previous?.state !== "published" || (recoverSnapshot && ["planned", "processing"].includes(selected.status)))
      selected.status =
        job.state === "published"
          ? "completed"
          : job.state === "unknown"
            ? "unknown"
            : job.state === "failed"
              ? "failed"
              : "processing";
    if (
      job.state === "published" &&
      (!existsSync(output.file) ||
        digest(readFileSync(output.file)) !== (job.result as Record<string, any>)?.published?.sha256)
    )
      throw Error("Published dubbing bytes changed");
    writeBinding(bindingFile, binding);
    return {
      outputs: job.state === "published" ? [output.file, `${output.file}.take.json`, bindingFile] : [bindingFile],
      metadata: {
        state: job.state,
        operationId,
        binding: bindingFile,
        target: selected,
        budget: store.summary(),
        nextAction:
          job.state === "unknown"
            ? "reconcile-existing-remote-operation"
            : job.state === "published"
              ? "review-localized-audio-and-alignments"
              : "resume-same-operation",
      },
    };
  } finally {
    release();
  }
}

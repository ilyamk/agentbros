import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AppleDomainSchema,
  LocalCapabilitySchema,
  LocalPolicySchema,
  LocalQualificationSchema,
  LocalTaskRequestSchema,
  NativeProbeSchema,
  NativeIssueSchema,
  type AppleDomain,
  type LocalCapability,
  type LocalPolicy,
  type LocalTask,
  type LocalTaskRequest,
  type NativeProbe,
} from "../../types/local-capabilities";
import {
  atomicJson,
  boundedFile,
  fileHash,
  hostIdentity,
  localRoot,
  NativeUnavailable,
  objectHash,
  probeNative,
  sourceIdentity,
  macosMajor,
  MINIMUM_MACOS,
} from "../apple/runtime";

export type Descriptor = {
  task: LocalTask;
  domain?: AppleDomain;
  legacy?: "ocr" | "visual" | "category" | "matte";
  command: string;
  operation?: string;
  alternative: string;
};
export const LOCAL_CAPABILITIES: readonly Descriptor[] = [
  {
    task: "speech.transcribe",
    domain: "speech",
    command: "speech:local",
    alternative: "Use a prepared Parakeet/whisper.cpp backend; paid Scribe remains an explicit budgeted choice.",
  },
  {
    task: "text.analyse",
    domain: "text",
    command: "text:analyse",
    alternative: "Use the existing portable text heuristics or ask the current agent.",
  },
  {
    task: "text.translate",
    domain: "translation",
    command: "text:translate",
    alternative: "Supply a translation or ask the current agent; retain localisation review.",
  },
  {
    task: "speech.synthesise",
    domain: "tts",
    command: "voiceover:local",
    alternative: "Choose another installed voice; external voiceover remains an explicit budgeted choice.",
  },
  {
    task: "audio.events",
    domain: "audio",
    command: "audio:events",
    alternative: "Use audio:describe for CLAP similarity, or supply reviewed event markers.",
  },
  ...(["faces", "people", "pose", "saliency", "quality", "flow", "tracking"] as const).map((feature) => ({
    task: `vision.${feature}` as LocalTask,
    domain: "vision" as const,
    command: "media:vision",
    alternative: "Use the existing OpenCV photo/reframe detector or reviewed frame annotations.",
  })),
  {
    task: "text.assist",
    domain: "foundation",
    command: "text:assist",
    alternative: "Ask the current agent to prepare a draft from the supplied sources.",
  },
  {
    task: "image.describe",
    domain: "foundation",
    command: "image:describe",
    alternative: "Use existing contact sheets and the current agent; OCR/categories serve narrower tasks.",
  },
  {
    task: "vision.ocr",
    legacy: "ocr",
    command: "media:ocr",
    alternative: "Use supplied screen text or an explicitly configured Tesseract route.",
  },
  {
    task: "vision.similarity",
    legacy: "visual",
    command: "media:visual",
    alternative: "Use reviewed image matches or transcript/tag search.",
  },
  {
    task: "vision.classify",
    legacy: "category",
    command: "media:category",
    alternative: "Use reviewed tags or transcript search.",
  },
  { task: "vision.matte", legacy: "matte", command: "matte", alternative: "Use the prepared ONNX matte backend." },
];
export const DEFAULT_LOCAL_POLICY: LocalPolicy = { version: 1, mode: "interactive", downloads: "task" };
export function readLocalPolicy(root = localRoot()): LocalPolicy {
  const file = path.join(root, "policy.json");
  const policy = existsSync(file)
    ? LocalPolicySchema.parse(JSON.parse(boundedFile(file, 4096).toString()))
    : DEFAULT_LOCAL_POLICY;
  return LocalPolicySchema.parse({
    ...policy,
    ...(process.env.AGENTBROS_INTERACTION_MODE ? { mode: process.env.AGENTBROS_INTERACTION_MODE } : {}),
    ...(process.env.AGENTBROS_LOCAL_DOWNLOADS ? { downloads: process.env.AGENTBROS_LOCAL_DOWNLOADS } : {}),
  });
}
export function writeLocalPolicy(input: unknown, root = localRoot()) {
  const policy = LocalPolicySchema.parse(input);
  atomicJson(path.join(root, "policy.json"), policy);
  return policy;
}
export function languageEquivalent(requested: string, supported: string) {
  try {
    const a = new Intl.Locale(requested.replaceAll("_", "-")).maximize(),
      b = new Intl.Locale(supported.replaceAll("_", "-")).maximize();
    return (
      a.language === b.language &&
      a.script === b.script &&
      (requested.replaceAll("_", "-").split("-").length === 1 || a.region === b.region)
    );
  } catch {
    return false;
  }
}
export const prepareArgv = (descriptor: Descriptor, language?: string) => [
  "pnpm",
  "media:prepare",
  "--engines",
  descriptor.domain ? `apple-${descriptor.domain}` : descriptor.legacy!,
  ...(language ? ["--language", language] : []),
];
export type CapabilityOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  refresh?: boolean;
  persist?: boolean;
  probe?: typeof probeNative;
  legacyProbe?: (descriptor: Descriptor) => Promise<{ available: boolean; reason?: string; identity?: string }>;
};
function qualification(
  task: LocalTask,
  language: string | undefined,
  identity: string,
  root: string,
  now: number,
): LocalCapability["quality"] {
  const file = path.join(root, "verification", objectHash({ task, language: language ?? "", identity }) + ".json");
  if (!existsSync(file)) return "unverified";
  try {
    const row = LocalQualificationSchema.parse(JSON.parse(boundedFile(file).toString()));
    const evidence = path.resolve(root, row.evidenceFile);
    if (!existsSync(evidence) || fileHash(evidence) !== row.evidenceHash) return "unverified";
    return row.task === task &&
      row.identity === identity &&
      row.language === (language ?? "") &&
      row.passed &&
      Date.parse(row.expiresAt) > now
      ? row.suite === "quality"
        ? "qualified"
        : "smoke"
      : "unverified";
  } catch {
    return "unverified";
  }
}
async function legacyStatus(
  descriptor: Descriptor,
): Promise<{ available: boolean; reason?: string; identity?: string }> {
  const { ocrStatus, matteStatus } = await import("../local-engines/prepare");
  if (descriptor.legacy === "ocr") {
    const status = await ocrStatus(path.dirname(localRoot()));
    return status.available ? { available: true, identity: status.identityHash } : status;
  }
  if (descriptor.legacy === "matte") {
    const status = await matteStatus(path.dirname(localRoot()));
    return status.available ? { available: true, identity: status.identityHash } : status;
  }
  const file = path.join(path.dirname(localRoot()), `${descriptor.legacy}/config.json`);
  if (!existsSync(file)) return { available: false, reason: "Prepared native configuration is missing" };
  const config: unknown = JSON.parse(boundedFile(file).toString());
  if (descriptor.legacy === "visual") {
    const { probeLocalVisual, LocalVisualConfigSchema } = await import("../ingest/local-visual");
    const status = await probeLocalVisual(LocalVisualConfigSchema.parse(config));
    return status.available ? { available: true, identity: status.identityHash } : status;
  }
  const { probeLocalCategory, LocalCategoryConfigSchema } = await import("../ingest/local-category");
  const status = await probeLocalCategory(LocalCategoryConfigSchema.parse(config));
  return status.available ? { available: true, identity: status.identityHash } : status;
}
const CacheSchema = z
  .object({
    version: z.literal(1),
    checkedAt: z.number(),
    value: z.object({ probe: NativeProbeSchema, identity: z.string() }).strict().optional(),
    issue: NativeIssueSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.value !== !!v.issue);
export async function inspectCapabilities(
  requests: readonly LocalTaskRequest[] = LOCAL_CAPABILITIES.map((d) => ({ task: d.task })),
  options: CapabilityOptions = {},
): Promise<LocalCapability[]> {
  const root = options.root ?? localRoot(),
    now = options.now?.() ?? Date.now(),
    platform = options.platform ?? process.platform;
  const pending = new Map<string, Promise<{ probe: NativeProbe; identity: string }>>();
  const probe = (domain: AppleDomain, payload: Record<string, unknown>) => {
    const key = objectHash({
      host: platform === "darwin" ? hostIdentity() : platform,
      source: sourceIdentity(domain),
      domain,
      payload,
    });
    if (!pending.has(key))
      pending.set(
        key,
        (async () => {
          const file = path.join(root, "status", key + ".json");
          if (!options.refresh && !options.probe && existsSync(file)) {
            try {
              const cached = CacheSchema.parse(JSON.parse(boundedFile(file).toString()));
              if (now - cached.checkedAt >= 0 && now - cached.checkedAt < (cached.issue ? 60000 : 300000)) {
                if (cached.issue) throw new NativeUnavailable(cached.issue);
                return cached.value!;
              }
            } catch (error) {
              if (error instanceof NativeUnavailable) throw error; /* An invalid cache never authorises execution. */
            }
          }
          let value: { probe: NativeProbe; identity: string };
          try {
            value = await (options.probe ?? probeNative)(domain, payload, root);
          } catch (error) {
            if (options.persist && !options.probe && error instanceof NativeUnavailable)
              atomicJson(file, { version: 1, checkedAt: now, issue: error.issue });
            throw error;
          }
          if (options.persist && !options.probe) atomicJson(file, { version: 1, checkedAt: now, value });
          return value;
        })(),
      );
    return pending.get(key)!;
  };
  const results: LocalCapability[] = [];
  // Sequential domain probes bound machine load; repeated requests share one result.
  for (const raw of requests) {
    const request = LocalTaskRequestSchema.parse(raw),
      descriptor = LOCAL_CAPABILITIES.find((d) => d.task === request.task)!;
    const base = {
      task: request.task,
      backend: descriptor.domain ? `apple-${descriptor.domain}` : `apple-vision-${descriptor.legacy}`,
      checkedAt: new Date(now).toISOString(),
      quality: "unverified" as const,
    };
    const unavailable = (state: LocalCapability["state"], reason: string, userAction?: string): LocalCapability =>
      LocalCapabilitySchema.parse({
        ...base,
        state,
        reason,
        ...(userAction ? { userAction } : {}),
        ...(state === "needs_prepare" || (state === "needs_download" && readLocalPolicy(root).downloads === "task")
          ? { prepare: prepareArgv(descriptor, request.language) }
          : state === "needs_download"
            ? {
                userAction:
                  "Download policy requires a decision: authorise media:prepare with --allow-download for this task, or use an installed alternative.",
              }
            : {}),
      });
    if (platform !== "darwin") {
      results.push(unavailable("unsupported", "This optional backend requires macOS"));
      continue;
    }
    if (!options.probe && descriptor.domain && macosMajor() < MINIMUM_MACOS[descriptor.domain]) {
      results.push(unavailable("unsupported", `Requires macOS ${MINIMUM_MACOS[descriptor.domain]} or later`));
      continue;
    }
    try {
      if (descriptor.legacy) {
        const status = await (options.legacyProbe ?? legacyStatus)(descriptor);
        results.push(
          status.available
            ? {
                ...base,
                state: "ready",
                reason: "Prepared native backend available",
                identity: status.identity,
                command: ["pnpm", descriptor.command],
              }
            : unavailable("needs_prepare", status.reason ?? "Prepare this native backend"),
        );
        continue;
      }
      const { probe: runtime, identity: runtimeIdentity } = await probe(descriptor.domain!, {
        ...(request.language ? { language: request.language } : {}),
        ...(request.targetLanguage ? { targetLanguage: request.targetLanguage } : {}),
      });
      if (!runtime.operations.includes(request.task)) {
        results.push(unavailable("unsupported", "The runtime does not support this operation"));
        continue;
      }
      if (
        request.language &&
        runtime.languages.length &&
        !runtime.languages.some((l) => languageEquivalent(request.language!, l))
      ) {
        results.push(unavailable("unsupported", `Language ${request.language} is unsupported`));
        continue;
      }
      if (
        descriptor.domain === "speech" &&
        request.language &&
        !runtime.installedLanguages.some((l) => languageEquivalent(request.language!, l))
      ) {
        results.push(unavailable("needs_download", "The supported speech model is not installed"));
        continue;
      }
      if (
        descriptor.domain === "tts" &&
        request.voice &&
        !runtime.voices?.some(
          (v) => v.id === request.voice && (!request.language || languageEquivalent(request.language, v.language)),
        )
      ) {
        results.push(
          unavailable(
            "needs_user_action",
            "The requested voice is not installed for this language",
            "Choose an installed voice or download the requested voice in macOS settings.",
          ),
        );
        continue;
      }
      if (descriptor.domain === "speech" && (request.requirements?.verbatim || request.requirements?.speakers)) {
        results.push(
          unavailable(
            "unsupported",
            "Apple ASR alone does not establish verbatim fidelity or speaker labels; use the complete speech pipeline",
          ),
        );
        continue;
      }
      if (descriptor.domain === "text" && request.language) {
        const schemes = (runtime.details?.schemes as Record<string, string[]> | undefined)?.[
          request.language.split(/[-_]/u)[0]!
        ];
        const needed = request.operations ?? ["language", "sentences", "tokens", "entities", "lemmas"];
        if (
          needed.some(
            (op) =>
              (op === "entities" && !schemes?.includes("NameType")) || (op === "lemmas" && !schemes?.includes("Lemma")),
          )
        ) {
          results.push(
            unavailable("unsupported", "Requested Natural Language operation is unavailable for this language"),
          );
          continue;
        }
      }
      if (request.purpose === "production" && descriptor.domain === "tts" && !request.voice) {
        results.push(
          unavailable(
            "needs_user_action",
            "Production qualification requires an exact installed voice",
            "Choose the intended installed voice identifier.",
          ),
        );
        continue;
      }
      const identity = objectHash({
        runtimeIdentity,
        task: request.task,
        voice: request.voice ?? null,
        operations: request.operations ?? null,
        assistTask: request.task === "text.assist" ? (request.assistTask ?? "summarise") : null,
      });
      const quality = qualification(request.task, request.language, identity, root, now);
      if (request.purpose === "production" && quality !== "qualified") {
        results.push(
          unavailable(
            "unknown",
            "Available for drafts; this task/language/runtime has no fresh production qualification",
          ),
        );
        continue;
      }
      const command = [
        "pnpm",
        descriptor.command,
        ...(descriptor.domain === "speech" ? ["--engine", "apple"] : []),
        ...(request.language ? ["--language", request.language] : []),
        ...(request.targetLanguage ? ["--target-language", request.targetLanguage] : []),
        ...(request.voice ? ["--voice", request.voice] : []),
        ...(request.assistTask ? ["--assist-task", request.assistTask] : []),
        ...(request.operations ? ["--operations", request.operations.join(",")] : []),
        ...(descriptor.domain === "vision" ? ["--features", request.task.slice(7)] : []),
        ...(request.purpose === "production" && descriptor.domain !== "speech" ? ["--purpose", "production"] : []),
      ];
      results.push({
        ...base,
        state: "ready",
        reason: "Runtime and requested resources available; result checks still apply",
        identity,
        quality,
        languages: runtime.languages,
        command,
      });
    } catch (error) {
      if (error instanceof NativeUnavailable)
        results.push(unavailable(error.issue.state, error.issue.message, error.issue.userAction));
      else results.push(unavailable("unknown", error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}
export async function resolveLocalTask(
  request: LocalTaskRequest,
  options: CapabilityOptions = {},
): Promise<{
  ready: LocalCapability[];
  preparation?: { argv: string[]; reason: string };
  userAction?: string;
  alternative: string;
}> {
  const capabilities = await inspectCapabilities([request], options),
    capability = capabilities[0]!,
    descriptor = LOCAL_CAPABILITIES.find((d) => d.task === request.task)!;
  return {
    ready: capabilities.filter((c) => c.state === "ready"),
    ...(capability.prepare
      ? { preparation: { argv: capability.prepare, reason: capability.reason } }
      : capability.userAction
        ? { userAction: capability.userAction }
        : {}),
    alternative: descriptor.alternative,
  };
}
export const APPLE_COMMANDS = new Set([
  "media:ocr",
  "media:visual",
  "media:category",
  "text:analyse",
  "text:translate",
  "voiceover:local",
  "audio:events",
  "media:vision",
  "text:assist",
  "image:describe",
]);
export async function availableLocalCommands(options: CapabilityOptions = {}) {
  const states = await inspectCapabilities(
    LOCAL_CAPABILITIES.filter((d) => APPLE_COMMANDS.has(d.command)).map((d) => ({ task: d.task })),
    options,
  );
  return new Set(
    states.filter((c) => c.state === "ready").map((c) => LOCAL_CAPABILITIES.find((d) => d.task === c.task)!.command),
  );
}
export function domainFromEngine(engine: string) {
  return engine.startsWith("apple-") ? AppleDomainSchema.parse(engine.slice(6)) : undefined;
}

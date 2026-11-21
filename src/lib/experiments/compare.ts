import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { mediaProbe } from "../audio/analysis";
import { RenderReceiptSchema } from "../../types/delivery";
import { digest, immutableJson, pinFile, projectDirectory, scopedFile, verifyPin } from "../campaigns/production/files";
import { captureBespokeIdentity, isBespokeDelivery } from "../delivery/bespoke";
import { captureRenderIdentity, withRenderIdentityReadCache } from "../delivery/identity";
import { findExperiment, THREE_SHOT_EXPERIMENT, type ExperimentId } from "./registry";
import { experimentError, readExperiments } from "./project";

const key = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const format = z.enum(["landscape", "vertical", "square"]);
const subject = z
  .object({
    slot: key,
    project: z.string().min(1),
    format,
    audioMaster: z.string().optional(),
    fontContext: z.string().optional(),
  })
  .strict();
const FreezeRequest = z
  .object({
    experiment: z.string(),
    model: z.string().min(1),
    limits: z.object({ maxCostUsd: z.number().nonnegative(), timeLimitSec: z.number().positive() }).strict(),
    inputs: z.record(key, z.string().min(1)),
    subjects: z.array(subject).min(1),
  })
  .strict();
const Frozen = FreezeRequest.omit({ inputs: true })
  .extend({
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    inputs: z.record(key, z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
    selections: z.array(z.string()),
    selectionHash: z.string(),
  })
  .strict();
const EvidenceRequest = z
  .object({
    manualCorrections: z.number().int().nonnegative(),
    corrections: z.array(
      z
        .object({
          slot: key,
          frame: z.number().int().nonnegative(),
          description: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const frozenFile = (directory: string) => path.join(directory, "pipeline/experiment-inputs.json");
const evidenceFile = (directory: string) => path.join(directory, "pipeline/experiment-outcome.json");

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }).trim();
}

function cleanCommit(root: string) {
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"]))
    experimentError("Compare from a clean committed checkout. Keep project inputs in their ignored project footprint.");
  return git(root, ["rev-parse", "HEAD"]);
}

const requiredInputs: Record<ExperimentId, string[]> = {
  "tutorial-series-kit@1": ["brief", "episodes", "materials", "style-change"],
  "tutorial-camera@1": ["brief", "script", "capture", "narration", "words"],
  [THREE_SHOT_EXPERIMENT]: ["brief", "concept", "script", "sources"],
  "proof-scenes@1": ["brief", "concept", "script", "sources"],
};

export function freezeComparison(root: string, project: string, raw: unknown) {
  const request = FreezeRequest.parse(raw);
  const experiment = findExperiment(request.experiment);
  if (!experiment) experimentError("Freeze inputs for a registered experiment");
  const directory = projectDirectory(root, project);
  const selections = readExperiments(directory);
  if (selections.some(({ started }) => started) && request.experiment !== "proof-scenes@1")
    experimentError("Freeze comparison inputs before beginning the experimental step");
  for (const role of requiredInputs[experiment.id])
    if (!request.inputs[role]) experimentError(`The comparison needs a pinned ${role} input`);
  if (new Set(request.subjects.map(({ slot, format }) => `${slot}/${format}`)).size !== request.subjects.length)
    experimentError("Each subject slot and format must be unique");
  for (const row of request.subjects) {
    const child = projectDirectory(root, row.project);
    if (request.experiment === "tutorial-series-kit@1") {
      const file = scopedFile(root, path.join(child, "pipeline/campaign-binding.json"));
      // Episodes may be prepared after the comparison inputs are frozen.
      if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).campaignId !== project)
        experimentError("The review subject belongs to another campaign");
    } else if (row.project !== project) experimentError("Use this project’s own renders as comparison subjects");
  }
  const value = Frozen.parse({
    ...request,
    commit: cleanCommit(root),
    selections: selections.map(({ id }) => id).sort(),
    selectionHash: digest(selections.map(({ id, kit }) => ({ id, ...(kit ? { kit } : {}) }))),
    inputs: Object.fromEntries(Object.entries(request.inputs).map(([name, file]) => [name, pinFile(root, file)])),
  });
  const file = frozenFile(directory);
  immutableJson(file, value);
  return file;
}

export function recordComparisonOutcome(root: string, project: string, raw: unknown) {
  const directory = projectDirectory(root, project);
  const frozen = Frozen.parse(JSON.parse(readFileSync(frozenFile(directory), "utf8")));
  const evidence = EvidenceRequest.parse(raw);
  if (
    evidence.manualCorrections !== evidence.corrections.length ||
    evidence.corrections.some(({ slot }) => !frozen.subjects.some((subject) => subject.slot === slot))
  )
    experimentError("Each counted correction needs a subject slot, frame and description");
  const file = evidenceFile(directory);
  immutableJson(file, evidence);
  return file;
}

function fullRender(root: string, row: z.infer<typeof subject>) {
  const output = scopedFile(
    root,
    path.join(root, "out", row.project, isBespokeDelivery(root, row.project) ? "film.mp4" : `${row.format}.mp4`),
  );
  const receipt = RenderReceiptSchema.parse(
    JSON.parse(readFileSync(scopedFile(root, output + ".receipt.json"), "utf8")),
  );
  if (receipt.partial || receipt.evidence !== "renderer" || receipt.format !== row.format || receipt.captions !== "on")
    experimentError(`Use a full captioned renderer output for ${row.slot}/${row.format}`);
  verifyPin(root, { path: path.relative(root, output), sha256: receipt.outputSha256 });
  const directory = projectDirectory(root, row.project);
  const explicitMaster = row.audioMaster ? scopedFile(root, row.audioMaster) : undefined;
  const filmMaster = path.join(directory, "audio/master.wav");
  const current = isBespokeDelivery(root, row.project)
    ? captureBespokeIdentity(row.project, row.format, {
        rootDir: root,
        audioMaster: explicitMaster ?? (existsSync(filmMaster) ? filmMaster : undefined),
      })
    : captureRenderIdentity(row.project, row.format, {
        rootDir: root,
        timeline: receipt.sources.some(({ role }) => role === "edit"),
        audioMaster: explicitMaster,
        fontContext: row.fontContext ? scopedFile(root, row.fontContext) : undefined,
        fontContextMode: "existing",
      });
  if (
    current.sourceSnapshotHash !== receipt.sourceSnapshotHash ||
    current.propsHash !== receipt.propsHash ||
    digest(current.sources) !== digest(receipt.sources)
  )
    experimentError(`Stale or misbound renderer receipt for ${row.slot}/${row.format}; re-render this project.`);
  const probe = mediaProbe(output);
  const picture = probe.streams.find(({ codec_type }) => codec_type === "video");
  if (!picture?.width || !picture.height) experimentError("The comparison clip has no playable picture");
  return {
    output,
    receipt,
    width: picture.width,
    height: picture.height,
    durationSec: Number(probe.format.duration),
    hasAudio: probe.streams.some(({ codec_type }) => codec_type === "audio"),
  };
}

export function compareProjects(root: string, baseline: string, candidate: string) {
  if (baseline === candidate) experimentError("Choose two different projects");
  const commit = cleanCommit(root);
  const runs = [baseline, candidate].map((project) => {
    const directory = projectDirectory(root, project);
    const frozen = Frozen.parse(JSON.parse(readFileSync(frozenFile(directory), "utf8")));
    if (frozen.commit !== commit) experimentError("Both variants must run on the current commit");
    Object.values(frozen.inputs).forEach((pin) => verifyPin(root, pin));
    const identity = digest({
      experiment: frozen.experiment,
      model: frozen.model,
      limits: frozen.limits,
      inputs: Object.fromEntries(Object.entries(frozen.inputs).map(([name, pin]) => [name, pin.sha256])),
      subjects: frozen.subjects.map(({ slot, format }) => `${slot}/${format}`).sort(),
    });
    const selections = readExperiments(directory);
    const selected = selections.map(({ id }) => id).sort();
    if (digest(selections.map(({ id, kit }) => ({ id, ...(kit ? { kit } : {}) }))) !== frozen.selectionHash)
      experimentError("The experiment or its configuration changed after freezing inputs");
    if (frozen.experiment === "tutorial-series-kit@1") {
      for (const row of frozen.subjects) {
        const file = scopedFile(root, path.join(projectDirectory(root, row.project), "pipeline/campaign-binding.json"));
        if (JSON.parse(readFileSync(file, "utf8")).campaignId !== project)
          experimentError("The review subject belongs to another campaign");
      }
    }
    if (digest(selected) !== digest(frozen.selections))
      experimentError("The experiment selection changed after freezing inputs");
    const outcome = EvidenceRequest.parse(JSON.parse(readFileSync(evidenceFile(directory), "utf8")));
    return { project, frozen, identity, selected, outcome };
  });
  const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]];
  const aSubjects = new Set(a.frozen.subjects.map(({ project }) => project));
  if (b.frozen.subjects.some(({ project }) => aSubjects.has(project)))
    experimentError("The two variants must render separate project outputs");
  if (a.identity !== b.identity)
    experimentError("The projects differ in frozen inputs, model, limits or requested render subjects");
  if (a.selected.length || b.selected.length !== 1 || b.selected[0] !== b.frozen.experiment)
    experimentError("Compare the ordinary route against exactly the registered candidate experiment");

  const id = randomUUID();
  const base = path.join(root, "out/experiments");
  const stage = path.join(base, `.${id}.tmp`);
  const directory = path.join(base, id);
  const review = path.join(stage, "review");
  const form: { slot: string; format: string; videos: string[]; rating: null; notes: string }[] = [];
  const keys: unknown[] = [];
  const technical: unknown[] = [];
  mkdirSync(base, { recursive: true });
  mkdirSync(stage, { mode: 0o700 });
  try {
    mkdirSync(review);
    for (const [index, left] of a.frozen.subjects.entries()) {
      const right = b.frozen.subjects.find(({ slot, format }) => slot === left.slot && format === left.format)!;
      const clips = withRenderIdentityReadCache(() => [fullRender(root, left), fullRender(root, right)]);
      technical.push({
        slot: left.slot,
        format: left.format,
        renders: clips.map(({ receipt, width, height, durationSec, hasAudio }) => ({
          width,
          height,
          durationSec,
          hasAudio,
          outputSha256: receipt.outputSha256,
          sourceSnapshotHash: receipt.sourceSnapshotHash,
          propsHash: receipt.propsHash,
          createdAt: receipt.createdAt,
        })),
      });
      const order = randomInt(2) ? [1, 0] : [0, 1];
      const videos = order.map((source, label) => {
        const filename = `pair-${index + 1}-${label + 1}.mp4`;
        const { output } = clips[source]!;
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-nostdin",
            "-n",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            output,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-map_metadata",
            "-1",
            "-map_metadata:s",
            "-1",
            "-map_chapters",
            "-1",
            "-c",
            "copy",
            path.join(review, filename),
          ],
          { timeout: 120_000, stdio: "pipe" },
        );
        keys.push({ filename, project: runs[source]!.project, render: clips[source]!.receipt.outputSha256 });
        return filename;
      });
      form.push({ slot: left.slot, format: left.format, videos, rating: null, notes: "" });
    }
    writeFileSync(
      path.join(review, "ratings.json"),
      JSON.stringify(
        {
          instructions:
            "Watch each pair with sound. Record the stronger clip or a tie for clarity, accuracy, pacing and visual fit. Cite a frame for any critical issue.",
          pairs: form,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    writeFileSync(
      path.join(stage, "private.json"),
      JSON.stringify(
        {
          commit,
          experiment: b.frozen.experiment,
          keys,
          technical,
          baseline: { project: a.project, outcome: a.outcome },
          candidate: { project: b.project, outcome: b.outcome },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    if (existsSync(directory)) experimentError("Comparison destination already exists");
    renameSync(stage, directory);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return {
    review: path.join(directory, "review"),
    privateKey: path.join(directory, "private.json"),
    pairs: form.length,
  };
}

import { vizProjectAdvice } from "../viz/integrity";
import { authoredCopyCommand } from "./authored-copy";
import { inspectReviewPack, reviewHash } from "../vision/review-pack";
import { captureProjectCopyEdits, assertProjectCopyEdits } from "./copy-validation";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { prepareVisualReframe } from "./visual-reframe";
import { inspectChapters } from "./chapters";
import { VisualRemoveProposalSchema, buildVisualRemoveProposal } from "./visual-remove";
import { VisualSlipProposalSchema, buildVisualSlipProposal } from "./visual-slip";
import { inspectSlipOriginal } from "./slip-original";
import { assertSplitOriginal } from "./split-original";
import { VisualSplitProposalSchema, buildVisualSplitProposal } from "./visual-split";
import { readLocalJson } from "../audio/local-input";
import { AssetRegistrySchema } from "../../types/assets";
import { ProjectConfigSchema, FORMAT_CONFIGS } from "../../types/video";
import { AudioPositionProposalSchema, buildAudioPositionProposal } from "./audio-position";
import { assertProjectAudioEdits } from "../audio/edit-validation";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  fsyncSync,
  linkSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertProjectId } from "../render-plan";
import { TimelineEditStore, RevisionConflict, parseTimelineEditDocument } from "../timeline-ir/store";
import { buildVisualGroupMove, ReviewGroupMoveSchema } from "./group-move";
import { applyEdit } from "../timeline-ir/commands";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { EditCommandSchema } from "../../types/timeline";
import { readAssetRegistry } from "../assets/registry";
import { listEntities, getEntityVersion } from "../entities/service";
import { OperationStore } from "../jobs/store";
import { RealtimeReviewService } from "./realtime";
export const ReviewDryRunSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    command: EditCommandSchema,
  })
  .strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const ReviewMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("edit"),
      expectedRevision: z.number().int().nonnegative(),
      command: EditCommandSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("undo"),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("redo"),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("snapshot"),
      expectedRevision: z.number().int().nonnegative(),
      label: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      action: z.literal("choose"),
      expectedRevision: z.number().int().nonnegative(),
      snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      actor: z.string().min(1).max(160),
    })
    .strict(),
]);
export class ReviewService {
  readonly project: string;
  readonly store: TimelineEditStore;
  readonly realtime: RealtimeReviewService;
  constructor(
    readonly projectId: string,
    readonly rootDir = process.cwd(),
  ) {
    assertProjectId(projectId);
    this.rootDir = realpathSync(rootDir);
    this.project = path.resolve(this.rootDir, "public/projects", projectId);
    this.safe(this.project);
    this.safe(path.join(this.project, "project.json"));
    this.realtime = new RealtimeReviewService(this.rootDir, projectId);
    this.store = new TimelineEditStore(path.join(this.project, "pipeline/timeline-edit.json"), (timeline, command) => {
      assertProjectAudioEdits(timeline, command, this.projectId, this.rootDir);
      assertProjectCopyEdits(timeline, command, this.projectId, this.rootDir);
    });
  }
  /** Validate existing ancestors as well as final file; project cannot alias another project. */
  safe(file: string) {
    const base = path.resolve(this.rootDir, "public/projects");
    const relative = path.relative(this.project, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path outside selected project");
    if (!existsSync(this.project) || realpathSync(this.project) !== this.project || realpathSync(base) !== base)
      throw new Error("Project directory must be local and must not be a symlink");
    let current = file;
    while (!existsSync(current)) current = path.dirname(current);
    const resolved = realpathSync(current);
    if (resolved !== this.project && !resolved.startsWith(this.project + path.sep))
      throw new Error("Project path escapes through a symlink");
    return file;
  }
  private evidenceFiles() {
    const directory = this.safe(path.join(this.project, "pipeline/qa-evidence"));
    if (!existsSync(directory)) return [];
    const result: string[] = [];
    for (const name of readdirSync(directory)) {
      if (!/^(vertical|square|landscape)-[a-f0-9-]{36}$/.test(name)) continue;
      const current = this.safe(path.join(directory, name));
      if (!statSync(current).isDirectory()) continue;
      for (const file of readdirSync(current))
        if (file === "evidence.json" || file === "contact-sheet.html" || /^frame-[0-9]{6}\.png$/.test(file)) {
          const target = this.safe(path.join(current, file));
          if (statSync(target).isFile()) result.push(path.relative(this.project, target));
        }
      for (const review of readdirSync(current).filter((name) => /^review-[a-f0-9-]{36}$/.test(name))) {
        const pack = this.safe(path.join(current, review));
        if (!statSync(pack).isDirectory()) continue;
        for (const name of readdirSync(pack).filter((name) =>
          /^(manifest\.json|index\.html|page-[0-9]{3}(-diff)?\.(html|png))$/.test(name),
        )) {
          const target = this.safe(path.join(pack, name));
          if (statSync(target).isFile()) result.push(path.relative(this.project, target));
        }
        const frames = this.safe(path.join(pack, "frames"));
        if (existsSync(frames))
          for (const name of readdirSync(frames).filter((name) =>
            /^(?:[0-9]{6}|crop-[0-9]+-[0-9]+|diff-[0-9]+)\.png$/.test(name),
          )) {
            const target = this.safe(path.join(frames, name));
            if (statSync(target).isFile()) result.push(path.relative(this.project, target));
          }
      }
      const browser = this.safe(path.join(current, "browser"));
      if (existsSync(browser))
        for (const file of readdirSync(browser))
          if (/^browser-[0-9]{6}\.png$/.test(file)) {
            const target = this.safe(path.join(browser, file));
            if (statSync(target).isFile()) result.push(path.relative(this.project, target));
          }
    }
    return result;
  }
  private outputFiles() {
    const directory = path.join(this.rootDir, "out", this.projectId);
    if (!existsSync(directory)) return [];
    const base = path.join(this.rootDir, "out");
    if (realpathSync(base) !== base || realpathSync(directory) !== directory)
      throw new Error("Output directory cannot be a symlink");
    const files: string[] = [];
    for (const name of ["vertical.mp4", "square.mp4", "landscape.mp4"])
      if (existsSync(path.join(directory, name))) files.push("@out/" + name);
    const screenshots = path.join(directory, "qa-screenshots");
    if (existsSync(screenshots)) {
      if (realpathSync(screenshots) !== screenshots) throw new Error("Screenshot directory cannot be a symlink");
      for (const name of readdirSync(screenshots))
        if (/^[a-zA-Z0-9_.-]+\.(png|jpe?g|json|md)$/.test(name)) files.push("@out/qa-screenshots/" + name);
    }
    for (const ref of files) {
      const file = path.join(directory, ref.slice(5));
      if (realpathSync(file) !== file || !statSync(file).isFile())
        throw new Error("Output artifact cannot be a symlink");
    }
    return files;
  }
  private publishSnapshot(file: string, value: unknown) {
    const temporary = this.safe(file + "." + randomUUID() + ".tmp");
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } finally {
      unlinkSync(temporary);
    }
  }
  private readSnapshot(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid snapshot hash");
    const value = JSON.parse(
      readFileSync(this.safe(path.join(this.project, "pipeline/review/snapshots", id + ".json")), "utf8"),
    );
    if (value.hash !== id || hash(value.timeline) !== id || value.timeline.projectId !== this.projectId)
      throw new Error("Snapshot hash or project mismatch");
    return value;
  }
  state() {
    this.safe(this.store.file);
    const document = existsSync(this.store.file) ? this.store.read() : undefined;
    if (document && document.timeline.projectId !== this.projectId)
      throw new Error("Journal belongs to another project");
    const timeline = document ? compileTimelineIR(document.timeline) : undefined;
    const assets = readAssetRegistry(this.projectId, this.rootDir).assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      hash: a.hash,
      media: a.media,
      rights: a.rights,
      origin: a.provenance.origin,
      model: a.provenance.model,
      billing: a.provenance.billing,
      original: a.files.original,
    }));
    const entities = listEntities(this.projectId, this.rootDir).map((m) => ({
      id: m.id,
      kind: m.kind,
      latestRevision: m.latestRevision,
      canonicalRevision: m.canonicalRevision,
      name: getEntityVersion(this.projectId, m.kind, m.id, {
        rootDir: this.rootDir,
      }).version.card.name,
    }));
    const operations = new OperationStore(this.projectId, {
      directory: path.join(this.project, "pipeline"),
    });
    this.safe(operations.file);
    const budget = existsSync(operations.file)
      ? {
          ...operations.summary(),
          jobs: Object.values(operations.snapshot().jobs).map((j) => ({
            id: j.operationId,
            state: j.state,
            endpoint: j.endpoint,
            reservedUsd: j.reservedMicros / 1e6,
            quote: j.quote,
            actualUsd: j.receipt?.actualUsd ?? null,
            paidAttempts: j.paidAttempts,
          })),
        }
      : { status: "uninitialized", jobs: [] };
    const directory = this.safe(path.join(this.project, "pipeline/review/snapshots"));
    const snapshots = existsSync(directory)
      ? readdirSync(directory)
          .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
          .map((f) => {
            const s = this.readSnapshot(f.slice(0, -5));
            return {
              hash: s.hash,
              label: s.label,
              revision: s.revision,
              createdAt: s.createdAt,
              durationInFrames: compileTimelineIR(s.timeline).durationInFrames,
            };
          })
      : [];
    const choices = this.safe(path.join(this.project, "pipeline/review/choices.jsonl"));
    const selected = existsSync(choices)
      ? readFileSync(choices, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .at(-1)
      : null;
    const outputs = this.outputFiles();
    const reports = [
      ...this.evidenceFiles(),
      "pipeline/qa.json",
      "pipeline/qa.md",
      "pipeline/editorial-qa.json",
      "pipeline/editorial-qa.md",
      "entities/asset-board.html",
      "animatic.html",
    ].filter((file) => existsSync(this.safe(path.join(this.project, file))));
    return {
      ...(vizProjectAdvice(this.rootDir, this.projectId)
        ? { visualisations: vizProjectAdvice(this.rootDir, this.projectId) }
        : {}),
      projectId: this.projectId,
      revision: document?.revision ?? null,
      timelineHash: document ? hash(document.timeline) : null,
      durationInFrames: timeline?.durationInFrames ?? 0,
      timebase: timeline?.timebase,
      tracks:
        timeline?.tracks.map((t) => ({
          id: t.id,
          kind: t.kind,
          clips: t.clips.map((c) => ({
            id: c.id,
            assetId: c.assetId,
            start: c.start,
            end: c.end,
            source: c.source,
            rate: c.rate,
            transition: c.transition,
            captions: c.captions,
            payload: c.payload,
          })),
        })) ?? [],
      journal: document?.undo.map((h) => h.command) ?? [],
      redoCount: document?.redo.length ?? 0,
      assets,
      entities,
      budget,
      snapshots,
      selected,
      reports,
      outputs,
    };
  }
  visualReframeProposal(raw: unknown) {
    return prepareVisualReframe(this.rootDir, this.projectId, raw);
  }
  chapterInspection(raw: unknown) {
    return inspectChapters(this.project, raw, this.rootDir);
  }
  visualSplitProposal(raw: unknown) {
    const input = VisualSplitProposalSchema.parse(raw);
    this.safe(this.store.file);
    const document = this.store.read();
    if (document.timeline.projectId !== this.projectId) throw Error("Journal belongs to another project");
    if (document.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, document.revision);
    const clip = document.timeline.tracks
      .find((t) => t.id === input.trackId && t.kind === "visual")
      ?.clips.find((c) => c.id === input.clipId);
    if (!clip) throw Error("Split proposal supports existing visual clips only");
    const config = ProjectConfigSchema.parse(readLocalJson(this.safe(path.join(this.project, "project.json"))));
    const registry = AssetRegistrySchema.parse(
      readLocalJson(this.safe(path.join(this.project, "pipeline/asset-registry.json"))),
    );
    const asset = registry.assets.find((a) => a.id === clip.assetId);
    if (
      !asset ||
      !["image", "video"].includes(asset.kind) ||
      !asset.files.original.startsWith("projects/" + this.projectId + "/assets/imported/") ||
      asset.files.original.includes("..") ||
      asset.files.original.includes("\\")
    )
      throw Error("Split proposal requires an imported project image or plain video");
    assertSplitOriginal(
      this.safe(path.resolve(this.rootDir, "public", asset.files.original)),
      asset.hash,
      asset.kind as "image" | "video",
    );
    // The Root uses these format configs; no source FPS is inferred from media labels.
    const clocks = [...new Set(config.formats.map((format) => FORMAT_CONFIGS[format].fps))];
    if (clocks.length !== 1) throw Error("Split proposal requires one shared output frame clock");
    const command = buildVisualSplitProposal(document.timeline, input, {
      kind: asset.kind as "image" | "video",
      fps: clocks[0],
      talkingHead: config.talkingHead?.enabled === true,
    });
    const result = this.dryRun({ expectedRevision: input.expectedRevision, command });
    assertSplitOriginal(
      this.safe(path.resolve(this.rootDir, "public", asset.files.original)),
      asset.hash,
      asset.kind as "image" | "video",
    );
    if (
      JSON.stringify(config) !==
        JSON.stringify(ProjectConfigSchema.parse(readLocalJson(this.safe(path.join(this.project, "project.json"))))) ||
      JSON.stringify(registry) !==
        JSON.stringify(
          AssetRegistrySchema.parse(readLocalJson(this.safe(path.join(this.project, "pipeline/asset-registry.json")))),
        )
    )
      throw Error("Split render classification changed during preparation");
    return { command, ...result };
  }
  visualRemoveProposal(raw: unknown) {
    const input = VisualRemoveProposalSchema.parse(raw),
      read = (file: string) => {
        this.safe(file);
        if (realpathSync(file) !== file) throw Error("Visual remove inputs must not use symlink aliases");
        return readLocalJson(file);
      };
    const document = parseTimelineEditDocument(read(this.store.file));
    if (document.timeline.projectId !== this.projectId) throw Error("Journal belongs to another project");
    if (document.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, document.revision);
    const clip = document.timeline.tracks
      .find((t) => t.id === input.trackId && t.kind === "visual")
      ?.clips.find((c) => c.id === input.clipId);
    if (!clip) throw Error("Visual remove supports existing visual clips only");
    const configFile = path.join(this.project, "project.json"),
      registryFile = path.join(this.project, "pipeline/asset-registry.json"),
      config = ProjectConfigSchema.parse(read(configFile)),
      registry = AssetRegistrySchema.parse(read(registryFile)),
      asset = registry.assets.find((a) => a.id === clip.assetId);
    if (
      !asset ||
      !["image", "video"].includes(asset.kind) ||
      !asset.files.original.startsWith("projects/" + this.projectId + "/assets/imported/") ||
      asset.files.original.includes("..") ||
      asset.files.original.includes("\\")
    )
      throw Error("Visual remove requires an imported plain image or video");
    if (clip.payload?.originalHash !== undefined && clip.payload.originalHash !== asset.hash)
      throw Error("Visual remove original metadata checksum mismatch");
    const file = this.safe(path.resolve(this.rootDir, "public", asset.files.original));
    if (realpathSync(file) !== file) throw Error("Visual remove original must not use symlink aliases");
    // Video must belong to the already verified plain MP4/H264 CFR subset. Static image bytes use the existing PNG/JPEG guard.
    if (asset.kind === "video") inspectSlipOriginal(file, asset.hash);
    else assertSplitOriginal(file, asset.hash, "image");
    const command = buildVisualRemoveProposal(document.timeline, input, {
        talkingHead: config.talkingHead?.enabled === true,
      }),
      candidate = applyEdit(document.timeline, command);
    assertSplitOriginal(file, asset.hash, asset.kind as "image" | "video");
    if (
      JSON.stringify(config) !== JSON.stringify(ProjectConfigSchema.parse(read(configFile))) ||
      JSON.stringify(registry) !== JSON.stringify(AssetRegistrySchema.parse(read(registryFile)))
    )
      throw Error("Visual remove classification changed during preparation");
    const current = parseTimelineEditDocument(read(this.store.file));
    if (current.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, current.revision);
    if (JSON.stringify(current) !== JSON.stringify(document))
      throw Error("Visual remove journal changed during preparation");
    return {
      command,
      revision: document.revision,
      timelineHash: hash(candidate),
      snapshot: compileTimelineIR(candidate),
    };
  }
  visualSlipProposal(raw: unknown) {
    const input = VisualSlipProposalSchema.parse(raw);
    this.safe(this.store.file);
    const document = parseTimelineEditDocument(readLocalJson(this.store.file));
    if (document.timeline.projectId !== this.projectId) throw Error("Journal belongs to another project");
    if (document.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, document.revision);
    const clip = document.timeline.tracks
      .find((t) => t.id === input.trackId && t.kind === "visual")
      ?.clips.find((c) => c.id === input.clipId);
    if (!clip) throw Error("Source slip supports existing visual clips only");
    const configFile = this.safe(path.join(this.project, "project.json")),
      registryFile = this.safe(path.join(this.project, "pipeline/asset-registry.json"));
    const config = ProjectConfigSchema.parse(readLocalJson(configFile)),
      registry = AssetRegistrySchema.parse(readLocalJson(registryFile)),
      asset = registry.assets.find((a) => a.id === clip.assetId);
    if (
      !asset ||
      asset.kind !== "video" ||
      !asset.files.original.startsWith("projects/" + this.projectId + "/assets/imported/") ||
      asset.files.original.includes("..") ||
      asset.files.original.includes("\\")
    )
      throw Error("Source slip requires an imported local video");
    if (clip.payload?.originalHash !== undefined && clip.payload.originalHash !== asset.hash)
      throw Error("Source slip original metadata checksum mismatch");
    const file = this.safe(path.resolve(this.rootDir, "public", asset.files.original)),
      physical = inspectSlipOriginal(file, asset.hash),
      clocks = [...new Set(config.formats.map((format) => FORMAT_CONFIGS[format].fps))];
    if (clocks.length !== 1) throw Error("Source slip requires one shared output frame clock");
    const command = buildVisualSlipProposal(document.timeline, input, {
      fps: clocks[0],
      talkingHead: config.talkingHead?.enabled === true,
      ...physical,
    });
    const candidate = applyEdit(document.timeline, command),
      result = { revision: document.revision, timelineHash: hash(candidate), snapshot: compileTimelineIR(candidate) };
    assertSplitOriginal(file, asset.hash, "video");
    if (
      JSON.stringify(config) !== JSON.stringify(ProjectConfigSchema.parse(readLocalJson(configFile))) ||
      JSON.stringify(registry) !== JSON.stringify(AssetRegistrySchema.parse(readLocalJson(registryFile)))
    )
      throw Error("Source slip classification changed during preparation");
    const current = parseTimelineEditDocument(readLocalJson(this.store.file));
    if (current.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, current.revision);
    if (JSON.stringify(current) !== JSON.stringify(document))
      throw Error("Source slip journal changed during preparation");
    return { command, ...result, physical };
  }
  audioPositionProposal(raw: unknown) {
    const input = AudioPositionProposalSchema.parse(raw);
    this.safe(this.store.file);
    const document = this.store.read();
    if (document.timeline.projectId !== this.projectId) throw Error("Journal belongs to another project");
    if (document.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, document.revision);
    const command = buildAudioPositionProposal(document.timeline, input);
    return { command, ...this.dryRun({ expectedRevision: input.expectedRevision, command }) };
  }
  groupMoveProposal(raw: unknown) {
    const input = ReviewGroupMoveSchema.parse(raw);
    this.safe(this.store.file);
    const document = this.store.read();
    if (document.timeline.projectId !== this.projectId) throw new Error("Journal belongs to another project");
    if (document.revision !== input.expectedRevision)
      throw new RevisionConflict(input.expectedRevision, document.revision);
    const command = buildVisualGroupMove(document.timeline, input);
    return { command, ...this.dryRun({ expectedRevision: input.expectedRevision, command }) };
  }
  authoredCopyProposal(raw: unknown) {
    const { expectedRevision, command } = authoredCopyCommand(raw);
    const before = readWorkflowEvidence(this.store.file, this.project, 4 * 1024 * 1024),
      document = parseTimelineEditDocument(JSON.parse(before.text));
    if (document.revision !== expectedRevision) throw new RevisionConflict(expectedRevision, document.revision);
    const inputs = captureProjectCopyEdits(document.timeline, command, this.projectId, this.rootDir)!;
    const candidate = applyEdit(document.timeline, command);
    assertProjectAudioEdits(candidate, command, this.projectId, this.rootDir);
    assertProjectCopyEdits(candidate, command, this.projectId, this.rootDir);
    const result = {
      revision: document.revision,
      timelineHash: hash(candidate),
      snapshot: compileTimelineIR(candidate),
    };
    if (readWorkflowEvidence(this.store.file, this.project, 4 * 1024 * 1024).sha256 !== before.sha256)
      throw Error("Copy journal changed during preparation");
    inputs.assertUnchanged();
    return { command, ...result };
  }
  dryRun(raw: unknown) {
    const input = ReviewDryRunSchema.parse(raw);
    this.safe(this.store.file);
    if (this.store.read().timeline.projectId !== this.projectId) throw new Error("Journal belongs to another project");
    const result = this.store.dryRun(input.command, input.expectedRevision);
    return {
      revision: result.revision,
      timelineHash: hash(result.timeline),
      snapshot: result.snapshot,
    };
  }
  mutate(raw: unknown) {
    const action = ReviewMutationSchema.parse(raw);
    this.safe(this.store.file);
    if (this.store.read().timeline.projectId !== this.projectId) throw new Error("Journal belongs to another project");
    if (action.action === "edit") this.store.apply(action.command, action.expectedRevision);
    else if (action.action === "undo") this.store.undo(action.expectedRevision);
    else if (action.action === "redo") this.store.redo(action.expectedRevision);
    else {
      const lock = this.safe(this.store.file + ".lock");
      const fd = openSync(lock, "wx", 0o600);
      try {
        const document = this.store.read();
        if (document.timeline.projectId !== this.projectId) throw new Error("Journal belongs to another project");
        if (document.revision !== action.expectedRevision)
          throw new RevisionConflict(action.expectedRevision, document.revision);
        if (action.action === "snapshot") {
          const id = hash(document.timeline),
            directory = this.safe(path.join(this.project, "pipeline/review/snapshots"));
          mkdirSync(directory, { recursive: true });
          const file = this.safe(path.join(directory, id + ".json"));
          if (!existsSync(file))
            this.publishSnapshot(file, {
              version: 1,
              hash: id,
              label: action.label,
              revision: document.revision,
              createdAt: new Date().toISOString(),
              timeline: document.timeline,
            });
          else this.readSnapshot(id);
        } else {
          const selected = this.readSnapshot(action.snapshotHash);
          const directory = this.safe(path.join(this.project, "pipeline/review"));
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            this.safe(path.join(directory, "choices.jsonl")),
            JSON.stringify({
              version: 1,
              snapshotHash: selected.hash,
              snapshotRevision: selected.revision,
              currentRevision: document.revision,
              currentHash: hash(document.timeline),
              actor: action.actor,
              declaredAt: new Date().toISOString(),
            }) + "\n",
            { flag: "a", mode: 0o600 },
          );
        }
      } finally {
        closeSync(fd);
        unlinkSync(lock);
      }
    }
    return this.state();
  }
  compare(a: string, b: string) {
    const read = (id: string) => {
      if (id !== "current") return this.readSnapshot(id);
      this.safe(this.store.file);
      const doc = this.store.read();
      if (doc.timeline.projectId !== this.projectId) throw new Error("Journal belongs to another project");
      return {
        hash: hash(doc.timeline),
        revision: doc.revision,
        timeline: doc.timeline,
      };
    };
    const left = read(a),
      right = read(b);
    return {
      left: {
        hash: left.hash,
        revision: left.revision,
        timeline: compileTimelineIR(left.timeline),
      },
      right: {
        hash: right.hash,
        revision: right.revision,
        timeline: compileTimelineIR(right.timeline),
      },
      equal: left.hash === right.hash,
    };
  }
  /** Dynamic allowlist contains only declared originals and selected report files. */
  reviewPack(relative: string) {
    if (!/\/review-[a-f0-9-]{36}\/manifest\.json$/.test(relative)) throw new Error("Not a declared review manifest.");
    const result = inspectReviewPack(this.file(relative), { limit: 100, verifySource: false });
    const source = existsSync(result.source.path) ? realpathSync(result.source.path) : path.resolve(result.source.path);
    const inside = (base: string) => {
      const rest = path.relative(base, source);
      return rest === "" || (rest !== ".." && !rest.startsWith(".." + path.sep) && !path.isAbsolute(rest));
    };
    const allowedSource = inside(this.project) || inside(path.join(this.rootDir, "out", this.projectId));
    if (allowedSource && (!existsSync(source) || reviewHash(source) !== result.source.sha256))
      throw new Error("Review source is stale or unavailable.");
    if (!allowedSource)
      result.warnings.push(
        "Source freshness is unverified in the selected-project UI; use the trusted vision:inspect CLI for sources outside this project.",
      );
    return { ...result, sourceFreshness: allowedSource ? "verified" : "unverified" };
  }
  file(relative: string) {
    if (relative.startsWith("@realtime/")) return this.realtime.file(relative);
    const state = this.state();
    const allowed = new Set([
      ...state.reports,
      ...state.outputs,
      ...state.assets.map((a) => a.original.replace(`projects/${this.projectId}/`, "")),
    ]);
    if (!allowed.has(relative)) throw new Error("File is not a declared review artifact");
    const file = relative.startsWith("@out/")
      ? path.join(this.rootDir, "out", this.projectId, relative.slice(5))
      : this.safe(path.join(this.project, relative));
    if (!statSync(file).isFile()) throw new Error("Not a file");
    return file;
  }
}

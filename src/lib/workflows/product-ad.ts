import {
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
  readdirSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ProductAdRequestSchema, type ProductAdRequest } from "../../types/workflow-product-ad";
import { ProjectConfigSchema } from "../../types/video";
import { hashFile, importAsset } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { TimelineEditStore } from "../timeline-ir/store";
import { compileTimelineIR } from "../timeline-ir/compiler";
import type { TimelineIR, TimelineClip } from "../../types/timeline";
import { planProjectRender } from "../render-plan";
import { captionCues, subtitleText } from "../captions/delivery";
import { CliErrorObject, assertPathWithin } from "../cli";
function syncTree(directory: string) {
  for (const item of readdirSync(directory, {
    withFileTypes: true,
  })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) syncTree(file);
    else {
      const fd = openSync(file, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  if (process.platform !== "win32") {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
const r = (num: number) => ({
  num,
  den: 1,
});
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
function failure(message: string): never {
  throw new CliErrorObject({
    code: "VALIDATION",
    message,
  });
}
function sourceFile(source: string, root: string, scopeRoot?: string) {
  const file = path.resolve(root, source);
  if (!existsSync(file) || !lstatSync(file).isFile())
    failure(`Required original file missing or not regular: ${source}`);
  const canonical = realpathSync(file);
  if (scopeRoot && !inside(realpathSync(scopeRoot), canonical)) failure("Source escapes the workflow authority scope");
  return canonical;
}
function inspectRequest(request: ProductAdRequest, root: string, scopeRoot?: string) {
  const media = new Map(
    request.media.map((item) => {
      const file = sourceFile(item.path, root, scopeRoot);
      if (hashFile(file) !== item.sha256) failure(`Source checksum changed: ${item.id}`);
      const inspected = inspectAsset(file);
      if (inspected.kind !== item.kind) failure(`Declared media kind differs from inspected bytes: ${item.id}`);
      return [
        item.id,
        {
          item,
          file,
          inspected,
        },
      ] as const;
    }),
  );
  const get = (id: string) => {
    const found = media.get(id);
    if (!found) failure(`Unknown media ID: ${id}`);
    return found;
  };
  const duration = request.beats.reduce((total, b) => total + b.durationFrames, 0);
  const checkRange = (id: string, start: number, frames: number, kind: "audio" | "video" | "image") => {
    const asset = get(id);
    if (asset.item.kind !== kind) failure(`Wrong media kind for ${id}; expected ${kind}`);
    if (kind !== "image" && (start + frames) / 30 > (asset.inspected.media.durationSec ?? 0) + 0.001)
      failure(`Selected source range exceeds ${id}`);
    return asset;
  };
  for (const claim of request.claims) {
    const file = sourceFile(claim.evidence.path, root, scopeRoot);
    if (lstatSync(file).size > 1024 * 1024) failure("Claim evidence text exceeds 1 MiB");
    if (hashFile(file) !== claim.evidence.sha256) failure(`Claim evidence checksum changed: ${claim.id}`);
    if (!readFileSync(file, "utf8").includes(claim.evidence.excerpt))
      failure(`Claim excerpt absent from evidence: ${claim.id}`);
  }
  const usedClaims = new Set<string>(),
    visuals = new Set<string>();
  for (const beat of request.beats) {
    const visual = get(beat.visual.mediaId);
    if (visual.item.kind === "audio") failure("Visual beats require original image/video");
    checkRange(visual.item.id, beat.visual.sourceStartFrame, beat.durationFrames, visual.item.kind);
    visuals.add(visual.item.id);
    if (visual.item.kind === "image" && beat.visual.sourceStartFrame !== 0)
      failure("Still images cannot have nonzero source offsets");
    const region = visual.item.criticalRegion;
    if (!region) failure(`Supply criticalRegion for multi-format crop review: ${visual.item.id}`);
    const w = visual.inspected.media.width!,
      h = visual.inspected.media.height!;
    for (const aspect of [9 / 16, 1, 16 / 9]) {
      const cropW = Math.min(1, (aspect * h) / w) / 1.08,
        cropH = Math.min(1, w / (aspect * h)) / 1.08;
      if (
        region.x < (1 - cropW) / 2 ||
        region.x + region.width > (1 + cropW) / 2 ||
        region.y < (1 - cropH) / 2 ||
        region.y + region.height > (1 + cropH) / 2
      )
        failure(`Critical product region would be cropped in a requested format: ${visual.item.id}`);
    }
    checkRange(beat.voice.mediaId, beat.voice.sourceStartFrame, beat.durationFrames, "audio");
    for (const id of beat.claimIds) {
      if (!request.claims.some((c) => c.id === id)) failure(`Unknown claim ID: ${id}`);
      const claim = request.claims.find((c) => c.id === id)!;
      const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
      if (
        !normalize([beat.headline, beat.subtext ?? "", beat.spokenText].join(" ")).includes(normalize(claim.statement))
      )
        failure(`Claim must actually appear in referenced beat copy: ${id}`);
      usedClaims.add(id);
    }
    if (beat.visual.interaction) {
      const i = beat.visual.interaction;
      if (
        visual.item.kind !== "video" ||
        i.startFrame < beat.visual.sourceStartFrame ||
        i.endFrame > beat.visual.sourceStartFrame + beat.durationFrames ||
        i.endFrame <= i.startFrame
      )
        failure("Actual interaction must be fully visible inside the selected original video range");
    }
  }
  if (visuals.size < 2) failure("Product advertising requires at least two distinct original visual assets");
  if (request.claims.some((c) => !usedClaims.has(c.id))) failure("Declared claims must be attached to concrete beats");
  const music = checkRange(request.music.mediaId, request.music.sourceStartFrame, duration, "audio");
  if (
    request.beats.some(
      (beat) =>
        get(beat.voice.mediaId).item.sha256 === music.item.sha256 &&
        beat.voice.sourceStartFrame + beat.durationFrames > request.music.sourceStartFrame &&
        beat.voice.sourceStartFrame < request.music.sourceStartFrame + duration,
    )
  )
    failure("Background music cannot duplicate overlapping original speech audio, including aliased media IDs");
  return {
    media,
    duration,
  };
}
/** Original inputs stay untouched; plan performs no writes, create commits one complete staged project. */
export function runProductAdWorkflow(
  raw: unknown,
  options: {
    action: "plan" | "create";
    rootDir?: string;
    scopeRoot?: string;
  },
): {
  outputs: string[];
  metadata: Record<string, unknown>;
} {
  const request = ProductAdRequestSchema.parse(raw),
    root = path.resolve(options.rootDir ?? process.cwd());
  if (!["plan", "create"].includes(options.action)) failure("Unknown workflow action");
  if (options.scopeRoot && !inside(realpathSync(options.scopeRoot), realpathSync(root)))
    failure("Workflow root escapes authority scope");
  const checked = inspectRequest(request, root, options.scopeRoot),
    destination = path.join(root, "public/projects", request.projectId);
  assertPathWithin(root, destination);
  if (options.action === "create" && existsSync(destination))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Workflow never overwrites an existing project",
    });
  const metadata = {
    workflow: "product-ad",
    projectId: request.projectId,
    durationFrames: checked.duration,
    formats: ["vertical", "square", "landscape"],
    variants: ["clean", "captioned"],
    productionReady: false,
    nextAction: "Review creative treatment, claims, original rights and all format crops before final delivery",
    sourceHashes: Object.fromEntries(request.media.map((m) => [m.id, m.sha256])),
    claimEvidence: request.claims,
    delivery: {
      usage: { advertising: true, endorsement: false, standaloneResale: false },
      declaredClaims: request.beats.flatMap((beat) =>
        beat.claimIds.map((id) => ({
          id: `${id}:${beat.id}`,
          text: request.claims.find((claim) => claim.id === id)!.statement,
          sceneId: beat.id,
        })),
      ),
      sources: request.claims.map((claim) => ({
        claimId: claim.id,
        ...claim.evidence,
      })),
    },
    approval: {
      status: "pending-human-review",
    },
    paidOperations: 0,
  };
  if (options.action === "plan")
    return {
      outputs: [],
      metadata: {
        ...metadata,
        dryRun: true,
        beats: request.beats,
      },
    };
  const projects = path.dirname(destination);
  assertPathWithin(root, projects);
  mkdirSync(projects, {
    recursive: true,
  });
  if (!inside(realpathSync(root), realpathSync(projects))) failure("Projects path escapes workspace");
  const lock = path.join(projects, `.${request.projectId}.workflow.lock`);
  const lockFd = openSync(lock, "wx", 0o600);
  let staging: string | undefined;
  try {
    if (existsSync(destination))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Project appeared while acquiring workflow ownership",
      });
    staging = mkdtempSync(path.join(root, ".workflow-product-ad-"));
    const project = path.join(staging, "public/projects", request.projectId);
    mkdirSync(path.join(project, "pipeline"), {
      recursive: true,
    });
    writeFileSync(
      path.join(project, "project.json"),
      JSON.stringify({
        name: request.productName,
        productName: request.productName,
        colors: request.style,
        scenes: [],
      }),
    );
    const imported = new Map<string, ReturnType<typeof importAsset>>();
    for (const { item, file } of checked.media.values()) {
      const result = importAsset({
        projectId: request.projectId,
        sourceFile: file,
        rootDir: staging,
        provenance: item.provenance,
        rights: item.rights,
      });
      if (result.asset.hash !== item.sha256) failure(`Source changed during creation: ${item.id}`);
      imported.set(item.id, result);
    }
    const clip = (
      id: string,
      assetId: string,
      start: number,
      offset: number,
      duration: number,
      payload?: Record<string, unknown>,
    ): TimelineClip => ({
      id,
      assetId,
      start: r(start),
      source: {
        start: r(offset),
        end: r(offset + duration),
        timebase: r(30),
      },
      rate: r(1),
      transition: {
        kind: "cut",
      },
      captions: [],
      payload,
    });
    const scenes: ReturnType<typeof ProjectConfigSchema.parse>["scenes"] = [],
      visualClips: TimelineClip[] = [],
      voiceClips: TimelineClip[] = [];
    let start = 0;
    for (const beat of request.beats) {
      const original = imported.get(beat.visual.mediaId)!.asset;
      let publicSource = original.files.original;
      if (original.kind === "video") {
        const excerpt = path.join(project, "assets", `${beat.id}.mp4`);
        mkdirSync(path.dirname(excerpt), {
          recursive: true,
        });
        const command = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            path.join(staging, "public", original.files.original),
            "-ss",
            String(beat.visual.sourceStartFrame / 30),
            "-t",
            String(beat.durationFrames / 30),
            "-an",
            "-vf",
            "fps=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            excerpt,
          ],
          {
            encoding: "utf8",
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          },
        );
        if (command.status !== 0 || command.error) failure(`Local demonstration excerpt failed: ${beat.id}`);
        const probe = inspectAsset(excerpt);
        if (Math.abs((probe.media.durationSec ?? 0) - beat.durationFrames / 30) > 0.04)
          failure("Demonstration excerpt does not cover every requested output frame");
        const derivative = importAsset({
          projectId: request.projectId,
          sourceFile: excerpt,
          rootDir: staging,
          rights: request.media.find((m) => m.id === beat.visual.mediaId)!.rights,
          provenance: {
            origin: "manual",
            tool: "local ffmpeg exact 30fps excerpt",
            referenceAssetIds: [original.id],
          },
        });
        publicSource = derivative.asset.files.original;
        unlinkSync(excerpt);
      }
      const scene = {
        id: beat.id,
        text: beat.spokenText,
        headline: beat.headline,
        subtext: beat.subtext,
        imageUrl: publicSource,
        visualType: original.kind === "video" ? ("video" as const) : ("photo" as const),
        durationInFrames: beat.durationFrames,
        transitionToNext: "cut" as const,
      };
      scenes.push(scene);
      visualClips.push(
        clip(beat.id, `scene:${beat.id}`, start, 0, beat.durationFrames, {
          scene,
        }),
      );
      const voice = clip(
        `${beat.id}-voice`,
        imported.get(beat.voice.mediaId)!.asset.id,
        start,
        beat.voice.sourceStartFrame,
        beat.durationFrames,
        {
          volume: 1,
        },
      );
      voice.captions = beat.voice.words.map((w, i) => ({
        id: `${beat.id}-word-${i}`,
        text: w.text,
        start: r(w.startFrame + beat.voice.sourceStartFrame),
        end: r(w.endFrame + beat.voice.sourceStartFrame),
      }));
      voiceClips.push(voice);
      start += beat.durationFrames;
    }
    const config = ProjectConfigSchema.parse({
      name: request.productName,
      productName: request.productName,
      tagline: request.cta.label,
      formats: ["vertical", "square", "landscape"],
      colors: request.style,
      musicVolume: request.music.volume,
      scenes,
    });
    writeFileSync(path.join(project, "project.json"), JSON.stringify(config, null, 2) + "\n");
    const timeline: TimelineIR = {
      version: 1,
      projectId: request.projectId,
      timebase: r(30),
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: visualClips,
        },
        {
          id: "voiceover",
          kind: "voiceover",
          clips: voiceClips,
        },
        {
          id: "music",
          kind: "music",
          clips: [
            clip(
              "music",
              imported.get(request.music.mediaId)!.asset.id,
              0,
              request.music.sourceStartFrame,
              checked.duration,
              {
                volume: request.music.volume,
              },
            ),
          ],
        },
      ],
    };
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize(timeline);
    if (compileTimelineIR(timeline).durationInFrames !== checked.duration)
      failure("Workflow output coverage differs from concrete beat timing");
    const frozenClaims = request.claims.map((claim) => {
      const evidenceDir = path.join(project, "assets/evidence");
      mkdirSync(evidenceDir, {
        recursive: true,
      });
      const file = path.join(evidenceDir, `${claim.evidence.sha256}.txt`);
      if (!existsSync(file)) copyFileSync(sourceFile(claim.evidence.path, root, options.scopeRoot), file);
      if (hashFile(file) !== claim.evidence.sha256) failure("Claim source changed while preserving evidence");
      return {
        ...claim,
        evidence: {
          ...claim.evidence,
          path: `projects/${request.projectId}/assets/evidence/${claim.evidence.sha256}.txt`,
        },
      };
    });
    writeFileSync(path.join(project, "pipeline/workflow-request.json"), JSON.stringify(request, null, 2) + "\n");
    writeFileSync(
      path.join(project, "pipeline/product-ad-evidence.json"),
      JSON.stringify(
        {
          ...metadata,
          claimEvidence: frozenClaims,
          delivery: {
            ...metadata.delivery,
            sources: frozenClaims.map((claim) => ({
              claimId: claim.id,
              ...claim.evidence,
            })),
          },
          beats: request.beats.map((b) => ({
            id: b.id,
            role: b.role,
            claimIds: b.claimIds,
            interaction: b.visual.interaction,
            framingNotes: b.framingNotes,
          })),
          sourceSelections: request.beats.map((b) => ({
            beatId: b.id,
            originalHash: request.media.find((m) => m.id === b.visual.mediaId)!.sha256,
            startFrame: b.visual.sourceStartFrame,
            endFrame: b.visual.sourceStartFrame + b.durationFrames,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    const cues = voiceClips.flatMap((voice) =>
      captionCues(
        {
          ...timeline,
          tracks: timeline.tracks.map((track) =>
            track.id === "voiceover"
              ? {
                  ...track,
                  clips: [voice],
                }
              : track,
          ),
        },
        {
          trackId: "voiceover",
        },
      ),
    );
    writeFileSync(path.join(project, "pipeline/captions.srt"), subtitleText(cues, "srt"));
    writeFileSync(path.join(project, "pipeline/captions.vtt"), subtitleText(cues, "vtt"));
    writeFileSync(
      path.join(project, "pipeline/workflow-render.json"),
      JSON.stringify({
        version: 1,
        workflow: "product-ad",
        projectId: request.projectId,
        timelineRequired: true,
      }) + "\n",
    );
    for (const captions of ["on", "off"] as const)
      planProjectRender(request.projectId, undefined, staging, {
        timeline: true,
        captions,
      });
    // Check evidence again immediately before publication; source/claim TOCTOU changes abort the entire stage.
    inspectRequest(request, root, options.scopeRoot);
    assertPathWithin(root, destination);
    if (existsSync(destination)) failure("Project appeared before atomic commit");
    syncTree(project);
    renameSync(project, destination);
    if (process.platform !== "win32") {
      const parent = openSync(projects, "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    return {
      outputs: [
        path.join(destination, "project.json"),
        path.join(destination, "pipeline/timeline-edit.json"),
        path.join(destination, "pipeline/product-ad-evidence.json"),
        path.join(destination, "pipeline/captions.srt"),
        path.join(destination, "pipeline/captions.vtt"),
      ],
      metadata: {
        ...metadata,
        dryRun: false,
        render: {
          timeline: true,
          clean: {
            captions: "off",
          },
          captioned: {
            captions: "on",
          },
        },
      },
    };
  } finally {
    if (staging)
      rmSync(staging, {
        recursive: true,
        force: true,
      });
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

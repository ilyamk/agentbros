import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EDUCATION_STAGES, EducationRequestSchema } from "../../types/workflow-education";
import { ProjectConfigSchema } from "../../types/video";
import { ChapterManifestSchema } from "../../types/longform";
import type { TimelineClip, TimelineIR } from "../../types/timeline";
import { importAsset, hashFile } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { TimelineEditStore } from "../timeline-ir/store";
import { validateTimeline } from "../timeline-ir/compiler";
import { stableHash } from "../longform/plans";
import { CliErrorObject } from "../cli";
const fail = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};
const within = (base: string, file: string) => {
  const p = path.relative(base, file);
  return !p || (!p.startsWith(`..${path.sep}`) && p !== ".." && !path.isAbsolute(p));
};
const r = (num: number) => ({ num, den: 1 });
const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
function unique(values: { id: string }[], label: string) {
  if (new Set(values.map((v) => v.id)).size !== values.length) fail(`Duplicate ${label} IDs`);
}
export function runEducationWorkflow(
  raw: unknown,
  options: { action: "plan" | "create"; rootDir?: string; scopeRoot?: string },
): { outputs: string[]; metadata: Record<string, unknown> } {
  const parsed = EducationRequestSchema.safeParse(raw);
  if (!parsed.success) return fail(`Invalid education request: ${parsed.error.message}`);
  const request = parsed.data,
    root = realpathSync(options.rootDir ?? process.cwd());
  if (options.action !== "plan" && options.action !== "create") fail("Invalid workflow action");
  const scope = options.scopeRoot ? realpathSync(options.scopeRoot) : undefined;
  if (scope && !within(scope, root)) fail("Workflow root escapes scopeRoot");
  unique(request.sources, "source");
  unique(request.claims, "claim");
  unique(request.media, "media");
  unique(request.chapters, "chapter");
  unique(
    request.chapters.flatMap((c) => c.beats),
    "beat",
  );
  if (new Set(request.formats).size !== request.formats.length) fail("Duplicate formats");
  let totalBytes = 0;
  const original = (file: string, sha: string, limit: number) => {
    let resolved: string;
    try {
      resolved = realpathSync(path.resolve(root, file));
    } catch {
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: "Workflow original input is missing",
      });
    }
    const localParts = path.relative(scope ?? root, resolved).split(path.sep);
    if (localParts.some((p) => p === ".git" || p === "node_modules" || p === ".cache" || p.startsWith(".env")))
      fail("Private/cache inputs are not workflow originals");
    if (scope && !within(scope, resolved)) fail("Original input escapes scopeRoot");
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) fail("Original input size/type rejected");
    totalBytes += stat.size;
    if (totalBytes > 1024 * 1024 * 1024) fail("Workflow input exceeds 1GiB");
    if (hashFile(resolved) !== sha) fail("Original input checksum mismatch");
    return resolved;
  };
  const sources = new Map(
    request.sources.map((s) => {
      const file = original(s.file, s.sha256, 2 * 1024 * 1024);
      if (!/\.(md|txt|json)$/i.test(file)) fail("Evidence must be a UTF-8 md/txt/json original");
      const bytes = readFileSync(file);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) fail("Evidence must be valid UTF-8");
      return [s.id, { ...s, file, text }];
    }),
  );
  const claims = new Map(request.claims.map((c) => [c.id, c]));
  for (const claim of request.claims) {
    if (claim.basis !== "direct" && !claim.uncertainty)
      fail("Inferred/illustrative/uncertain claims require explicit uncertainty");
    for (const evidence of claim.evidence) {
      const source = sources.get(evidence.sourceId);
      if (!source || !source.text.includes(evidence.excerpt))
        fail("Claim excerpt is absent from checksum-bound source");
    }
  }
  const media = new Map(
    request.media.map((m) => {
      const file = original(m.file, m.sha256, 256 * 1024 * 1024);
      const probe = inspectAsset(file);
      if (probe.kind !== m.kind) fail("Declared media kind differs from actual media");
      if (
        (probe.media.width ?? 0) > 8192 ||
        (probe.media.height ?? 0) > 8192 ||
        (probe.media.width ?? 0) * (probe.media.height ?? 0) > 33554432 ||
        (probe.media.durationSec ?? 0) > 7200
      )
        fail("Media decode dimensions/duration exceed workflow limits");
      return [m.id, { ...m, file, probe }];
    }),
  );
  const availableRefs = new Set<string>();
  for (const m of media.values()) {
    for (const ref of m.provenance.referenceAssetIds)
      if (!availableRefs.has(ref)) fail("Provenance reference must name a preceding immutable import");
    availableRefs.add(`sha256:${m.sha256}`);
  }
  const checkSpan = (id: string, start: number, duration: number, kind: "audio" | "visual", loop = false) => {
    const m = media.get(id);
    if (!m || (kind === "audio" ? m.kind !== "audio" : m.kind === "audio"))
      return fail("Missing or incompatible media reference");
    if (
      m.kind !== "image" &&
      (start / 30 >= (m.probe.media.durationSec ?? 0) ||
        (!loop && (start + duration) / 30 > (m.probe.media.durationSec ?? 0) + 0.001))
    )
      fail("Media source span exceeds original duration");
    return m;
  };
  const usedClaims = new Set<string>();
  let frames = 0;
  for (const chapter of request.chapters) {
    const context = new Set<string>();
    chapter.beats.forEach((beat, i) => {
      if (beat.stage !== EDUCATION_STAGES[i]) fail("Each chapter must preserve the six-stage learning order");
      checkSpan(beat.visualId, beat.visualStartFrame, beat.durationFrames, "visual");
      checkSpan(beat.voiceId, beat.sourceStartFrame, beat.durationFrames, "audio");
      for (const id of beat.claimIds) {
        const claim = claims.get(id);
        if (!claim) return fail("Unknown claim reference");
        usedClaims.add(id);
        if (!beat.spokenText.includes(claim.text))
          fail("Every referenced claim statement must occur verbatim in its owning spoken script");
        for (const line of [...claim.limitations, ...(claim.uncertainty ? [claim.uncertainty] : [])]) {
          context.add(line);
          if (!beat.spokenText.includes(line)) fail("Claim caveat must be spoken in its owning beat");
        }
      }
      beat.context.forEach((line) => {
        context.add(line);
        if (!beat.spokenText.includes(line)) fail("Context must occur verbatim in spoken script");
      });
      let previous = 0;
      for (const word of beat.captions) {
        if (word.startFrame < previous || word.endFrame <= word.startFrame || word.endFrame > beat.durationFrames)
          fail("Caption spans must be ordered, nonoverlapping and within beat");
        previous = word.endFrame;
      }
      if (normalize(beat.captions.map((w) => w.text).join(" ")) !== normalize(beat.spokenText))
        fail("Captions must match the supplied spoken script verbatim");
      frames += beat.durationFrames;
    });
    const recap = chapter.beats[5];
    for (const line of context)
      if (!recap.context.includes(line) || !recap.spokenText.includes(line))
        fail("Recap must carry chapter assumptions/caveats verbatim");
  }
  if (usedClaims.size !== claims.size) fail("Every supplied claim must be used by the lesson");
  if (frames > 30 * 1200) fail("Lesson exceeds the 20-minute workflow limit");
  if (new Set(request.chapters.flatMap((c) => c.beats.map((b) => media.get(b.visualId)!.sha256))).size < 2)
    fail("Lesson requires at least two distinct supplied visual originals");
  const music = checkSpan(request.music.mediaId, request.music.sourceStartFrame, frames, "audio", request.music.loop);
  const musicEnd = request.music.loop
    ? Math.floor(music.probe.media.durationSec! * 30)
    : request.music.sourceStartFrame + frames;
  for (const beat of request.chapters.flatMap((c) => c.beats))
    if (
      media.get(beat.voiceId)!.sha256 === music.sha256 &&
      beat.sourceStartFrame < musicEnd &&
      beat.sourceStartFrame + beat.durationFrames > request.music.sourceStartFrame
    )
      fail("Music overlaps original voiceover source; duplicate speech is forbidden");
  const build = (paths: Map<string, string>) => {
    const tracks: TimelineIR["tracks"] = [
      { id: "visual", kind: "visual", clips: [] },
      { id: "voiceover", kind: "voiceover", clips: [] },
      { id: "captions", kind: "captions", clips: [] },
      { id: "music", kind: "music", clips: [] },
    ];
    const scenes: EducationScene[] = [];
    let at = 0;
    const chapters = [];
    const protectedSpans = [];
    for (const chapter of request.chapters) {
      const chapterStart = at;
      for (const beat of chapter.beats) {
        const visual = media.get(beat.visualId)!;
        const scene = {
          id: beat.id,
          text: beat.spokenText,
          visualType: visual.kind === "video" ? ("video" as const) : ("photo" as const),
          headline: beat.headline,
          subtext: beat.context.join(" "),
          imageUrl: paths.get(beat.visualId),
          durationInFrames: beat.durationFrames,
          transitionToNext: "cut" as const,
        };
        scenes.push(scene);
        const clip = (id: string, assetId: string, start: number): TimelineClip => ({
          id,
          assetId,
          start: r(at),
          source: {
            start: r(start),
            end: r(start + beat.durationFrames),
            timebase: r(30),
          },
          rate: r(1),
          transition: { kind: "cut" },
          captions: [],
        });
        const lessonEvidenceHash = stableHash(
          beat.claimIds.map((id) => ({
            claim: claims.get(id),
            sources: claims.get(id)!.evidence.map((e) => request.sources.find((s) => s.id === e.sourceId)),
          })),
        );
        tracks[0].clips.push({
          ...clip(
            beat.id,
            visual.kind === "image" ? `scene:${beat.id}` : `sha256:${visual.sha256}`,
            visual.kind === "image" ? 0 : beat.visualStartFrame,
          ),
          payload: { scene, lessonEvidenceHash },
        });
        tracks[1].clips.push({
          ...clip(beat.id, `sha256:${media.get(beat.voiceId)!.sha256}`, beat.sourceStartFrame),
          payload: { volume: 1 },
        });
        tracks[2].clips.push({
          ...clip(beat.id, "caption:inline", 0),
          captions: beat.captions.map((w, i) => ({
            id: `${beat.id}-${i}`,
            text: w.text,
            start: r(w.startFrame),
            end: r(w.endFrame),
          })),
        });
        if (
          beat.context.length ||
          beat.stage === "recap" ||
          beat.claimIds.some((id) => claims.get(id)!.limitations.length || claims.get(id)!.uncertainty)
        )
          protectedSpans.push({
            id: `context-${beat.id}`,
            start: r(at),
            end: r(at + beat.durationFrames),
            reason: "claim-context" as const,
            requires: [],
            note: beat.context.join(" ") || "Preserve the complete sourced explanation",
          });
        at += beat.durationFrames;
      }
      chapters.push({
        id: chapter.id,
        title: chapter.title,
        revision: 1,
        start: r(chapterStart),
        end: r(at),
      });
    }
    tracks[3].clips.push({
      id: "music",
      assetId: `sha256:${media.get(request.music.mediaId)!.sha256}`,
      start: r(0),
      source: {
        start: r(request.music.sourceStartFrame),
        end: r(request.music.sourceStartFrame + at),
        timebase: r(30),
      },
      rate: r(1),
      transition: { kind: "cut" },
      captions: [],
      payload: { volume: request.music.volume, loop: request.music.loop },
    });
    return {
      project: ProjectConfigSchema.parse({
        name: request.title,
        productName: request.title,
        tagline: request.objective,
        formats: request.formats,
        colors: { accent: "#6C5CE7", background: "#F0F0F0", text: "#111111" },
        musicVolume: request.music.volume,
        musicPrompt: "Supplied original; generation disabled",
        scenes,
      }),
      timeline: validateTimeline({
        version: 1,
        projectId: request.projectId,
        timebase: r(30),
        tracks,
      }),
      manifest: ChapterManifestSchema.parse({
        version: 1,
        revision: 1,
        chapters,
        protectedSpans,
      }),
    };
  };
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
  };
  const paths = new Map(
    [...media].map(([id, m]) => [
      id,
      `projects/${request.projectId}/assets/imported/${m.sha256}.${extensions[m.probe.mime] ?? "bin"}`,
    ]),
  );
  const plan = build(paths);
  const metadata = {
    workflow: "source-backed-education",
    requestHash: stableHash(request),
    durationFrames: frames,
    durationSec: frames / 30,
    chapterCount: request.chapters.length,
    status: "draft-needs-source-creative-and-delivery-review",
    approvals: [],
    claims: request.claims,
    evidenceCheck: "sha256 and exact local excerpt; semantic truth unverified",
    captionCheck: "supplied script/timestamps; spoken recording content needs review",
    delivery: {
      formats: request.formats,
      language: request.language,
      title: request.title,
      declaredClaims: request.chapters.flatMap((c) =>
        c.beats.flatMap((b) =>
          b.claimIds.map((id) => ({
            id: `${id}:${b.id}`,
            text: b.spokenText,
            sceneId: b.id,
          })),
        ),
      ),
      claimSources: request.claims.map((claim) => ({
        id: claim.id,
        sourceUrls: claim.evidence.map((e) => sources.get(e.sourceId)!.url).filter(Boolean),
      })),
    },
    project: plan.project,
    timeline: plan.timeline,
    chapterManifest: plan.manifest,
  };
  if (options.action === "plan") return { outputs: [], metadata };
  const projects = path.join(root, "public/projects");
  let nearest = projects;
  while (!existsSync(nearest)) nearest = path.dirname(nearest);
  if (!within(root, realpathSync(nearest))) fail("Project destination symlink escapes root");
  mkdirSync(projects, { recursive: true });
  const final = path.join(projects, request.projectId);
  if (existsSync(final))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Education project already exists",
    });
  const stageRoot = path.join(projects, `.education-${randomUUID()}`),
    staged = path.join(stageRoot, "public/projects", request.projectId),
    lock = path.join(projects, `.${request.projectId}.workflow.lock`);
  const fd = openSync(lock, "wx", 0o600);
  let reserved = false,
    published = false;
  try {
    mkdirSync(path.join(staged, "pipeline"), { recursive: true });
    writeFileSync(path.join(staged, "project.json"), JSON.stringify(plan.project), { flag: "wx" });
    for (const [id, m] of media) {
      const imported = importAsset({
        projectId: request.projectId,
        sourceFile: m.file,
        provenance: m.provenance,
        rights: m.rights,
        rootDir: stageRoot,
      });
      if (imported.asset.hash !== m.sha256) fail("Original changed during import");
      paths.set(id, imported.asset.files.original);
    }
    const actual = build(paths);
    writeFileSync(path.join(staged, "project.json"), JSON.stringify(actual.project, null, 2));
    new TimelineEditStore(path.join(staged, "pipeline/timeline-edit.json")).initialize(actual.timeline);
    writeFileSync(
      path.join(staged, "pipeline/workflow-render.json"),
      JSON.stringify({
        version: 1,
        workflow: "education",
        projectId: request.projectId,
        timelineRequired: true,
      }),
      { flag: "wx" },
    );
    writeFileSync(path.join(staged, "pipeline/chapters.json"), JSON.stringify(actual.manifest, null, 2), {
      flag: "wx",
    });
    mkdirSync(path.join(staged, "pipeline/evidence"));
    for (const s of sources.values()) {
      const dest = path.join(staged, "pipeline/evidence", `${s.id}${path.extname(s.file).toLowerCase()}`);
      copyFileSync(s.file, dest);
      if (hashFile(dest) !== s.sha256) fail("Evidence changed during copy");
    }
    writeFileSync(
      path.join(staged, "pipeline/education.json"),
      JSON.stringify(
        {
          version: 1,
          ...metadata,
          request,
          evidenceFiles: [...sources.values()].map((s) => ({
            id: s.id,
            sha256: s.sha256,
            file: `pipeline/evidence/${s.id}${path.extname(s.file).toLowerCase()}`,
          })),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    // Exclusive reservation prevents replacing even an empty project. project.json is the final commit marker.
    mkdirSync(final);
    reserved = true;
    for (const child of ["assets", "pipeline", "project.json"])
      renameSync(path.join(staged, child), path.join(final, child));
    published = true;
    return {
      outputs: ["project.json", "pipeline/timeline-edit.json", "pipeline/chapters.json", "pipeline/education.json"].map(
        (f) => path.join(final, f),
      ),
      metadata: {
        ...metadata,
        project: actual.project,
        timeline: actual.timeline,
        chapterManifest: actual.manifest,
      },
    };
  } finally {
    if (reserved && !published) rmSync(final, { recursive: true, force: true });
    rmSync(stageRoot, { recursive: true, force: true });
    closeSync(fd);
    unlinkSync(lock);
  }
}
type EducationScene = ReturnType<typeof ProjectConfigSchema.parse>["scenes"][number];

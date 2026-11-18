import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashFile } from "../assets/registry";
import { mediaProbe } from "../audio/analysis";
import { TranslationSchema } from "../../types/campaigns";
import { ProjectConfigSchema } from "../../types/video";
import { stableHash } from "../longform/plans";
import { compileTimeline } from "../timeline";
import { assertDubbingSnapshot } from "../elevenlabs/dubbing";
import { studioPath } from "../elevenlabs/files";
export function planLocalization(
  projectInput: unknown,
  translationInput: unknown,
  options: { sceneDurationFrames?: Record<string, number> } = {},
) {
  const project = ProjectConfigSchema.parse(projectInput);
  const translation = TranslationSchema.parse(translationInput);
  if (translation.projectId === translation.sourceProjectId) throw new Error("Localization requires a new project ID");
  const supplied = new Map(translation.scenes.map((scene) => [scene.id, scene]));
  if (
    supplied.size !== translation.scenes.length ||
    supplied.size !== project.scenes.length ||
    project.scenes.some((scene) => !supplied.has(scene.id))
  )
    throw new Error("Supply exactly one translation for every scene");
  const audioStale =
    translation.sourceLanguage !== translation.targetLanguage ||
    project.scenes.some((scene) => scene.text !== supplied.get(scene.id)!.text) ||
    project.voice !== translation.voice;
  const output = structuredClone(project);
  output.name = `${project.name} (${translation.targetLanguage})`;
  output.voice = translation.voice;
  const timedScenes = project.scenes.map((scene) => {
    const duration = options.sceneDurationFrames?.[scene.id];
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1))
      throw new Error("Localisation duration must be positive integer frames");
    return duration === undefined ? scene : { ...scene, durationInFrames: duration };
  });
  if (
    options.sceneDurationFrames &&
    Object.keys(options.sceneDurationFrames).some((id) => !project.scenes.some((scene) => scene.id === id))
  )
    throw new Error("Localisation duration names an absent scene");
  const timing = compileTimeline(timedScenes, {
    fps: 30,
    talkingHead: project.talkingHead?.enabled ?? false,
  });
  output.scenes = timedScenes.map((scene, index) => {
    const localized = supplied.get(scene.id)!;
    const wordCount = localized.text.trim() ? localized.text.trim().split(/\s+/u).length : 0;
    const availableSec = timing.entries[index].durationInFrames / 30;
    if (wordCount > Math.floor(availableSec * translation.wordsPerSecond))
      throw new Error(`Translated word budget exceeds scene: ${scene.id}`);
    // Only supplied strings are substituted; no automatic semantic translation.
    const replacements = new Map<string, string>(
      [
        [scene.text, localized.text] as [string, string],
        [scene.headline ?? "", localized.headline] as [string, string],
        ...(localized.subtext !== undefined ? [[scene.subtext ?? "", localized.subtext] as [string, string]] : []),
        ...Object.entries(localized.labels),
      ].filter(([original]) => original.length > 0),
    );
    const patch = (value: unknown): unknown =>
      typeof value === "string"
        ? (replacements.get(value) ?? value)
        : Array.isArray(value)
          ? value.map(patch)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  ["id", "kind", "source", "imageUrl", "videoUrl", "url", "assetId", "fontFamily", "color"].includes(
                    key,
                  )
                    ? item
                    : patch(item),
                ]),
              )
            : value;
    const updated = {
      ...scene,
      text: localized.text,
      headline: localized.headline,
      ...(localized.subtext !== undefined ? { subtext: localized.subtext } : {}),
    };
    if (updated.leftPanel) updated.leftPanel = patch(updated.leftPanel) as typeof updated.leftPanel;
    if (updated.template) updated.template = patch(updated.template) as typeof updated.template;
    return updated;
  });
  if (audioStale && output.talkingHead?.enabled)
    output.talkingHead.presenterVideo = `projects/${translation.projectId}/talking-head/full.mp4`;
  return {
    version: 1,
    project: output,
    sourceHash: stableHash(project),
    translation,
    audioStale,
    alignmentStale: true,
    timestampReuse: false,
    productionReady: false,
    generationRequests: 0,
  };
}
export function createLocalizedProject(
  raw: unknown,
  rootDir = process.cwd(),
  options: { sceneDurationFrames?: Record<string, number> } = {},
) {
  const translation = TranslationSchema.parse(raw);
  const source = path.join(rootDir, "public/projects", translation.sourceProjectId, "project.json");
  const plan = planLocalization(JSON.parse(readFileSync(source, "utf8")), translation, options);
  const target = path.join(rootDir, "public/projects", translation.projectId);
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(target); // Exclusive directory creation refuses existing projects.
  try {
    mkdirSync(path.join(target, "pipeline"));
    writeFileSync(path.join(target, "pipeline/localization.json"), JSON.stringify(plan, null, 2) + "\n", {
      flag: "wx",
    });
    writeFileSync(path.join(target, "project.json"), JSON.stringify(plan.project, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    rmSync(target, { recursive: true });
    throw error;
  }
  return { outputs: [path.join(target, "project.json")], plan };
}
/** New localized drafts require replacement/alignment review before production rendering. */
export function assertLocalizationReady(projectDir: string) {
  const file = path.join(projectDir, "pipeline/localization.json");
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.review?.dubbing) {
    const root = path.resolve(projectDir, "../../..");
    const selected = assertDubbingSnapshot(root, state.review.dubbing.binding, state.review.dubbing.language);
    if (selected.sha256 !== state.review.dubbing.sha256 || selected.selectedRevision !== state.review.dubbing.revision)
      throw new Error("Reviewed dubbing snapshot changed");
  }
  if (
    !state.review ||
    !state.review.reviewedBy ||
    !state.review.evidence ||
    state.review.projectHash !== stableHash(JSON.parse(readFileSync(path.join(projectDir, "project.json"), "utf8")))
  )
    throw new Error("Localized project requires a matching supplied review");
  for (const item of [...state.review.audio, ...state.review.alignments]) {
    const target = safeReviewFile(projectDir, item.file);
    if (
      !state.review.dubbing &&
      state.review.audio.some((audio: { file: string }) => audio.file === item.file) &&
      existsSync(`${target}.dubbing-source.json`)
    )
      throw new Error("Conformed dubbed audio requires a reviewed dubbing binding");
    if (hashFile(target) !== item.hash) throw new Error("Reviewed localized media changed");
  }
  if (state.productionReady !== true || state.audioStale !== false || state.alignmentStale !== false)
    throw new Error("Localized project audio/alignment needs an explicit reviewed repair before production render");
}

function safeReviewFile(projectDir: string, file: string) {
  const target = path.resolve(projectDir, file);
  const relative = path.relative(realpathSync(projectDir), realpathSync(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Reviewed media must be inside localized project");
  return target;
}
export function reviewLocalization(
  projectDir: string,
  input: {
    reviewedBy: string;
    evidence: string;
    expectedSourceHash: string;
    audio: string[];
    alignments: string[];
    dubbing?: { binding: string; language: string };
  },
) {
  if (!input.reviewedBy.trim() || !input.evidence.trim()) throw new Error("Explicit supplied review is required");
  const file = path.join(projectDir, "pipeline/localization.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.sourceHash !== input.expectedSourceHash) throw new Error("Localization source hash changed");
  const project = ProjectConfigSchema.parse(JSON.parse(readFileSync(path.join(projectDir, "project.json"), "utf8")));
  const root = path.resolve(projectDir, "../../..");
  const dubbed = input.dubbing ? assertDubbingSnapshot(root, input.dubbing.binding, input.dubbing.language) : undefined;
  if (input.dubbing && input.dubbing.language !== state.translation.targetLanguage)
    throw new Error("Dubbing language differs from the localisation target");
  const hasSpeech = project.scenes.some((scene) => scene.text.trim().length > 0);
  if ((hasSpeech || project.talkingHead?.enabled) && input.audio.length === 0)
    throw new Error("Replacement audio must be supplied and reviewed");
  if (hasSpeech && input.alignments.length === 0) throw new Error("New alignment must be supplied and reviewed");
  const spokenScenes = project.scenes.filter((scene) => scene.text.trim());
  const embedded = project.talkingHead?.enabled && project.talkingHead.audioSource === "embedded";
  const presenter = project.talkingHead?.presenterVideo;
  const prefix = `projects/${path.basename(projectDir)}/`;
  const requiredAudio = embedded
    ? presenter?.startsWith(prefix)
      ? [presenter.slice(prefix.length)]
      : (() => {
          throw new Error("Localized presenter must use this project's replacement file");
        })()
    : spokenScenes.map((scene) => `voiceover/${scene.id}.mp3`);
  for (const file of requiredAudio)
    if (!input.audio.includes(file)) throw new Error(`Review the actual renderer audio file: ${file}`);
  for (const scene of spokenScenes)
    if (
      !input.alignments.includes(`voiceover/${scene.id}.words.json`) &&
      !input.alignments.includes(`voiceover/${scene.id}.words.edited.json`)
    )
      throw new Error(`Review alignment for scene: ${scene.id}`);
  const audioDurations = new Map<string, number>();
  const audio = input.audio.map((file) => {
    const target = safeReviewFile(projectDir, file);
    const measured = mediaProbe(target);
    audioDurations.set(file, Number(measured.format.duration));
    if (!measured.streams.some((stream) => stream.codec_type === "audio"))
      throw new Error("Replacement media has no audio stream");
    return { file, hash: hashFile(target) };
  });
  if (!input.dubbing && audio.some((item) => existsSync(path.join(projectDir, `${item.file}.dubbing-source.json`))))
    throw new Error("Conformed dubbed audio requires its selected dubbing binding for localisation review");
  if (dubbed)
    for (const item of audio) {
      if (item.hash === dubbed.sha256) continue;
      const receiptFile = safeReviewFile(projectDir, `${item.file}.dubbing-source.json`);
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (
        receipt.sourceSha256 !== dubbed.sha256 ||
        receipt.sha256 !== item.hash ||
        receipt.language !== input.dubbing!.language
      )
        throw new Error("Renderer audio is unrelated to the selected dub; conform explicit reviewed spans first");
    }
  const alignments = input.alignments.map((file) => {
    const target = safeReviewFile(projectDir, file);
    const rawWords = JSON.parse(readFileSync(target, "utf8"));
    const words = Array.isArray(rawWords) ? rawWords : rawWords.words;
    if (
      !Array.isArray(words) ||
      (hasSpeech && words.length === 0) ||
      words.some(
        (word) =>
          typeof word.text !== "string" ||
          !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) ||
          word.start < 0 ||
          word.end <= word.start,
      )
    )
      throw new Error("Supply valid new word alignments");
    const scene = spokenScenes.find(
      (scene) => file === `voiceover/${scene.id}.words.json` || file === `voiceover/${scene.id}.words.edited.json`,
    );
    if (scene && !Array.isArray(rawWords) && rawWords.sourceSha256) {
      const rendererFile = embedded ? requiredAudio[0]! : `voiceover/${scene.id}.mp3`;
      if (rawWords.sourceSha256 !== audio.find((item) => item.file === rendererFile)?.hash)
        throw new Error("Word timing source hash differs from renderer audio");
    }
    if (scene) {
      const limitSec = embedded
        ? compileTimeline(project.scenes, {
            fps: 30,
            talkingHead: true,
          }).entries.find((entry) => entry.scene.id === scene.id)!.durationInFrames / 30
        : audioDurations.get(`voiceover/${scene.id}.mp3`)!;
      if (
        words.some((word, index) => word.end > limitSec + 1 / 30 || (index > 0 && word.start < words[index - 1].start))
      )
        throw new Error("New alignment exceeds reviewed audio/window or is unordered");
    }
    const normalized = (text: string) =>
      text
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/[\p{P}\p{S}]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
    if (scene && normalized(words.map((word) => word.text).join(" ")) !== normalized(scene.text))
      throw new Error("Reviewed alignment text differs from supplied translated speech");
    return { file, hash: hashFile(target) };
  });
  const next = {
    ...state,
    audioStale: false,
    alignmentStale: false,
    productionReady: true,
    review: {
      reviewedBy: input.reviewedBy,
      evidence: input.evidence,
      projectHash: stableHash(project),
      audio,
      alignments,
      reviewedAt: new Date().toISOString(),
      ...(input.dubbing && dubbed
        ? {
            dubbing: {
              binding: path.relative(root, studioPath(root, input.dubbing.binding)),
              language: input.dubbing.language,
              revision: dubbed.selectedRevision,
              sha256: dubbed.sha256,
            },
          }
        : {}),
    },
  };
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", {
    flag: "wx",
  });
  renameSync(temporary, file);
  return next;
}

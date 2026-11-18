import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getInfo as bebasNeue } from "@remotion/google-fonts/BebasNeue";
import { getInfo as dmSans } from "@remotion/google-fonts/DMSans";
import { getInfo as golosText } from "@remotion/google-fonts/GolosText";
import { getInfo as inter } from "@remotion/google-fonts/Inter";
import { getInfo as montserrat } from "@remotion/google-fonts/Montserrat";
import { getInfo as oswald } from "@remotion/google-fonts/Oswald";
import { getInfo as playfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { getInfo as rubik } from "@remotion/google-fonts/Rubik";
import { getInfo as sofiaSansExtraCondensed } from "@remotion/google-fonts/SofiaSansExtraCondensed";
import { getInfo as spaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { getInfo as unbounded } from "@remotion/google-fonts/Unbounded";
import type { z } from "zod";
import { ConceptSchema, MotionPlanSchema, type Concept, type MotionPlan } from "../../types/creative";
import { DEFAULT_LIBRARY_ROOT, readLayer, referenceDirectory } from "../reference/library";
import { checkFadedFinal, FADE_LOOKBACK_FRAMES, measurePixels, type FramePixels } from "../sensors/pixels";
import { checkVisualReviews, hashRenderFile } from "../vision/reviews";

export const CREATIVE_FINDING_CODES = [
  "CONCEPT_MISSING",
  "MOTION_PLAN_MISSING",
  "PRODUCT_MATERIAL_MISSING",
  "FONT_GLYPHS_MISSING",
  "SCRIPT_TEXT_LOST",
  "FINAL_FRAME_FADED",
  "VISUAL_REVIEW_MISSING",
  "REVIEW_STALE",
  "BLUEPRINT_INVALID",
] as const;

export type CreativeFindingCode = (typeof CREATIVE_FINDING_CODES)[number];

/** Same shape as `Finding` in scripts/pipeline-check.ts, which cannot be imported without running that script. That shape has no fix field, so each message ends with the instruction. */
export type CreativeFinding = {
  severity: "error" | "warning" | "info";
  code: CreativeFindingCode;
  stage?: string;
  message: string;
  ref?: { file: string; jsonPath?: string };
};

export type CreativeCheckOptions = {
  /** Repository root that `render-status.json` outputs and the reference library resolve against. Defaults to the working directory. */
  rootDir?: string;
  libraryRoot?: string;
  /** The render to judge, in place of the one `render-status.json` names. */
  renderFile?: string;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// --- Artefacts ---

export type Artefact<T> =
  { state: "absent" } | { state: "legacy" } | { state: "invalid"; reason: string } | { state: "valid"; value: T };

/**
 * A motion-plan.json without `schemaVersion` predates MotionPlanSchema: older projects have one, written by hand.
 * It says nothing about this contract unless the project chose bespoke rendering.
 */
function readArtefact<T>(file: string, schema: z.ZodType<T>, bespoke: boolean, mayBeLegacy: boolean): Artefact<T> {
  if (!existsSync(file)) return { state: "absent" };
  const raw = readJson(file);
  if (mayBeLegacy && !bespoke && !(isObject(raw) && raw["schemaVersion"] !== undefined)) return { state: "legacy" };
  if (raw === undefined) return { state: "invalid", reason: "it is not valid JSON" };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { state: "valid", value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    state: "invalid",
    reason: `${issue?.path.join(".") || "root"}: ${issue?.message ?? "does not match the schema"}`,
  };
}

const value = <T>(artefact: Artefact<T>): T | undefined => (artefact.state === "valid" ? artefact.value : undefined);

// --- Concept and motion plan ---

export function checkConcept(
  concept: Artefact<Concept>,
  bespoke: boolean,
  scriptDone: boolean,
  file: string,
): CreativeFinding[] {
  if (!scriptDone) return [];
  if (concept.state === "absent" && bespoke)
    return [
      {
        severity: "error",
        code: "CONCEPT_MISSING",
        stage: "script",
        message:
          "The script stage is done but pipeline/concept.json is absent. Fix: write the concept with at least three candidates and the selected one (ConceptSchema), before the script is approved.",
        ref: { file },
      },
    ];
  if (concept.state === "invalid")
    return [
      {
        severity: "error",
        code: "CONCEPT_MISSING",
        stage: "script",
        message: `pipeline/concept.json does not count: ${concept.reason}. Fix: correct it against ConceptSchema in src/types/creative.ts.`,
        ref: { file },
      },
    ];
  return [];
}

export function checkMotionPlan(
  plan: Artefact<MotionPlan>,
  bespoke: boolean,
  storyboardDone: boolean,
  file: string,
): CreativeFinding[] {
  if (!storyboardDone) return [];
  if (plan.state === "absent" && bespoke)
    return [
      {
        severity: "error",
        code: "MOTION_PLAN_MISSING",
        stage: "storyboard",
        message:
          "The storyboard stage is done but pipeline/motion-plan.json is absent. Fix: write the shot plan (MotionPlanSchema) before any scene code.",
        ref: { file },
      },
    ];
  if (plan.state === "invalid")
    return [
      {
        severity: "error",
        code: "MOTION_PLAN_MISSING",
        stage: "storyboard",
        message: `pipeline/motion-plan.json does not count: ${plan.reason}. Fix: correct it against MotionPlanSchema in src/types/creative.ts.`,
        ref: { file },
      },
    ];
  return [];
}

// --- Product material ---

/** `productName` is required by BriefSchema, so a brief that is not about a product says so with one of these. */
const NO_PRODUCT = /^(none|n\/?a|-+|—|нет)$/i;
/** Technique cards whose whole point is to show captured interface material. */
const REAL_MATERIAL_TECHNIQUES = new Set(["real-interface-playback"]);

export const isProductBrief = (brief: unknown): boolean => {
  const name = isObject(brief) ? text(brief["productName"]) : undefined;
  return Boolean(name && !NO_PRODUCT.test(name.trim()));
};

export const shotShowsRealMaterial = (shot: MotionPlan["shots"][number], sources: readonly string[]): boolean =>
  shot.route === "footage" ||
  shot.techniqueIds.some((id) => REAL_MATERIAL_TECHNIQUES.has(id)) ||
  sources.some((source) => shot.subject.includes(source));

export function checkProductMaterial(input: {
  brief: unknown;
  concept?: Concept;
  plan?: MotionPlan;
  scriptDone: boolean;
  storyboardDone: boolean;
  conceptFile: string;
  planFile: string;
}): CreativeFinding[] {
  const { brief, concept, plan, scriptDone, storyboardDone, conceptFile, planFile } = input;
  if (!isProductBrief(brief)) return [];
  const product = isObject(brief) ? text(brief["productName"]) : "";
  const findings: CreativeFinding[] = [];
  const noSubject = `If the film is not about a product, set brief.productName to "none".`;
  if (scriptDone && concept && !concept.productTruth.sources.length)
    findings.push({
      severity: "error",
      code: "PRODUCT_MATERIAL_MISSING",
      stage: "script",
      message: `The brief is about ${product} but concept.productTruth.sources is empty, so every claim is unsupported. Fix: list the real captures, documents or URLs the film draws on, or ask the user for them. ${noSubject}`,
      ref: { file: conceptFile, jsonPath: "productTruth.sources" },
    });
  if (
    storyboardDone &&
    plan &&
    !plan.shots.some((shot) => shotShowsRealMaterial(shot, concept?.productTruth.sources ?? []))
  )
    findings.push({
      severity: "error",
      code: "PRODUCT_MATERIAL_MISSING",
      stage: "storyboard",
      message: `The brief is about ${product} but no shot in the plan shows the real product. Fix: add a shot with route "footage", or technique "real-interface-playback", or name a productTruth source in its subject. ${noSubject}`,
      ref: { file: planFile, jsonPath: "shots" },
    });
  return findings;
}

// --- Font glyphs ---

type UnicodeInfo = { fontFamily: string; unicodeRanges: Record<string, string> };

/** Design token to face and the subsets its loader asks for. Mirrors src/lib/fonts.ts and fonts-cyrillic.ts, which cannot be imported here because they load fonts. tests/creative-checks.test.ts compares them. */
export const FONT_TOKEN_FACES: Record<
  string,
  { exportName: string; getInfo: () => UnicodeInfo; subsets: readonly string[] }
> = {
  primary: { exportName: "primaryFont", getInfo: inter, subsets: ["latin", "cyrillic"] },
  display: { exportName: "displayFont", getInfo: spaceGrotesk, subsets: ["latin"] },
  condensed: { exportName: "condensedFont", getInfo: bebasNeue, subsets: ["latin"] },
  serif: { exportName: "serifFont", getInfo: playfairDisplay, subsets: ["latin", "cyrillic"] },
  rounded: { exportName: "roundedFont", getInfo: dmSans, subsets: ["latin"] },
  narrow: { exportName: "narrowFont", getInfo: oswald, subsets: ["latin", "cyrillic"] },
  geometric: { exportName: "geometricFont", getInfo: montserrat, subsets: ["latin", "cyrillic"] },
  "cyrillic-condensed": {
    exportName: "cyrillicCondensedFont",
    getInfo: sofiaSansExtraCondensed,
    subsets: ["latin", "cyrillic"],
  },
  "cyrillic-wide": { exportName: "cyrillicWideFont", getInfo: unbounded, subsets: ["latin", "cyrillic"] },
  "cyrillic-grotesk": { exportName: "cyrillicGroteskFont", getInfo: golosText, subsets: ["latin", "cyrillic"] },
  "cyrillic-rounded": { exportName: "cyrillicRoundedFont", getInfo: rubik, subsets: ["latin", "cyrillic"] },
};

export function parseUnicodeRanges(ranges: string): Array<[number, number]> {
  return ranges.split(",").flatMap((part) => {
    const match = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (!match) return [];
    const low = match[1]!;
    return [
      [Number.parseInt(low.replaceAll("?", "0"), 16), Number.parseInt(match[2] ?? low.replaceAll("?", "F"), 16)] as [
        number,
        number,
      ],
    ];
  });
}

const coverageCache = new Map<string, Array<[number, number]>>();

function coverageOf(token: string): Array<[number, number]> {
  const cached = coverageCache.get(token);
  if (cached) return cached;
  const face = FONT_TOKEN_FACES[token]!;
  const { unicodeRanges } = face.getInfo();
  const coverage = face.subsets.flatMap((subset) => parseUnicodeRanges(unicodeRanges[subset] ?? ""));
  coverageCache.set(token, coverage);
  return coverage;
}

/** Characters of `copy` outside the subsets the token loads. Spaces, combining marks and emoji are not the font's job. Subset ranges are an upper bound: a face can lack a code point inside a range. */
export function missingGlyphs(copy: string, token: string): string[] {
  const coverage = coverageOf(token);
  const missing = new Set<string>();
  for (const character of copy.normalize("NFC")) {
    if (/[\s\p{M}\p{C}\p{Extended_Pictographic}]/u.test(character)) continue;
    const code = character.codePointAt(0)!;
    if (!coverage.some(([low, high]) => code >= low && code <= high)) missing.add(character);
  }
  return [...missing];
}

export type ScreenLine = { text: string; setIn: "display" | "body" | "either"; where: string };

const familyOf = (token: string) => FONT_TOKEN_FACES[token]!.getInfo().fontFamily;
const sample = (items: string[]) => items.slice(0, 12).join("");

/**
 * design.json holds one display and one body font. Headlines take the first and subtext the second.
 * A plan's copy does not record its face: it is an error only if neither font can set it.
 */
export function checkFontGlyphs(
  fonts: readonly string[],
  lines: readonly ScreenLine[],
  file: string,
): CreativeFinding[] {
  const known = fonts.filter((token) => token in FONT_TOKEN_FACES);
  if (!known.length) return [];
  const groups = new Map<
    string,
    { severity: "error" | "warning"; tokens: string[]; characters: Set<string>; lines: string[] }
  >();
  const add = (severity: "error" | "warning", tokens: string[], characters: string[], line: ScreenLine) => {
    const key = `${severity}|${tokens.join()}`;
    const group = groups.get(key) ?? { severity, tokens, characters: new Set<string>(), lines: [] };
    for (const character of characters) group.characters.add(character);
    group.lines.push(line.where);
    groups.set(key, group);
  };
  for (const line of lines) {
    const faces = line.setIn === "display" ? [known[0]!] : line.setIn === "body" ? [known[1] ?? known[0]!] : known;
    const missing = faces.map((token) => ({ token, characters: missingGlyphs(line.text, token) }));
    const everywhere = missing[0]!.characters.filter((character) =>
      missing.every((face) => face.characters.includes(character)),
    );
    if (everywhere.length) add("error", faces, everywhere, line);
    else for (const face of missing) if (face.characters.length) add("warning", [face.token], face.characters, line);
  }
  return [...groups.values()].map((group) => {
    const characters = [...group.characters];
    const able = Object.keys(FONT_TOKEN_FACES).filter((token) =>
      characters.every((character) => !missingGlyphs(character, token).length),
    );
    const names = group.tokens.map((token) => `${token} (${familyOf(token)})`).join(" and ");
    const consequence =
      group.severity === "error"
        ? "They will render in a fallback font"
        : "Any line set in it will fall back, and the plan does not record which face sets each line";
    return {
      severity: group.severity,
      code: "FONT_GLYPHS_MISSING" as const,
      stage: "design",
      message: `On-screen copy uses "${sample(characters)}", which ${names} cannot set with the subsets it loads (${group.lines.slice(0, 4).join(", ")}). ${consequence}. Fix: choose a font token that covers them: ${able.join(", ") || "none of the known tokens do, so change the copy or import a font"}.`,
      ref: { file, jsonPath: "fonts" },
    };
  });
}

// --- Text kept from script to screen ---

export const normaliseCopy = (copy: string): string =>
  copy
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const screenHas = (screen: string, line: string) => ` ${screen} `.includes(` ${normaliseCopy(line)} `);

export function storyboardScreenLines(storyboard: unknown): ScreenLine[] {
  if (!isObject(storyboard)) return [];
  return list(storyboard["scenes"]).flatMap((scene, index) => {
    if (!isObject(scene)) return [];
    const id = text(scene["id"]) ?? String(index);
    const headline = text(scene["headline"]);
    const subtext = text(scene["subtext"]);
    // `onScreenText` is an optional storyboard field for copy beyond the headline and subtext.
    const extra = list(scene["onScreenText"]).flatMap((item) => (text(item) ? [item as string] : []));
    return [
      ...(headline ? [{ text: headline, setIn: "display" as const, where: `storyboard ${id}` }] : []),
      ...(subtext ? [{ text: subtext, setIn: "body" as const, where: `storyboard ${id}` }] : []),
      ...extra.map((item) => ({ text: item, setIn: "either" as const, where: `storyboard ${id}` })),
    ];
  });
}

export function planScreenLines(plan: MotionPlan | undefined): ScreenLine[] {
  return (plan?.onScreenCopy ?? []).map((item) => ({
    text: item.text,
    setIn: "either" as const,
    where: `shot ${item.shotId}`,
  }));
}

/**
 * Approved lines are the tagline, the call to action and the sign-off. Beat text is voiceover, so it need not be on screen.
 * Screen text joins every item in order, because one line is often split across shots.
 */
export function checkScriptText(input: {
  brief: unknown;
  script: unknown;
  storyboard: unknown;
  plan?: MotionPlan;
  storyboardFile: string;
  planFile: string;
}): CreativeFinding[] {
  const { brief, script, storyboard, plan, storyboardFile, planFile } = input;
  const boardLines = storyboardScreenLines(storyboard);
  const board = normaliseCopy(boardLines.map((line) => line.text).join(" "));
  const shotIds = new Set(plan?.shots.map((shot) => shot.id));
  const attached = plan?.onScreenCopy.filter((item) => shotIds.has(item.shotId)) ?? [];
  const screen = normaliseCopy(
    [...attached.map((item) => item.text), ...boardLines.map((line) => line.text)].join(" "),
  );
  const briefField = (key: string) => (isObject(brief) ? text(brief[key]) : undefined);
  const approved = [
    { label: "call to action", line: briefField("callToAction"), file: "brief.callToAction" },
    { label: "tagline", line: briefField("tagline"), file: "brief.tagline" },
    { label: "sign-off", line: isObject(script) ? text(script["signOff"]) : undefined, file: "script.signOff" },
  ];
  const findings: CreativeFinding[] = [];
  const reported = new Set<string>();
  for (const { label, line, file } of approved)
    if (
      line &&
      normaliseCopy(line) &&
      !screenHas(screen, line) &&
      !reported.has(normaliseCopy(line)) &&
      reported.add(normaliseCopy(line))
    )
      findings.push({
        severity: "error",
        code: "SCRIPT_TEXT_LOST",
        stage: "storyboard",
        message: `The approved ${label} "${line}" (${file}) is not in the screen text of the plan or storyboard. Fix: add it word for word to onScreenCopy or to a scene headline. If the user changed it, change ${file} too.`,
        ref: { file: plan ? planFile : storyboardFile, jsonPath: "onScreenCopy" },
      });
  plan?.onScreenCopy.forEach((item, index) => {
    if (!item.required) return;
    const jsonPath = `onScreenCopy[${index}]`;
    if (!shotIds.has(item.shotId))
      findings.push({
        severity: "error",
        code: "SCRIPT_TEXT_LOST",
        stage: "storyboard",
        message: `Required copy "${item.text}" is attached to shot "${item.shotId}", which the plan does not have, so no shot shows it. Fix: point shotId at a real shot.`,
        ref: { file: planFile, jsonPath },
      });
    else if (boardLines.length && !screenHas(board, item.text))
      findings.push({
        severity: "warning",
        code: "SCRIPT_TEXT_LOST",
        stage: "storyboard",
        message: `Required copy "${item.text}" is in the plan but not in the storyboard the user approved. Fix: add it to the matching scene's headline, subtext or onScreenText, or drop required if the user removed it.`,
        ref: { file: storyboardFile, jsonPath: "scenes" },
      });
  });
  return findings;
}

// --- Final frame ---

export const checkFinalFrame = (
  last: FramePixels,
  before: FramePixels,
  intent: MotionPlan["finalFrameIntent"],
  file: string,
): CreativeFinding[] =>
  intent === "fade"
    ? []
    : checkFadedFinal(last, before).map((occurrence) => ({
        severity: "error" as const,
        code: "FINAL_FRAME_FADED" as const,
        stage: "qa",
        message: `${occurrence.message} Fix: hold the last message at full strength through the last frame, because players and feeds freeze on it. If the fade is the intent, set finalFrameIntent to "fade" in the motion plan.`,
        ref: { file },
      }));

/** A fade shows only against a nearby frame: further back than the sensor's lookback there may be a cut, and nearer than this it has barely started. */
const MIN_FADE_DISTANCE = 5;

type EvidenceFrame = { frame: number; meanLuma: number; nearBlack: boolean; intentionalDark: boolean };
type Evidence = {
  file: string;
  sourceHash?: string;
  createdAt: string;
  expectedFrames: number;
  frames: EvidenceFrame[];
};

function readEvidence(projectDir: string): Evidence[] {
  const directory = path.join(projectDir, "pipeline", "qa-evidence");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .flatMap((name) => {
      const file = path.join(directory, name, "evidence.json");
      const raw = readJson(file);
      if (!isObject(raw) || !isObject(raw["extraction"])) return [];
      const extraction = raw["extraction"];
      if (typeof extraction["expectedFrames"] !== "number") return [];
      const frames = list(extraction["frames"]).flatMap((frame): EvidenceFrame[] =>
        isObject(frame) && typeof frame["frame"] === "number" && typeof frame["meanLuma"] === "number"
          ? [
              {
                frame: frame["frame"],
                meanLuma: frame["meanLuma"],
                nearBlack: frame["nearBlack"] === true,
                intentionalDark: frame["intentionalDark"] === true,
              },
            ]
          : [],
      );
      return [
        {
          file,
          sourceHash: text(raw["sourceHash"]),
          createdAt: text(raw["createdAt"]) ?? "",
          expectedFrames: extraction["expectedFrames"],
          frames,
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const toPixels = ({ frame, meanLuma, nearBlack }: EvidenceFrame): FramePixels => ({
  frame,
  meanLuma,
  nearBlack,
  hash: "",
});

/** Pair of the tail frame and the earliest frame within the lookback. Undefined when the evidence is too sparse to tell. */
export function finalPairFromEvidence(
  evidence: Pick<Evidence, "expectedFrames" | "frames">,
): { last: EvidenceFrame; before: EvidenceFrame } | undefined {
  const lastFrame = evidence.expectedFrames - 1;
  const last = evidence.frames.find((frame) => frame.frame === lastFrame);
  const before = evidence.frames
    .filter((frame) => frame.frame >= lastFrame - FADE_LOOKBACK_FRAMES && frame.frame <= lastFrame - MIN_FADE_DISTANCE)
    .sort((a, b) => a.frame - b.frame)[0];
  return last && before ? { last, before } : undefined;
}

/** Decodes the last frame and the one a lookback before it. Undefined when ffmpeg cannot read the file: the check then did not run. */
export function decodeFinalPair(file: string): { last: FramePixels; before: FramePixels } | undefined {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_packets",
      "-show_entries",
      "stream=nb_read_packets",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8" },
  );
  const count = Number.parseInt(probe.stdout ?? "", 10);
  if (probe.status !== 0 || !Number.isInteger(count) || count <= FADE_LOOKBACK_FRAMES) return undefined;
  const [lastFrame, beforeFrame] = [count - 1, count - 1 - FADE_LOOKBACK_FRAMES];
  const size = 16 * 16 * 3;
  const decoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      `select='eq(n\\,${beforeFrame})+eq(n\\,${lastFrame})',scale=16:16`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: size * 4 },
  );
  if (decoded.status !== 0 || decoded.stdout.length !== size * 2) return undefined;
  return {
    before: measurePixels(beforeFrame, decoded.stdout.subarray(0, size)),
    last: measurePixels(lastFrame, decoded.stdout.subarray(size)),
  };
}

// --- Blueprint ---

export function checkBlueprint(plan: MotionPlan | undefined, libraryRoot: string, planFile: string): CreativeFinding[] {
  const id = plan?.blueprintReferenceId;
  if (!id) return [];
  const finding = (problem: string): CreativeFinding[] => [
    {
      severity: "error",
      code: "BLUEPRINT_INVALID",
      stage: "storyboard",
      message: `motionPlan.blueprintReferenceId names "${id}", but ${problem}. Fix: finish that reference's blueprint and run ref:validate, or remove the field if the plan does not follow a blueprint.`,
      ref: { file: planFile, jsonPath: "blueprintReferenceId" },
    },
  ];
  try {
    return readLayer(referenceDirectory(libraryRoot, id), "blueprint.json")
      ? []
      : finding(`${path.join(libraryRoot, id, "blueprint.json")} does not exist`);
  } catch (error) {
    return finding(
      `its blueprint.json does not validate: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
    );
  }
}

// --- Entry point ---

function currentRender(
  projectDir: string,
  rootDir: string,
  override: string | undefined,
): { file?: string; sha256?: string } {
  const status = readJson(path.join(projectDir, "pipeline", "render-status.json"));
  const output = override ?? (isObject(status) ? text(status["output"]) : undefined);
  const file = output ? path.resolve(rootDir, output) : undefined;
  if (file && existsSync(file)) return { file, sha256: hashRenderFile(file) };
  const recorded = isObject(status) ? text(status["sha256"]) : undefined;
  return override ? {} : { sha256: recorded && /^[a-f0-9]{64}$/.test(recorded) ? recorded : undefined };
}

/**
 * Pipeline checks for the creative stages. Old projects stay quiet:
 * - CONCEPT_MISSING and MOTION_PLAN_MISSING run for `brief.renderMode === "bespoke"`, or when the file itself exists in the new format.
 * - Every other code runs only for `brief.renderMode === "bespoke"`.
 */
export function runCreativeChecks(projectDir: string, options: CreativeCheckOptions = {}): CreativeFinding[] {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const libraryRoot = options.libraryRoot ?? path.join(rootDir, DEFAULT_LIBRARY_ROOT);
  const artefact = (name: string) => path.join(projectDir, "pipeline", name);
  const read = (name: string) => readJson(artefact(name));
  const [conceptFile, planFile, storyboardFile] = [
    artefact("concept.json"),
    artefact("motion-plan.json"),
    artefact("storyboard.json"),
  ];

  const brief = read("brief.json");
  // Read from the raw file: BriefSchema strips keys it does not know.
  const bespoke = isObject(brief) && brief["renderMode"] === "bespoke";
  const state = read("pipeline-state.json");
  const stageDone = (stage: string) => {
    const stages = isObject(state) ? state["stages"] : undefined;
    const record = isObject(stages) ? stages[stage] : undefined;
    return isObject(record) && record["status"] === "done";
  };
  const [scriptDone, storyboardDone] = [stageDone("script"), stageDone("storyboard")];

  const concept = readArtefact(conceptFile, ConceptSchema, bespoke, false);
  const motionPlan = readArtefact(planFile, MotionPlanSchema, bespoke, true);
  const findings = [
    ...checkConcept(concept, bespoke, scriptDone, conceptFile),
    ...checkMotionPlan(motionPlan, bespoke, storyboardDone, planFile),
  ];
  if (!bespoke) return findings;

  const plan = value(motionPlan);
  const script = read("script.json");
  const storyboard = read("storyboard.json");
  const design = read("design.json");
  const fonts = isObject(design)
    ? list(design["fonts"]).flatMap((token) => (text(token) ? [token as string] : []))
    : [];

  findings.push(
    ...checkProductMaterial({
      brief,
      concept: value(concept),
      plan,
      scriptDone,
      storyboardDone,
      conceptFile,
      planFile,
    }),
  );
  findings.push(
    ...checkFontGlyphs(
      fonts,
      [...storyboardScreenLines(storyboard), ...planScreenLines(plan)],
      artefact("design.json"),
    ),
  );
  if (storyboardDone) findings.push(...checkScriptText({ brief, script, storyboard, plan, storyboardFile, planFile }));
  findings.push(...checkBlueprint(plan, libraryRoot, planFile));

  const render = currentRender(projectDir, rootDir, options.renderFile);
  const intent = plan?.finalFrameIntent ?? "hold";
  const evidence = readEvidence(projectDir).find((item) => !render.sha256 || item.sourceHash === render.sha256);
  const pair = evidence && finalPairFromEvidence(evidence);
  if (evidence && pair) {
    if (!pair.last.intentionalDark)
      findings.push(...checkFinalFrame(toPixels(pair.last), toPixels(pair.before), intent, evidence.file));
  } else if (render.file) {
    const decoded = decodeFinalPair(render.file);
    if (decoded) findings.push(...checkFinalFrame(decoded.last, decoded.before, intent, render.file));
  }

  if (render.sha256 && (stageDone("render") || options.renderFile))
    findings.push(
      ...checkVisualReviews(projectDir, render.sha256).map((finding) => ({
        ...finding,
        ref: finding.ref && { ...finding.ref, file: path.join(projectDir, finding.ref.file) },
      })),
    );
  return findings;
}

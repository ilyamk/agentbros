import { IconUsageSchema } from "../../types/icon-resources";
import { z } from "zod";
import { ConceptSchema, CritiqueSchema, MotionPlanSchema } from "../../types/creative";
import {
  AudioMapSchema,
  CueSheetSchema,
  FilmMeasureSchema,
  FilmTargetsSchema,
  MaterialSchema,
  MusicDecisionSchema,
  MusicShortlistSchema,
} from "../../types/film";
import { BriefSchema, DesignSchema, ScriptSchema, type FilmType } from "../../types/pipeline";
import { NarrationDirectionSchema, NarrationSchema } from "../../types/narration";
import { ReplicaRightsSchema, ReplicaSpecSchema } from "../../types/reference-replica";
import { ReferencesPlanSchema } from "../../types/references";
import { ShotsFileSchema } from "../vision/sheets";
import { SfxSelectionSchema } from "../../types/sfx-selection";
import {
  CategoryScanSchema,
  ConceptBoardsSchema,
  CreativePoolSchema,
  PoolKeySchema,
  ScriptVariantSchema,
  StrategySchema,
  TEAM_STANCES,
  SCRIPT_VARIANTS,
  TeamIdeasSchema,
} from "../../types/studio";
import type { ReviewKind } from "./creative-rubric";

/**
 * The bespoke film chain as data: who runs next, with which inputs and commands, what ends the step
 * and which decisions belong to the human. `film:next` and `film:brief` read it, so an orchestrator
 * never has to compose a brief. See docs/production-chain.md.
 *
 * Path and value templates: `{token}` is resolved by the engine, `<placeholder>` is filled by the owner.
 * In a command, a value starting with `?` drops the flag when its token cannot be resolved.
 */

// --- Artefact schemas that have no home in src/types yet ---

export const ProductSourcesSchema = z.object({ schemaVersion: z.literal(1), paths: z.array(z.string()) });
export const ProductTruthSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(z.string()),
  /** How each source was read: its role, and whether it was read to the end. */
  sourceNotes: z
    .array(
      z.object({
        path: z.string().min(1),
        role: z.string().min(1),
        readToEnd: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  claims: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["working", "in-development", "horizon", "unverified"]),
      source: z.string().optional(),
    }),
  ),
  publicRule: z.string().optional(),
  mayNotSay: z.array(z.unknown()).optional(),
  showingLimits: z.array(z.unknown()).optional(),
  alternatives: z.array(z.unknown()).optional(),
  material: z.array(z.unknown()).optional(),
});
/** Ties each script beat to a section of the audio map: the script is written to the music. */
export const ScriptMusicMapSchema = z.object({
  schemaVersion: z.literal(1),
  beats: z.array(z.object({ beatId: z.string(), sectionIndex: z.number().int().nonnegative() })),
});
/** What was built, so later scripts need not be told the composition. */
export const BuildRecordSchema = z.object({
  iconUsages: z.array(IconUsageSchema).optional(),
  schemaVersion: z.literal(1),
  composition: z.string().min(1),
  localAssets: z.array(z.string().min(1)).max(1000).optional(),
  entry: z.string().optional(),
  props: z.string().optional(),
  vizMotionPlanHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** What the film mounts for a hero shot when it is not the film's own composition: the tournament's winner and its props file. */
  shots: z.record(z.string(), z.object({ composition: z.string().min(1), props: z.string().optional() })).optional(),
});
/** A sensor's report as written by plan:check. */
export const VerdictReportSchema = z.object({ verdict: z.enum(["pass", "fail"]) }).loose();
/** A CLI result envelope kept with a shell redirect. */
export const EnvelopeSchema = z.object({ ok: z.boolean() }).loose();

export const ARTEFACT_SCHEMAS = {
  brief: BriefSchema,
  "product-truth": ProductTruthSchema,
  strategy: StrategySchema,
  "category-scan": CategoryScanSchema,
  "team-ideas": TeamIdeasSchema,
  "script-variant": ScriptVariantSchema,
  "creative-pool": CreativePoolSchema,
  "pool-key": PoolKeySchema,
  "concept-boards": ConceptBoardsSchema,
  "film-targets": FilmTargetsSchema,
  concept: ConceptSchema,
  "music-shortlist": MusicShortlistSchema,
  "music-decision": MusicDecisionSchema,
  "audio-map": AudioMapSchema,
  script: ScriptSchema,
  "script-music-map": ScriptMusicMapSchema,
  "narrator-direction": NarrationDirectionSchema,
  narration: NarrationSchema,
  material: MaterialSchema,
  references: ReferencesPlanSchema,
  design: DesignSchema,
  "motion-plan": MotionPlanSchema,
  "cue-sheet": CueSheetSchema,
  "verdict-report": VerdictReportSchema,
  build: BuildRecordSchema,
  envelope: EnvelopeSchema,
  "film-measure": FilmMeasureSchema,
  critique: CritiqueSchema,
  "replica-rights": ReplicaRightsSchema,
  "replica-spec": ReplicaSpecSchema,
  "replica-shots": ShotsFileSchema,
  "sfx-selection": SfxSelectionSchema,
} as const;
export type ArtefactSchemaId = keyof typeof ARTEFACT_SCHEMAS;

// --- Commands ---

/** Alias to script. Siblings' scripts and every film:* alias are registered at integration. */
export const COMMAND_SCRIPTS = {
  "film:done": "scripts/film-done.ts",
  "ref:add": "scripts/ref-add.ts",
  "ref:analyze": "scripts/ref-analyze.ts",
  "ref:validate": "scripts/ref-validate.ts",
  "ref:compare": "scripts/ref-compare.ts",
  "motion:still": "scripts/motion-still.ts",
  "motion:strip": "scripts/motion-strip.ts",
  "motion:render": "scripts/motion-render.ts",
  "motion:check": "scripts/motion-check.ts",
  "review:sheet": "scripts/review-sheet.ts",
  "blender:run": "scripts/blender-run.ts",
  "vork:render": "scripts/vork-render.ts",
  "vork:scene": "scripts/vork-scene.ts",
  "vork:recipe": "scripts/vork-recipe.ts",
  "hyperframes:render": "scripts/hyperframes-render.ts",
  "audio:mix": "scripts/mix-audio.ts",
  "asset:import": "scripts/import-asset.ts",
  "audio:map": "scripts/audio-map.ts",
  "edit:snap": "scripts/edit-snap.ts",
  "edit:plan": "scripts/edit-plan.ts",
  "music:backtime": "scripts/music-backtime.ts",
  music: "scripts/music.ts",
  "sfx:library": "scripts/sfx-library.ts",
  "film:targets": "scripts/film-targets.ts",
  "film:measure": "scripts/film-measure.ts",
  "plan:check": "scripts/plan-check.ts",
  "critic:pack": "scripts/critic-pack.ts",
  "film:render": "scripts/film-render.ts",
  "film:versions": "scripts/film-versions.ts",
  "film:stills": "scripts/film-stills.ts",
  "sfx:cues": "scripts/sfx-cues.ts",
  "sfx:audition": "scripts/sfx-audition.ts",
  "sfx:synth": "scripts/sfx-synth.ts",
  "capture:app": "scripts/capture-app.ts",
  "film:route": "scripts/film-route.ts",
  "library:list": "scripts/library-list.ts",
  "creative:pool": "scripts/creative-pool.ts",
  "creative:rank": "scripts/creative-rank.ts",
  "creative:pick": "scripts/creative-pick.ts",
  "concept:boards": "scripts/concept-boards.ts",
  "film:rights": "scripts/film-rights.ts",
  "model:prepare": "scripts/model-prepare.ts",
  "entity:card": "scripts/entity-card.ts",
  "refs:profiles": "scripts/refs-profiles.ts",
  "refs:plan": "scripts/refs-plan.ts",
  "refs:derive": "scripts/refs-derive.ts",
  "refs:pack": "scripts/refs-pack.ts",
  "motion:library": "scripts/motion-library.ts",
  "ref:replica-check": "scripts/ref-replica-check.ts",
  "shot:tournament": "scripts/shot-tournament.ts",
  "library:usage": "scripts/library-usage.ts",
  "generate:voiceover": "scripts/generate-voiceover.ts",
  "generate:music": "scripts/generate-music.ts",
  "generate:dialogue": "scripts/generate-dialogue.ts",
  "speech:replace": "scripts/speech-replace.ts",
  "voiceover:local": "scripts/local-task.ts",
  "speech:local": "scripts/speech-local.ts",
  "narration:check": "scripts/narration-check.ts",
} as const;
export type CommandAlias = keyof typeof COMMAND_SCRIPTS;

export type ChainCommand = {
  alias: CommandAlias;
  purpose: string;
  /** Flag to value template, in order. `true` is a boolean flag. */
  args: Record<string, string | true>;
  /** Keep the result envelope: the sensor has no output flag. */
  stdoutTo?: string;
};

const run = (alias: CommandAlias, purpose: string, args: ChainCommand["args"], stdoutTo?: string): ChainCommand => ({
  alias,
  purpose,
  args,
  ...(stdoutTo ? { stdoutTo } : {}),
});

// --- Steps ---

export type ChainInput = {
  path: string;
  what: string;
  optional?: boolean;
  /** Not needed when the user chose silence. */
  unlessSilence?: boolean;
  /** Read for reference only: not hashed into the receipt, so its changes never stale the step (e.g. the library catalogue). */
  untracked?: boolean;
  /** Read only in these types' films; other routes never see it. */
  onlyFor?: FilmType[];
};
export type ChainOutput = {
  path: string;
  what: string;
  schema: ArtefactSchemaId | null;
  optional?: boolean;
  unlessSilence?: boolean;
};
export type GateKind = "user" | "critic" | "measure" | "none";

/** Machine-checked by DONE_CHECKS in state.ts; validating every output against its schema is always included. */
export type DoneCheckId =
  | "brief-filled"
  | "truth-sourced"
  | "strategy-filled"
  | "teams-ready"
  | "variants-ready"
  | "idea-pool-current"
  | "script-pool-current"
  | "concept-from-review"
  | "boards-rendered"
  | "script-from-review"
  | "reference-usable"
  | "ideas-differ"
  | "music-resolved"
  | "map-matches-music"
  | "script-on-music"
  | "narration-ready"
  | "material-sourced"
  | "references-ready"
  | "cues-on-map"
  | "plan-passed"
  | "project-lint-clean"
  | "motion-check-passed"
  | "tournament-decided"
  | "mix-passed"
  | "hero-sounds-selected"
  | "measure-passed"
  | "replica-reference-ready"
  | "replica-spec-passed"
  | "replica-within-tolerance";

export type ChainStep = {
  id: string;
  title: string;
  purpose: string;
  /** An agent id from .agents/agents, or `script`, or `user`. */
  owner: string;
  inputs: ChainInput[];
  outputs: ChainOutput[];
  /** What the owner runs, in order. `film:done` is appended, except on self-sealing steps. */
  commands: ChainCommand[];
  gate: GateKind;
  done: { rule: string; checks: DoneCheckId[] };
  stop: { maxRounds: number; noProgress: string };
  /** Asked when the gate is `user`. */
  question?: {
    text: string;
    show: string[];
    /** The user already answered in this file: approve with those words instead of asking again. */ answerFrom?: {
      path: string;
      key: "askedUser.answer";
    };
  };
  /** A question that comes before the outputs can exist. */
  firstAsk?: { after: string; until: string; text: string; show: string[]; thenRun: ChainCommand };
  /**
   * An independent judge, new every round. `agent` defaults to creative-critic, whose critiques are CritiqueSchema in
   * pipeline/critique/. With `review`, the judge is a creative-director writing CreativeReviewSchema rounds to
   * pipeline/creative-review/, and a round below the threshold goes back to the authors of step `fixBy`.
   */
  critic?: { target: string; prefix: string; pack: boolean; agent?: string; review?: ReviewKind; fixBy?: string };
  /** Several authors write apart, one brief each: `--team` or `--variant` on film:brief. */
  fanOut?: { flag: "team" | "variant"; kind: ReviewKind; output: string };
  /** A failing result goes to the fixer agent rather than back to the owner. */
  fixerInputs?: ChainInput[];
  skipWhenSilence?: boolean;
  /** Bound to the artefact by its own record (critique, approval): no film:done receipt. */
  selfSealing?: boolean;
  /** Its own command records the receipt (film:done runs inside it), so the next action after it is the critic. */
  sealedBy?: CommandAlias;
  /** May be skipped with a recorded reason: film:done --skip "<reason>". */
  skippable?: boolean;
  /** Steps that must be closed though no output of theirs is an input here. */
  requires?: string[];
  /** The old stage whose `approve` history entry also opens this user gate. */
  legacyApprovalStage?: "brief" | "script";
  /** Runs only in these types' films: other routes do not list, count or show it. */
  onlyFor?: FilmType[];
  orchestratorChecks: { before: string[]; after: string[] };
  forbidden: string[];
};

export const P = (file: string) => `{dir}/pipeline/${file}`;

export const BRIEF = P("brief.json");
export const SOURCES = P("product-sources.json");
export const TRUTH = P("product-truth.json");
export const TARGETS = P("film-targets.json");
export const CONCEPT = P("concept.json");
export const STRATEGY = P("strategy.json");
export const CATEGORY_SCAN = P("category-scan.json");
export const IDEA_POOL = P("pools/ideas.json");
export const IDEA_KEY = P("pools/ideas-key.json");
export const SCRIPT_POOL = P("pools/scripts.json");
export const SCRIPT_KEY = P("pools/scripts-key.json");
export const BOARDS = P("concept-boards.json");
export const BOARDS_SHEET = P("boards/boards.jpg");
export const SCRIPT_ALTERNATIVE = P("script-alternative.json");
export const TEAM_FILE = P("concepts/{lane}.json");
export const VARIANT_FILE = P("scripts/{lane}.json");
export const DIRECTOR_AGENT = "creative-director";
export const SHORTLIST = P("music-shortlist.json");
export const DECISION = P("music-decision.json");
export const AUDIO_MAP = P("audio-map.json");
export const SCRIPT = P("script.json");
export const SCRIPT_MAP = P("script-music-map.json");
/** Reference requirements per generated shot (RFC 0003 §6.3), written by refs:plan. */
export const REFERENCES = P("references.json");
/** The narrator's direction (generate:voiceover --directed reads it) and the measured takes (narration:check writes it). */
export const NARRATION_DIRECTION = P("narrator-direction.json");
export const NARRATION = P("narration.json");
/** The measured takes, for the steps that time picture and sound to the voice; absent when the film has no voice. */
const NARRATION_INPUT: ChainInput = {
  path: NARRATION,
  what: "the measured voiceover takes: each beat's file, durationSec, caption words and default startSec",
  optional: true,
};
/** Outside media shot by shot, with provenance, licence and cost; written only by types that need it (routes.ts). */
export const MATERIAL = P("material.json");
const MATERIAL_INPUT: ChainInput = {
  path: MATERIAL,
  what: "the film's outside media, shot by shot, with provenance and licence",
  optional: true,
};
const DESIGN = P("design.json");
const FILM_STYLE = P("film-style.json");
const STYLEFRAMES = P("look/styleframes.png");
export const MOTION_PLAN = P("motion-plan.json");
const CUE_DRAFTS = P("cue-drafts.json");
export const CUE_SHEET = P("cue-sheet.json");
export const PLAN_CHECK = P("plan-check.json");
/** Library blocks at their start frames, the input sfx:cues turns into sounds on the blocks' own cue frames. */
export const CUE_PLACEMENTS = P("cue-placements.json");
export const SOUND_CUES = P("sound-cues.json");
/** sfx:audition: each hero sound chosen from measured candidates. */
export const SFX_SELECTION = P("sfx-selection.json");
const ANIMATIC = "out/{id}/animatic.mp4";
export const BUILD = P("build.json");
export const MOTION_CHECK = P("motion-check.json");
const MIX_PLAN = P("mix-plan.json");
export const MIX_REPORT = P("mix-report.json");
const MASTER = "{dir}/audio/master.wav";
export const RENDER = "out/{id}/film.mp4";
export const MEASURE = P("film-measure.json");
export const CRITIC_PACK_DIR = P("critic-pack/round-{round}");
/** The replica route (film type `replica`): the user's rights answer, the shot-for-shot spec and its checks. */
export const RIGHTS = P("replica-rights.json");
export const REPLICA_SPEC = P("replica-spec.json");
export const REPLICA_SHOTS = P("replica-shots.json");
export const REPLICA_CHECK = P("replica-check.json");
export const REPLICA_COMPARE = P("replica-compare.json");
const REPLICA: FilmType[] = ["replica"];
const REPLICA_SKILL = ".agents/skills/reference-replica/SKILL.md";
const REPLICA_SPEC_RULES = ".agents/skills/reference-replica/references/replica-spec.md";

const BLUEPRINT = "{library}/{referenceId}/blueprint.json";
export const REFERENCE_DIR = "{library}/{referenceId}";

export const LIBRARY_CATALOGUE = "docs/library/catalogue.json";
/** What the picture can be built from without new material: ideas are feasible against it. */
const LIBRARY_INPUT: ChainInput = {
  path: LIBRARY_CATALOGUE,
  what: 'the motion library catalogue, what a picture can be built from without new material; search it with `pnpm library:list --query "<what>"`',
  untracked: true,
};

/** The music and the reference are first-class inputs of every step from `script` on. */
const MUSIC_AND_REFERENCE: ChainInput[] = [
  { path: DECISION, what: "the music the user chose; the film is cut to it" },
  {
    path: AUDIO_MAP,
    what: "the audio map: sections, phrases, events and how far to trust the grid",
    unlessSilence: true,
  },
  {
    path: "{musicFile}",
    what: "the cut of the track the film uses: listen to it, or read its map if you cannot",
    unlessSilence: true,
  },
  { path: TARGETS, what: "the reference's numbers the film has to match" },
  { path: BLUEPRINT, what: "the reference's blueprint, when the targets come from a reference", optional: true },
];

export const FORBIDDEN_FOR_ALL = [
  "An orchestrator must not write or edit a subagent's prompt: start the subagent with film:brief's metadata.dispatch line, and add only the user's words with --note.",
  "An orchestrator must not add technique lists, effect counts, a fixed topic or an existing clip to justify to a brief.",
  "Nobody may approve for the user, or turn silence, a missing reference or a failed gate into a decision the user did not make.",
];
/** FORBIDDEN_FOR_ALL in a project whose user granted an autonomous policy (pipeline/policy.json): the same lines, the last one bounded by it. */
export const FORBIDDEN_UNDER_POLICY = [
  ...FORBIDDEN_FOR_ALL.slice(0, -1),
  "Nobody may approve for the user, except under a policy the user granted in their own words, within its limits (film:approve --policy); never turn silence, a missing reference or a failed gate into a decision the user did not make.",
];

const ONE_ROUND = {
  maxRounds: 3,
  noProgress: "Two rounds with the same failures: stop and report them, do not try a third way.",
};

/** The user's open feedback on one step, written by `pnpm feedback` (src/lib/feedback): a tracked input, so writing it reopens the step. */
export const FEEDBACK_OPEN = (stepId: string) => P(`feedback/open/${stepId}.json`);
/**
 * The steps feedback can be routed to: agent-owned and not a judge (src/lib/feedback/route.ts holds the table). The two
 * pool authors (ideas, script-variants) are fan-out: their open feedback reopens the pool for a new round (studio.ts).
 */
export const FEEDBACK_STEPS: readonly string[] = [
  "intake",
  "replica-spec",
  "truth",
  "strategy",
  "ideas",
  "music",
  "script-variants",
  "narration",
  "material",
  "look",
  "beat-sheet",
  "build",
  "sound",
];
const withFeedback = (steps: ChainStep[]): ChainStep[] =>
  steps.map((step) =>
    FEEDBACK_STEPS.includes(step.id)
      ? {
          ...step,
          inputs: [
            ...step.inputs,
            {
              path: FEEDBACK_OPEN(step.id),
              what: "the user's feedback on the film they watched, routed to this step: answer every open item (their words are also under the user's words below)",
              optional: true,
            },
          ],
        }
      : step,
  );

export const FILM_CHAIN: readonly ChainStep[] = withFeedback([
  {
    id: "intake",
    title: "Intake",
    purpose: "Fix what the film is for, who it is for and what material is real, in the user's terms.",
    owner: "brief-collector",
    inputs: [{ path: SOURCES, what: "product material the user named", optional: true }],
    outputs: [
      { path: BRIEF, what: "the brief, renderMode kept as bespoke", schema: "brief" },
      { path: P("brief.md"), what: "the brief for the user to read", schema: null, optional: true },
    ],
    commands: [],
    gate: "user",
    done: {
      rule: "brief.json validates, keeps renderMode bespoke, and topic, audience, tone and productName are filled.",
      checks: ["brief-filled"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "The user's answers leave a required field empty: ask once more, then stop and say which.",
    },
    question: {
      text: "Is this the film you want: its goal, audience, length and format?",
      show: [P("brief.md"), BRIEF],
    },
    legacyApprovalStage: "brief",
    orchestratorChecks: {
      before: [
        "Pass on what the user said about the goal and the audience, in their words, with --note. Do not propose a topic.",
      ],
      after: [
        "Read the brief as the user would: does anything in it come from you rather than from them? Remove it before asking.",
      ],
    },
    forbidden: ["Choosing the topic to fit footage or a clip that already exists."],
  },
  {
    id: "rights",
    title: "Rights",
    purpose:
      "Ask the user who owns the film to copy and what the replica is for, and record their answer before anything is measured.",
    owner: "user",
    inputs: [{ path: BRIEF, what: "the approved brief, whose references name the film to copy" }],
    outputs: [
      {
        path: RIGHTS,
        what: "the user's answer: owned, licensed or study-only, in their words",
        schema: "replica-rights",
      },
    ],
    commands: [
      run(
        "film:rights",
        "Record the user's answer in their own words: owned (their film), licensed (quote the licence) or study-only (anything else, or no answer).",
        { project: "{id}", status: "<owned|licensed|study-only>", answer: "<the user's words>" },
      ),
    ],
    gate: "none",
    done: { rule: "replica-rights.json validates and holds the user's own words.", checks: [] },
    stop: {
      maxRounds: 1,
      noProgress: "The user does not answer: the replica is study-only, recorded as such, and is never published.",
    },
    question: {
      text: "Who owns the film we are copying, and what is the replica for? Without your own film or a licence to remake it, it stays a private study and is never published. Another owner's brand, logos, characters, copy, voice and music are replaced whatever the answer.",
      show: [P("brief.md"), BRIEF],
    },
    onlyFor: REPLICA,
    orchestratorChecks: {
      before: ["Ask in the user's language and record their exact words; do not suggest which status to pick."],
      after: ["Read the status back: study-only means nothing ships, and the user should know it now."],
    },
    forbidden: [
      "Recording owned or licensed without the user saying so.",
      "Starting the measurement before the answer is recorded.",
    ],
  },
  {
    id: "replica-reference",
    title: "Reference measure",
    purpose:
      "Measure the film to copy in every layer, crop it to its picture, and have its judged layers written, so every later number comes from the film itself.",
    owner: "reference-analyst",
    inputs: [
      { path: BRIEF, what: "the approved brief, whose references name the film to copy" },
      { path: SOURCES, what: "the material the user named, the film to copy among it", optional: true },
      { path: RIGHTS, what: "the user's rights answer, recorded on the reference" },
    ],
    outputs: [{ path: TARGETS, what: "film targets measured from the reference", schema: "film-targets" }],
    commands: [
      run(
        "ref:add",
        "Add the film to the library with the user's rights answer; use --url in place of --file for a link. Check source.json crop and rerun with --crop W:H:X:Y or none if the picture box is wrong.",
        {
          file: "<film-file>",
          id: "<reference-id>",
          rights: "{rightsStatus}",
          "rights-note": "{rightsStatement}",
          crop: "auto",
        },
      ),
      run("ref:analyze", "Measure every layer.", { id: "<reference-id>" }),
      run(
        "ref:validate",
        "Confirm the measured layers, then write the judged ones (story, visual, edit with its shot corrections, techniques, blueprint) and confirm again.",
        { id: "<reference-id>" },
      ),
      run("film:targets", "Turn the measured layers into targets.", { project: "{id}", reference: "<reference-id>" }),
    ],
    gate: "none",
    done: {
      rule: "film-targets.json names the reference; its library entry has every measured and judged layer valid, and its source.json carries the user's rights status.",
      checks: ["reference-usable", "replica-reference-ready"],
    },
    stop: { maxRounds: 2, noProgress: "The film cannot be analysed: stop and ask the user for another copy of it." },
    onlyFor: REPLICA,
    orchestratorChecks: {
      before: ["Is this the exact film the user named, at its best available quality?"],
      after: [
        "Open edit.json: does the corrected shot count match the film you watched? Every later frame count rests on it.",
      ],
    },
    forbidden: [
      "Writing targets or judged layers from memory of the film rather than its frames.",
      "Setting rights on the reference other than the user's answer.",
    ],
  },
  {
    id: "replica-spec",
    title: "Replica spec",
    purpose:
      "Write the film again on paper, one row per corrected reference shot with its frames, camera, ease, colour, type and blocks, and put to the user exactly what is swapped.",
    owner: "reference-analyst",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: RIGHTS, what: "the user's rights answer; the spec's rights block repeats it" },
      { path: TARGETS, what: "the reference's numbers" },
      {
        path: REFERENCE_DIR,
        what: "the reference's measured and judged layers: shots, edit corrections, motion, visuals, speech text",
        optional: true,
        untracked: true,
      },
      LIBRARY_INPUT,
    ],
    outputs: [
      {
        path: REPLICA_SPEC,
        what: "one row per corrected reference shot, the swaps and the rights",
        schema: "replica-spec",
      },
      {
        path: REPLICA_SHOTS,
        what: "the spec's shots in seconds, for ref:compare --render-shots",
        schema: "replica-shots",
      },
      { path: REPLICA_CHECK, what: "ref:replica-check's result", schema: "envelope" },
      {
        path: P("replica-spec.md"),
        what: "the spec for the user to read: shot list, what is swapped and why, what is unreachable",
        schema: null,
        optional: true,
      },
    ],
    commands: [
      run("library:list", "Find the block for each shot; set its props to the spec's numbers.", {
        query: "<what the shot shows>",
      }),
      run(
        "ref:replica-check",
        "Check the spec against the reference until it passes; it writes replica-shots.json.",
        { project: "{id}", "library-root": "{library}", "write-shots": true },
        REPLICA_CHECK,
      ),
    ],
    gate: "user",
    done: {
      rule: "replica-spec.json validates, ref:replica-check passed on this exact spec, the spec's rights are the user's answer and it replicates the measured reference.",
      checks: ["replica-spec-passed"],
    },
    stop: { maxRounds: 3, noProgress: "The same check issue twice: stop and report it with the reference's numbers." },
    question: {
      text: "Is this the replica, shot for shot? Are these the only things swapped, and is each swap what you want in its place?",
      show: [P("replica-spec.md"), REPLICA_SPEC],
    },
    onlyFor: REPLICA,
    orchestratorChecks: {
      before: [
        "The reference's judged layers exist: the spec is written from the corrected shot list, never the detector's.",
      ],
      after: [
        "Does every other owner's brand, character, copy, voice and track appear as a swap row? One left out would be copied.",
      ],
    },
    forbidden: [
      "Swapping content the user did not name.",
      "Writing a number by feel where the reference has a measurement.",
      "Keeping another owner's brand, characters, copy, voice or music.",
    ],
  },
  {
    id: "truth",
    title: "Product truth",
    purpose: "Record what the product really does, each claim with a status, so no later step invents a capability.",
    owner: "concept-director",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: SOURCES, what: "product material the user named", optional: true },
    ],
    outputs: [
      {
        path: TRUTH,
        what: "sources, and claims with status working, in-development, horizon or unverified",
        schema: "product-truth",
      },
    ],
    commands: [],
    gate: "none",
    done: {
      rule: "product-truth.json validates; a film about a product lists at least one source and one working claim.",
      checks: ["truth-sourced"],
    },
    stop: { maxRounds: 2, noProgress: "No source can be read: stop and name what is needed from the user." },
    orchestratorChecks: {
      before: ["Has the user pointed at real material? If not, ask them before dispatching."],
      after: ["Do the claims marked working point to a source you could open?"],
    },
    forbidden: ["Marking a claim working because it reads well or appears in marketing copy alone."],
  },
  {
    id: "reference",
    title: "Reference numbers",
    purpose:
      "Take the numbers of a film we want to match before any idea exists, so ambition is measured rather than described.",
    owner: "reference-analyst",
    inputs: [{ path: BRIEF, what: "the approved brief, whose references name the films to study" }],
    outputs: [
      {
        path: TARGETS,
        what: "film targets, measured from the reference or set by hand with a reason",
        schema: "film-targets",
      },
    ],
    commands: [
      run("ref:add", "Add the film to the library; use --url in place of --file for a link.", {
        file: "<film-file>",
        id: "<reference-id>",
        rights: "study-only",
      }),
      run("ref:analyze", "Measure its layers.", { id: "<reference-id>" }),
      run("ref:validate", "Confirm the measured and judged layers.", { id: "<reference-id>" }),
      run("film:targets", "Turn the measured layers into targets.", { project: "{id}", reference: "<reference-id>" }),
    ],
    gate: "none",
    done: {
      rule: "film-targets.json validates; with source reference its library entry has no invalid or missing measured layer, with source manual it carries a reason.",
      checks: ["reference-usable"],
    },
    stop: {
      maxRounds: 2,
      noProgress:
        "The film cannot be analysed: stop and ask for another, do not write targets by hand without saying so.",
    },
    orchestratorChecks: {
      before: [
        "Did the user name a reference? If not, ask for one. Manual targets are a decision for the user, not a fallback.",
      ],
      after: [
        "Do the numbers describe the film you have in mind? A median shot of 6 s on a film you remember as fast means something broke.",
      ],
    },
    forbidden: ["Skipping the reference because no film is at hand, without asking the user."],
  },
  {
    id: "strategy",
    title: "Strategy",
    purpose:
      "Fix the audience and their moment, the platform, one proposition and the first two seconds' hook mechanic before any idea exists.",
    owner: "strategist",
    inputs: [
      { path: BRIEF, what: "the approved brief, with its filmType" },
      { path: TRUTH, what: "what may be claimed, and what may not be said or shown" },
      { path: TARGETS, what: "the reference's numbers" },
      { path: BLUEPRINT, what: "the reference's blueprint, when the targets come from a reference", optional: true },
    ],
    outputs: [
      {
        path: STRATEGY,
        what: "audience and moment, platform and sound, proposition, hook mechanic, tone, mandatories, forbidden, success criteria, film type, concept teams",
        schema: "strategy",
      },
      { path: P("strategy.md"), what: "the strategy on one page, in the user's language", schema: null },
    ],
    commands: [run("film:route", "Read the film's route; strategy.filmType repeats the brief's.", { project: "{id}" })],
    gate: "user",
    done: {
      rule: "strategy.json validates, its filmType is the brief's, its teams are distinct, it has one proposition and at least two success criteria, and strategy.md exists.",
      checks: ["strategy-filled"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "The user rejects the proposition twice: stop and ask them to say it in one sentence.",
    },
    question: {
      text: "Is this the strategy: who it is for and when, the one thing the film proves, the platform and the hook? Say what is wrong.",
      show: [P("strategy.md"), STRATEGY],
    },
    orchestratorChecks: {
      before: ["The brief is approved and the reference numbers exist. Pass on only the user's words."],
      after: [
        "Is the proposition one sentence a viewer could repeat? Two claims joined by 'and' are two films: send it back.",
      ],
    },
    forbidden: ["Writing ideas, lines or pictures into the strategy: it says what the film must do, not how."],
  },
  {
    id: "discovery",
    title: "Category scan",
    purpose:
      "Read what the category already does before anyone has an idea: at least eight real examples, their conventions and clichés, what to learn, what not to take, and where the white space is.",
    owner: "category-scout",
    inputs: [
      { path: BRIEF, what: "the approved brief: the category, never the product's name, is what you search" },
      { path: STRATEGY, what: "the approved strategy: audience, platform and proposition" },
    ],
    outputs: [
      {
        path: CATEGORY_SCAN,
        what: "category, examples (url, brand, first two seconds, core visual device, product role, structure, read or inferred), conventions, clichés, learn, dontTake, whiteSpace",
        schema: "category-scan",
      },
    ],
    commands: [],
    gate: "none",
    skippable: true,
    done: {
      rule: "category-scan.json validates: at least 8 examples and at least 8 clichés, each example marked read or inferred. Or the step is skipped with a reason: film:done --skip.",
      checks: [],
    },
    stop: {
      maxRounds: 2,
      noProgress:
        "Fewer than eight examples can be found with category terms: write what was found in the report and skip the step with that reason.",
    },
    orchestratorChecks: {
      before: [
        "Dispatch the scout only after the strategy is approved. If the user wants no scan, skip with their reason.",
      ],
      after: [
        "Do the clichés name concrete pictures, not adjectives? Would the teams recognise them in their own first ideas?",
      ],
    },
    forbidden: [
      "Searching with the product's name, its handle or any private detail from the brief or the product truth: search with category terms only.",
      "Downloading videos or media: read pages and look; this is study only and nothing found is used in the film.",
      "Marking an example read when you only inferred it.",
    ],
  },
  {
    id: "ideas",
    title: "Concept teams",
    purpose:
      "Have each concept team, with its own stance, write four to six raw ideas apart, so the pool is wide before anyone judges it.",
    owner: "concept-director",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: STRATEGY, what: "the approved strategy: proposition, hook mechanic, mandatories, forbidden" },
      { path: TRUTH, what: "what may be claimed" },
      { path: TARGETS, what: "the reference's numbers" },
      { path: BLUEPRINT, what: "the reference's blueprint, when the targets come from a reference", optional: true },
      {
        path: "{previousReview}",
        what: "the creative director's notes on the last round; you cannot see which ideas were yours",
        optional: true,
      },
      {
        path: CATEGORY_SCAN,
        what: "the category's examples, conventions and clichés; when it exists your brief lists what not to do",
        optional: true,
      },
      LIBRARY_INPUT,
    ],
    outputs: TEAM_STANCES.map((team) => ({
      path: P(`concepts/${team}.json`),
      what: `the ${team} team's ideas for the current round`,
      schema: "team-ideas" as const,
      optional: true,
    })),
    fanOut: { flag: "team", kind: "ideas", output: TEAM_FILE },
    commands: [],
    gate: "none",
    done: {
      rule: "Every team the strategy names (default metaphor, product-in-use, provocation) has written 4 to 6 ideas for the current round, valid against team-ideas.",
      checks: ["teams-ready"],
    },
    stop: {
      maxRounds: 3,
      noProgress:
        "A team cannot find four ideas that differ in the picture: it says so in its report rather than padding.",
    },
    orchestratorChecks: {
      before: [
        "Dispatch every team at once, each with its own film:brief --team. Never show a team another team's file.",
      ],
      after: ["Do not read, rank or trim the ideas yourself: the creative director judges them blind."],
    },
    forbidden: [
      "Telling a team what another team wrote, or which ideas the director liked.",
      "Filtering ideas before the pool.",
    ],
  },
  {
    id: "idea-review",
    title: "Creative review",
    purpose:
      "Have a creative director who wrote none of the ideas score the pool blind on the frozen rubric, compare the best in both orders, and send a round below the threshold back to the teams.",
    owner: "script",
    inputs: [
      ...TEAM_STANCES.map((team) => ({
        path: P(`concepts/${team}.json`),
        what: `the ${team} team's ideas`,
        optional: true,
      })),
      { path: STRATEGY, what: "the approved strategy" },
      LIBRARY_INPUT,
    ],
    outputs: [
      {
        path: IDEA_POOL,
        what: "every team's ideas, authorship stripped, shuffled with a seed",
        schema: "creative-pool",
      },
      { path: IDEA_KEY, what: "who wrote which idea; never shown to the director", schema: "pool-key" },
    ],
    sealedBy: "creative:pool",
    commands: [run("creative:pool", "Pool the teams' current round blind.", { project: "{id}", kind: "ideas" })],
    gate: "critic",
    critic: {
      target: IDEA_POOL,
      prefix: "ideas-round-",
      pack: false,
      agent: DIRECTOR_AGENT,
      review: "ideas",
      fixBy: "ideas",
    },
    done: {
      rule: "The pool holds the current round of every team; the latest review of this exact pool, ranked by creative:rank, passes the threshold.",
      checks: ["idea-pool-current"],
    },
    stop: {
      maxRounds: 3,
      noProgress:
        "A round with no higher best mean than the last, or a third round below the threshold: stop and show the user the pool and the reviews.",
    },
    orchestratorChecks: {
      before: [
        "Start a new creative director every round; never resume one. Add nothing to its brief: --note is refused here.",
      ],
      after: [
        "When the round goes back, dispatch the teams as film:next says; their briefs carry the director's notes. Do not rescore or reorder.",
      ],
    },
    forbidden: [
      "Passing the director the pool key, a team's name or your own preference.",
      "Writing the ranking or the verdict by hand.",
    ],
  },
  {
    id: "concept",
    title: "Concept",
    purpose:
      "Put the creative director's top three ideas to the user with boards of their hook and last frames, one recommended and each argued against.",
    owner: DIRECTOR_AGENT,
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: STRATEGY, what: "the approved strategy" },
      { path: TRUTH, what: "what may be claimed" },
      { path: TARGETS, what: "the reference's numbers" },
      { path: IDEA_POOL, what: "the pooled ideas" },
      { path: IDEA_KEY, what: "who wrote which idea" },
      { path: "{ideasReview}", what: "the latest ranked review: the top three and the argument against each" },
    ],
    outputs: [
      {
        path: CONCEPT,
        what: "the review's top three, the first recommended, the rest rejected with their rank",
        schema: "concept",
      },
      {
        path: P("concept.md"),
        what: "the three ideas for the user to read, each with its argument against",
        schema: null,
      },
      {
        path: BOARDS,
        what: "per idea, its hook and last frame (and turn) as library blocks with props and a caption",
        schema: "concept-boards",
      },
      { path: BOARDS_SHEET, what: "the boards' contact sheet", schema: null },
    ],
    commands: [
      run("creative:pick", "Write concept.json from the ranked review.", { project: "{id}", kind: "ideas" }),
      run("library:list", "Find the block for each board frame.", { query: "<what the frame shows>" }),
      run("concept:boards", "Render each idea's frames from library blocks and the contact sheet.", {
        project: "{id}",
      }),
    ],
    gate: "user",
    done: {
      rule: "concept.json validates and holds the review's top three with different core images and opening frames; every board frame is rendered and the contact sheet exists.",
      checks: ["ideas-differ", "concept-from-review", "boards-rendered"],
    },
    stop: { maxRounds: 3, noProgress: "The user rejects a third set: stop and ask them what they picture." },
    question: {
      text: "Which of the three ideas do we make? The boards show each one's hook and last frame. Say what you would change.",
      show: [P("concept.md"), BOARDS_SHEET, CONCEPT],
    },
    orchestratorChecks: {
      before: ["The review passed, or the user chose to go on past the round limit."],
      after: [
        "Open the contact sheet. If two hook frames look alike, say so to the user rather than reorder the ideas.",
      ],
    },
    forbidden: [
      "Showing the user one idea with two weaker ones around it.",
      "Changing the director's order or its arguments.",
    ],
  },
  {
    id: "music",
    title: "Music",
    purpose: "Choose the track with the user by ear before any script or edit exists, because the film is cut to it.",
    owner: "sound-director",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: TARGETS, what: "the reference's numbers" },
    ],
    outputs: [
      {
        path: SHORTLIST,
        what: "candidates to listen to, each with its licence",
        schema: "music-shortlist",
        optional: true,
      },
      { path: DECISION, what: "the user's choice, in their words", schema: "music-decision" },
    ],
    commands: [
      run("music", "List the routes open to this project.", {
        action: "options",
        project: "{id}",
        reference: "?{referenceId}",
      }),
      run("music", "Search free stock.", { action: "search", project: "{id}", route: "free-stock", query: "<query>" }),
      run("music", "Read the charts, for a track the user adds on the platform.", {
        action: "trending",
        project: "{id}",
      }),
      run("music", "Read the reference's own track; delivery needs confirmed rights.", {
        action: "from-reference",
        project: "{id}",
        reference: "<reference-id>",
      }),
      run(
        "generate:music",
        "Generated route, only after the user's yes to the quoted takes and a budget ceiling raised in their words: one take per call, within its bound.",
        {
          project: "{id}",
          "composition-plan": P("music/composition-plan.json"),
          output: "{dir}/music/take-<n>.mp3",
          "operation-id": "{id}-music-take-<n>",
          "max-cost-usd": "<bound per take>",
        },
      ),
      run("music", "Write the shortlist for the user to hear.", {
        action: "shortlist",
        project: "{id}",
        from: "<search-a.json,search-b.json>",
        top: "<n>",
      }),
      run("music", "After the user has chosen: fetch the original.", {
        action: "acquire",
        project: "{id}",
        candidate: "<candidate-id>",
      }),
      run("music", "After the choice is recorded: the rights guard must not report it blocked.", {
        action: "check",
        project: "{id}",
      }),
    ],
    gate: "user",
    done: {
      rule: "music-decision.json validates and resolves: any track names a shortlisted candidate with a file on disk, an embedded track has its original file and a licence allowing commercial use, and silence carries a reason.",
      checks: ["music-resolved"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "The user rejects a third shortlist: stop and ask for a track or artist they like.",
    },
    firstAsk: {
      after: SHORTLIST,
      until: DECISION,
      text: "Listen to the shortlist. Which track do we cut to, or would you rather use your own, generate one, or go without music?",
      show: [SHORTLIST, P("music/contact-sheet.png")],
      thenRun: run("music", "Record the choice in the user's own words, then acquire it if it is a stock track.", {
        action: "record",
        project: "{id}",
        route: "<route>",
        candidate: "<candidate-id>",
        answer: "<the user's words>",
        reason: "<why, from the user>",
      }),
    },
    question: { text: "Confirm the track.", show: [DECISION], answerFrom: { path: DECISION, key: "askedUser.answer" } },
    orchestratorChecks: {
      before: [
        "The route is the user's: reference track, free stock, trending, generated, their own, synth or none. Do not narrow it for them.",
        "A paid generation needs an authorised budget.",
      ],
      after: [
        "Has the user actually heard it? A licence that is unknown blocks delivery, and a study-only track blocks release: say so now.",
      ],
    },
    forbidden: [
      "Choosing the music without asking.",
      "Treating silence as a default: it needs the user's reason.",
      "Embedding a trending track: it is added on the platform.",
    ],
  },
  {
    id: "audio-map",
    title: "Audio map",
    purpose: "Read the chosen track into sections, phrases, events and a stated trust in its beat grid.",
    owner: "script",
    inputs: [
      { path: DECISION, what: "the chosen track and its cut: the excerpt the film uses" },
      { path: "{musicFile}", what: "the cut (music/cue.wav): map exactly this file, never the whole track" },
    ],
    outputs: [
      { path: AUDIO_MAP, what: "the audio map", schema: "audio-map" },
      { path: P("audio-map.png"), what: "the map as a picture", schema: null, optional: true },
    ],
    commands: [
      run("audio:map", "Analyse the cut the film uses.", {
        input: "{musicFile}",
        output: AUDIO_MAP,
        image: P("audio-map.png"),
      }),
    ],
    gate: "none",
    done: {
      rule: "audio-map.json validates and its source hash is the hash of the decision's cut file.",
      checks: ["map-matches-music"],
    },
    stop: { maxRounds: 2, noProgress: "The analyser fails twice on the same file: stop and report its error." },
    skipWhenSilence: true,
    orchestratorChecks: {
      before: ["Is this the cut of the file the user chose, not a preview of another or the whole track?"],
      after: [
        "Open the map picture. If gridTrust is weak or none, the edit paces by phrases and sections: expect that in the next steps.",
      ],
    },
    forbidden: ["Editing the map by hand to make a grid look reliable."],
  },
  {
    id: "script-variants",
    title: "Script variants",
    purpose:
      "Write the film's words two or three ways, each with its own hook line and density, all to the music's sections.",
    owner: "script-writer",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: STRATEGY, what: "the approved strategy" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: TRUTH, what: "what may be claimed" },
      ...MUSIC_AND_REFERENCE,
      { path: "{previousReview}", what: "the creative director's notes on the last round of variants", optional: true },
    ],
    outputs: SCRIPT_VARIANTS.map((variant) => ({
      path: P(`scripts/${variant}.json`),
      what: `variant ${variant}: hook line, density, script, music map and markdown`,
      schema: "script-variant" as const,
      optional: true,
    })),
    fanOut: { flag: "variant", kind: "scripts", output: VARIANT_FILE },
    commands: [],
    gate: "none",
    done: {
      rule: "Every variant (a, b, c) is written for the current round and validates against script-variant.",
      checks: ["variants-ready"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "Two variants come out alike: say so in the report rather than force a difference.",
    },
    orchestratorChecks: {
      before: ["The music must be decided. Dispatch every variant at once, each with its own film:brief --variant."],
      after: ["Do not choose between the variants: the creative director does, blind."],
    },
    forbidden: [
      "Claiming anything whose product-truth status is not working.",
      "Showing one writer another's variant.",
    ],
  },
  {
    id: "script-review",
    title: "Script review",
    purpose:
      "Have a new creative director score the variants blind on the script rubric, in both orders, with the reading floor measured rather than judged.",
    owner: "script",
    inputs: [
      ...SCRIPT_VARIANTS.map((variant) => ({
        path: P(`scripts/${variant}.json`),
        what: `variant ${variant}`,
        optional: true,
      })),
      { path: CONCEPT, what: "the chosen idea" },
    ],
    outputs: [
      {
        path: SCRIPT_POOL,
        what: "the variants, authorship stripped, shuffled, with measured reading overruns",
        schema: "creative-pool",
      },
      { path: SCRIPT_KEY, what: "which variant is which; never shown to the director", schema: "pool-key" },
    ],
    sealedBy: "creative:pool",
    commands: [
      run("creative:pool", "Pool the variants blind and measure their reading floor.", {
        project: "{id}",
        kind: "scripts",
      }),
    ],
    gate: "critic",
    critic: {
      target: SCRIPT_POOL,
      prefix: "scripts-round-",
      pack: false,
      agent: DIRECTOR_AGENT,
      review: "scripts",
      fixBy: "script-variants",
    },
    done: {
      rule: "The pool holds every variant's current round; the latest review of this exact pool, ranked by creative:rank, passes the threshold.",
      checks: ["script-pool-current"],
    },
    stop: {
      maxRounds: 3,
      noProgress:
        "A round with no higher best mean than the last, or a third round below the threshold: stop and show the user the variants and the reviews.",
    },
    orchestratorChecks: {
      before: ["A new creative director every round, never one that reviewed the ideas."],
      after: ["Hand the notes back to the writers as written."],
    },
    forbidden: [
      "Passing the director the pool key or which variant you prefer.",
      "Writing the ranking or the verdict by hand.",
    ],
  },
  {
    id: "script",
    title: "Script",
    purpose: "Put the winning variant to the user as the script, read against the music, with the runner-up beside it.",
    owner: "script",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: TRUTH, what: "what may be claimed" },
      { path: SCRIPT_POOL, what: "the pooled variants" },
      { path: SCRIPT_KEY, what: "which variant is which" },
      { path: "{scriptsReview}", what: "the latest ranked script review" },
      ...MUSIC_AND_REFERENCE,
    ],
    outputs: [
      { path: SCRIPT, what: "the script: the winning variant's", schema: "script" },
      {
        path: SCRIPT_MAP,
        what: "each beat tied to a section of the audio map",
        schema: "script-music-map",
        unlessSilence: true,
      },
      { path: P("script.md"), what: "the script for the user to read", schema: null, optional: true },
      {
        path: SCRIPT_ALTERNATIVE,
        what: "the runner-up variant, shown as the alternative",
        schema: "script-variant",
        optional: true,
      },
      { path: P("script-alternative.md"), what: "the runner-up for the user to read", schema: null, optional: true },
    ],
    commands: [
      run("creative:pick", "Copy the winning variant to script.json and the runner-up beside it.", {
        project: "{id}",
        kind: "scripts",
      }),
    ],
    gate: "user",
    done: {
      rule: "script.json is the review's winning variant and validates; every beat maps to an existing section of the audio map and each beat fits the music's length.",
      checks: ["script-on-music", "script-from-review"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "The user sends the same objection twice: stop and ask them to say the line they want.",
    },
    question: {
      text: "Does this script say what you want, read against the music? The runner-up is beside it if you prefer its lines.",
      show: [P("script.md"), P("script-alternative.md"), SCRIPT],
    },
    legacyApprovalStage: "script",
    orchestratorChecks: {
      before: ["The script review passed, or the user chose to go on past the round limit."],
      after: [
        "Does a claim in the script go beyond the product truth's working claims? Send it back, do not soften it yourself.",
      ],
    },
    forbidden: [
      "Claiming anything whose product-truth status is not working.",
      "Editing the winning variant's words before the user has seen them.",
    ],
  },
  {
    id: "narration",
    title: "Narration",
    purpose:
      "Direct the voice from the approved script, then make the takes, measure them and align their words, so the motion plan is timed to the voice that will be heard.",
    owner: "narrator-director",
    inputs: [
      { path: BRIEF, what: "the approved brief: audience, tone, language, budgetUsd" },
      { path: SCRIPT, what: "the approved script: beats, narratorVoice, voiceRef, language; never edit it" },
      { path: SCRIPT_MAP, what: "beats on the music's sections", unlessSilence: true },
      { path: DECISION, what: "the music the user chose; the voice sits over it" },
      {
        path: AUDIO_MAP,
        what: "the audio map: where the music leaves room for the voice",
        unlessSilence: true,
      },
    ],
    outputs: [
      {
        path: NARRATION_DIRECTION,
        what: "the voice and its why, route (elevenlabs, local, existing), maxCostUsd for paid takes, directed text per beat",
        schema: "narrator-direction",
      },
      {
        path: P("narration.md"),
        what: "for the user: the voice and why, each beat directed, the quote, then the takes to listen to",
        schema: null,
        optional: true,
      },
      {
        path: NARRATION,
        what: "written by narration:check once the takes exist: each take measured, with receipt and caption words",
        schema: "narration",
        optional: true,
      },
    ],
    commands: [
      run("generate:voiceover", "Quote the ElevenLabs takes offline, before the user's yes.", {
        project: "{id}",
        directed: true,
        take: "<take>",
        "dry-run": true,
      }),
      run("generate:voiceover", "Only after the user approved this direction: the paid takes, within its bound.", {
        project: "{id}",
        directed: true,
        take: "<take>",
        "max-cost-usd": "<maxCostUsd>",
      }),
      run(
        "voiceover:local",
        "Free route: local draft takes. Set localVoice in the direction to select the portable engine.",
        {
          project: "{id}",
          output: P("narration-local.json"),
        },
      ),
      run("speech:local", "Free route: word timings for local takes without a word sidecar.", {
        input: "<take.mp3>",
        output: "<take>.transcript.json",
        language: "<language>",
      }),
      run("narration:check", "Measure the takes, check receipts and words, write the caption words.", {
        project: "{id}",
      }),
    ],
    gate: "user",
    done: {
      rule: "The direction validates, covers every spoken beat and, on the paid route, pins a timestamped voice and the user's maxCostUsd. Once the user approved it (or on a free route), every spoken beat has a take, a receipt and word timings, measured by narration:check into narration.json from the current direction; the user then approves the takes by ear.",
      checks: ["narration-ready"],
    },
    stop: {
      maxRounds: 3,
      noProgress:
        "The user rejects the voice twice for the same reason, or the takes cannot be made within the bound: stop and ask them to name a voice or a bound.",
    },
    question: {
      text: "Is this the voice and its direction, at this cost? Paid takes are made only after your yes; once they exist, listen and approve them.",
      show: [P("narration.md"), NARRATION_DIRECTION, NARRATION],
    },
    skippable: true,
    orchestratorChecks: {
      before: [
        "Does the approved script have voiceoverEnabled true? If not, skip the step with film:done --skip and the reason.",
        "Is the paid route in play? Its bound is the user's: budgetUsd null authorises nothing.",
      ],
      after: [
        "Listen to two takes yourself, or say you cannot; agents never claim a voice sounds good.",
        "Do the measured durations fit the beats' durationSec? A long overrun goes back to the script or the beat sheet, not to a faster voice.",
      ],
    },
    forbidden: [
      "Changing the script's words: direction adds tags and punctuation only.",
      "Generating paid takes before the user approves this direction and its maxCostUsd.",
      "Marking a beat voiced without its take, receipt and word timings on disk.",
    ],
  },
  {
    id: "material",
    title: "Material",
    purpose:
      "List and secure the outside media the film is made of, shot by shot, with provenance, licence and cost, before the look is set.",
    owner: "asset-planner",
    inputs: [
      { path: BRIEF, what: "the approved brief, with its filmType" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: SCRIPT, what: "the approved script, whose beats the material serves" },
      { path: TRUTH, what: "what may be shown; its material[] is where to start" },
      ...MUSIC_AND_REFERENCE,
      {
        path: REPLICA_SPEC,
        what: "the approved replica spec: each swap names what replaces another owner's content, and in which shots",
        onlyFor: REPLICA,
      },
    ],
    outputs: [
      { path: MATERIAL, what: "every item: shots, route, status, path, provenance, licence, cost", schema: "material" },
      {
        path: P("material.md"),
        what: "the material for the user to read: sources, licences, cost, what is pending",
        schema: null,
        optional: true,
      },
      {
        path: REFERENCES,
        what: "reference requirements of each generated shot (refs:plan); absent when no item is generated",
        schema: "references",
        optional: true,
      },
    ],
    commands: [
      run("asset:import", "Register each original file you acquire.", {
        project: "{id}",
        input: "<file>",
        origin: "<origin>",
      }),
      run("refs:plan", "Each generated shot's reference inputs and the command that resolves each.", {
        project: "{id}",
        action: "status",
      }),
      run("refs:profiles", "What the target model accepts: slots, limits, markers.", {
        action: "for",
        endpoint: "<endpoint>",
      }),
      run("entity:card", "Which views a card still lacks.", {
        project: "{id}",
        action: "coverage",
        kind: "<kind>",
        id: "<entity>",
      }),
      run("refs:derive", "Plan a trim, frame or pass; run it, and any paid step, after the material approval.", {
        project: "{id}",
        action: "plan",
        spec: "<derivative.json>",
        "dry-run": true,
      }),
      run("refs:pack", "Prepare the pack the user approves before a paid request.", {
        project: "{id}",
        action: "prepare",
        spec: "<pack.json>",
      }),
    ],
    gate: "user",
    done: {
      rule: "material.json validates; every item names provenance and licence; acquired items exist on disk; a generated item not yet acquired carries the user's maxCostUsd, and a paid acquired item records costUsd. Every generated image or video carries referencePlan none with a reason, or has a shot in references.json whose required inputs are ready and an approved, current referencePack.",
      checks: ["material-sourced", "references-ready"],
    },
    stop: {
      maxRounds: 3,
      noProgress:
        "A shot has no source that is licensed, affordable or recordable: stop and ask the user, do not substitute a weaker shot.",
    },
    question: {
      text: "Is this the material: its sources, licences and cost? Paid items are generated only after your yes.",
      show: [P("material.md"), MATERIAL],
    },
    orchestratorChecks: {
      before: ["Is a paid route in play? Its bound is the user's: budgetUsd null authorises nothing."],
      after: [
        "Open three items' sources yourself. Would the licence survive the film's actual use (ads, modification)?",
      ],
    },
    forbidden: [
      "Generating or buying anything before the user approves its cost.",
      "Marking an item acquired without its file on disk, or licensed without evidence.",
    ],
  },
  {
    id: "look",
    title: "Look",
    purpose: "Prove the visual language with real code on real frames, judged by someone who did not make them.",
    owner: "design-director",
    inputs: [
      { path: FILM_STYLE, what: "the selected style revision", optional: true },
      { path: BRIEF, what: "the approved brief" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: SCRIPT, what: "the approved script" },
      MATERIAL_INPUT,
      ...MUSIC_AND_REFERENCE,
      { path: "{previousCritique}", what: "the last critic's verdict on your frames", optional: true },
    ],
    outputs: [
      { path: DESIGN, what: "the visual language", schema: "design" },
      { path: STYLEFRAMES, what: "the styleframes on one sheet, rendered from real code", schema: null },
    ],
    commands: [
      run("motion:still", "Render styleframes from the real composition.", {
        entry: "<entry>",
        composition: "<composition>",
        frames: "<frames>",
        output: P("look/frames"),
      }),
      run(
        "review:sheet",
        "Lay them out on one sheet, if a draft render exists; otherwise combine the stills yourself.",
        { input: "<draft.mp4>", project: "{id}", output: STYLEFRAMES, count: "<n>" },
      ),
    ],
    gate: "critic",
    critic: { target: STYLEFRAMES, prefix: "look-round-", pack: false },
    done: {
      rule: "design.json validates, the sheet exists, and an independent critic's latest verdict on this exact sheet is approve-for-human.",
      checks: [],
    },
    stop: {
      maxRounds: 3,
      noProgress: "Two critic rounds without a higher total score: stop and show the user the frames.",
    },
    orchestratorChecks: {
      before: ["Styleframes come from code, not an image generator's mood board."],
      after: [
        "Open the sheet yourself. Could these frames belong to any other product? The critic judges, but you must have looked.",
      ],
    },
    forbidden: ["Telling the critic what the frames are trying to do."],
  },
  {
    id: "beat-sheet",
    title: "Beat sheet",
    purpose:
      "Plan every shot on the audio map, with what carries the eye across each boundary, before scene code exists.",
    owner: "motion-director",
    inputs: [
      { path: BRIEF, what: "the approved brief" },
      { path: CONCEPT, what: "the chosen idea" },
      { path: SCRIPT, what: "the approved script" },
      { path: SCRIPT_MAP, what: "beats on the music's sections", unlessSilence: true },
      { path: DESIGN, what: "the approved look" },
      MATERIAL_INPUT,
      NARRATION_INPUT,
      ...MUSIC_AND_REFERENCE,
    ],
    outputs: [
      { path: MOTION_PLAN, what: "shot plan with a carry on every boundary", schema: "motion-plan" },
      { path: CUE_DRAFTS, what: "cue intents to snap", schema: null, optional: true },
      { path: CUE_SHEET, what: "cues snapped to the audio map", schema: "cue-sheet", unlessSilence: true },
      {
        path: CUE_PLACEMENTS,
        what: "{fps, durationInFrames, blocks:[{id, startFrame, props}]} for sfx:cues, start frames from the cue sheet",
        schema: null,
        optional: true,
      },
      { path: PLAN_CHECK, what: "plan:check's report", schema: "verdict-report" },
    ],
    commands: [
      run(
        "edit:plan",
        "Start from the music's form: slots on phrase starts, hero hits on drops, holds on breaks, flurries on fills, a stop on the final downbeat; its cues feed edit:snap.",
        { map: AUDIO_MAP, fps: "<fps>", style: "<calm|punchy|flurry>", output: P("edit-plan.json") },
      ),
      run(
        "edit:snap",
        "Snap your intents: structural moments (cut, ground swap, hero hit) to downbeats and surges; per-kind leads apply.",
        { cues: CUE_DRAFTS, map: AUDIO_MAP, fps: "<fps>", offset: "<offset>", output: CUE_SHEET },
      ),
      run(
        "plan:check",
        "Block a slideshow, a missing carry, or a plan that misses the reference's numbers; advises on cuts off the music's form.",
        {
          project: "{id}",
          plan: MOTION_PLAN,
          "cue-sheet": CUE_SHEET,
          "audio-map": AUDIO_MAP,
          targets: TARGETS,
          output: PLAN_CHECK,
        },
      ),
    ],
    gate: "measure",
    done: {
      rule: "Plan and cue sheet validate, the cue sheet is built on the current audio map, and plan:check's verdict is pass.",
      checks: ["cues-on-map", "plan-passed"],
    },
    stop: ONE_ROUND,
    orchestratorChecks: {
      before: [
        "Has the audio map's grid trust reached the motion director through the brief? It is an input, so do not restate it.",
      ],
      after: [
        "Read the shot list aloud against the track: where does the film rest, and is it where the music rests?",
        "Does every cut, ground swap and hero hit sit on a downbeat or surge in the cue sheet, and does the last frame stop on the music's ending?",
      ],
    },
    forbidden: ["Passing plan:check by adding shots or carries that mean nothing."],
  },
  {
    id: "animatic",
    title: "Animatic",
    purpose: "Let the user feel the timing with the music, while changing it is still cheap.",
    owner: "motion-engineer",
    inputs: [
      { path: MOTION_PLAN, what: "the shot plan" },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      { path: DESIGN, what: "the approved look" },
      NARRATION_INPUT,
      ...MUSIC_AND_REFERENCE,
    ],
    outputs: [{ path: ANIMATIC, what: "the animatic with the music", schema: null }],
    commands: [
      run("motion:render", "Render the animatic with the music.", {
        entry: "<entry>",
        composition: "<composition>",
        output: ANIMATIC,
      }),
      run("review:sheet", "Look at it before anyone else does.", {
        input: ANIMATIC,
        project: "{id}",
        output: P("animatic-sheet.jpg"),
      }),
    ],
    gate: "user",
    done: {
      rule: "The animatic file exists and is not empty, the film's code in src/projects/ passes the render lint (pnpm lint --project), and the user approved this exact file.",
      checks: ["project-lint-clean"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "The user sends the same timing note twice: stop and ask them to mark the moment in the video.",
    },
    question: { text: "Watch it with sound. Does the timing work, and where does it drag?", show: [ANIMATIC] },
    orchestratorChecks: {
      before: ["Rough shapes are right here: polish before this gate is wasted."],
      after: [
        "Watch it with sound yourself first, or read its strip and the cue sheet if you cannot play sound, and say which you did.",
      ],
    },
    forbidden: ["Skipping the animatic because the plan passed its check."],
  },
  {
    id: "build",
    title: "Build",
    purpose: "Build the scenes to the approved animatic and look at them frame by frame.",
    owner: "motion-engineer",
    inputs: [
      { path: ANIMATIC, what: "the approved animatic" },
      { path: MOTION_PLAN, what: "the shot plan" },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      { path: CUE_PLACEMENTS, what: "library blocks at their start frames, for sfx:cues", optional: true },
      { path: DESIGN, what: "the approved look" },
      MATERIAL_INPUT,
      NARRATION_INPUT,
      ...MUSIC_AND_REFERENCE,
      { path: REPLICA_SPEC, what: "the approved replica spec: build each shot to its numbers", onlyFor: REPLICA },
    ],
    outputs: [
      { path: BUILD, what: "the composition id and entry", schema: "build" },
      {
        path: SOUND_CUES,
        what: "draft cue sounds the composition plays with <CueSounds>",
        schema: null,
        optional: true,
      },
      { path: MOTION_CHECK, what: "motion:check's result", schema: "envelope" },
    ],
    commands: [
      run("motion:strip", "Look at every transition frame by frame.", {
        input: "<draft.mp4>",
        output: P("strips/<name>.jpg"),
        "start-sec": "<a>",
        "end-sec": "<b>",
        diff: true,
      }),
      run("sfx:cues", "Sounds on the blocks' cue frames, for <CueSounds> in drafts; the sound step replaces them.", {
        placements: CUE_PLACEMENTS,
        "motion-plan": "?{decidedPlan}",
        "cue-sheet": "?{cueSheet}",
        output: SOUND_CUES,
      }),
      run("film:stills", "Stills at each cue, to compare with the plan.", {
        project: "{id}",
        entry: "<entry>",
        composition: "<composition>",
        "cue-sheet": CUE_SHEET,
      }),
      run("ref:compare", "Compare a draft with the reference, when there is one.", {
        id: "<reference-id>",
        render: "<draft.mp4>",
      }),
      run("blender:run", "Only when a shot needs Blender.", {
        script: "<scene.py>",
        output: "{dir}/assets/blender/<shot>",
      }),
      run("vork:render", "Only for a qualified Vork shot; inspect warnings and import the receipt-bound output.", {
        scene: "<scene.json>",
        output: "{dir}/assets/vork/<shot>",
      }),
      run("hyperframes:render", "Only when a shot needs HTML capture.", {
        "project-dir": "<dir>",
        output: "{dir}/assets/hyperframes/<shot>.mp4",
      }),
      run("asset:import", "Register any original media.", { project: "{id}", input: "<file>", origin: "<origin>" }),
      run(
        "shot:tournament",
        "Each hero shot: render 2-3 variants, sensors and corpus distance, blind pairs for a critic; then --action judge.",
        { action: "prepare", project: "{id}", shot: "<hero-shot-id>", variants: "<CompA,CompB[,CompC]>" },
      ),
      run(
        "motion:check",
        "Sensor over the composition; its result is kept. The safe zone is the brief's format.",
        { entry: "?{entry}", composition: "<composition>", project: "{id}", "safe-zone": "?{format}" },
        MOTION_CHECK,
      ),
    ],
    gate: "measure",
    done: {
      rule: "build.json names the composition, the film's code in src/projects/ passes the render lint (pnpm lint --project), motion:check's result is ok, and every hero shot's tournament is decided for what the build mounts.",
      checks: ["project-lint-clean", "motion-check-passed", "tournament-decided"],
    },
    stop: ONE_ROUND,
    orchestratorChecks: {
      before: ["The animatic is approved. Changes to timing go back there, not into the build."],
      after: ["Open strips of two transitions yourself: a clean check does not say it looks good."],
    },
    forbidden: ["Adding an allow entry to motion:check to pass it without a stated reason."],
  },
  {
    id: "sound",
    title: "Sound",
    purpose:
      "Make sound half the film: every action heard, layered, with deliberate silences, then mixed and measured.",
    owner: "sound-director",
    inputs: [
      { path: BUILD, what: "what was built" },
      { path: MOTION_PLAN, what: "the shot plan" },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      { path: CUE_PLACEMENTS, what: "library blocks at their start frames, for sfx:cues", optional: true },
      { path: SOUND_CUES, what: "the build's draft cue sounds, replaced in key", optional: true },
      NARRATION_INPUT,
      ...MUSIC_AND_REFERENCE,
      {
        path: REPLICA_SPEC,
        what: "the approved replica spec: each shot's cues are the reference's sound timing",
        onlyFor: REPLICA,
      },
    ],
    outputs: [
      {
        path: SFX_SELECTION,
        what: "each hero sound chosen from measured candidates (sfx:audition)",
        schema: "sfx-selection",
        optional: true,
        unlessSilence: true,
      },
      { path: MIX_PLAN, what: "the local mix plan with SFX on events", schema: null },
      { path: MASTER, what: "the mixed master", schema: null },
      { path: MIX_REPORT, what: "audio:mix's result with its loudness", schema: "envelope" },
    ],
    commands: [
      run("music:backtime", "Land the track's ending on the end card.", {
        map: AUDIO_MAP,
        "film-sec": "<seconds>",
        "end-card-frame": "<frame>",
        fps: "<fps>",
      }),
      run("sfx:synth", "A procedural pack in the film's key.", { project: "{id}", key: "<root>" }),
      run(
        "sfx:audition",
        "Each hero cue's sound chosen from measured candidates (pack, library, Earshot takes via --earshot-takes), with Earshot's advisory audit when prepared.",
        { project: "{id}", "cue-sheet": "?{cueSheet}", pack: "{dir}/assets/sfx/synth", output: SFX_SELECTION },
      ),
      run("sfx:cues", "After writing mix-plan.json: sounds on the blocks' cue frames, merged into it.", {
        placements: CUE_PLACEMENTS,
        "motion-plan": "?{decidedPlan}",
        "cue-sheet": "?{cueSheet}",
        selection: "?{sfxSelection}",
        pack: "{dir}/assets/sfx/synth",
        output: SOUND_CUES,
        "plan-output": MIX_PLAN,
        merge: MIX_PLAN,
      }),
      run("sfx:library", "Find a sound for each action the blocks do not cue.", {
        action: "find",
        query: "<what is heard>",
        duration: "<seconds>",
      }),
      run(
        "audio:mix",
        "Mix locally to social loudness and keep the result.",
        { plan: MIX_PLAN, output: MASTER, preset: "social" },
        MIX_REPORT,
      ),
    ],
    gate: "measure",
    done: {
      rule: "The mix plan and master exist, and audio:mix's result is ok; every hero sound cue was chosen from measured candidates (sfx-selection.json for the current cue sheet) and its chosen sound is what sfx:cues placed; film:measure then holds the master to the loudness target.",
      checks: ["mix-passed", "hero-sounds-selected"],
    },
    stop: ONE_ROUND,
    orchestratorChecks: {
      before: [
        "Is the delivery native-on-platform? Then the film ships without the track: the mix is for review only.",
      ],
      after: ["Listen, or say you could not. Which two moments are silent on purpose?"],
    },
    forbidden: ["Delivering a preview or a study-only track in the mix."],
  },
  {
    id: "measure",
    title: "Measure",
    purpose: "Render, and compare the film with the reference's numbers before anyone spends taste on it.",
    owner: "script",
    inputs: [
      { path: TARGETS, what: "the targets" },
      { path: DECISION, what: "the music" },
      { path: AUDIO_MAP, what: "the audio map", unlessSilence: true },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      { path: BUILD, what: "what was built" },
      { path: MOTION_CHECK, what: "the sensor result" },
      { path: MASTER, what: "the master" },
    ],
    outputs: [
      { path: RENDER, what: "the film", schema: null },
      { path: MEASURE, what: "measurement against the targets", schema: "film-measure" },
    ],
    commands: [
      run("film:render", "Render the film.", {
        project: "{id}",
        composition: "{composition}",
        entry: "?{entry}",
        audio: MASTER,
        decision: DECISION,
        output: RENDER,
      }),
      run("film:measure", "Compare it with the targets.", {
        project: "{id}",
        render: RENDER,
        targets: TARGETS,
        "audio-map": "?{audioMap}",
        "cue-sheet": "?{cueSheet}",
        decision: DECISION,
        output: MEASURE,
      }),
    ],
    gate: "measure",
    done: {
      rule: "film-measure.json validates, its verdict is pass, and its render hash is the hash of the current film.",
      checks: ["measure-passed"],
    },
    stop: {
      maxRounds: 3,
      noProgress: "Three renders sent to the fixer and still failing: stop and show the user the failing legs.",
    },
    fixerInputs: [
      { path: MEASURE, what: "the failing legs and their fixes" },
      { path: BUILD, what: "what was built" },
      { path: MOTION_PLAN, what: "the shot plan" },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      ...MUSIC_AND_REFERENCE,
    ],
    orchestratorChecks: {
      before: ["Do not argue with a number: a target that seems wrong is a question for the user."],
      after: ["Which legs were skipped, and why? A skipped leg is not a pass."],
    },
    forbidden: ["Changing the targets so that the film passes."],
  },
  {
    id: "replica-compare",
    title: "Replica compare",
    purpose:
      "Render, and hold the film to the reference shot by shot at the replica tolerances, sending findings to the fixer in severity order.",
    owner: "script",
    inputs: [
      { path: REPLICA_SPEC, what: "the approved spec: its swapped shots are exempt from colour" },
      { path: REPLICA_SHOTS, what: "the spec's shots, so pairing does not depend on the detector" },
      { path: DECISION, what: "the music" },
      { path: BUILD, what: "what was built" },
      { path: MOTION_CHECK, what: "the sensor result" },
      { path: MASTER, what: "the master" },
    ],
    outputs: [
      { path: RENDER, what: "the film", schema: null },
      { path: REPLICA_COMPARE, what: "ref:compare's result at the replica tolerances", schema: "envelope" },
    ],
    commands: [
      run("film:render", "Render the film.", {
        project: "{id}",
        composition: "{composition}",
        entry: "?{entry}",
        audio: MASTER,
        decision: DECISION,
        output: RENDER,
      }),
      run(
        "ref:compare",
        "Compare it with the reference, shot by shot, at the replica tolerances.",
        {
          id: "{referenceId}",
          render: RENDER,
          "render-shots": REPLICA_SHOTS,
          tolerance: "replica",
          project: "{id}",
          "library-root": "{library}",
        },
        REPLICA_COMPARE,
      ),
    ],
    gate: "measure",
    done: {
      rule: "ref:compare ran in replica mode on the current film, and no measure in summary.withinTolerance has a failed shot.",
      checks: ["replica-within-tolerance"],
    },
    stop: {
      maxRounds: 5,
      noProgress:
        "Five renders sent to the fixer and still outside tolerance: report each residual with its shot, numbers and strip, and ask the user whether to continue.",
    },
    fixerInputs: [
      {
        path: REPLICA_COMPARE,
        what: "the findings, fixed in severity order: alignment and cuts, then timing, camera, colour",
      },
      { path: REPLICA_SPEC, what: "the approved spec" },
      { path: BUILD, what: "what was built" },
      {
        path: REFERENCE_DIR,
        what: "the reference, for motion:strip --vs on every shot with a finding",
        optional: true,
        untracked: true,
      },
    ],
    onlyFor: REPLICA,
    orchestratorChecks: {
      before: ["The spec was approved and the build passed motion:check."],
      after: [
        "Every notMeasured count is checked by strip, not assumed held. Within tolerance is measured close, not approved: the user judges.",
      ],
    },
    forbidden: [
      "Changing the spec or the tolerances so that the film passes.",
      "Reading a single similarity number as a pass.",
    ],
  },
  {
    id: "critic",
    title: "Independent critic",
    purpose:
      "Have a critic who knows nothing of how the film was made judge what is on screen, a new critic each round.",
    owner: "creative-critic",
    inputs: [
      { path: RENDER, what: "the film" },
      { path: MEASURE, what: "the measurement that this film passed" },
    ],
    outputs: [],
    commands: [],
    gate: "critic",
    critic: { target: RENDER, prefix: "round-", pack: true },
    done: {
      rule: "The latest critique's render hash is the current film's, and its verdict is approve-for-human.",
      checks: [],
    },
    stop: {
      maxRounds: 3,
      noProgress: "Two rounds without a higher total score: stop and show the user the film and both critiques.",
    },
    selfSealing: true,
    fixerInputs: [
      { path: "{previousCritique}", what: "the critic's verdict and actions" },
      { path: BUILD, what: "what was built" },
      { path: MOTION_PLAN, what: "the shot plan" },
      { path: CUE_SHEET, what: "the cues", unlessSilence: true },
      ...MUSIC_AND_REFERENCE,
    ],
    orchestratorChecks: {
      before: ["Start a new agent, never resume the last critic. Add nothing to the brief: --note is refused here."],
      after: [
        "Hand actions to the fixer as written. If you disagree with a score, tell the user; do not re-run until it changes.",
      ],
    },
    forbidden: [
      "Passing the critic the maker's reasoning, the spine, the concept or the plan.",
      "Resuming a previous critic.",
    ],
  },
  {
    id: "human",
    title: "Human verdict",
    purpose: "The film is finished only when the user has watched it and said so.",
    owner: "user",
    inputs: [{ path: RENDER, what: "the film" }],
    outputs: [{ path: RENDER, what: "the film the user watched", schema: null }],
    commands: [],
    gate: "user",
    done: { rule: "A recorded approval of this exact render.", checks: [] },
    stop: {
      maxRounds: 1,
      noProgress:
        "The user decides. What should change goes, in their words, to `pnpm feedback`: it routes each item to its step and reopens that step and everything after it.",
    },
    question: {
      text: "Watch the film. Do you accept it, what should change, and what should we remember for the next one?",
      show: [RENDER],
    },
    selfSealing: true,
    requires: ["critic"],
    orchestratorChecks: {
      before: ["Show the film itself, and say plainly what you did and did not look at or listen to."],
      after: [
        "Only what the user confirms goes to design-reference/creative-lessons.md.",
        "A change the user asks for goes through `pnpm feedback --file <items.json>`, quoted in their words: show them its preview, and add --confirm only on their yes.",
      ],
    },
    forbidden: ["Reading a critic's approval as the user's."],
  },
]);

export const stepById = (id: string): ChainStep | undefined => FILM_CHAIN.find((step) => step.id === id);

/** Definitions that arrive in the next wave. tests/film-chain.test.ts fails when one of these appears, so the list is pruned. */
export const PENDING_AGENTS = [] as const;
/** Rule files that arrive in the next wave. */
export const PENDING_RULES = [] as const;
export const RULE_FILES = ["design-reference/creative-standards.md", "design-reference/creative-lessons.md"] as const;
const STANDARDS = "design-reference/creative-standards.md";
const LESSONS = "design-reference/creative-lessons.md";
const CRAFT = "design-reference/craft-rules.md";
/** Rule files each brief lists; `library` and `spine` are expanded by film:brief. Steps not named get none. */
export const STEP_RULES: Record<string, string[]> = {
  music: ["docs/audio-integrations.md"],
  material: [
    "docs/audio-integrations.md",
    ".agents/skills/model-and-asset-production/SKILL.md",
    "docs/higgsfield-prompting.md",
  ],
  sound: ["docs/audio-integrations.md"],
  strategy: [STANDARDS, LESSONS],
  ideas: [STANDARDS, LESSONS, "spine"],
  concept: ["library"],
  "script-variants": [STANDARDS, LESSONS],
  look: [STANDARDS, CRAFT, "library"],
  "beat-sheet": [CRAFT, "library"],
  animatic: [CRAFT, "library"],
  build: [CRAFT, "library"],
  fixer: [CRAFT, "library"],
  "replica-reference": [".agents/skills/reference-analysis/SKILL.md", REPLICA_SKILL],
  "replica-spec": [REPLICA_SKILL, REPLICA_SPEC_RULES, "library"],
};
export const CRITIC_AGENT = "creative-critic";
export const FIXER_AGENT = "fixer";

export const stepOwnerKind = (step: ChainStep): "agent" | "script" | "user" =>
  step.owner === "script" ? "script" : step.owner === "user" ? "user" : "agent";

/** Consistency of the chain itself: returns problems, empty when sound. */
export function chainProblems(chain: readonly ChainStep[] = FILM_CHAIN): string[] {
  const problems: string[] = [];
  const produced = new Set<string>();
  for (const step of chain) {
    if (!step.purpose.endsWith(".")) problems.push(`${step.id}: purpose is not a sentence`);
    if ((step.gate === "user" || step.owner === "user") && !step.question)
      problems.push(`${step.id}: a user gate needs a question`);
    if (step.gate === "critic" && !step.critic) problems.push(`${step.id}: a critic gate needs a target`);
    if (!step.selfSealing && !step.fanOut && step.outputs.every((output) => output.optional))
      problems.push(`${step.id}: nothing to seal`);
    if (step.critic?.fixBy && !chain.some((other) => other.id === step.critic!.fixBy && other.fanOut))
      problems.push(`${step.id}: fixBy names no fan-out step`);
    if (step.fanOut && step.gate !== "none") problems.push(`${step.id}: a fan-out step is judged by the step after it`);
    if (step.stop.maxRounds < 1) problems.push(`${step.id}: no stop rule`);
    if (!step.done.rule) problems.push(`${step.id}: no done rule`);
    if (!step.orchestratorChecks.before.length || !step.orchestratorChecks.after.length)
      problems.push(`${step.id}: no orchestrator checks`);
    if (!step.forbidden.length) problems.push(`${step.id}: no forbidden moves`);
    for (const input of step.inputs) {
      const fromChain = input.path.startsWith("{dir}/pipeline/") || input.path.startsWith("out/");
      if (fromChain && !input.optional && input.path !== SOURCES && !produced.has(input.path) && !step.selfSealing)
        problems.push(`${step.id}: required input ${input.path} has no earlier producer`);
    }
    for (const output of step.outputs) produced.add(output.path);
  }
  return problems;
}

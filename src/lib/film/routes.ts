import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FILM_CHAIN, SOURCES, STEP_RULES, type ChainStep } from "./chain";
import { FilmTypeSchema, type FilmType } from "../../types/pipeline";

/**
 * The film's type, chosen first, decides its route: which chain steps run, where its material comes from, which tools each
 * step reaches for, how the reference is used and what QA looks at hardest. The chain (chain.ts) stays one list of steps with
 * fixed owners; a route switches steps off and hands each step its tools. See docs/film-types.md.
 */

export const FILM_TYPES = FilmTypeSchema.options;
export const DEFAULT_FILM_TYPE: FilmType = "motion-graphics";

/** `command`: a package.json alias. `block`: a motion library id. `category`: a library category. `skill`: .agents/skills/<id>. `path`: a repository path. */
export type RouteTool = { kind: "command" | "block" | "category" | "skill" | "path"; id: string; use: string };

export type FilmTypeRoute = {
  type: FilmType;
  title: string;
  /** The line the user picks from at intake. */
  line: string;
  /** Steps this type does not run. `material` is off unless `material` is set. */
  off: string[];
  /** Outside media this type is made of; switches the material step on. */
  material?: string;
  /** The voice this type is spoken in; switches the narration step on (skippable when the script has no voice). */
  narration?: string;
  tools: Partial<Record<string, RouteTool[]>>;
  reference: string;
  qa: string[];
  /** A route outside the bespoke chain that fits supplied media better: its next-step command, guide and owning agent. */
  workflow?: RouteWorkflow;
};

export type RouteWorkflow = { command: string; guide: string; agent?: string; when: string };

const OWN_FOOTAGE = {
  command: "pnpm footage:next --project <id>",
  guide: "docs/footage-editing.md",
  agent: "footage-editor",
} as const;

const cmd = (id: string, use: string): RouteTool => ({ kind: "command", id, use });
const block = (id: string, use: string): RouteTool => ({ kind: "block", id, use });
const category = (id: string, use: string): RouteTool => ({ kind: "category", id, use });
const skill = (id: string, use: string): RouteTool => ({ kind: "skill", id, use });
const repoPath = (id: string, use: string): RouteTool => ({ kind: "path", id, use });

const IMPORT = cmd("asset:import", "register every original file with its origin, before a scene uses it");
const STOCK = [
  cmd(
    "resources",
    "search and acquire licensed stock, ranked for the frame (`--action search --provider auto|unsplash|pexels|pixabay|openverse|wikimedia --kind image|video|audio --format vertical --zoom 1.3`), with rights recorded",
  ),
  skill("resource-discovery", "licence evidence and provenance for every outside file"),
];
const PAID = skill("model-and-asset-production", "durable paid jobs with budget admission; never an ad hoc API call");
const LIBRARY = cmd("library:list", "library blocks first; write code only for what no block shows");
/** The narration step's tools; its own commands (generate:voiceover, voiceover:local, speech:local, narration:check) come from the chain. */
const NARRATION_TOOLS = [
  cmd("elevenlabs:capabilities", "offline speech profiles and production command contracts"),
  cmd("voices", "explicit account/shared voice discovery; user selection is separate"),
  skill("directing-and-performance", "the narrator's intention per beat: tags, pauses, emphasis"),
];
/** Speech that is not the narrator; narrator takes belong to the narration step, never to sound. */
const OPTIONAL_SPEECH = [
  cmd("generate:dialogue", "optional explicitly authored speaker/scene turns, never inferred dialogue"),
];
/** The reference's sound events by family: written once by the reference step, compared by the sound step and the critic. */
const SFX_MAP = cmd(
  "sfx:map",
  "optional prepared Earshot (earshot-find): the reference's candidate sound events by family into <reference>/sfx-map.json; densities to compare, never a verdict",
);
const OPTIONAL_AUDIO = [
  SFX_MAP,
  cmd("sfx:find-segment", "optional prepared Earshot source-clock candidates; retain source hash and review context"),
  cmd("audio:review", "optional advisory SFX artifact evidence; existing mix QA and user listening remain"),
];
const CUE_SOUNDS = cmd("sfx:cues", "sounds on the blocks' own cue frames");

export const FILM_ROUTES: Record<FilmType, FilmTypeRoute> = {
  "motion-graphics": {
    type: "motion-graphics",
    title: "Motion graphics",
    line: "an animated product or promo film built from type, shapes, UI and 3D, with no outside footage",
    off: [],
    tools: {
      look: [
        LIBRARY,
        category("kinetic", "GSAP type builds seeked to the frame"),
        block("type-hero-word", "type as the shot at 50-95% width"),
        block("blender-plate", "a hero product as a Blender plate"),
        skill("engine-selection", "Remotion, three.js, Blender or Vork per shot"),
      ],
      "beat-sheet": [
        LIBRARY,
        category("kinetic", "type builds"),
        category("transitions", "ground swaps and caused morphs as cut devices"),
      ],
      build: [
        LIBRARY,
        category("kinetic", "type builds"),
        block("blender-plate", "hero product"),
        skill("blender-3d", "photoreal product shots"),
        skill("vork-3d-vfx", "qualified procedural GPU shots and Blender hand-offs"),
        cmd("vork:recipe", "discover tested local 3D/VFX recipes"),
        CUE_SOUNDS,
      ],
      sound: [...OPTIONAL_AUDIO, cmd("sfx:synth", "a pack in the film's key"), CUE_SOUNDS],
    },
    reference:
      "A motion-design film: measure its pace and sync; take its type scale, grounds and carries, never its frames.",
    qa: [
      "Type scale bimodal, never mid-size",
      "Every cut caused or on a downbeat",
      "No sparing block without a reason in the plan",
    ],
  },
  "ui-demo": {
    type: "ui-demo",
    title: "UI demo",
    line: "the real product's screens in use: a web or mobile app recorded and staged at reading scale",
    off: [],
    material: "captures of the real product's screens, recorded frame by frame",
    narration: "a narrator walking through the product; skipped when the demo has no voice",
    tools: {
      narration: NARRATION_TOOLS,
      material: [
        cmd("capture:app", "record the product's web app frame by frame on the page clock"),
        cmd("capture:html", "capture a local HTML page or prototype"),
        IMPORT,
      ],
      look: [
        LIBRARY,
        category("ui", "the real-UI kit at reading scale"),
        block("ui-camera-read", "a camera that reads the UI"),
      ],
      "beat-sheet": [
        category("ui", "UI blocks"),
        block("ui-camera-read", "read the screen: push, pan, hold on what the beat uses"),
      ],
      build: [category("ui", "UI blocks"), block("ui-camera-read", "camera over the captured screen"), CUE_SOUNDS],
      sound: [...OPTIONAL_AUDIO, cmd("sfx:synth", "clicks and soft UI sounds in key"), CUE_SOUNDS],
    },
    reference:
      "A product-demo film: match how long a screen is held and how close the camera reads it; take no layouts.",
    qa: [
      "UI text readable at phone size (26 px after the push)",
      "Real captures, no drawn placeholder in the final",
      "The click and the state change land on the beat",
    ],
  },
  footage: {
    type: "footage",
    title: "Footage",
    line: "live footage or b-roll, stock or supplied, cut to music with type over picture",
    off: [],
    material: "licensed stock or supplied clips, chosen as selects with in and out points",
    tools: {
      material: [...STOCK, IMPORT],
      look: [
        skill("cinematography", "grade, framing and continuity of the selects"),
        block("type-hero-word", "type between shots"),
        category("typography", "captions over picture at ~10% width"),
      ],
      "beat-sheet": [skill("editorial-storytelling", "motivated cuts and holds on real shots")],
      build: [
        skill("editorial-storytelling", "cutting selects"),
        category("typography", "captions over picture"),
        CUE_SOUNDS,
      ],
      sound: [...OPTIONAL_AUDIO, cmd("sfx:library", "foley for what the footage shows"), CUE_SOUNDS],
    },
    reference:
      "A cut-to-music footage film: measure cut rate and sync; match the grade's contrast and the caption scale.",
    qa: [
      "Every clip licensed for this use, with provenance",
      "No clip looks like generic stock next to the idea",
      "Captions small and out of the subject's way",
    ],
    workflow: {
      ...OWN_FOOTAGE,
      when: "the film is cut from the user's own footage or recordings, keeping their speech",
    },
  },
  "ai-video": {
    type: "ai-video",
    title: "AI video",
    line: "shots generated by video models, directed shot by shot, within an authorised budget",
    off: [],
    material: "generated stills and video shots, each with model, prompt, operation id and cost",
    narration: "an optional narrator over the generated shots; skipped when the film has no voice",
    tools: {
      narration: NARRATION_TOOLS,
      material: [
        cmd("generate:dialogue", "prepare approved, timed character lines before a speech-driven shot"),
        cmd("refs:pack", "bind a performed line or native dialogue to the exact shot request and review its result"),
        cmd("generate:image", "key frames first, cheap, for approval"),
        cmd(
          "model:prepare",
          "prepare and approve Genjutsu source segments, references, marker prompts and source-use rights before generation",
        ),
        cmd(
          "motion:library",
          "find dated local remix candidates; acquire originals separately with provenance and budget",
        ),
        cmd("generate:model", "fal/Higgsfield video and image jobs with --project budgets and --max-cost-usd"),
        PAID,
        skill("world-and-entity-bible", "one card per character and object, reused in every prompt"),
        IMPORT,
      ],
      look: [
        skill("cinematography", "framing, light and camera per generated shot"),
        skill("world-and-entity-bible", "consistency across shots"),
      ],
      "beat-sheet": [skill("cinematography", "shot sizes and camera moves the models can hold")],
      build: [
        skill("editorial-storytelling", "cutting generated shots"),
        category("typography", "type over picture"),
        CUE_SOUNDS,
      ],
      sound: [...OPTIONAL_AUDIO, cmd("sfx:library", "foley for generated action"), CUE_SOUNDS],
    },
    reference:
      "A film of similar shots: match shot length and camera grammar; never prompt for the reference's look by name.",
    qa: [
      "Characters and objects consistent across shots",
      "No model artefacts: hands, text, morphing edges",
      "Spend within the authorised bound, per material.json",
    ],
  },
  "talking-head": {
    type: "talking-head",
    title: "Talking head",
    line: "a presenter or UGC creator speaking to camera, recorded, with captions and inserts",
    off: [],
    material: "the presenter's recorded takes, with release, plus any inserts",
    tools: {
      material: [
        skill("recording-guide", "plan the shoot: framing, sound, takes, release"),
        skill("directing-and-performance", "the presenter's intentions and delivery"),
        IMPORT,
      ],
      look: [
        repoPath("src/templates/talkinghead", "talking-head layouts and karaoke captions"),
        skill("captions-and-localization", "caption profiles"),
      ],
      "beat-sheet": [skill("recording-recut", "cuts inside the recorded speech, kept reversible")],
      build: [
        repoPath("src/templates/talkinghead", "TalkingHeadVideo and KaraokeCaptions"),
        skill("captions-and-localization", "timed captions"),
        CUE_SOUNDS,
      ],
      sound: [
        ...OPTIONAL_AUDIO,
        cmd("speech:replace", "plan and apply an explicitly reviewed phrase replacement in a timeline project"),
        cmd(
          "audio:transform",
          "requested isolation or voice conversion as a derived take with new timing/clock review",
        ),
        skill("sound-design-and-mix", "dialogue first, music ducked under speech"),
      ],
    },
    reference: "A presenter film: match the cut rate inside speech and the caption style; never the person.",
    qa: [
      "Speech intelligible, music ducked under it",
      "Captions timed to the words and readable",
      "No cut breaks a sentence's meaning",
    ],
    workflow: { ...OWN_FOOTAGE, when: "the recordings exist and the job is to select and cut them" },
  },
  explainer: {
    type: "explainer",
    title: "Explainer",
    line: "teaching an idea with diagrams, data and worked examples, usually with a voice",
    off: [],
    narration: "a narrator who teaches; the diagrams are timed to the voice",
    tools: {
      narration: [...NARRATION_TOOLS, skill("script-and-education", "language-aware timing of the spoken lesson")],
      look: [
        LIBRARY,
        category("data", "charts, counters and diagrams that build"),
        skill("script-and-education", "accurate, sourced explanation"),
      ],
      "beat-sheet": [
        category("data", "one idea per diagram state"),
        block("before-after-split", "a change made visible"),
      ],
      build: [category("data", "data blocks"), category("kinetic", "labels that build"), CUE_SOUNDS],
      sound: [...OPTIONAL_AUDIO, ...OPTIONAL_SPEECH, skill("sound-design-and-mix", "voice first, music low")],
    },
    reference: "An explainer: match how long each idea is held and how a diagram builds; take no diagram.",
    qa: [
      "Every number and claim sourced",
      "One idea on screen at a time, held long enough to read",
      "Diagrams change state in place rather than cut",
    ],
    workflow: {
      command: "pnpm video:workflow --scenario education",
      guide: "docs/workflows/education.md",
      when: "a source-backed lesson with chapters and timed captions",
    },
  },
  collage: {
    type: "collage",
    title: "Collage",
    line: "mixed media: cut-out photos, paper, texture and type assembled on a flat field",
    off: [],
    material: "photos and textures cut out, with licence, plus any generated pieces",
    tools: {
      material: [
        ...STOCK,
        cmd("rmbg", "cut a subject out of its background, with budget tracking"),
        cmd("generate:image", "pieces no stock source has, within budget"),
        PAID,
        IMPORT,
      ],
      look: [
        block("paper-collage-assemble", "halftone cut-outs assembling on a flat field"),
        category("effects", "film damage, tape, paper when the idea is that material"),
      ],
      "beat-sheet": [
        block("paper-collage-assemble", "assemblies per beat"),
        category("transitions", "caused carries between collages"),
      ],
      build: [block("paper-collage-assemble", "collage scenes"), category("effects", "material effects"), CUE_SOUNDS],
      sound: [...OPTIONAL_AUDIO, cmd("sfx:library", "paper, tape and print sounds"), CUE_SOUNDS],
    },
    reference: "A collage film: match the density of a frame and how pieces arrive; take no cut-outs.",
    qa: [
      "Every cut-out licensed for modification",
      "Clean cut edges at full size",
      "A frame reads as one composition, not a pile",
    ],
  },
  replica: {
    type: "replica",
    title: "Replica",
    line: "an exact copy of one given film, shot for shot and frame for frame, with only what the user names swapped (only when they ask to copy a film, not for a film in its style)",
    off: [
      "truth",
      "reference",
      "strategy",
      "discovery",
      "ideas",
      "idea-review",
      "concept",
      "script-variants",
      "script-review",
      "script",
      "look",
      "beat-sheet",
      "animatic",
      "measure",
      "critic",
    ],
    material:
      "the user's replacements for what another owner holds: their real product's screens, logos, copy assets and licensed media, each a swap in the spec",
    tools: {
      "replica-reference": [
        skill("reference-analysis", "measured and judged layers; edit.json corrections fix the shot list"),
        cmd("ref:validate", "every layer valid before the spec"),
      ],
      "replica-spec": [
        skill("reference-replica", "the spec's rows, the rights gate and the tolerances"),
        LIBRARY,
        cmd("ref:replica-check", "until passed; --write-shots writes replica-shots.json"),
      ],
      music: [
        skill(
          "reference-replica",
          "another owner's music and voice are replaced: the reference's own track is study-only and ships only on the user's owned or licensed answer",
        ),
      ],
      material: [cmd("capture:app", "the user's real product screens, per docs/real-ui.md"), ...STOCK, IMPORT],
      build: [
        LIBRARY,
        skill("reference-replica", "each block's props set to the spec's numbers, not its defaults"),
        repoPath("docs/real-ui.md", "product screens 90-100% identical to the user's real product"),
        cmd("motion:strip", "--vs the reference, shot by shot"),
        CUE_SOUNDS,
      ],
      sound: [
        ...OPTIONAL_AUDIO,
        skill("sound-design-and-mix", "the reference's sound timing with the user's own or licensed sounds"),
        CUE_SOUNDS,
      ],
      "replica-compare": [
        cmd(
          "motion:strip",
          "--vs the reference on every shot with a finding, every camera move, transition and the climax",
        ),
      ],
    },
    reference:
      "The film itself: every shot, cut, move, ease, colour and type size is measured from it and rebuilt within the replica tolerances; another owner's brand, characters, copy, voice and music are replaced.",
    qa: [
      "No measure in summary.withinTolerance has a failed shot; notMeasured checked by strip",
      "Nothing of another owner's brand, characters, copy, voice or music remains",
      "Product screens are the user's real product",
    ],
  },
};

/** Types that are a route of their own and never join another as a hybrid. */
export const STANDALONE_TYPES: readonly FilmType[] = ["replica"];

export const filmTypeOf = (value: unknown): FilmType | undefined => {
  const result = FilmTypeSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

export type ResolvedStep = {
  id: string;
  title: string;
  agent: string;
  gate: ChainStep["gate"];
  inputs: { path: string; what: string; optional: boolean }[];
  outputs: { path: string; what: string; schema: string | null; optional: boolean }[];
  rules: string[];
  tools: RouteTool[];
};

export type ResolvedRoute = {
  type: FilmType;
  secondary?: FilmType;
  /** True when the brief named no type and the default was used. */
  defaulted: boolean;
  title: string;
  material?: string;
  reference: string;
  qa: string[];
  workflow?: FilmTypeRoute["workflow"];
  steps: ResolvedStep[];
  skipped: string[];
};

/** The route a workflow names, as one sentence fragment for docs and warnings. */
export const workflowText = (workflow: RouteWorkflow) =>
  `${workflow.agent ? `the \`${workflow.agent}\` agent with ` : ""}\`${workflow.command}\` (guide ${workflow.guide})`;

export const routeOf = (type: FilmType): FilmTypeRoute => FILM_ROUTES[type];

/** The chain as this type sees it: steps kept for other types are left out, so they are neither listed nor counted. */
export const chainFor = (type: FilmType): ChainStep[] =>
  FILM_CHAIN.filter((step) => !step.onlyFor || step.onlyFor.includes(type));

/** Whether a step runs for this type (and its hybrid partner). */
export function stepEnabled(stepId: string, type: FilmType, secondary?: FilmType): boolean {
  const onlyFor = FILM_CHAIN.find((step) => step.id === stepId)?.onlyFor;
  if (onlyFor && !onlyFor.includes(type)) return false;
  const routes = [routeOf(type), ...(secondary ? [routeOf(secondary)] : [])];
  if (stepId === "material") return routes.some((route) => route.material !== undefined);
  if (stepId === "narration") return routes.some((route) => route.narration !== undefined);
  return !routes[0]!.off.includes(stepId);
}

export function toolsFor(stepId: string, type: FilmType, secondary?: FilmType): RouteTool[] {
  const visualisationTools: RouteTool[] = ["motion", "animatic", "build", "qa"].includes(stepId)
    ? ["viz:list", "viz:prepare", "viz:preview", "viz:render", "viz:mount", "viz:check"].map((id) => ({
        kind: "command",
        id,
        use: "Prepare, inspect and mount pinned data visualisations; elkjs 0.12.1 has a package-specific EPL-2.0 owner review",
      }))
    : [];
  const referenceTools: RouteTool[] = stepId === "reference" ? [SFX_MAP] : [];
  const tools = [
    ...visualisationTools,
    ...referenceTools,
    ...(routeOf(type).tools[stepId] ?? []),
    ...(secondary ? (routeOf(secondary).tools[stepId] ?? []) : []),
  ];
  return tools.filter(
    (tool, index) => tools.findIndex((other) => other.kind === tool.kind && other.id === tool.id) === index,
  );
}

/** Paths only a disabled step produces: a consumer reads them as optional. */
export function absentOutputs(type: FilmType, secondary?: FilmType): Set<string> {
  const enabled = FILM_CHAIN.filter((step) => stepEnabled(step.id, type, secondary));
  const made = new Set(enabled.flatMap((step) => step.outputs.map((output) => output.path)));
  return new Set(
    FILM_CHAIN.filter((step) => !stepEnabled(step.id, type, secondary))
      .flatMap((step) => step.outputs.map((output) => output.path))
      .filter((file) => !made.has(file)),
  );
}

export function resolveRoute(type: FilmType | undefined, secondary?: FilmType): ResolvedRoute {
  const chosen = type ?? DEFAULT_FILM_TYPE;
  const partner =
    secondary && secondary !== chosen && !STANDALONE_TYPES.includes(chosen) && !STANDALONE_TYPES.includes(secondary)
      ? secondary
      : undefined;
  const route = routeOf(chosen);
  const absent = absentOutputs(chosen, partner);
  const materials = [route.material, partner ? routeOf(partner).material : undefined].filter(
    (line): line is string => line !== undefined,
  );
  const chain = chainFor(chosen);
  const steps = chain
    .filter((step) => stepEnabled(step.id, chosen, partner))
    .map((step) => ({
      id: step.id,
      title: step.title,
      agent: step.owner,
      gate: step.gate,
      inputs: step.inputs
        .filter((input) => !input.onlyFor || input.onlyFor.includes(chosen))
        .map((input) => ({
          path: input.path,
          what: input.what,
          optional: Boolean(input.optional) || absent.has(input.path),
        })),
      outputs: step.outputs.map((output) => ({
        path: output.path,
        what: output.what,
        schema: output.schema,
        optional: Boolean(output.optional),
      })),
      rules: STEP_RULES[step.id] ?? [],
      tools: toolsFor(step.id, chosen, partner),
    }));
  return {
    type: chosen,
    ...(partner ? { secondary: partner } : {}),
    defaulted: type === undefined,
    title: partner ? `${route.title} with ${routeOf(partner).title.toLowerCase()}` : route.title,
    ...(materials.length ? { material: materials.join("; ") } : {}),
    reference: route.reference,
    qa: [...route.qa, ...(partner ? routeOf(partner).qa : [])],
    ...(route.workflow ? { workflow: route.workflow } : {}),
    steps,
    skipped: chain.filter((step) => !stepEnabled(step.id, chosen, partner)).map((step) => step.id),
  };
}

/** Consistency of every route against the chain and the repository: returns problems, empty when sound. */
export function routeProblems(repoRoot: string): string[] {
  const problems: string[] = [];
  const scripts = (
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const catalogue = JSON.parse(readFileSync(path.join(repoRoot, "docs/library/catalogue.json"), "utf8")) as {
    items: { id: string; category: string }[];
  };
  const blocks = new Set(catalogue.items.map((item) => item.id));
  const categories = new Set(catalogue.items.map((item) => item.category));
  const known: Record<RouteTool["kind"], (id: string) => boolean> = {
    command: (id) => id in scripts,
    block: (id) => blocks.has(id),
    category: (id) => categories.has(id),
    skill: (id) => existsSync(path.join(repoRoot, ".agents/skills", id, "SKILL.md")),
    path: (id) => existsSync(path.join(repoRoot, id)),
  };
  const combinations: [FilmType, FilmType | undefined][] = [
    ...FILM_TYPES.map((type): [FilmType, undefined] => [type, undefined]),
    ...FILM_TYPES.filter((type) => !STANDALONE_TYPES.includes(type)).map((type): [FilmType, FilmType] => [
      DEFAULT_FILM_TYPE === type ? "explainer" : DEFAULT_FILM_TYPE,
      type,
    ]),
  ];
  for (const [type, secondary] of combinations) {
    const label = secondary ? `${type}+${secondary}` : type;
    const route = resolveRoute(type, secondary);
    const produced = new Set<string>();
    for (const step of route.steps) {
      if (
        step.agent !== "script" &&
        step.agent !== "user" &&
        !existsSync(path.join(repoRoot, ".agents/agents", `${step.agent}.md`))
      )
        problems.push(`${label} ${step.id}: no agent ${step.agent}`);
      for (const input of step.inputs) {
        const fromChain = input.path.startsWith("{dir}/pipeline/") || input.path.startsWith("out/");
        if (
          fromChain &&
          !input.optional &&
          input.path !== SOURCES &&
          !produced.has(input.path) &&
          !FILM_CHAIN.find((chain) => chain.id === step.id)!.selfSealing
        )
          problems.push(`${label} ${step.id}: required input ${input.path} has no enabled producer`);
      }
      for (const output of step.outputs) produced.add(output.path);
      for (const tool of step.tools)
        if (!known[tool.kind](tool.id)) problems.push(`${label} ${step.id}: unknown ${tool.kind} ${tool.id}`);
    }
    for (const stepId of Object.keys(routeOf(type).tools))
      if (!FILM_CHAIN.some((step) => step.id === stepId)) problems.push(`${label}: tools for unknown step ${stepId}`);
    if (routeOf(type).material && !route.steps.some((step) => step.id === "material"))
      problems.push(`${label}: material named but the step is off`);
  }
  return problems;
}

/** The intake menu: one line per type. */
export const typeMenu = (): string[] => FILM_TYPES.map((type) => `- \`${type}\`: ${FILM_ROUTES[type].line}`);

const toolText = (tool: RouteTool) =>
  tool.kind === "command"
    ? `\`pnpm ${tool.id}\``
    : tool.kind === "skill"
      ? `skill \`${tool.id}\``
      : tool.kind === "category"
        ? `\`library:list --category ${tool.id}\``
        : tool.kind === "block"
          ? `block \`${tool.id}\``
          : `\`${tool.id}\``;

export const toolLines = (tools: RouteTool[]): string[] => tools.map((tool) => `- ${toolText(tool)}: ${tool.use}`);

/** One type's generated route page, read at intake for that type. */
export const filmTypeDoc = (type: FilmType): string => `docs/film-types/${type}.md`;

/** docs/film-types.md, the generated index, so it cannot drift from the table; each type's steps and tools are on its own page (routeTypeMarkdown). */
export function routesMarkdown(): string {
  const lines = [
    "# Film types",
    "",
    "Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. The type is the film's technique, named by its playbook (the kind of video: [playbooks](../playbooks/AGENTS.md)) and set with `pnpm film:init --type <type>`: it switches chain steps on or off and hands each step its tools. Owners and their inputs and outputs come from the chain (`src/lib/film/chain.ts`); rules from `STEP_RULES`.",
    "",
    "| Type | Choose it for | Material | Steps off |",
    "|---|---|---|---|",
    ...FILM_TYPES.map((type) => {
      const route = routeOf(type);
      const resolved = resolveRoute(type);
      return `| [\`${type}\`](film-types/${type}.md) | ${route.line} | ${route.material ?? "none: library, code and 3D"} | ${resolved.skipped.join(", ") || "none"} |`;
    }),
    "",
    "A hybrid sets `secondaryFilmType`: its material switches the material step on and its tools join the primary type's. A brief with no type is routed as `motion-graphics`, and `film:next` says so.",
    "",
  ];
  const sample = resolveRoute("ui-demo");
  lines.push(
    "## Steps, owners, inputs and outputs",
    "",
    "The same for every type, except the steps a type switches off. Optional inputs are in brackets.",
    "",
    "| Step | Agent | Inputs | Outputs |",
    "|---|---|---|---|",
  );
  for (const step of sample.steps) {
    const inputs = step.inputs.map((input) => (input.optional ? `[${input.path}]` : input.path)).join(", ");
    const outputs = step.outputs.map((output) => (output.optional ? `[${output.path}]` : output.path)).join(", ");
    lines.push(`| ${step.id} | ${step.agent} | ${inputs || "none"} | ${outputs} |`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** docs/film-types/<type>.md: one type's route, generated from the same table. */
export function routeTypeMarkdown(type: FilmType): string {
  const route = routeOf(type);
  const lines = [
    `# \`${type}\`: ${route.title}`,
    "",
    "Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).",
    "",
    route.line.charAt(0).toUpperCase() + route.line.slice(1) + ".",
    "",
  ];
  const own = FILM_CHAIN.filter((step) => step.onlyFor?.includes(type)).map((step) => step.id);
  if (own.length)
    lines.push(`Steps only this type runs: ${own.join(", ")}. It never joins another type as a hybrid.`, "");
  if (route.workflow)
    lines.push(`Supplied media instead? Use ${workflowText(route.workflow)} when ${route.workflow.when}.`, "");
  lines.push("| Step | Agent | Tools |", "|---|---|---|");
  for (const step of resolveRoute(type).steps.filter((row) => row.tools.length))
    lines.push(`| ${step.id} | ${step.agent} | ${step.tools.map(toolText).join("; ")} |`);
  lines.push("", `Reference: ${route.reference}`, "", `QA looks hardest at: ${route.qa.join("; ")}.`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every generated film-type page by path: the index and one page per type. */
export const routeDocs = (): Record<string, string> =>
  Object.fromEntries([
    ["docs/film-types.md", routesMarkdown()],
    ...FILM_TYPES.map((type) => [filmTypeDoc(type), routeTypeMarkdown(type)]),
  ]);

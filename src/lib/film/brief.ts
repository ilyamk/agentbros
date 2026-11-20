import { experimentInstructions, startExperiment } from "../experiments/project";
import { FILM_STYLE_ARTEFACT, filmStyleForStep } from "../film-styles/binding";
import { localToolPrompt, type LocalToolHints } from "../local-capabilities/suggestions";
import { localEvidence } from "./local-evidence";
import { briefFileName, inspectLine } from "./brief-handoff";
import { excerpt } from "./excerpt";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUBRIC_FILES } from "./creative-rubric";
import {
  KILLED_OBVIOUS,
  MIN_STIMULUS_IDEAS,
  authorRound,
  categoryScan,
  StudioRefusal,
  laneFile,
  lanesFor,
  latestReopen,
  methodFor,
  openPoolRound,
  productOnlyProofs,
  projectRubricVersion,
  reviewFile,
  stimulusSeed,
} from "./studio";
import { writeStimuli } from "./stimuli";
import { StrategySchema, type PoolReopen } from "../../types/studio";
import {
  BRIEF,
  LIBRARY_CATALOGUE,
  STRATEGY,
  TRUTH,
  TARGETS,
  CRITIC_AGENT,
  CRITIC_PACK_DIR,
  FILM_CHAIN,
  FIXER_AGENT,
  FORBIDDEN_FOR_ALL,
  P,
  REFERENCE_DIR,
  RENDER,
  STEP_RULES,
  stepById,
  stepOwnerKind,
  type ChainCommand,
  type ChainStep,
} from "./chain";
import { appendUserWords, readUserWords } from "./spine";
import { feedbackWhere, openFeedbackFile, readOpenFeedback } from "../feedback/store";
import { latestRatings, readRatings } from "../console/ratings";
import { memoryFields } from "../pipeline/route";
import { absentOutputs, chainFor, resolveRoute, toolLines, toolsFor, typeMenu, type ResolvedRoute } from "./routes";
import {
  ChainRefusal,
  commandsFor,
  deriveChain,
  doneCommand,
  fill,
  filmTypes,
  recordFixerRound,
  renderCommand,
  stepState,
  type CriticGate,
  type FilmProject,
  type StepState,
  type Tokens,
} from "./state";

export type BriefRole = "owner" | "critic" | "fixer";

const REPORT_FORMAT = [
  "Reply with these lines and nothing else:",
  "- step: the step id",
  "- status: done, or stuck and why",
  "- outputs: each path you wrote",
  "- film:done: the command's result, or that you did not reach it",
  "- looked at: what you opened or listened to, and what you could not",
  "- for the user: anything only the user can decide, or none",
].join("\n");

const CRITIC_REPORT = REPORT_FORMAT.replace(
  "- film:done: the command's result, or that you did not reach it\n",
  "- verdict: your verdict\n",
);

const CRITIC_FORBIDDEN = [
  "Do not read the project's pipeline folder beyond the paths above and this brief, its source code or its history: you judge what is on screen and what is heard.",
  "Do not ask the maker what was intended.",
  "Do not soften a score because of an earlier round.",
];

const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);

/** The user's memory for this step (owner and fixer briefs; a critic judges unprompted): the refs, how to open one, and that leaf agents only propose entries. */
export const MEMORY_TITLE = "The user's memory for this step";
/** Steps whose rules name the creative lessons get up to this many of the user's lessons beyond memoryFor's cap. */
export const MEMORY_LESSONS = 3;
export const memoryLines = (project: Pick<FilmProject, "projectDir">, stepId: string): string[] => {
  const lessons = (STEP_RULES[stepId] ?? []).includes(LESSONS_FILE) ? MEMORY_LESSONS : 0;
  const refs = memoryFields(project.projectDir, stepId, undefined, { lessons }).memory ?? [];
  if (!refs.length) return [];
  return [
    ...refs.map((entry) => `- ${entry.id} (${entry.type}): ${entry.summary}`),
    "",
    "Open one with `pnpm memory --id <id>` only when its summary bears on this step. Never write memory yourself: propose a new entry (type, one-line summary, the user's verbatim words or your evidence) in your report.",
  ];
};

const LESSONS_FILE = "design-reference/creative-lessons.md";

/** A creative director's brief: only the user's lessons (their confirmed words), never decisions, preferences or observations; a critic gets none. */
export const MEMORY_LESSONS_TITLE = "The user's lessons for this step";
export const lessonLines = (project: Pick<FilmProject, "projectDir">, stepId: string): string[] => {
  const refs =
    memoryFields(project.projectDir, stepId, undefined, { lessons: MEMORY_LESSONS, lessonsOnly: true }).memory ?? [];
  if (!refs.length) return [];
  return [
    ...refs.map((entry) => `- ${entry.id}: ${entry.summary}`),
    "",
    "Open one with `pnpm memory --id <id>` when it bears on an axis; cite it like a curated lesson.",
  ];
};

const definitionLine = (project: FilmProject, agent: string) => {
  const file = `.agents/agents/${agent}.md`;
  return existsSync(path.join(project.repoRoot, file))
    ? `You are ${agent}. Read your definition first and follow it: ${file}`
    : `You are ${agent}. Your definition is not in this repository yet (${file}): act from this brief alone.`;
};

const commandLines = (commands: ChainCommand[], tokens: Tokens) =>
  commands.map((command, index) => `${index + 1}. ${command.purpose}\n   \`${renderCommand(command, tokens)}\``);

const inputLine = (file: string, what: string, optional?: boolean) =>
  `- ${file}: ${what}${optional ? " (optional)" : ""}`;

const routeFor = (project: FilmProject, tokens: Tokens): ResolvedRoute => {
  const { type, secondary } = filmTypes(project, tokens);
  return resolveRoute(type, secondary);
};

function resolveStepInputs(project: FilmProject, step: ChainStep, tokens: Tokens, inputs = step.inputs): string[] {
  const silent =
    tokens["audioMap"] === undefined &&
    existsSync(path.join(project.rootDir, fill(P("music-decision.json"), tokens) ?? ""));
  const route = routeFor(project, tokens);
  const absent = absentOutputs(route.type, route.secondary);
  return inputs.flatMap((input) => {
    if (input.onlyFor && !input.onlyFor.includes(route.type)) return [];
    if (input.unlessSilence && silent) return [];
    if (absent.has(input.path) || input.path.endsWith(`/${FILM_STYLE_ARTEFACT}`)) return [];
    const file = fill(input.path, tokens);
    if (file === undefined) return input.optional ? [] : [inputLine(input.path, input.what)];
    if (input.optional && !existsSync(path.join(project.rootDir, file))) return [];
    return [inputLine(file, input.what, input.optional)];
  });
}

const LIBRARY_LINE =
  '- the motion library: `pnpm library:list --query "<what>"`, then import the block from its importPath; wrap the film in FilmFinish';

/** Only what the step needs: each extra file is read by a fresh agent on every dispatch. */
const ruleLines = (project: FilmProject, tokens: Tokens, stepId: string) =>
  (STEP_RULES[stepId] ?? []).map((rule) => {
    if (rule === "library") return LIBRARY_LINE;
    if (rule === "spine") return `- ${fill(P("spine.md"), tokens)!}`;
    return `- ${rule}${existsSync(path.join(project.repoRoot, rule)) ? "" : " (not in this repository yet)"}`;
  });

function approvalLines(project: FilmProject, stepId: string): string[] {
  const own = FILM_CHAIN.findIndex((step) => step.id === stepId);
  return FILM_CHAIN.slice(0, own)
    .filter((step) => step.gate === "user")
    .flatMap((step) => {
      const file = path.join(project.projectDir, "pipeline", "approvals", `${step.id}.json`);
      if (!existsSync(file)) return [];
      const events = (
        JSON.parse(readFileSync(file, "utf8")) as { events: { answer: string; proxy?: string; reason?: string }[] }
      ).events;
      const last = events.at(-1);
      if (!last) return [];
      return [
        last.proxy
          ? `- ${step.id}: not the user's decision; a benchmark proxy went on (${last.reason ?? "no reason given"})`
          : `- ${step.id}: ${last.answer}`,
      ];
    });
}

/** The film type's tools for this step, and at intake the menu of types to ask from. */
function routeLines(project: FilmProject, tokens: Tokens, stepId: string): { title: string; lines: string[] } {
  const route = routeFor(project, tokens);
  const lines = toolLines(toolsFor(stepId, route.type, route.secondary));
  if (stepId === "material" && route.material) lines.unshift(`- material for this type: ${route.material}`);
  return {
    title: `Tools for a ${route.title.toLowerCase()} film (${route.type}${route.secondary ? `+${route.secondary}` : ""})`,
    lines,
  };
}

const TYPE_QUESTION =
  "Ask the film's type before anything else, with these lines to choose from; record it as brief.filmType (and secondaryFilmType for a hybrid). If the job is to cut the user's own footage or recordings, this chain is the wrong route: hand it to the `footage-editor` agent and `pnpm footage:next --project <id>` (docs/footage-editing.md).";

const outputLines = (step: ChainStep, tokens: Tokens) =>
  step.outputs.flatMap((output) => {
    const file = fill(output.path, tokens) ?? output.path;
    return [
      `- ${file}: ${output.what}${output.schema ? ` (validated against ${output.schema})` : ""}${output.optional ? " (optional)" : ""}`,
    ];
  });

const TEAMS_FILE = ".agents/skills/creative-studio/references/creative-teams.md";
const METHODS_FILE = ".agents/skills/creative-studio/references/creative-methods.md";

/** Where a brief quotes a shared reference: the whole file stays one link away, in a section agents open only when the quote is not enough. */
const REFERENCES_TITLE = "Full references, only when a quote above is not enough";

/** A concept team's stance or a script variant from creative-teams.md: the shared rules of its kind, then its own section. */
export const laneExcerpt = (repoRoot: string, kind: "ideas" | "scripts", lane: string) =>
  excerpt(repoRoot, TEAMS_FILE, [
    { heading: kind === "ideas" ? "Concept teams" : "Script variants", take: "intro" },
    { heading: lane, take: "body" },
  ]);

/** A method's procedure from creative-methods.md, with what a concept team does with a category scan. */
export const methodExcerpt = (repoRoot: string, method: string) =>
  excerpt(repoRoot, METHODS_FILE, [
    { heading: method, take: "body" },
    { heading: "In a concept team, with a category scan", take: "body" },
    { heading: "After any method", take: "body" },
  ]);

/** The frozen rubric for one kind of review: how to score, that kind's axes, the threshold and the pairwise protocol. */
export const rubricExcerpt = (repoRoot: string, file: string, kind: "ideas" | "scripts") => {
  const title = readFileSync(path.join(repoRoot, file), "utf8").split("\n", 1)[0]!.replace(/^#\s*/, "");
  return excerpt(repoRoot, file, [
    { heading: title, take: "intro" },
    { heading: kind === "ideas" ? "Idea rubric" : "Script rubric", take: "body" },
    { heading: "Threshold", take: "body" },
    { heading: "Pairwise comparison, in both orders", take: "body" },
  ]);
};

const readJsonIn = (project: FilmProject, relative: string | undefined): unknown => {
  if (!relative) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(project.rootDir, relative), "utf8"));
  } catch {
    return undefined;
  }
};

/** What exists to build the picture from, from product-truth material[] and the brief's budget: what feasibility is judged against. */
export function materialLines(project: FilmProject, tokens: Tokens): string[] {
  const brief = readJsonIn(project, fill(BRIEF, tokens)) as
    { budgetUsd?: number | null; bespoke?: { realData?: unknown[] } } | undefined;
  const truth = readJsonIn(project, fill(TRUTH, tokens)) as { material?: unknown[] } | undefined;
  const describe = (item: unknown): string => {
    if (typeof item === "string") return `- ${item}`;
    const entry = (item ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : undefined);
    const state = text("state") ?? text("status");
    return `- ${state ? `${state}: ` : ""}${text("what") ?? JSON.stringify(item)}${text("where") ? ` (${text("where")})` : ""}`;
  };
  const items = truth?.material?.length
    ? truth.material.map(describe)
    : ["- product-truth.json lists no material: assume nothing exists beyond the library"];
  for (const item of brief?.bespoke?.realData ?? []) {
    const entry = (item ?? {}) as { what?: unknown; mayShow?: unknown };
    if (typeof entry.what === "string")
      items.push(`- real data from the brief${entry.mayShow === false ? ", not to be shown" : ""}: ${entry.what}`);
  }
  const budget = brief?.budgetUsd;
  const catalogue = `the motion library (${LIBRARY_CATALOGUE}, or \`pnpm library:list --query "<what>"\`)`;
  const budgetLine =
    budget === undefined || budget === null || budget === 0
      ? `- Budget ${budget === 0 ? "0" : "not authorised (budgetUsd is not set, which authorises nothing)"}: the picture is built only from ${catalogue} and the material above that exists. Nothing is generated, bought, filmed or recorded; an idea that needs that is not feasible.`
      : `- Budget ${budget} USD: ${catalogue} and the material above cost nothing; anything else is paid or recorded and needs the user's yes at the material step. Say what each idea needs beyond them.`;
  return [...items, budgetLine];
}

/** One author's part of a fan-out step: its stance or variant, its round, and the director's notes from the last round. */
function laneLines(
  project: FilmProject,
  step: ChainStep,
  lane: string,
  tokens: Tokens,
): { lines: string[]; output: string; previousReview?: string; quoteTitle: string; quote: string } {
  const kind = step.fanOut!.kind;
  const round = authorRound(project.projectDir, kind);
  const output = path.relative(project.rootDir, laneFile(project.projectDir, kind, lane));
  const reopen = latestReopen(project.projectDir, kind);
  const reopened = reopen?.round === round ? reopen : undefined;
  // The first round after a reopen answers the user or the change, not the notes of a round that passed.
  const previous =
    round > 1 && !reopened
      ? path.relative(project.rootDir, reviewFile(project.projectDir, kind, round - 1))
      : undefined;
  const who = kind === "ideas" ? `the ${lane} team` : `variant ${lane}`;
  const quoteTitle = `${kind === "ideas" ? "Stance" : "Variant"} ${lane}, quoted from the creative teams reference`;
  const lines = [
    `You are ${who}. Hold to your ${kind === "ideas" ? "stance" : "variant"}, quoted in the next section.`,
    `Write round ${round} to ${output}${kind === "ideas" ? `, with "team": "${lane}" and 4 to 6 ideas` : `, with "variant": "${lane}"`}.`,
    "Other authors are writing at the same time. You do not see their work, and you do not judge yours against it: a creative director scores everything blind.",
    ...(previous
      ? [
          `Round ${round - 1} fell below the threshold. Read its notes and scores in ${previous}; you cannot tell which items were yours, so answer the notes, not a score.`,
        ]
      : []),
    ...(reopened ? reopenLines(reopened, kind) : []),
  ];
  void tokens;
  return {
    lines,
    output,
    ...(previous ? { previousReview: previous } : {}),
    quoteTitle,
    quote: laneExcerpt(project.repoRoot, kind, lane),
  };
}

/** A reopened pool: why, the user's words as a constraint, and the previous winner as what not to repeat. */
function reopenLines(reopen: PoolReopen, kind: "ideas" | "scripts"): string[] {
  const what = kind === "ideas" ? "idea" : "script";
  return [
    reopen.cause === "feedback"
      ? `The pool reopened for round ${reopen.round} because the user asked for a change after watching the film.`
      : `The pool reopened for round ${reopen.round} because the inputs changed after the last round: ${reopen.changed.join(" ")}`,
    ...(reopen.quotes.length
      ? [
          "The user's words, verbatim. They are a constraint: every item you write answers them.",
          ...reopen.quotes.map((quote) => `- "${quote}"`),
        ]
      : []),
    ...(reopen.previousWinner
      ? [
          reopen.cause === "feedback"
            ? `What the user rejected, the previous winning ${what}: ${reopen.previousWinner}. Do not write it again in other words.`
            : `The previous winning ${what}, written before the change: ${reopen.previousWinner}. Keep its strength only where it still holds.`,
        ]
      : []),
  ];
}

/** With a category scan: the clichés to ban, what not to take, the white space, and this team's method with its stimuli. */
function categoryLines(
  project: FilmProject,
  team: string,
): { scan: string[]; method: string[]; methodName: string; procedure: string } | undefined {
  const scan = categoryScan(project.projectDir);
  if (!scan) return undefined;
  const method = methodFor(team);
  const [sheet] = writeStimuli(project.projectDir, [method], stimulusSeed(project.id, team));
  const file = path.relative(project.rootDir, sheet!.file);
  return {
    scan: [
      `Category: ${scan.category}. Clichés of this category; none of your ideas may rest on one:`,
      ...scan.cliches.map((item) => `- ${item.cliche}: ${item.description} (seen in ${item.seenIn})`),
      "Do not take:",
      ...scan.dontTake.map((line) => `- ${line}`),
      "White space, where the category is not yet:",
      ...scan.whiteSpace.map((line) => `- ${line}`),
    ],
    method: [
      `1. Kill the first ten. Starting from the clichés above, write the ${KILLED_OBVIOUS} most obvious ideas for this film into "killedObvious" in your file, then ban them: no idea of yours may be one of them.`,
      `2. Your method is ${method}. Its stimuli are in ${file} (seed ${sheet!.sheet.seed}). Work from them; the procedure is quoted in the next section.`,
      `3. At least ${MIN_STIMULUS_IDEAS} of your ideas carry "stimulus": {"method": "${method}", "seed": "${sheet!.sheet.seed}", "prompt": "<the stimulus you used, verbatim>"}. Other ideas set it to null or leave it out. The creative director never sees it: ideas are judged as written.`,
    ],
    methodName: method,
    procedure: methodExcerpt(project.repoRoot, method),
  };
}

/** With product-only proofs in the strategy: the alternative to beat, the proofs, and where an idea must show one. */
function proofLines(project: FilmProject): string[] | undefined {
  const found = productOnlyProofs(project.projectDir);
  if (!found) return undefined;
  return [
    ...(found.alternative
      ? [`Strongest alternative: ${found.alternative.name} (${found.alternative.whyConsidered})`]
      : []),
    "Proofs only this product can show, each with its frame:",
    ...found.proofs.map((item) => `- ${item.proof}: ${item.looksLike}`),
    'Every idea puts at least one proof in its hook or its turn, not only in the last frame, and records "proofFrame": {"proof": "<the proof above, verbatim>", "where": "hook" | "turn"}. An idea without one makes your file invalid. The creative director never sees proofFrame: ideas are judged as written.',
  ];
}

/** With product truth: the strategy fields that carry product-only proofs. The instruction to fill them is the strategist's. */
function strategyProofFields(project: FilmProject, tokens: Tokens): string[] | undefined {
  if (readJsonIn(project, fill(TRUTH, tokens)) === undefined) return undefined;
  return [
    '- "strongestAlternative": {"name", "whyConsidered"}: what the buyer would otherwise do that looks most like the product on screen.',
    '- "productOnlyProofs": [{"proof", "claim", "looksLike"}]: "claim" quotes a product-truth.json claim\'s text verbatim (or its id), and that claim\'s status must be working; "looksLike" is one line, the frame.',
  ];
}

function ownerBrief(project: FilmProject, step: ChainStep, state: StepState, tokens: Tokens, lane?: string): string {
  const chain = chainFor(routeFor(project, tokens).type);
  const index = chain.indexOf(step) + 1;
  const owner = stepOwnerKind(step);
  const part = lane ? laneLines(project, step, lane, tokens) : undefined;
  const category = step.id === "ideas" && lane ? categoryLines(project, lane) : undefined;
  const proofs = step.id === "ideas" && lane ? proofLines(project) : undefined;
  const proofFields = step.id === "strategy" ? strategyProofFields(project, tokens) : undefined;
  const stepTokens = {
    ...tokens,
    ...(state.critic?.latestPath ? { previousCritique: state.critic.latestPath } : {}),
    ...(part?.previousReview ? { previousReview: part.previousReview } : {}),
  };
  const outputs = part
    ? [
        `- ${part.output}: your ${step.fanOut!.kind === "ideas" ? "team's ideas" : "variant"} (validated against ${step.fanOut!.kind === "ideas" ? "team-ideas" : "script-variant"})`,
      ]
    : outputLines(step, tokens);
  return [
    `# Film chain: ${step.title}${lane ? `, ${step.fanOut!.flag} ${lane}` : ""} (step ${index} of ${chain.length}, project ${project.id})`,
    "",
    owner === "agent" ? definitionLine(project, step.owner) : "You run this step's scripts.",
    "Run from the repository root. Do not start other agents.",
    // Not for a fan-out author: the step's outputs include the other authors' files, which it must not see.
    ...(part ? [] : [inspectLine(project.id, step.id)]),
    "",
    ...section("Goal", [step.purpose]),
    ...(part ? section(`Your ${step.fanOut!.flag}`, part.lines) : []),
    ...(part ? section(part.quoteTitle, [part.quote]) : []),
    ...section("Inputs", resolveStepInputs(project, step, stepTokens)),
    ...(step.id === "ideas"
      ? section("Existing material and budget: write only ideas this can build", materialLines(project, tokens))
      : []),
    ...(category ? section("Category conventions and clichés", category.scan) : []),
    ...(category ? section("Your method, before you write ideas", category.method) : []),
    ...(category
      ? section(`Method ${category.methodName}, quoted from the creative methods reference`, [category.procedure])
      : []),
    ...(proofs ? section("Proof only this product can show", proofs) : []),
    ...(proofFields ? section("Product-only proofs (strategy.json fields)", proofFields) : []),
    ...section("Rules, read before you start", ruleLines(project, tokens, step.id)),
    ...(step.id === "intake"
      ? section("The film's type, first", [TYPE_QUESTION, ...typeMenu()])
      : section(routeLines(project, tokens, step.id).title, routeLines(project, tokens, step.id).lines)),
    ...section("The user's approvals so far", approvalLines(project, step.id)),
    ...section(
      "The user's words for this step",
      readUserWords(project.projectDir, step.id).map((words) => `- ${words}`),
    ),
    ...(step.id === "look"
      ? section(
          "The user's ratings of the styleframes (latest per file; keep what they rate high)",
          styleframeRatings(project),
        )
      : []),
    ...section(MEMORY_TITLE, memoryLines(project, step.id)),
    ...section("Outputs", outputs),
    ...section(
      "Commands, in order; fill each <placeholder>",
      part
        ? [`1. Nothing to run: write your file. The orchestrator pools every ${step.fanOut!.flag} when all are in.`]
        : commandLines(commandsFor(step), stepTokens),
    ),
    ...section("Done when", [step.done.rule]),
    ...section("Stop when", [`At most ${step.stop.maxRounds} rounds. ${step.stop.noProgress}`]),
    ...section(
      "Never",
      [...step.forbidden, ...FORBIDDEN_FOR_ALL].map((line) => `- ${line}`),
    ),
    ...section(REFERENCES_TITLE, [...(part ? [`- ${TEAMS_FILE}`] : []), ...(category ? [`- ${METHODS_FILE}`] : [])]),
    ...section("Report", [REPORT_FORMAT]),
  ].join("\n");
}

/** Holds only the artefact, the brief, the references and the critic pack, so the judgement stays independent. */
function criticBrief(project: FilmProject, step: ChainStep, state: StepState, tokens: Tokens): string {
  const critic = step.critic!;
  const round = state.critic!.round;
  const roundTokens: Tokens = { ...tokens, round: String(round) };
  const target = fill(critic.target, tokens)!;
  const packDir = fill(CRITIC_PACK_DIR, roundTokens)!;
  const referenceDir = tokens["referenceId"] ? fill(REFERENCE_DIR, tokens) : undefined;
  const output = `${tokens["dir"]}/pipeline/critique/${critic.prefix}${round}.json`;
  const inputs = [
    inputLine(target, "what you judge"),
    inputLine(fill(BRIEF, tokens)!, "the brief, as the user approved it"),
    inputLine(fill(TARGETS, tokens)!, "the targets; advisory when the brief's profile is promo", true),
    ...(referenceDir ? [inputLine(referenceDir, "the reference film's measured and judged layers")] : []),
    ...(critic.pack
      ? [
          inputLine(
            `${packDir}/pack.json`,
            "transition strips, frozen time, loudness, duck depth and sync against the music, the reference on matching downbeats with its pilot spec, in a reading order; the command below writes it",
          ),
        ]
      : []),
  ];
  const pack: ChainCommand[] = critic.pack
    ? [
        {
          alias: "critic:pack",
          purpose: "Build your pack for this film.",
          args: {
            project: "{id}",
            render: RENDER,
            ...(referenceDir ? { reference: `${referenceDir}/media/source.mp4` } : {}),
            "previous-critique": `?{previousCritique}`,
            "output-dir": packDir,
          },
        },
      ]
    : [];
  const packTokens = {
    ...roundTokens,
    ...(state.critic?.latestPath ? { previousCritique: state.critic.latestPath } : {}),
  };
  return [
    `# Film chain: independent critic, round ${round} (step ${step.id}, project ${project.id})`,
    "",
    definitionLine(project, CRITIC_AGENT),
    "You are a new critic: you did not make this and you know nothing of how it was made. Do not start other agents.",
    "",
    ...section("Goal", [
      "Judge what is on screen and what is heard, against the brief and the reference. Open the frames: a score without frames you looked at does not count.",
    ]),
    ...section("Inputs, and nothing else", inputs),
    ...section("Commands, in order", commandLines(pack, packTokens)),
    ...section(
      `Look hardest at, for a ${routeFor(project, tokens).type} film`,
      routeFor(project, tokens).qa.map((line) => `- ${line}`),
    ),
    ...section("Outputs", [
      `- ${output}: your critique (validated against critique), round ${round}, renderSha256 the SHA-256 of ${target}`,
    ]),
    ...section("Done when", [
      "The critique validates and names the frames you looked at; verdict is approve-for-human, revise or rethink-idea; actions say what to change, as seen. If a previous critique is in the pack, say whether each of its actions was done.",
    ]),
    ...section("Stop when", ["You have judged once. This round is yours alone; the next is another critic's."]),
    ...section(
      "Never",
      CRITIC_FORBIDDEN.map((line) => `- ${line}`),
    ),
    ...section("Report", [CRITIC_REPORT]),
  ].join("\n");
}

const DIRECTOR_FORBIDDEN = [
  "Do not open the pool key, the authors' files (pipeline/concepts/, pipeline/scripts/), their briefs (the other files in pipeline/briefs/) or the spine: you judge what is written in the pool.",
  "Do not write ranking, passing, top or verdict by hand: creative:rank computes them.",
  "Do not soften a score because of an earlier round, and do not reward an item for answering your notes: score what is written.",
];

/** Rubric v2: the distinctiveness swap uses the strategy's strongest alternative, so every director swaps against the same thing. */
function swapTarget(project: FilmProject, tokens: Tokens): string[] | undefined {
  const parsed = StrategySchema.safeParse(readJsonIn(project, fill(STRATEGY, tokens)));
  const alternative = parsed.success ? parsed.data.strongestAlternative : undefined;
  if (!alternative) return undefined;
  return [
    `Strongest alternative: ${alternative.name} (${alternative.whyConsidered})`,
    "For distinctiveness, swap the product for this alternative, as the rubric's anchor says; do not choose a swap target of your own.",
  ];
}

/** The creative director's round: the anonymised pool, the strategy and the rubric, nothing about who wrote what. */
function directorBrief(project: FilmProject, step: ChainStep, state: StepState, tokens: Tokens): string {
  const critic = step.critic!;
  const kind = critic.review!;
  const round = state.critic!.round;
  const target = fill(critic.target, tokens)!;
  const output = path.relative(project.rootDir, reviewFile(project.projectDir, kind, round));
  const version = projectRubricVersion(project.projectDir);
  const alternative = version >= 2 && kind === "ideas" ? swapTarget(project, tokens) : undefined;
  const rubricAxes = kind === "ideas" ? "the idea rubric's seven axes" : "the script rubric's five axes";
  const inputs = [
    inputLine(target, `what you judge: the pool of ${kind}, anonymised and shuffled`),
    inputLine(
      fill(STRATEGY, tokens)!,
      "the approved strategy: proposition, hook mechanic, platform, mandatories, forbidden",
    ),
    inputLine(fill(BRIEF, tokens)!, "the brief, as the user approved it"),
    inputLine(fill(TRUTH, tokens)!, "the product truth: the truth axis is scored against its statuses"),
    inputLine(fill(TARGETS, tokens)!, "the reference's numbers, for the ambition axis", true),
    ...(kind === "ideas"
      ? [
          inputLine(
            LIBRARY_CATALOGUE,
            "the motion library catalogue: what the picture can be built from without new material, for the feasibility axis",
          ),
        ]
      : []),
    ...(kind === "scripts"
      ? [
          inputLine(fill(P("concept.json"), tokens)!, "the chosen idea the scripts serve"),
          ...(tokens["audioMap"] ? [inputLine(tokens["audioMap"], "the audio map, for the music-fit axis")] : []),
        ]
      : []),
  ];
  const rank: ChainCommand = {
    alias: "creative:rank",
    purpose: "After writing your scores, pairs, arguments and notes: rank, compute the verdict, and check the review.",
    args: { project: "{id}", kind },
  };
  return [
    `# Film chain: creative director, ${kind} round ${round} (step ${step.id}, project ${project.id})`,
    "",
    definitionLine(project, critic.agent!),
    "You are a new creative director: you wrote none of this, and you do not know who did. Do not start other agents.",
    "",
    ...section("Goal", [
      `Score every item in the pool on ${rubricAxes}, compare the best in both orders, argue against the top, and say what the authors should do if nothing passes.`,
    ]),
    ...section("Inputs, and nothing else", inputs),
    ...(kind === "ideas"
      ? section("Existing material and budget: score feasibility against this", materialLines(project, tokens))
      : []),
    ...(alternative ? section("Swap target", alternative) : []),
    ...section("Before you rank", [
      `- Two ${kind} that are one picture in different words: list them together in "sameImage", e.g. [["I5", "I7"]]. creative:rank then keeps only the higher one in the top and takes the next.`,
      '- Your scores are final once creative:rank has given its verdict. A change after that is refused unless you run creative:rank --rescore-reason "<why>"; it is recorded with the diff and the user sees it.',
    ]),
    ...section("Rules, read before you start", [
      `- design-reference/creative-lessons.md: the user's lessons; cite one in an axis note when it moves a score`,
    ]),
    ...section(`The frozen rubric v${version} for ${kind}, quoted: its anchors, threshold and pairwise protocol`, [
      rubricExcerpt(project.repoRoot, RUBRIC_FILES[version], kind),
    ]),
    ...section(MEMORY_LESSONS_TITLE, lessonLines(project, step.id)),
    ...section("Outputs", [
      `- ${output}: your review (validated against creative-review), rubricVersion ${version}, kind ${kind}, round ${round}, targetSha256 the SHA-256 of ${target}`,
    ]),
    ...section("Commands, in order", commandLines([rank], tokens)),
    ...section("Done when", [
      "creative:rank succeeds: every item scored on every axis with a note, every ordered pair among the top six judged, an argument against each of the top, and notes for the authors when the round is below the threshold.",
    ]),
    ...section("Stop when", ["You have judged once. The next round, if any, is another director's."]),
    ...section(
      "Never",
      [...DIRECTOR_FORBIDDEN, ...FORBIDDEN_FOR_ALL].map((line) => `- ${line}`),
    ),
    ...section(REFERENCES_TITLE, [`- ${RUBRIC_FILES[version]}`]),
    ...section("Report", [CRITIC_REPORT]),
  ].join("\n");
}

/**
 * The user's latest ratings of the styleframes (`ref:rate`, RFC 0004 §8): untracked, so a rating never reopens a step;
 * the look owner reads them with the user's words. The critic is not shown them: its judgement stays independent.
 */
function styleframeRatings(project: FilmProject): string[] {
  try {
    return [...latestRatings(readRatings(project.projectDir)).values()]
      .filter((rating) => rating.kind === "styleframe" || rating.step === "look")
      .map(
        (rating) =>
          `- ${rating.target.path}: ${rating.score}/5${rating.note !== undefined ? `, "${rating.note}"` : ""} (${rating.at})`,
      );
  } catch {
    return [];
  }
}

/**
 * The user's open feedback on the build (frame and region comments on a render, RFC 0004 A17): the fixer answers it in
 * the same round as the findings, in the user's words, with where they pointed.
 */
function openBuildFeedback(project: FilmProject): { input: string[]; lines: string[] } {
  const open = readOpenFeedback(project.projectDir, "build");
  if (!open?.items.length) return { input: [], lines: [] };
  const file = path.relative(project.rootDir, openFeedbackFile(project.projectDir, "build"));
  return {
    input: [inputLine(file, "the user's open feedback on the film, routed to the build: answer every item")],
    lines: [
      ...open.items.map(
        (item) =>
          `- ${item.feedbackId} ${item.itemId} (${item.aspect}, ${item.severity}${feedbackWhere(item)}, on ${item.watched}): "${item.quote}"`,
      ),
      ...open.clarifications.map((clarification) => `- Clarified: "${clarification.quote}"`),
    ],
  };
}

function fixerBrief(project: FilmProject, step: ChainStep, state: StepState, tokens: Tokens): string {
  const stepTokens = { ...tokens, ...(state.critic?.latestPath ? { previousCritique: state.critic.latestPath } : {}) };
  const userFeedback = openBuildFeedback(project);
  const measure = step.id === "replica-compare" ? step : stepById("measure")!;
  const build = stepById("build")!;
  const sensor = build.commands.find((command) => command.alias === "motion:check")!;
  const commands = [
    { ...sensor, args: { ...sensor.args, composition: "{composition}" } },
    doneCommand("build"),
    ...commandsFor(measure),
  ];
  return [
    `# Film chain: fixer for ${step.title} (project ${project.id})`,
    "",
    definitionLine(project, FIXER_AGENT),
    "Do not start other agents. Change only what the findings name.",
    inspectLine(project.id, step.id),
    "",
    ...section("Goal", ["Do what the findings below say, as written, then render and measure again."]),
    ...section("Inputs", [...resolveStepInputs(project, step, stepTokens, step.fixerInputs), ...userFeedback.input]),
    ...section("The user's feedback on the film (fix it in this round, where they pointed)", userFeedback.lines),
    ...section("Rules, read before you start", ruleLines(project, tokens, "fixer")),
    ...section(routeLines(project, tokens, "build").title, routeLines(project, tokens, "build").lines),
    ...section(
      "The user's words for this step",
      readUserWords(project.projectDir, step.id).map((words) => `- ${words}`),
    ),
    ...section(MEMORY_TITLE, memoryLines(project, step.id)),
    ...section("Commands, in order", commandLines(commands, stepTokens)),
    ...section("Done when", [measure.done.rule]),
    ...section("Stop when", [`At most ${step.stop.maxRounds} rounds. ${step.stop.noProgress}`]),
    ...section(
      "Never",
      [...measure.forbidden, ...FORBIDDEN_FOR_ALL].map((line) => `- ${line}`),
    ),
    ...section("Report", [REPORT_FORMAT]),
  ].join("\n");
}

// --- Token telemetry: one line per brief handed out, so the cost of a film is visible. ---

export type Dispatch = {
  step: string;
  role: BriefRole;
  agent: string;
  bytes: number;
  approxTokens: number;
  at: string;
};

const dispatchLog = (project: FilmProject) => path.join(project.projectDir, "pipeline", "briefs", "dispatches.jsonl");

/** About four bytes a token: an estimate for comparing films, not a bill. */
export const approxTokens = (bytes: number) => Math.ceil(bytes / 4);

function recordDispatch(project: FilmProject, entry: Omit<Dispatch, "approxTokens" | "at">): void {
  const file = dispatchLog(project);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({ ...entry, approxTokens: approxTokens(entry.bytes), at: new Date().toISOString() })}\n`,
  );
}

export function readDispatches(project: FilmProject): Dispatch[] {
  const file = dispatchLog(project);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Dispatch];
      } catch {
        return [];
      }
    });
}

/** Totals for film:status: brief bytes only; an agent's own reading comes on top. */
export function dispatchTotals(project: FilmProject) {
  const dispatches = readDispatches(project);
  const bytes = dispatches.reduce((sum, item) => sum + item.bytes, 0);
  const byStep: Record<string, { dispatches: number; bytes: number; approxTokens: number }> = {};
  for (const item of dispatches) {
    const row = (byStep[item.step] ??= { dispatches: 0, bytes: 0, approxTokens: 0 });
    row.dispatches++;
    row.bytes += item.bytes;
    row.approxTokens += item.approxTokens;
  }
  return { dispatches: dispatches.length, bytes, approxTokens: approxTokens(bytes), byStep };
}

export const defaultRole = (step: ChainStep): BriefRole => (step.owner === CRITIC_AGENT ? "critic" : "owner");

export type BuiltBrief = { step: string; role: BriefRole; agent: string; prompt: string; file: string };

/** The prompt and agent for a role on a step. Reads the project's files; only a concept team's stimuli sheet is written. */
function briefText(
  project: FilmProject,
  step: ChainStep,
  state: StepState,
  tokens: Tokens,
  role: BriefRole,
  lane?: string,
): { prompt: string; agent: string } {
  const brief =
    role === "critic"
      ? step.critic!.review
        ? { prompt: directorBrief(project, step, state, tokens), agent: step.critic!.agent! }
        : { prompt: criticBrief(project, step, state, tokens), agent: CRITIC_AGENT }
      : role === "fixer"
        ? { prompt: fixerBrief(project, step, state, tokens), agent: FIXER_AGENT }
        : (() => {
            const experiments = experimentInstructions(project.projectDir, step.id);
            const instructions = experiments.map(({ id, instruction }) => `\n\n## ${id}\n\n${instruction}`);
            return { prompt: ownerBrief(project, step, state, tokens, lane) + instructions.join(""), agent: step.owner };
          })();
  const style = filmStyleForStep(project.projectDir, role === "critic" && step.id === "look" ? "critic" : step.id);
  if (!style?.rules) return brief;
  const lines = style.rules.map((line) => `- ${line}`);
  if (role !== "critic" && style.preset)
    lines.push(
      `- Library preset: ${style.preset}. ${style.choices} For exact pinned values: pnpm film:style --action status --project ${project.id}.`,
    );
  if (role !== "critic" && style.blocks?.length) lines.push(`- Suggested blocks: ${style.blocks.join(", ")}.`);
  if (role !== "critic" && style.engines?.length) lines.push(`- Suggested engines: ${style.engines.join(", ")}.`);
  return { ...brief, prompt: brief.prompt + `\n\n## Film style · ${style.key}\n\n${lines.join("\n")}\n` };
}

/**
 * The brief buildBrief would hand out for this step and role, without its readiness check, the user's note, the brief
 * file or the dispatch log: for offline measurement on a scratch project (src/lib/context/simulate.ts). `round` and
 * `previousCritique` stand in for the critic state a real project would have.
 */
export function renderBrief(
  project: FilmProject,
  stepId: string,
  options: { role?: BriefRole; lane?: string; round?: number; previousCritique?: string } = {},
): { agent: string; prompt: string } {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  const role = options.role ?? defaultRole(step);
  if (role === "critic" && !step.critic) throw new ChainRefusal(`Step ${stepId} has no critic.`);
  if (role === "fixer" && !step.fixerInputs) throw new ChainRefusal(`Step ${stepId} has no fixer.`);
  const { tokens } = deriveChain(project);
  const critic: CriticGate = {
    round: options.round ?? 1,
    action: "review",
    why: "",
    ...(options.previousCritique ? { latestPath: options.previousCritique } : {}),
  };
  const state: StepState = {
    id: step.id,
    status: "ready",
    reasons: [],
    inputs: {},
    outputs: {},
    missingInputs: [],
    openUpstream: [],
    critic,
  };
  return briefText(project, step, state, tokens, role, options.lane);
}

/**
 * The full subagent prompt. Depends only on the project's files: the same state gives the same bytes,
 * for any harness. Refuses while the step's inputs are not ready.
 */
export function buildBrief(
  project: FilmProject,
  stepId: string,
  options: { role?: BriefRole; note?: string; lane?: string; localTools?: LocalToolHints; localEvidence?: string } = {},
): BuiltBrief {
  const step = stepById(stepId);
  if (!step) throw new ChainRefusal(`Unknown step "${stepId}".`);
  const role = options.role ?? defaultRole(step);
  if (role === "critic" && options.localEvidence)
    throw new ChainRefusal("An independent critic refuses optional local evidence");
  const evidence = options.localEvidence
    ? localEvidence(project.projectDir, options.localEvidence, stepId, project.rootDir)
    : undefined;
  if (step.fanOut && role === "owner") {
    const lanes = lanesFor(project.projectDir, step.fanOut.kind);
    if (!options.lane)
      throw new ChainRefusal(
        `Step ${stepId} has one brief per ${step.fanOut.flag}: pass --${step.fanOut.flag} ${lanes.join("|")}.`,
      );
    if (!lanes.includes(options.lane))
      throw new ChainRefusal(`${options.lane} is not one of this film's ${step.fanOut.flag}s: ${lanes.join(", ")}.`);
  } else if (options.lane) throw new ChainRefusal(`Step ${stepId} takes no --team or --variant.`);
  if (role === "critic" && !step.critic) throw new ChainRefusal(`Step ${stepId} has no critic.`);
  if (role === "fixer" && !step.fixerInputs) throw new ChainRefusal(`Step ${stepId} has no fixer.`);
  if (role === "owner" && step.owner === CRITIC_AGENT) throw new ChainRefusal(`Step ${stepId} is the critic's.`);
  if (role === "owner" && step.owner === "user")
    throw new ChainRefusal(`Step ${stepId} belongs to the user: use film:next for the question.`);
  if (role === "critic" && options.note)
    throw new ChainRefusal("A critic judges independently: --note is refused on a critic brief.");

  if (options.note?.trim()) appendUserWords(project.projectDir, step.id, options.note);

  const chain = deriveChain(project);
  const { tokens } = chain;
  const state = stepState(project, stepId, chain);
  if (state.status === "blocked" || state.status === "skipped")
    throw new ChainRefusal(`Step ${stepId} is ${state.status}: ${state.reasons.join(" ")}`);
  if (state.status === "stale" && state.openUpstream.length)
    throw new ChainRefusal(`Step ${stepId} must wait: ${state.reasons.join(" ")}`);
  // A stale pool's first lane brief opens the new round (studio.ts); the other lanes then see it as due.
  if (step.fanOut && role === "owner" && state.status === "stale")
    try {
      openPoolRound(project.projectDir, step.fanOut.kind, state.reasons);
    } catch (error) {
      if (error instanceof StudioRefusal) throw new ChainRefusal(error.message);
      throw error;
    }
  if (role === "critic" && !state.critic) {
    const step = stepById(stepId);
    const next =
      state.status === "unsealed"
        ? ` Run \`${renderCommand(doneCommand(stepId), tokens)}\` first: it records ${step?.sealedBy ? `the output (${step.sealedBy} normally does this itself)` : "the output"}, and then the critic's brief is ready.`
        : state.status === "ready" && step
          ? ` Run ${commandsFor(step)
              .map((command) => `\`${renderCommand(command, tokens)}\``)
              .join(", then ")} first.`
          : "";
    throw new ChainRefusal(
      `Step ${stepId} is ${state.status}: ${state.reasons.join(" ")} It has nothing for a critic yet.${next}`,
    );
  }

  if (role === "owner") {
    for (const { id } of experimentInstructions(project.projectDir, step.id)) startExperiment(project.projectDir, id);
  }
  const built = briefText(project, step, state, tokens, role, options.lane);
  const agent = built.agent;
  let prompt = built.prompt;
  if (role === "fixer") {
    const target = fill(step.critic?.target ?? RENDER, tokens);
    const hash = target ? (state.outputs[target] ?? state.inputs[target]) : undefined;
    if (hash) recordFixerRound(project, step.id, hash);
  }
  if (role !== "critic" && options.localTools) prompt += localToolPrompt(options.localTools);
  if (evidence) {
    evidence.verify();
    prompt += evidence.prompt;
  }
  const file = path.join(project.projectDir, "pipeline", "briefs", briefFileName(step.id, options.lane, role));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, prompt);
  recordDispatch(project, { step: step.id, role, agent, bytes: Buffer.byteLength(prompt) });
  return { step: step.id, role, agent, prompt, file: path.relative(project.rootDir, file) };
}

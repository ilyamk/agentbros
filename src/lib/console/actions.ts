/**
 * The console's action table (RFC 0004 §8, D9, D10, D13, D24): which CLI the server spawns for a user's decision, with
 * exactly which argv. Pure: the decision is the server's own derivation of the current state (never the client's
 * argv), the words are the user's, verbatim. `apply.ts` runs the plan.
 *
 * | Action          | Decision and option                                 | Commands                                                                 |
 * |-----------------|-----------------------------------------------------|--------------------------------------------------------------------------|
 * | approve         | gate, option `approve` (default of a gate)          | film:approve --project P --step S --answer W [--expect E]                |
 * | choose          | choice, any other option (idea or script candidate) | film:approve --project P --step S --answer W [--expect E]                |
 * | quote (film)    | quote on material or narration, `approve`           | film:approve --project P --step S --answer W [--expect E]                |
 * | quote (footage) | quote on a recording, `approve`                     | budget --project P --ceiling-usd C --answer W                            |
 * | changes         | option `changes` (or `reject`, `revise`)            | feedback --project P --step S --answer W [--expect E] --confirm          |
 * | another-round   | critic step, option `another-round`                 | feedback --project P --step S --answer W [--expect E] --confirm          |
 * | skip            | option `skip`, step skippable in the chain          | film:done --project P --step S --skip W                                  |
 * | autonomy        | option whose derived argv runs film:policy          | film:policy --project P --autonomy M --answer W [--ceiling-usd C]        |
 * | ceiling         | option whose derived argv runs budget               | budget --project P --ceiling-usd C --answer W                            |
 * | record          | music or film:rights option (first questions)       | the derived argv, "<the user's words>" replaced by W                     |
 * | verdict         | verdict (step human)                                | film:approve --step human --answer W [--expect E]; memory --add --type   |
 * |                 |                                                     | decision --summary … --quote W --project P --step human [--body-file];   |
 * |                 |                                                     | feedback --project P --file <frame comments, verdict accept> --confirm   |
 *
 * `changes` and `another-round` are accepted on any decision with a step, listed or not. Every value from the user is
 * one `--flag=value` token, so words such as `-h` or `- tighten it` are never read as flags. Step and action come
 * from the server-derived decision only. E is the outputs hash in the derived decision's own film:approve argv: the
 * snapshot the user reviewed (apply.ts checks the request's `expect` against the decision first). Amounts (C) and modes (M) come
 * from the server-derived decision (its quote or its option's argv), never from the request: the console cannot grant
 * more than the CLI would, and the CLI checks again. The console never spends: approving a quote only records the
 * user's yes; the agent's own CLI spends later under normal admission.
 */
import { stepById } from "../film/chain";
import type { Decision, DecisionRequest, FrameComment, Verdict } from "../../types/console";
import { HttpError } from "../local-server/errors";
import { DECISION_ID_PATTERN, needsIntent } from "./intent";
import { DECISION_ALIASES, type DecisionAlias } from "./spawn";
import { FEEDBACK_FILE_PLACEHOLDER, feedbackFileFor, normaliseAnswer } from "./view/argv";

export const ACTIONS = [
  "approve",
  "choose",
  "quote",
  "changes",
  "another-round",
  "skip",
  "autonomy",
  "ceiling",
  "verdict",
  "record",
  "clarify",
  "raise",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Option ids the projector (WP3) gives each action; other ids of a `choice` decision are candidates. */
export const OPTION_ACTIONS: Readonly<Record<string, Action>> = {
  approve: "approve",
  accept: "approve",
  changes: "changes",
  reject: "changes",
  revise: "changes",
  "another-round": "another-round",
  "critic-round": "another-round",
  skip: "skip",
  clarify: "clarify",
  autonomy: "autonomy",
  ceiling: "ceiling",
};

/** A file a command reads (feedback --file, memory --body-file): written to a temporary file at spawn time. */
export interface Attachment {
  flag: string;
  name: string;
  content: string;
  /** `base64`: `content` is binary (a frame note's overlay PNG); else UTF-8 text. */
  encoding?: "base64";
}
export interface CommandPlan {
  alias: DecisionAlias;
  args: string[];
  attachments?: Attachment[];
}
export interface ActionPlan {
  action: Action;
  /** The first command decides the outcome; the rest follow only after it succeeded (verdict). */
  commands: CommandPlan[];
  /** The chosen option id, when the decision has options. */
  choice?: string;
  /** Shown after an applied verdict (D24). */
  hint?: string;
}

export const POSTMORTEM_HINT =
  "The user's verdict is recorded. Run the creative-postmortem skill on it: turn the verdict into lessons, and a repeated problem into a proposed rule or sensor.";

const unprocessable = (message: string) => new HttpError(422, "INVALID_INPUT", message);

/** `--flag=value`: one argv token, whatever the value starts with. */
export const flagged = (flag: string, value: string): string => `${flag}=${value}`;

/** The pnpm argv of a command, as the user sees it and the inbox records it. */
export const pnpmArgv = (command: CommandPlan, files: readonly string[] = []): string[] => [
  "pnpm",
  command.alias,
  ...command.args,
  ...(command.attachments ?? []).flatMap((attachment, index) => [
    attachment.flag,
    files[index] ?? `<${attachment.name}>`,
  ]),
];

/** The value of `--flag` (or `--flag=value`) in a derived option's argv. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i]!.startsWith(`${flag}=`)) return argv[i]!.slice(flag.length + 1);
  }
  return undefined;
}

/** Option ids the console accepts on any decision with a step even when the projector did not list them. */
export const IMPLICIT_OPTIONS = ["changes", "another-round"] as const;

/** Commands whose derived argv the console runs as derived, the placeholder replaced by the user's words. */
export const DERIVED_ALIASES = ["music", "film:rights"] as const;
/** The projector's stand-in for the user's words in a derived argv (src/lib/console/view/argv.ts). */
export const ANSWER_PLACEHOLDER = "<the user's words>";

const aliasOf = (argv: readonly string[]) => (argv[0] === "pnpm" ? argv[1] : argv[0]);

/** Whether a derived argv runs as derived: a command the console spawns, with the user's words or a feedback file in it. */
export function derivable(argv: readonly string[]): boolean {
  const tokens = normaliseAnswer(argv);
  const alias = aliasOf(tokens);
  return (
    (DECISION_ALIASES as readonly string[]).includes(alias ?? "") &&
    tokens.some(
      (token) =>
        token === ANSWER_PLACEHOLDER || token === FEEDBACK_FILE_PLACEHOLDER || token.endsWith(`=${ANSWER_PLACEHOLDER}`),
    )
  );
}

/**
 * A derived option's command: the projector's argv with every `--flag <the user's words>` as one `--flag=<words>`
 * token, and `--file <feedback file>` as the feedback file written from the words ({@link feedbackFileFor}).
 */
export function derivedCommand(
  option: { id: string; argv: readonly string[] },
  words: string,
  step?: string,
): CommandPlan {
  const tokens = normaliseAnswer(option.argv);
  const [alias, ...rest] = tokens[0] === "pnpm" ? tokens.slice(1) : tokens;
  if (!(DECISION_ALIASES as readonly string[]).includes(alias ?? ""))
    throw unprocessable(`The console does not run ${alias} (option "${option.id}").`);
  const args: string[] = [];
  const attachments: Attachment[] = [];
  let placed = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const next = rest[i + 1];
    if (token.startsWith("--") && next === ANSWER_PLACEHOLDER) {
      args.push(flagged(token, words));
      placed = true;
      i++;
    } else if (token.startsWith("--") && token.endsWith(`=${ANSWER_PLACEHOLDER}`)) {
      args.push(flagged(token.slice(0, -ANSWER_PLACEHOLDER.length - 1), words));
      placed = true;
    } else if (token.startsWith("--") && next === FEEDBACK_FILE_PLACEHOLDER) {
      const content = feedbackFileFor(step ?? "", words);
      attachments.push({ flag: token, name: "changes.json", content: `${JSON.stringify(content, null, 2)}\n` });
      placed = true;
      i++;
    } else if (token === ANSWER_PLACEHOLDER || token === FEEDBACK_FILE_PLACEHOLDER) {
      throw unprocessable(`Option "${option.id}" puts the words outside a flag.`);
    } else args.push(token);
  }
  if (!placed) throw unprocessable(`Option "${option.id}" takes no words.`);
  return { alias: alias as DecisionAlias, args, ...(attachments.length ? { attachments } : {}) };
}

/** Which action an option stands for: its id first, then the alias its server-derived argv runs. */
export function optionAction(decision: Decision, optionId: string | undefined): Action {
  if (optionId !== undefined && (IMPLICIT_OPTIONS as readonly string[]).includes(optionId)) {
    if (!decision.options?.some((item) => item.id === optionId) && !decision.step)
      throw unprocessable(`"${decision.title}" names no step to ask changes of.`);
    return optionId as Action;
  }
  if (optionId === undefined) {
    if (decision.kind === "verdict" || (decision.kind === "gate" && decision.step === "human")) return "verdict";
    if (decision.kind === "gate") return "approve";
    if (decision.kind === "quote") return "quote";
    throw unprocessable(`Choose one of the options of "${decision.title}".`);
  }
  const option = decision.options?.find((item) => item.id === optionId);
  if (!option) throw unprocessable(`"${optionId}" is not an option of "${decision.title}".`);
  const named = OPTION_ACTIONS[option.id] ?? (option.id.startsWith("raise-") ? ("raise" as const) : undefined);
  const alias = aliasOf(option.argv);
  const action: Action | undefined =
    named ??
    (alias === "feedback"
      ? "changes"
      : alias === "film:done" && option.argv.includes("--skip")
        ? "skip"
        : alias === "film:policy"
          ? "autonomy"
          : alias === "budget"
            ? "ceiling"
            : (DERIVED_ALIASES as readonly string[]).includes(alias ?? "")
              ? "record"
              : alias === "film:approve"
                ? decision.kind === "choice"
                  ? "choose"
                  : "approve"
                : undefined);
  if (!action && derivable(option.argv)) return option.id.startsWith("raise-") ? "raise" : "record";
  if (!action) throw unprocessable(`The console has no action for option "${option.id}".`);
  if (action === "approve" && (decision.kind === "verdict" || decision.step === "human")) return "verdict";
  if (action === "approve" && decision.kind === "quote") return "quote";
  return action;
}

export interface PlanInput {
  project: string;
  /** The project's route: decides how a quote is approved. */
  route: "film" | "footage" | string;
  /** The current, server-derived pending decision. */
  decision: Decision;
  request: DecisionRequest;
  /**
   * The `--expect` hashes (apply.ts): `approve` for film:approve (the derived option's own `--expect`), `feedback`
   * for feedback --step. Absent: no `--expect`.
   */
  expects?: { approve?: string; feedback?: string };
}

const FILM_CHAIN_ACTIONS = new Set(["approve", "choose", "changes", "another-round", "skip", "verdict"]);

/** The commands for a user's decision. Throws 422 when the decision cannot be applied as asked. */
export function planDecision({ project, route, decision, request, expects }: PlanInput): ActionPlan {
  const words = request.answer;
  // Step and action come from the derived decision alone: a request's `step` or `verdict` reroutes nothing.
  const step = decision.step;
  const choice = request.choice;
  const action = optionAction(decision, choice);
  if (request.verdict && action !== "verdict") throw unprocessable(`"${decision.title}" takes no verdict.`);
  const expectFlag = expects?.approve ? ["--expect", expects.approve] : [];
  const feedbackExpectFlag = expects?.feedback ? ["--expect", expects.feedback] : [];
  const needStep = () => {
    if (!step) throw unprocessable(`"${decision.title}" names no step.`);
    return step;
  };
  const option = choice
    ? decision.options?.find((item) => item.id === choice)
    : decision.options?.find((item) => item.id === "approve" || item.id === "accept");
  const base = { action, ...(choice ? { choice } : {}) };
  // An option the projector derived with the user's words in it runs as derived: its own flags (--expect, --choice,
  // --raise, --clarify, the feedback file), the words as one --flag=value token. Only the verdict adds its follow-ups.
  if (option && derivable(option.argv)) {
    const command = derivedCommand(option, words, step);
    // A command that records the approval itself names its decision: the server writes the intent for it (intent.ts).
    if (needsIntent(command.alias)) {
      if (!DECISION_ID_PATTERN.test(decision.id))
        throw unprocessable(`Decision id ${decision.id} cannot name an intent.`);
      command.args.push(`--decision=${decision.id}`);
    }
    if (action === "skip" && !stepById(needStep())?.skippable) throw unprocessable(`Step ${step} is not skippable.`);
    if (action !== "verdict") return { ...base, commands: [command] };
    if (step !== "human") throw unprocessable(`The final verdict is given at step human, not ${step ?? "none"}.`);
    if (!request.verdict) throw unprocessable("A verdict carries the overall score (1–10).");
    const [, ...followUps] = verdictCommands(project, words, request.verdict, request.frameComments ?? [], []);
    return { ...base, commands: [command, ...followUps], hint: POSTMORTEM_HINT };
  }
  const approve = (stepId: string): CommandPlan => ({
    alias: "film:approve",
    args: ["--project", project, "--step", stepId, flagged("--answer", words), ...expectFlag],
  });

  // film:approve, feedback, film:done and the verdict are the film chain's: on a recording, a step without a derived
  // command is answered in the chat, and the agent runs what footage:next names (WP12).
  if (route === "footage" && FILM_CHAIN_ACTIONS.has(action))
    throw unprocessable(
      `"${decision.title}" has no console command: answer it in the chat, and the agent runs what footage:next names.`,
    );
  switch (action) {
    case "approve":
    case "choose":
      return { ...base, commands: [approve(needStep())] };
    case "quote": {
      if (route === "film") {
        const stepId = needStep();
        if (stepId !== "material" && stepId !== "narration")
          throw unprocessable(`A film approves paid quotes at material or narration, not at ${stepId}.`);
        return { ...base, commands: [approve(stepId)] };
      }
      const ceiling = decision.quote?.ceilingUsd ?? (option ? flagValue(option.argv, "--ceiling-usd") : undefined);
      if (ceiling === undefined || ceiling === null)
        throw unprocessable("This quote names no ceiling to raise: the agent must quote the amount first.");
      return { ...base, commands: [budgetCommand(project, Number(ceiling), words)] };
    }
    case "changes":
    case "another-round": {
      const stepId = needStep();
      if (action === "another-round" && !stepById(stepId)?.critic)
        throw unprocessable(`Step ${stepId} has no critic: ask for changes instead.`);
      return {
        ...base,
        commands: [
          {
            alias: "feedback",
            args: [
              "--project",
              project,
              "--step",
              stepId,
              flagged("--answer", words),
              ...feedbackExpectFlag,
              "--confirm",
            ],
          },
        ],
      };
    }
    case "record":
    case "clarify":
    case "raise":
      if (!option) throw unprocessable(`Choose one of the options of "${decision.title}".`);
      return { ...base, commands: [derivedCommand(option, words, step)] };
    case "skip": {
      const stepId = needStep();
      if (!stepById(stepId)?.skippable) throw unprocessable(`Step ${stepId} is not skippable.`);
      return {
        ...base,
        commands: [{ alias: "film:done", args: ["--project", project, "--step", stepId, flagged("--skip", words)] }],
      };
    }
    case "autonomy": {
      const mode = option ? flagValue(option.argv, "--autonomy") : undefined;
      if (mode !== "interactive" && mode !== "autonomous")
        throw unprocessable("This option names no autonomy mode (interactive or autonomous).");
      const ceiling = option ? flagValue(option.argv, "--ceiling-usd") : undefined;
      return {
        ...base,
        commands: [autonomyCommand(project, mode, words, ceiling === undefined ? undefined : Number(ceiling))],
      };
    }
    case "ceiling": {
      const ceiling = option ? flagValue(option.argv, "--ceiling-usd") : undefined;
      if (ceiling === undefined) throw unprocessable("This option names no ceiling.");
      return { ...base, commands: [budgetCommand(project, Number(ceiling), words)] };
    }
    case "verdict": {
      if (step !== "human") throw unprocessable(`The final verdict is given at step human, not ${step ?? "none"}.`);
      if (!request.verdict) throw unprocessable("A verdict carries the overall score (1–10).");
      return {
        ...base,
        commands: verdictCommands(project, words, request.verdict, request.frameComments ?? [], expectFlag),
        hint: POSTMORTEM_HINT,
      };
    }
  }
}

function usd(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw unprocessable(`${value} is not an amount in USD.`);
  return String(value);
}

/** `budget --ceiling-usd` with the user's words (D13): the store refuses what needs more authority. */
export const budgetCommand = (project: string, ceilingUsd: number, words: string): CommandPlan => ({
  alias: "budget",
  args: ["--project", project, "--ceiling-usd", usd(ceilingUsd), flagged("--answer", words)],
});

/** `film:policy --autonomy` with the user's words (D13), optionally with the policy's ceiling. */
export const autonomyCommand = (
  project: string,
  mode: "interactive" | "autonomous",
  words: string,
  ceilingUsd?: number,
): CommandPlan => ({
  alias: "film:policy",
  args: [
    "--project",
    project,
    "--autonomy",
    mode,
    flagged("--answer", words),
    ...(ceilingUsd === undefined ? [] : ["--ceiling-usd", usd(ceilingUsd)]),
  ],
});

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line for memory's summary (8–160 characters): the score, the axis scores and the start of the words. */
export function verdictSummary(verdict: Verdict, words: string): string {
  const axes = Object.entries(verdict.axes ?? {})
    .map(([axis, score]) => `${axis} ${score}`)
    .join(", ");
  const head = `Final verdict ${verdict.score}/10${axes ? ` (${axes})` : ""}`;
  const room = 160 - head.length - 2;
  const said = oneLine(words);
  if (room < 8) return head.slice(0, 160);
  return `${head}: ${said.length > room ? `${said.slice(0, room - 1)}…` : said}`;
}

/** The body of the verdict's memory entry: the scores and the user's texts, verbatim. */
export function verdictBody(verdict: Verdict, words: string): string {
  const lines = [`Overall: ${verdict.score}/10`];
  for (const [axis, score] of Object.entries(verdict.axes ?? {})) lines.push(`${axis}: ${score}/10`);
  lines.push("", "The user's words:", "", words);
  if (verdict.worked?.trim()) lines.push("", "What worked:", "", verdict.worked);
  if (verdict.didNot?.trim()) lines.push("", "What did not:", "", verdict.didNot);
  return `${lines.join("\n")}\n`;
}

/** Frame comments as feedback items on the film the user watched; `accept`, so the approval just given stands. */
export function frameCommentsFeedback(comments: readonly FrameComment[], project: string): unknown {
  const first = comments[0]!;
  const watched =
    first.media.root === "out"
      ? `out/${project}/${first.media.path}`
      : `public/projects/${project}/${first.media.path}`;
  return {
    verdict: "accept",
    watched: { path: watched, ...(first.media.sha256 ? { sha256: first.media.sha256 } : {}) },
    source: { kind: "user" },
    items: comments.map((comment) => {
      const fps = comment.media.fps ?? 30;
      const second = Math.round((comment.frame / fps) * 1000) / 1000;
      return {
        quote: comment.text,
        aspect: "shot",
        severity: "should",
        at: { fromSec: second, toSec: second },
        frame: comment.frame,
        ...(comment.region ? { region: comment.region } : {}),
      };
    }),
  };
}

function verdictCommands(
  project: string,
  words: string,
  verdict: Verdict,
  comments: readonly FrameComment[],
  expectFlag: string[],
): CommandPlan[] {
  const media = new Set(comments.map((comment) => `${comment.media.root ?? "project"}:${comment.media.path}`));
  if (media.size > 1) throw unprocessable("Frame comments of a verdict are on one film.");
  const commands: CommandPlan[] = [
    {
      alias: "film:approve",
      args: ["--project", project, "--step", "human", flagged("--answer", words), ...expectFlag],
    },
    {
      alias: "memory",
      args: [
        "--add",
        "--type",
        "decision",
        flagged("--summary", verdictSummary(verdict, words)),
        flagged("--quote", words),
        "--project",
        project,
        "--step",
        "human",
      ],
      attachments: [{ flag: "--body-file", name: "verdict.md", content: verdictBody(verdict, words) }],
    },
  ];
  if (comments.length)
    commands.push({
      alias: "feedback",
      args: ["--project", project, "--confirm"],
      attachments: [
        {
          flag: "--file",
          name: "frame-comments.json",
          content: `${JSON.stringify(frameCommentsFeedback(comments, project), null, 2)}\n`,
        },
      ],
    });
  return commands;
}

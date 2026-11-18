/**
 * The exact command a decision option runs (RFC 0004 §8), as a literal argv: `pnpm <alias> --flag value …`. Pure
 * functions, no I/O. The user's words travel as {@link ANSWER_PLACEHOLDER}; the decisions work package (WP5)
 * re-derives the pending decision, replaces the placeholder with the submitted words ({@link withAnswer}) and spawns
 * the result; it never runs an argv sent by the client. Every flag here is one the target script declares
 * (tests/console-projector-argv.test.ts checks them against the scripts' `parseArgs`).
 */

/** Stands for the user's words until the console submits them (the chain's own placeholder: film:approve refuses it). */
export const ANSWER_PLACEHOLDER = "<the user's words>";

export type Argv = string[];

const pnpm = (alias: string, ...args: string[]): Argv => ["pnpm", alias, ...args];

/**
 * `film:approve --project P --step S --answer <words> --expect <hash>`. `expect` is {@link import("./film").outputsHash}
 * of the step's outputs: film:approve refuses the approval once they changed. The console (WP5) runs it with the
 * words as one `--answer=<words>` token.
 */
export const filmApproveArgv = (project: string, step: string, expect?: string, choice?: string): Argv =>
  pnpm(
    "film:approve",
    "--project",
    project,
    "--step",
    step,
    "--answer",
    ANSWER_PLACEHOLDER,
    ...(expect ? ["--expect", expect] : []),
    ...(choice ? ["--choice", choice] : []),
  );

/**
 * Stands for the path of the feedback file the console writes from the user's words before it spawns
 * (`{verdict, items: [{quote, aspect, …}]}`, scripts/feedback.ts); like the answer, the client never supplies it.
 */
export const FEEDBACK_FILE_PLACEHOLDER = "<feedback file>";

/**
 * Ask for changes once a film was rendered: `feedback --project P --file <feedback file> --confirm` reopens the step
 * that owns each item's aspect (feedback is bound to the watched `out/<id>/film.mp4`; without it the CLI refuses).
 * The file is {@link feedbackFileFor}'s object, written by the console before it spawns.
 */
export const feedbackFileArgv = (project: string): Argv =>
  pnpm("feedback", "--project", project, "--file", FEEDBACK_FILE_PLACEHOLDER, "--confirm");

/** The aspect (src/types/feedback.ts) a change asked at a step is about, so `feedback` reopens the right owner. */
export const STEP_ASPECT: Readonly<Record<string, string>> = {
  intake: "audience",
  strategy: "audience",
  truth: "claim",
  ideas: "concept",
  "idea-review": "concept",
  concept: "concept",
  music: "music",
  "script-variants": "words",
  "script-review": "words",
  script: "words",
  narration: "voice",
  material: "material",
  look: "look",
  "beat-sheet": "pacing",
  animatic: "pacing",
  build: "shot",
  sound: "sfx-mix",
  "replica-spec": "shot",
};

/**
 * The feedback file for "ask for changes" at `step`: the user's words verbatim and the step's aspect (`unclear` when no
 * step owns it, e.g. the final verdict: the CLI then asks where the change belongs). `watched` defaults to the film.
 */
export const feedbackFileFor = (step: string, words: string, aspect: string = STEP_ASPECT[step] ?? "unclear") => ({
  items: [{ quote: words, aspect, severity: "must" as const }],
});

/**
 * Ask for changes before any render exists, when no command reopens a step on the user's words: the words are kept
 * as a decision in the local memory (`memory --add --type decision`), which the next step's answer carries to the
 * orchestrator; the agent revises and the gate is asked again.
 */
export const memoryChangesArgv = (project: string, step: string): Argv =>
  pnpm(
    "memory",
    "--add",
    "--type",
    "decision",
    "--summary",
    `The user asks for changes at step ${step}`.slice(0, 160),
    "--quote",
    ANSWER_PLACEHOLDER,
    "--project",
    project,
    "--step",
    step,
  );

/** The user's answer when the same objection came back to a step: `feedback --project P --step S --clarify <words>`. */
export const feedbackClarifyArgv = (project: string, step: string): Argv =>
  pnpm("feedback", "--project", project, "--step", step, "--clarify", ANSWER_PLACEHOLDER);

/** `film:done --project P --step S --skip <words>`: only for a step the chain marks skippable. */
export const filmSkipArgv = (project: string, step: string): Argv =>
  pnpm("film:done", "--project", project, "--step", step, "--skip", ANSWER_PLACEHOLDER);

/** The music step's first question: record the user's pick of one shortlisted candidate. */
export const musicRecordArgv = (project: string, route: string, candidate: string): Argv =>
  pnpm(
    "music",
    "--action",
    "record",
    "--project",
    project,
    "--route",
    route,
    "--candidate",
    candidate,
    "--answer",
    ANSWER_PLACEHOLDER,
    "--reason",
    ANSWER_PLACEHOLDER,
  );

/** A replica's rights answer (`film:rights`), one option per status. */
export const filmRightsArgv = (project: string, status: "owned" | "licensed" | "study-only"): Argv =>
  pnpm("film:rights", "--project", project, "--status", status, "--answer", ANSWER_PLACEHOLDER);

/** Footage shorts: the clips the user approves, in their words (`--approved-by`). */
export const shortsRequestArgv = (project: string, selections: string, ids: string): Argv =>
  pnpm(
    "shorts:request",
    "--project",
    project,
    "--selections",
    selections,
    "--ids",
    ids,
    "--approved-by",
    ANSWER_PLACEHOLDER,
  );

/** Footage: a first or raised budget ceiling on the user's words (D13). */
export const budgetCeilingArgv = (project: string, ceilingUsd: number): Argv =>
  pnpm("budget", "--project", project, "--ceiling-usd", String(ceilingUsd), "--answer", ANSWER_PLACEHOLDER);

/** Replaces every {@link ANSWER_PLACEHOLDER} with the user's words; the rest of the argv is unchanged. */
export const withAnswer = (argv: readonly string[], answer: string): Argv =>
  argv.map((token) => (token === ANSWER_PLACEHOLDER ? answer : token));

/** The chain's own placeholders for the user's words, normalised to {@link ANSWER_PLACEHOLDER}. */
export const normaliseAnswer = (argv: readonly string[]): Argv =>
  argv.map((token) => (/^<(?:the )?user'?s (?:own )?words>$/i.test(token) ? ANSWER_PLACEHOLDER : token));

/**
 * Splits a one-line `pnpm …` command as the chain and footage:next print it (double-quoted values, JSON escapes) into
 * an argv, or undefined when it is not a single plain pnpm command (pipes, redirects, `&&`, prose around it).
 */
export function splitCommand(command: string): Argv | undefined {
  const tokens: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'|&;<>]+|<[^<>]*>))/gy;
  let index = 0;
  const trimmed = command.trim();
  while (index < trimmed.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(trimmed);
    if (!match) return undefined;
    index = pattern.lastIndex;
    if (match[1] !== undefined) {
      try {
        tokens.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        return undefined;
      }
    } else tokens.push(match[2] ?? match[3]!);
    while (trimmed[index] === " ") index++;
  }
  return tokens[0] === "pnpm" && tokens.length >= 2 ? tokens : undefined;
}

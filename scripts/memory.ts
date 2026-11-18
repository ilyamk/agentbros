import { improvementHistory } from "../src/lib/blender-arsenal/improvements";
/** The user's local memory (memory/AGENTS.md): add, read, query, list, count a sighting, retire, consolidate, reindex; propose and move improvement proposals. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { wordsChannel } from "../src/lib/cli/channel";
import {
  addMemory,
  consolidate,
  getMemory,
  loadMemory,
  markSeen,
  memoryDir,
  moveProposal,
  queryMemory,
  setStatus,
  writeIndex,
  INDEX_FILE,
  VERIFY_DAYS,
} from "../src/lib/memory";
import { MEMORY_TYPES, PROPOSAL_CHANGES, type MemoryEntry, type MemoryType } from "../src/types/memory";
import { PIPELINE_STAGES } from "../src/types/pipeline";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { STEP as FOOTAGE_STEP } from "../src/lib/footage/next";
import { listPlaybookIds, playbooksRoot } from "../src/lib/playbooks";

const ACTIONS = [
  "add",
  "id",
  "query",
  "list",
  "seen",
  "retire",
  "consolidate",
  "reindex",
  "propose",
  "approve",
  "applied",
  "reject",
  "verdict",
] as const;
const VERDICT_STATES = ["verified", "ineffective", "retired"] as const;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
/** Relative to the working directory through real paths when inside it; absolute when the memory root lies elsewhere. */
const relativisePath = (file: string) => {
  const real = (target: string) => (existsSync(target) ? realpathSync(target) : path.resolve(target));
  const relative = path.relative(real(process.cwd()), real(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return real(file);
  return relative.split(path.sep).join("/") || ".";
};

/** Step ids a scope may name: the film chain's steps, footage:next's steps and template-mode pipeline stages. */
const knownSteps = () =>
  [
    ...new Set([
      ...FILM_CHAIN.map((step) => step.id),
      ...Object.values(FOOTAGE_STEP).map(([id]) => id),
      ...PIPELINE_STAGES,
    ]),
  ].sort();

function checkKnown(flag: string, values: string[], known: string[]): void {
  const unknown = values.filter((value) => !known.includes(value));
  if (unknown.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `--${flag}: unknown ${unknown.join(", ")}. Valid: ${known.join(", ")}.`,
    });
}

function checkScope(playbook: string | undefined, step: string | undefined): void {
  if (playbook) checkKnown("playbook", list(playbook), listPlaybookIds(playbooksRoot()));
  if (step) checkKnown("step", list(step), knownSteps());
}
const fileOf = (entry: MemoryEntry) => relativisePath(getMemory(entry.id).file);

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

/** Each sha must name a commit of the git repository the command runs in, reachable from HEAD (merged); returns the full shas. */
function resolveCommits(shas: string[]): string[] {
  if (!shas.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--applied needs --commit <sha>[,<sha>...]." });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "--applied checks each commit in the git repository; run it from the repository root.",
    });
  }
  return shas.map((sha) => {
    if (!/^[0-9a-f]{7,40}$/i.test(sha))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `--commit: ${sha} is not a commit sha (7-40 hex characters).`,
      });
    const full = git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
    if (git("cat-file", "-e", `${sha}^{commit}`).status !== 0 || full.status !== 0) {
      throw new CliErrorObject({ code: "VALIDATION", message: `--commit: ${sha} is not a commit in this repository.` });
    }
    if (git("merge-base", "--is-ancestor", full.stdout.trim(), "HEAD").status !== 0) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `--commit: ${sha} is not reachable from HEAD; merge it first.`,
      });
    }
    return full.stdout.trim();
  });
}

/** Paths that do not exist yet in the working directory (they may be new files). */
const missingPaths = (paths: string[]) => paths.filter((file) => !existsSync(file));

/** Files the commits change. */
const changedFiles = (shas: string[]) => [
  ...new Set(
    shas.flatMap((sha) =>
      git("show", "--name-only", "--format=", sha)
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ),
];

function sourceOf(args: { quote?: string; agent?: string; evidence?: string; measured?: string }) {
  const sources = [
    args.quote !== undefined,
    args.agent !== undefined || args.evidence !== undefined,
    args.measured !== undefined,
  ].filter(Boolean).length;
  if (sources !== 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        'Give one source: --quote "<the user\'s words>", --agent <name> --evidence "<what>", or --measured "<what>".',
    });
  if ((args.agent === undefined) !== (args.evidence === undefined))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--agent and --evidence go together." });
  return args.quote !== undefined
    ? { kind: "user" as const, quote: args.quote, ...wordsChannel() }
    : args.measured !== undefined
      ? { kind: "measured" as const, evidence: args.measured }
      : { kind: "agent" as const, agent: args.agent!, evidence: args.evidence! };
}

function bodyOf(file: string | undefined): string {
  if (!file) return "";
  if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No body file ${file}.` });
  return readFileSync(file, "utf8");
}

void runScript(async () => {
  const args = parseArgs([
    {
      name: "add",
      type: "boolean",
      description: "Add an entry: --type, --summary and one source (--quote, --agent with --evidence, or --measured)",
    },
    { name: "id", description: "Print one entry in full, with its body" },
    {
      name: "query",
      description: "Ranked entries for these words, within --playbook, --step, --platform, --project and --type",
    },
    { name: "list", type: "boolean", description: "Every entry (--type narrows), with the store's warnings" },
    { name: "seen", description: "One more sighting of an observation or gap (occurrences + 1)" },
    {
      name: "retire",
      description: "Retire an entry that no longer holds; supersede instead when a new entry replaces it",
    },
    {
      name: "consolidate",
      type: "boolean",
      description: "Read-only report: near-duplicates, repeats (seen >= 2), stale (> 180 days), broken files",
    },
    { name: "reindex", type: "boolean", description: `Regenerate memory/${INDEX_FILE} from the entry files` },
    { name: "type", choices: MEMORY_TYPES, description: "Entry type: for --add, and a filter for --query and --list" },
    {
      name: "summary",
      description: "One line, 8-160 characters; a lesson names no product or brand (specifics go in the body)",
    },
    {
      name: "quote",
      description: "The user's own words, verbatim, in their language (required for preference, decision and lesson)",
    },
    { name: "agent", description: "The agent that saw it (observation or gap); needs --evidence" },
    {
      name: "evidence",
      description:
        "What the agent saw: an artefact path, a frame or a command; with --seen, a dated line added to the body",
    },
    { name: "measured", description: "Measured evidence written by a command (episodes, recorded workarounds)" },
    { name: "playbook", description: "Comma-separated playbook ids (scope for --add, filter for --query)" },
    { name: "step", description: "Comma-separated chain or footage step ids" },
    { name: "platform", description: "Comma-separated platforms (tiktok, youtube-shorts, ...)" },
    { name: "axis", description: "Comma-separated creative rubric axes, for lessons" },
    { name: "project", description: "The project it came from (an episode needs one); a filter for --query" },
    { name: "body-file", description: "A text file whose content becomes the entry's body" },
    { name: "supersedes", description: "Comma-separated ids this entry replaces; they become superseded" },
    { name: "limit", type: "number", description: "--query: at most this many entries [default: 7]" },
    {
      name: "max-chars",
      type: "number",
      description: "--query: at most this many summary characters in total [default: 1200]",
    },
    {
      name: "propose",
      type: "boolean",
      description:
        "File an improvement proposal: --summary, --change, --target, --cause, [--test], and --agent orchestrator --evidence (or --quote)",
    },
    { name: "change", choices: PROPOSAL_CHANGES, description: "--propose: what it changes" },
    { name: "target", description: "--propose: comma-separated repository paths the change touches" },
    { name: "cause", description: "--propose: comma-separated active observation, gap or lesson ids it answers" },
    { name: "test", description: "--propose: the test that guards the change" },
    { name: "approve", description: "A proposal the user approved: needs --quote with their words" },
    {
      name: "applied",
      description: "A proposal whose change landed: needs --commit; each sha must be a commit reachable from HEAD here",
    },
    { name: "commit", description: "--applied: comma-separated commit shas" },
    {
      name: "reject",
      description: "A proposal turned down; --text gives why; an approved one needs --quote with the user's words",
    },
    {
      name: "verdict",
      description: `A verdict on a proposal: --state verified|ineffective (from applied, with --quote of the user's words) or retired, with --text`,
    },
    { name: "state", choices: VERDICT_STATES, description: "--verdict: verified, ineffective or retired" },
    { name: "text", description: "--verdict and --reject: why, in one line" },
  ] as const);

  const chosen = ACTIONS.filter((action) => args[action] !== undefined && args[action] !== false);
  if (chosen.length !== 1) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Pass exactly one of ${ACTIONS.map((action) => `--${action}`).join(", ")}${chosen.length ? `; got ${chosen.map((action) => `--${action}`).join(", ")}` : ""}.`,
    });
  }
  const type = args.type as MemoryType | undefined;
  if (args.add || args.propose || args.query !== undefined) checkScope(args.playbook, args.step);
  const scope = () => ({
    playbooks: list(args.playbook),
    steps: list(args.step),
    platforms: list(args.platform) as MemoryEntry["scope"]["platforms"],
    axes: list(args.axis),
    ...(args.project ? { project: args.project } : {}),
  });

  if (args.add) {
    if (!type || !args.summary)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: '--add needs --type <type> and --summary "<one line>".',
      });
    if (type === "proposal")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "File a proposal with --propose --summary --change --target --cause [--test] --agent orchestrator --evidence.",
      });
    const entry = addMemory({
      type,
      summary: args.summary,
      source: sourceOf(args),
      body: bodyOf(args["body-file"]),
      supersedes: list(args.supersedes),
      scope: scope(),
    });
    return { outputs: [fileOf(entry)], metadata: { entry } };
  }
  if (args.propose) {
    if (!args.summary || !args.change || !args.target || !args.cause) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: '--propose needs --summary "<one line>", --change <kind>, --target <paths> and --cause <ids>.',
      });
    }
    const entry = addMemory({
      type: "proposal",
      summary: args.summary,
      source: sourceOf(args),
      body: bodyOf(args["body-file"]),
      supersedes: list(args.supersedes),
      scope: scope(),
      proposal: {
        change: args.change as (typeof PROPOSAL_CHANGES)[number],
        targets: list(args.target),
        causes: list(args.cause),
        ...(args.test ? { test: args.test } : {}),
      },
    });
    const missing = missingPaths([...entry.proposal!.targets, ...(entry.proposal!.test ? [entry.proposal!.test] : [])]);
    return {
      outputs: [fileOf(entry)],
      metadata: {
        entry,
        ...(missing.length
          ? { warnings: missing.map((file) => `${file} does not exist yet; fine if the change creates it.`) }
          : {}),
        hint: `Put it to the user; on their go-ahead: pnpm memory --approve ${entry.id} --quote "<the user's words>".`,
      },
    };
  }
  if (args.approve !== undefined) {
    if (args.quote === undefined)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--approve needs --quote "<the user's words>".` });
    const entry = moveProposal(args.approve, { to: "approved", quote: args.quote });
    return {
      outputs: [fileOf(entry)],
      metadata: {
        entry,
        hint: "Implement it in a worktree with a test that fails before and passes after; after the merge, --applied with its commits.",
      },
    };
  }
  if (args.applied !== undefined) {
    const commits = resolveCommits(list(args.commit));
    const proposal = getMemory(args.applied).proposal;
    const watched = proposal
      ? [...proposal.targets, ...(proposal.test ? [proposal.test] : [])].map((file) => file.replace(/\/+$/, ""))
      : [];
    const touched = changedFiles(commits).some((file) =>
      watched.some((target) => file === target || file.startsWith(`${target}/`)),
    );
    const entry = moveProposal(args.applied, { to: "applied", commits });
    return {
      outputs: [fileOf(entry)],
      metadata: {
        entry,
        ...(touched
          ? {}
          : {
              warnings: [
                "None of the commits touches a --target or the --test path; check they are the right commits.",
              ],
            }),
        hint: `pnpm memory --consolidate reviews it: a cause seen again means ineffective; none for ${VERIFY_DAYS} days, verified. The user confirms the verdict.`,
      },
    };
  }
  if (args.reject !== undefined) {
    const entry = moveProposal(args.reject, {
      to: "rejected",
      ...(args.text !== undefined ? { verdict: args.text } : {}),
      ...(args.quote !== undefined ? { quote: args.quote } : {}),
    });
    return { outputs: [fileOf(entry)], metadata: { entry } };
  }
  if (args.verdict !== undefined) {
    if (!args.state || args.text === undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--verdict needs --state ${VERDICT_STATES.join("|")} and --text "<why>".`,
      });
    const state = args.state as (typeof VERDICT_STATES)[number];
    if (state !== "retired" && args.quote === undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--verdict --state ${state} needs --quote "<the user's words>".`,
      });
    const entry = moveProposal(
      args.verdict,
      state === "retired" ? { to: state, verdict: args.text } : { to: state, verdict: args.text, quote: args.quote! },
    );
    return { outputs: [fileOf(entry)], metadata: { entry } };
  }
  if (args.id !== undefined) {
    const { file, ...entry } = getMemory(args.id);
    return { metadata: { entry: { ...entry, file: relativisePath(file) } } };
  }
  if (args.query !== undefined) {
    const entries = queryMemory({
      text: args.query,
      ...(type ? { types: [type] } : {}),
      ...(args.playbook ? { playbook: args.playbook } : {}),
      ...(args.step ? { step: args.step } : {}),
      ...(args.platform ? { platform: args.platform } : {}),
      ...(args.project ? { project: args.project } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args["max-chars"] !== undefined ? { maxChars: args["max-chars"] } : {}),
    });
    return { metadata: { entries, hint: "pnpm memory --id <id> prints an entry in full." } };
  }
  if (args.list) {
    const { entries, warnings } = loadMemory();
    return {
      metadata: {
        dir: relativisePath(memoryDir()),
        entries: entries
          .filter((entry) => !type || entry.type === type)
          .map(({ id, type: kind, status, summary, occurrences, createdAt, proposal }) => ({
            id,
            type: kind,
            status,
            summary,
            occurrences,
            createdAt,
            ...(proposal ? { state: proposal.state } : {}),
          })),
        warnings,
      },
    };
  }
  if (args.seen !== undefined) {
    const entry = markSeen(args.seen, undefined, args.evidence);
    return {
      outputs: [fileOf(entry)],
      metadata: {
        entry,
        ...(entry.occurrences >= 2
          ? { hint: "Seen twice or more: a candidate for the creative-postmortem improvement loop." }
          : {}),
      },
    };
  }
  if (args.retire !== undefined) {
    const entry = setStatus(args.retire, "retired");
    return { outputs: [fileOf(entry)], metadata: { entry } };
  }
  if (args.consolidate) {
    const report = consolidate();
    let blenderImprovements: Array<{ file: string; target: string; decision: string; verdict: string }> = [];
    const blenderWarnings: string[] = [];
    try {
      blenderImprovements = improvementHistory().map(({ file, target, decision, ab }) => ({
        file,
        target,
        decision,
        verdict: ab.verdict,
      }));
    } catch (error) {
      blenderWarnings.push(String(error));
    }
    return {
      metadata: {
        ...report,
        blenderImprovements,
        blenderWarnings,
        hint: "Merge duplicates with --add --supersedes; take suggest to the creative-postmortem skill (--propose); put review candidates to the user (--verdict); review stale entries with the user (--retire or a superseding entry); fix or remove broken files, then --reindex.",
      },
    };
  }
  writeIndex();
  return {
    outputs: [relativisePath(path.join(memoryDir(), INDEX_FILE))],
    metadata: { entries: loadMemory().entries.length },
  };
});

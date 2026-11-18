/**
 * The `guard` role's verdict (RFC 0004 §7.1): for a shell command naming `pnpm <alias> --project <id>` (or a
 * repository script run directly), the console's pause check and the step lease's predicate, ported from
 * src/lib/step-lease/{lease,guard}.ts so the harness can refuse before the command starts. runScript stays the
 * authority: this only denies what runScript would refuse, with the same reason, and allows whatever it cannot judge
 * (an unknown alias, an unreadable lease or policy). Parity is tested in tests/console-hooks-guard.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clamp, existingProject, isObject, PROJECT_ID, projectDirOf, readJson, str } from "./runtime.mjs";
import { commandOf, splitShell } from "./shell.mjs";
import { readControl, readLease } from "./state.mjs";

/** Kept equal to ALWAYS_ADMITTED in src/lib/step-lease/lease.ts (tests/console-hooks-guard.test.ts). */
export const ALWAYS_ADMITTED = [
  "next",
  "film:next",
  "film:status",
  "film:brief",
  "film:done",
  "footage:next",
  "step:unlock",
  "step:violations",
  "film:policy",
  "film:revert",
  "console",
  "console:wait",
  "console:control",
  "job:cancel",
];

/** Kept equal to CONTROL_ALIASES in src/lib/step-lease/lease.ts: admitted by a lease, and while a project is paused. */
export const CONTROL_ALIASES = [
  ...ALWAYS_ADMITTED,
  "film:route",
  "feedback",
  "memory",
  "ref:rate",
  "library:list",
  "library:preview",
  "playbook",
  "commands",
  "budget",
  "cost:report",
  "lint",
  "typecheck",
  "console:card",
  "console:snapshot",
];

/** Kept equal to SESSION_FILE in src/types/console.ts (tests/console-hooks-guard.test.ts). */
export const CONSOLE_SESSION_FILE = "out/console/session.json";
/** Kept equal to GRANT_ENV and GRANT_AT_ENV in src/lib/console/grant.ts. */
export const CONSOLE_GRANT_ENVS = ["AGENTBROS_CONSOLE_GRANT", "AGENTBROS_CONSOLE_GRANT_AT"];

const SESSION_DENIAL = `The studio console's token (${CONSOLE_SESSION_FILE}) is the user's: an agent never reads, copies or writes it. It signs the user's own decisions in the console (approvals included); ask the user to decide there.`;
const INBOX_DENIAL = `A project's pipeline/inbox/ (decisions and the console's intents) is written only by the studio console on the user's click: an agent never writes it. Ask the user to decide in the console.`;
const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const GRANT_DENIAL = `AGENTBROS_CONSOLE_GRANT is signed by the studio console for the user's own decisions: an agent never sets or reads it. Ask the user to decide in the console.`;
const ATTRIBUTION_DENIAL = `AGENTBROS_ACTOR and AGENTBROS_CHANNEL say a command is the user's own console decision: only the studio console sets them (with its grant). An agent never sets them; ask the user to decide in the console.`;
const PRINT_TOKEN_DENIAL = `--print-token prints the studio console's token URL, which is the user's: an agent never asks for it. Use the token-free URL the command prints, and ask the user to open the console (pnpm console --open opens it in their browser).`;
/** An assignment of the attribution variables (a prefix, export, env, setenv or a code string); mentions pass. */
const ATTRIBUTION_SETTER = /\bAGENTBROS_(?:ACTOR|CHANNEL)\s*=/;
const PRINT_TOKEN = /(?:^|[\s'"])--print-token(?=$|[\s'"=;&|)])/;

/**
 * Defence in depth for the console grant (RFC 0004 D15): a tool call that reads or writes the console's session token,
 * or names the grant variables, sets AGENTBROS_ACTOR or AGENTBROS_CHANNEL, asks any command for `--print-token`, or
 * writes a project's pipeline/inbox/ (decisions and the server's intents; a Codex apply_patch counts as a write of
 * every file it touches), is denied for every project, before any lease or pause is judged. Shell lines are matched
 * as text (any mention of session.json, inbox/intent or the grant), file tools by the file or folder they name. Text matching is defence in
 * depth, not a boundary: a glob gets past it.
 */
export function consoleSecretRefusal(payload, root) {
  const tool = payload?.tool;
  if (!tool) return undefined;
  if (tool.kind === "shell") {
    const command = tool.command ?? "";
    if (CONSOLE_GRANT_ENVS.some((name) => command.includes(name))) return GRANT_DENIAL;
    if (ATTRIBUTION_SETTER.test(command)) return ATTRIBUTION_DENIAL;
    if (PRINT_TOKEN.test(command)) return PRINT_TOKEN_DENIAL;
    if (/session\.json/i.test(command)) return SESSION_DENIAL;
    if (/inbox\/intent/i.test(command)) return INBOX_DENIAL;
    return undefined;
  }
  // Codex apply_patch: every file the patch adds, updates, deletes or moves to is judged as a write.
  if (tool.kind === "patch") {
    for (const file of tool.files ?? []) {
      const refusal = fileRefusal("Write", file, payload, root);
      if (refusal) return refusal;
    }
    return undefined;
  }
  if (!tool.filePath) return undefined;
  return fileRefusal(tool.name, tool.filePath, payload, root);
}

/** A file tool's refusal: the session token (any checkout's, by place) for every tool, the inbox for writers. */
function fileRefusal(toolName, filePath, payload, root) {
  const target = path.join(root, CONSOLE_SESSION_FILE);
  const resolved = path.resolve(payload.cwd ?? root, filePath);
  const real = (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  const named = new Set([resolved, real(resolved)]);
  const guarded = [target, real(target), path.dirname(target), real(path.dirname(target))];
  if (guarded.some((file) => named.has(file))) return SESSION_DENIAL;
  // The console's decision records and intents: written by the server only (src/lib/console/{inbox,intent}.ts).
  if (WRITE_TOOLS.includes(toolName)) {
    const parts = path.relative(root, real(resolved)).split(path.sep);
    if (parts[0] === "public" && parts[1] === "projects" && parts[3] === "pipeline" && parts[4] === "inbox")
      return INBOX_DENIAL;
  }
  // Any checkout's console token (another worktree), by its place: out/console/session.json.
  if (
    path.basename(resolved).toLowerCase() === "session.json" &&
    path.basename(path.dirname(resolved)) === "console" &&
    path.basename(path.dirname(path.dirname(resolved))) === "out"
  )
    return SESSION_DENIAL;
  return undefined;
}

const BENCHMARK_PROXY = "orchestrator-benchmark";
const RANK = { none: 0, "may-spend": 1, paid: 2 };

let table;
/** alias -> { script, spend } for every registry alias with a script (commands.json, generated from the registry). */
export function commandTable() {
  if (!table) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands.json");
    const value = readJson(file);
    table = isObject(value?.aliases) ? value.aliases : {};
  }
  return table;
}

/** The aliases sharing an alias's script (runScript judges the script, not the alias) and their highest spend. */
function resolveAlias(alias, aliases = commandTable()) {
  const entry = aliases[alias];
  if (!isObject(entry) || !str(entry.script)) return undefined;
  return scriptGroup(entry.script, aliases);
}

/**
 * `guarded`: the script calls runScript, whose guardStep judges it. Scripts that never reach guardStep are never
 * refused by it, so the hook never judges them either.
 */
function scriptGroup(script, aliases = commandTable()) {
  const group = Object.entries(aliases).filter(([, entry]) => entry?.script === script);
  if (!group.length) return undefined;
  const spend = group.reduce((most, [, entry]) => (RANK[entry.spend] > RANK[most] ? entry.spend : most), "none");
  return { aliases: group.map(([name]) => name), spend, guarded: group.every(([, entry]) => entry?.guarded === true) };
}

/** Words that change the directory, the environment or what runs next: the guard stops judging there (H6). */
const BARRIERS = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "unset",
  "source",
  ".",
  "eval",
  "exec",
  "set",
  "alias",
  "declare",
  "typeset",
  "bash",
  "sh",
  "zsh",
  "xargs",
  "sudo",
]);
const SCRIPT_PATH = /^(?:\.\/)?(scripts\/[A-Za-z0-9._/-]+\.(?:ts|mts|mjs|js))$/;

/** The project runScript would read from argv (projectFromArgv): the first --project, undefined when invalid. */
function projectOf(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const value = token === "--project" ? args[i + 1] : token.startsWith("--project=") ? token.slice(10) : undefined;
    if (value !== undefined) return PROJECT_ID.test(value) && value.length <= 128 ? value : undefined;
  }
  return undefined;
}

/** Every value of these flags, in the forms parseArgs reads (`--x v`, `--x=v`); port of flagValues in control.ts. */
function flagValues(args, forms) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (!forms.includes(flag)) continue;
    const value = equal < 0 ? args[i + 1] : token.slice(equal + 1);
    if (value !== undefined) values.push(value);
    if (equal < 0) i++;
  }
  return values;
}

/** Port of pauseCandidates (src/lib/console/control.ts): any id projectDir() resolves, as written and lowercased. */
export function pauseCandidates(ids) {
  const out = new Set();
  for (const id of ids)
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) && id.length <= 128) {
      out.add(id);
      out.add(id.toLowerCase());
    }
  return [...out];
}

/** The id when public/projects/<id> is a directory as the file system resolves it (case-insensitive disks too). */
function projectDirectory(root, id) {
  try {
    return statSync(projectDirOf(root, id)).isDirectory() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Kept equal to COMPLETION_SCRIPTS in src/lib/console/control.ts: scripts that run the one job --operation-id names. */
export const COMPLETION_SCRIPTS = [
  "scripts/generate-model.ts",
  "scripts/generate-image.ts",
  "scripts/generate-video.ts",
  "scripts/generate-music.ts",
  "scripts/generate-lipsync.ts",
  "scripts/rmbg.ts",
  "scripts/upscale.ts",
];

/** One segment as a call runScript would guard, a barrier, or nothing of ours. */
function segmentCall(segment, aliases, { scripts }) {
  const { env, words, opaque } = commandOf(segment.words);
  if (opaque) return { barrier: true };
  const [cmd] = words;
  if (cmd === undefined) return Object.keys(env).length ? { barrier: true } : undefined; // `VAR=x` alone sets the shell's variable
  if (BARRIERS.has(cmd)) return { barrier: true };
  let group;
  let args;
  let typed;
  if (cmd === "pnpm") {
    let j = 1;
    while (words[j] === "-s" || words[j] === "--silent") j++;
    if (words[j] === "run") j++;
    while (words[j] === "-s" || words[j] === "--silent") j++;
    const alias = words[j];
    if (alias === undefined) return undefined;
    if (alias.startsWith("-")) return { barrier: true }; // -C, --dir, --filter: another place or package
    if (["exec", "dlx", "install", "add", "i", "x"].includes(alias)) return undefined;
    group = resolveAlias(alias, aliases) ?? { aliases: [alias], spend: "none", unknown: true, guarded: false };
    args = words.slice(j + 1);
    if (group.aliases.includes(alias)) typed = alias;
  } else if (["npx", "tsx", "node"].includes(cmd)) {
    const at = words.findIndex((word, index) => index > 0 && SCRIPT_PATH.test(word));
    if (at < 0 || !scripts) return undefined;
    group = scriptGroup(SCRIPT_PATH.exec(words[at])[1], aliases);
    if (!group) return undefined;
    args = words.slice(at + 1);
  } else return undefined;
  return {
    alias: group.aliases[0],
    aliases: group.aliases,
    spend: group.spend,
    known: !group.unknown,
    guarded: group.guarded,
    env,
    help: args.includes("--help") || args.includes("-h"),
    /** What runScript's journal names the run: the alias as typed (pnpm sets npm_lifecycle_event), else the script's first. */
    typed: typed ?? group.aliases[0],
    args,
    project: projectOf(args),
    projects: [...new Set(flagValues(args, ["--project", "-p"]))],
    script: aliases[group.aliases[0]]?.script,
    dryRun: args.some((token) => token === "--dry-run" || token === "--dry-run=true" || token === "--dry-run=1"),
    operationIds: flagValues(args, ["--operation-id"]).length,
  };
}

/**
 * The commands a shell line runs, in order: calls (aliases, spend, guarded, env prefixes, --help, --project,
 * --dry-run) and `{ barrier: true }` where the line changes directory or environment. An ambiguous line is one
 * barrier. `scripts`: whether `scripts/<file>` paths resolve against the checkout (the session's cwd is its root).
 */
export function invocations(command, aliases = commandTable(), { scripts = true } = {}) {
  const parsed = splitShell(command);
  if (parsed.ambiguous) return [{ barrier: true }];
  return parsed.segments.map((segment) => segmentCall(segment, aliases, { scripts })).filter(Boolean);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Port of chainHash (src/lib/step-lease/lease.ts). */
export function chainHash(projectDir, route) {
  const pipeline = path.join(projectDir, "pipeline");
  const files =
    route === "film"
      ? ["chain", "approvals", "skips"].flatMap((dir) => {
          const full = path.join(pipeline, dir);
          if (!existsSync(full)) return [];
          return readdirSync(full)
            .filter((name) => name.endsWith(".json") && name !== "fixer-rounds.json")
            .map((name) => `${dir}/${name}`);
        })
      : ["footage-goals.json", "playbook.json"].filter((name) => existsSync(path.join(pipeline, name)));
  const lines = files.sort().map((file) => `${file}\0${sha256(readFileSync(path.join(pipeline, file)))}`);
  return sha256(`${route}\n${lines.join("\n")}`);
}

/** Port of autonomousPolicy: the revision in force is autonomous (an unreadable or odd policy is not). */
function autonomousPolicy(projectDir) {
  const policy = readJson(path.join(projectDir, "pipeline/policy.json"));
  if (!isObject(policy) || policy.schemaVersion !== 1 || !Array.isArray(policy.revisions)) return false;
  const last = policy.revisions.at(-1);
  return (
    isObject(last) &&
    last.autonomy === "autonomous" &&
    Number.isInteger(last.revision) &&
    str(last.at) &&
    isObject(last.grantedBy) &&
    str(last.grantedBy.answer)
  );
}

function benchmarkProxyRun(projectDir) {
  const dir = path.join(projectDir, "pipeline/approvals");
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
  return names.some((name) => {
    const events = readJson(path.join(dir, name))?.events;
    return Array.isArray(events) && events.some((event) => event?.proxy === BENCHMARK_PROXY);
  });
}

/** Port of effectiveGuardMode (src/lib/step-lease/guard.ts). */
export function effectiveMode(projectDir, env = process.env) {
  const explicit = String(env.AGENTBROS_STEP_GUARD ?? "")
    .trim()
    .toLowerCase();
  if (["off", "warn", "enforce"].includes(explicit)) return { mode: explicit, source: "env" };
  if (autonomousPolicy(projectDir)) return { mode: "enforce", source: "policy" };
  if (
    String(env.AGENTBROS_INTERACTION_MODE ?? "")
      .trim()
      .toLowerCase() === "autonomous" ||
    benchmarkProxyRun(projectDir)
  )
    return { mode: "enforce", source: "benchmark" };
  return { mode: "warn", source: "default" };
}

function activeUnlock(projectDir, now) {
  let text;
  try {
    text = readFileSync(path.join(projectDir, "pipeline/session/unlocks.jsonl"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    try {
      const unlock = JSON.parse(line);
      return str(unlock?.reason) && Date.parse(unlock.at) <= now.getTime() && now.getTime() < Date.parse(unlock.until);
    } catch {
      return false;
    }
  });
}

function budgetCeiling(projectDir) {
  const ceiling = readJson(path.join(projectDir, "pipeline/operations.json"))?.policy?.ceilingUsd;
  return typeof ceiling === "number" && ceiling > 0;
}

const SOURCE_LABEL = { policy: "the project's autonomous policy", benchmark: "a benchmark run" };
const modeLabel = (mode, source) => (SOURCE_LABEL[source] ? `${mode}, ${SOURCE_LABEL[source]}` : mode);

/** Port of guardMessage (src/lib/step-lease/lease.ts): the same words runScript refuses with. */
export function guardMessage(lease, reason, mode, source) {
  const allowed = lease.allow.filter((alias) => !CONTROL_ALIASES.includes(alias));
  return [
    `Step guard (${modeLabel(mode, source)}): ${reason}.`,
    `Project ${lease.project} is at step ${lease.step} (owner ${lease.owner}, role ${lease.role}).`,
    `Allowed now: ${allowed.length ? allowed.join(", ") : "(no step tools)"} plus control commands (${ALWAYS_ADMITTED.join(", ")}, feedback, memory, library:list, ...).`,
    `Run \`pnpm next --project ${lease.project}\` for the current step.`,
    `If this run is intended: \`pnpm step:unlock --project ${lease.project} --reason "<why>" [--minutes 30]\` (spend still needs the user's approval); for manual work AGENTBROS_STEP_GUARD=off.`,
  ].join(" ");
}

/** The lease's verdict for one invocation in enforce mode: a refusal message, or undefined (admitted or not judged). */
export function leaseRefusal(projectDir, call, { env = process.env, now = new Date() } = {}) {
  const { mode, source } = effectiveMode(projectDir, env);
  if (mode !== "enforce") return undefined;
  const loaded = readLease(projectDir);
  if (!loaded || !("lease" in loaded)) return undefined; // no lease, or unreadable: runScript decides (H4)
  const { lease, hash } = loaded;
  if (call.aliases.some((alias) => ALWAYS_ADMITTED.includes(alias))) return undefined;
  const allowed = call.aliases.find((alias) => lease.allow.includes(alias));
  const alias = allowed ?? call.aliases[0] ?? "unknown";
  if (env.AGENTBROS_STEP_ADMITTED && env.AGENTBROS_STEP_ADMITTED === hash) return undefined;
  const may = lease.paidAllowed === true || (lease.paidWhen === "budget-ceiling" && budgetCeiling(projectDir));
  if (call.spend !== "none" && !call.dryRun && !may) {
    const why =
      lease.paidWhen === "budget-ceiling"
        ? "no budget ceiling raised with the user's words"
        : lease.step === "material"
          ? "the user has not approved this material.json"
          : "this step's chain has no spend approval";
    return guardMessage(
      lease,
      `\`pnpm ${alias}\` may spend, and step ${lease.step} has no user approval for spending (${why}); run it with --dry-run to plan`,
      mode,
      source,
    );
  }
  const reason =
    now.getTime() >= Date.parse(lease.expiresAt)
      ? `the lease for step ${lease.step} expired at ${lease.expiresAt}`
      : chainHash(projectDir, lease.route) !== lease.chainHash
        ? `the chain changed since the lease for step ${lease.step} was issued (a step was sealed, approved or skipped)`
        : !allowed
          ? `\`pnpm ${alias}\` is not a tool of step ${lease.step}`
          : undefined;
  if (!reason || activeUnlock(projectDir, now)) return undefined;
  return guardMessage(lease, reason, mode, source);
}

/** The pause check: a paused or stopped project refuses every non-control command (D12, the `PAUSED` refusal). */
export function pauseRefusal(projectDir, call) {
  if (call.aliases.some((alias) => CONTROL_ALIASES.includes(alias))) return undefined;
  // Soft pause: a script that runs exactly the one job a single --operation-id names, on a single project, may be
  // completing an already-submitted job; runScript reads the job store and judges it (the store refuses a new submit).
  if (COMPLETION_SCRIPTS.includes(call.script) && call.operationIds === 1 && (call.projects?.length ?? 1) === 1)
    return undefined;
  const control = readControl(projectDir);
  if (!control || control.state === "running") return undefined;
  const why = control.answer ?? control.reason;
  const project = path.basename(projectDir);
  return [
    `PAUSED: project ${project} is ${control.state} by the user since ${control.at}${why ? ` ("${clamp(why.replace(/\s+/g, " "), 200)}")` : ""}.`,
    `\`pnpm ${call.alias}\` is not a control command, so it does not run until the user resumes the project in the console.`,
    `Control commands still run (${ALWAYS_ADMITTED.join(", ")}, feedback, memory, ...). Do not retry; tell the user.`,
    "Only the user resumes; never run console:control yourself.",
  ].join(" ");
}

/** Variables the guard reads; another AGENTBROS_* prefix may change what runScript does, so the call is not judged. */
const KNOWN_PREFIXES = [
  "AGENTBROS_STEP_GUARD",
  "AGENTBROS_INTERACTION_MODE",
  "AGENTBROS_STEP_ADMITTED",
  "AGENTBROS_PROJECT",
];

/**
 * The guard's verdict for a normalised PreToolUse payload: `{ deny, project, code, call }` (code: runScript's error
 * code for the same refusal, `PAUSED` or `VALIDATION`), or `{ project }` when it admits.
 * Never denies what runScript would admit: it stops at a barrier (cd, export, an ambiguous line), stops after a
 * control command (a later segment may depend on it: step:unlock, next, budget, console:control), skips --help, unknown
 * and unguarded scripts, and reads `VAR=value` prefixes. The pause check runs whatever AGENTBROS_STEP_GUARD says.
 */
export function decide(payload, { root, env = process.env, now = new Date() }) {
  const secret = consoleSecretRefusal(payload, root);
  if (secret) return { deny: secret };
  if (payload?.tool?.kind !== "shell" || !payload.tool.command) return {};
  let scripts = false;
  try {
    scripts = !payload.cwd || realpathSync(payload.cwd) === root;
  } catch {
    scripts = false;
  }
  let first;
  for (const call of invocations(payload.tool.command, commandTable(), { scripts })) {
    if (call.barrier) break;
    const control = call.aliases.some((alias) => CONTROL_ALIASES.includes(alias));
    if (call.help) continue;
    const prefixes = Object.keys(call.env);
    const judged =
      call.known &&
      call.guarded &&
      !prefixes.some((name) => name.startsWith("AGENTBROS_") && !KNOWN_PREFIXES.includes(name));
    const project = judged ? existingProject(root, call.project) : undefined;
    // The pause judges every project the line names (a decoy first --project must not hide the one parseArgs keeps).
    for (const named of judged ? pauseCandidates(call.projects) : []) {
      const paused = projectDirectory(root, named);
      const deny = paused && pauseRefusal(projectDirOf(root, paused), call);
      if (deny) return { deny, project: paused, code: "PAUSED", call };
    }
    if (project) {
      first ??= project;
      const dir = projectDirOf(root, project);
      const callEnv = { ...env, ...call.env };
      const deny = leaseRefusal(dir, call, { env: callEnv, now });
      if (deny) return { deny, project, code: "VALIDATION", call };
    }
    if (control) break;
  }
  return first ? { project: first } : {};
}

/** The PreToolUse output that denies with a reason (same shape in Claude Code and Codex). */
export const denyOutput = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

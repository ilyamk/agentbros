/**
 * The text the hooks inject (RFC 0004 §7.1 H7): facts, never instructions, in English, at most 1,200 characters,
 * prefixed `Agent Bros. console:`. Orient describes where a project stands; relay and wake describe what the user did
 * in the console since the session last heard.
 */
import { clamp, oneLine, projectDirOf } from "./runtime.mjs";
import { consoleUrl, readControl, readLease, waitingFor } from "./state.mjs";
import { CONTROL_ALIASES } from "./guard.mjs";

export const PREFIX = "Agent Bros. console:";
export const CONTEXT_MAX = 1200;

/** Joins sentences after the prefix and bounds the result to CONTEXT_MAX characters. */
export const block = (sentences) => clamp(`${PREFIX} ${sentences.filter(Boolean).join(" ")}`, CONTEXT_MAX);

const leaseOf = (root, project) => {
  const loaded = readLease(projectDirOf(root, project));
  return loaded && "lease" in loaded ? loaded.lease : undefined;
};

const controlSentence = (control) =>
  control && control.state !== "running"
    ? `The user ${control.state === "paused" ? "paused" : "stopped"} this project at ${control.at}${control.answer || control.reason ? ` ("${oneLine(control.answer ?? control.reason, 160)}")` : ""}; only control commands run until it is resumed.`
    : undefined;

/** Orient facts for the main session: project, route, step and owner, what waits for the user, pause, console URL. */
export function sessionFacts(root, project, now = new Date()) {
  const lease = leaseOf(root, project);
  const control = readControl(projectDirOf(root, project));
  const waiting = waitingFor(root, project, now);
  const url = consoleUrl(root);
  const waits = [
    waiting.gate ? "an approval at the current step" : undefined,
    waiting.cards ? `${waiting.cards} agent card${waiting.cards === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  return block([
    `project ${project}${lease ? ` (${lease.route} route)` : ""}.`,
    lease
      ? `Current step ${lease.step}, owner ${lease.owner} (role ${lease.role}); lease until ${lease.expiresAt}.`
      : "No step lease is issued.",
    waits.length ? `Waiting for the user: ${waits.join(", ")}.` : "Nothing waits for the user.",
    controlSentence(control),
    url ? `Console: ${url}` : "The console server is not running.",
  ]);
}

/** Orient facts for one of the repository's own subagents: its project's lease (step, tools, paid authority). */
export function subagentFacts(root, project, agentType) {
  const lease = leaseOf(root, project);
  const control = readControl(projectDirOf(root, project));
  if (!lease)
    return block([`project ${project}; you run as ${agentType}; no step lease is issued.`, controlSentence(control)]);
  const tools = lease.allow.filter((alias) => !CONTROL_ALIASES.includes(alias));
  const paid = lease.paidAllowed
    ? "spending is authorised by the user's approval"
    : lease.paidWhen === "budget-ceiling"
      ? "spending needs a budget ceiling the user raised in their own words"
      : "spending is not authorised (commands that may spend run with --dry-run only)";
  return block([
    `project ${project}; you run as ${agentType}.`,
    `The step lease is for step ${lease.step} (owner ${lease.owner}, role ${lease.role}${lease.lanes?.length ? `, lanes ${lease.lanes.join(", ")}` : ""}).`,
    `Step tools: ${tools.length ? clamp(tools.join(", "), 500) : "none beyond the control commands"}; ${paid}.`,
    controlSentence(control),
  ]);
}

const quote = (text, max = 300) => `"${oneLine(text, max)}"`;
const STATUS = { applied: "applied", refused: "refused by its command", superseded: "superseded" };

/** One console item as a sentence. */
export function itemSentence(item, words = 300) {
  if (item.type === "decision")
    return `Decision ${item.id} (${item.kind}${item.step ? `, step ${item.step}` : ""}${item.title ? `, "${oneLine(item.title, 80)}"` : ""}) was ${STATUS[item.status] ?? item.status} in the console${item.choice ? `, option ${item.choice}` : ""}; the user's words: ${quote(item.answer, words)}.`;
  if (item.type === "card")
    return `Card ${item.id}${item.title ? ` ("${oneLine(item.title, 80)}")` : ""} was answered${item.choice ? `: ${item.choiceLabel ? `"${oneLine(item.choiceLabel, 80)}" (${item.choice})` : item.choice}` : ""}${item.text ? `; the user's words: ${quote(item.text, words)}` : ""}${item.ratings ? `; ${item.ratings} rating${item.ratings === 1 ? "" : "s"}` : ""}.`;
  if (item.type === "control")
    return `The user set the project to ${item.state} at ${new Date(item.at).toISOString()}${item.answer || item.reason ? `: ${quote(item.answer ?? item.reason, Math.min(words, 200))}` : ""}.`;
  return undefined;
}

/**
 * Relay and wake text: the new items, oldest first, within the bound, the rest counted; and `through`, the time the
 * session's watermark may move to. The watermark holds a time only, so the text never stops inside a group of items
 * that share a time: it stops before the group, or, when the first group alone does not fit, tells that group with
 * shorter quotes and, at worst, by id. Hidden items are told next time and never lost.
 */
export function itemsBlock(project, items) {
  const head = `new in the console for project ${project}:`;
  const budget = CONTEXT_MAX - PREFIX.length - head.length - 2;
  const fits = (sentences, more) =>
    sentences.reduce((sum, sentence) => sum + sentence.length + 1, 0) + (more ? 40 : 0) <= budget;
  const sentences = items.map((item) => itemSentence(item) ?? "");
  let shown = 0;
  while (shown < items.length && fits(sentences.slice(0, shown + 1), shown + 1 < items.length)) shown++;
  // Back off to the start of the group the cut falls into.
  while (shown > 0 && shown < items.length && items[shown].at === items[shown - 1].at) shown--;
  let parts = sentences.slice(0, shown);
  if (shown === 0 && items.length) {
    const group = items.filter((item) => item.at === items[0].at);
    const short = group.map((item) => itemSentence(item, 60) ?? "");
    let n = 0;
    while (n < short.length && fits(short.slice(0, n + 1), true)) n++;
    const rest = group.slice(n).map((item) => item.id);
    parts = [
      ...short.slice(0, n),
      ...(rest.length ? [oneLine(`Also at the same time: ${rest.join(", ")}.`, 300)] : []),
    ];
    shown = group.length;
  }
  if (shown < items.length) parts.push(`(${items.length - shown} more not shown.)`);
  return { text: block([head, ...parts]), through: items[shown - 1]?.at };
}

/** Wake's one-line fact and its watermark. */
export function wakeLine(project, items) {
  const { text, through } = itemsBlock(project, items);
  return { text: oneLine(text, CONTEXT_MAX), through };
}

/**
 * What an agent reads of the console over MCP (RFC 0004 D17): `console_url` (the running server's address, never its
 * token) and `console_view` (the project read model, trimmed to what the next move needs: steps, what waits for the
 * user, control, money totals, the latest render, QA counts and open cards). Pure over a {@link ProjectView}, so it
 * works with the default data source today and with the projector (WP3) unchanged.
 */
import type { Card, Decision, ProjectView } from "../../types/console";
import { cardIsOpen } from "./cards";
import { lockBeforeBoot, pidAlive, readLock } from "./lock";

/** Upper bounds of the trimmed view's lists (the full view stays in the console). */
export const AGENT_VIEW_LIMITS = { reasons: 3, waiting: 12, cards: 20, findings: 10, advisories: 8 } as const;

const clip = (text: string | undefined, max: number) =>
  text === undefined ? undefined : text.length > max ? `${text.slice(0, max - 1)}…` : text;

function trimDecision(decision: Decision) {
  return {
    id: decision.id,
    kind: decision.kind,
    ...(decision.step ? { step: decision.step } : {}),
    title: decision.title,
    ...(decision.summary ? { summary: clip(decision.summary, 400) } : {}),
    ...(decision.options?.length ? { options: decision.options.map((option) => option.label) } : {}),
    ...(decision.quote ? { quoteUsd: decision.quote.amountUsd, provider: decision.quote.provider } : {}),
    createdAt: decision.createdAt,
  };
}

function trimCard(card: Card, now: number) {
  const options = "options" in card ? card.options : undefined;
  const media = "media" in card ? card.media : undefined;
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    from: card.from.agent,
    ...(card.step ? { step: card.step } : {}),
    expectsAnswer: card.expectsAnswer,
    open: cardIsOpen(card, now),
    ...(options?.length ? { options: options.map((option) => ({ id: option.id, label: option.label })) } : {}),
    ...(media?.length ? { media: media.length } : {}),
    ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
    createdAt: card.createdAt,
    ...(card.answer
      ? {
          answer: {
            ...(card.answer.choice !== undefined ? { choice: card.answer.choice } : {}),
            ...(card.answer.text !== undefined ? { text: clip(card.answer.text, 2000) } : {}),
            ...(card.answer.ratings ? { ratings: card.answer.ratings } : {}),
            at: card.answer.at,
          },
        }
      : {}),
  };
}

export type AgentView = ReturnType<typeof trimView>;

/**
 * The trimmed read model: no argv of options, job lists, asset lists, agent histories or media metadata beyond the
 * latest render's path; lists capped by {@link AGENT_VIEW_LIMITS} with their full counts.
 */
export function trimView(view: ProjectView, now: number = Date.now()) {
  const findings = view.qa.findings;
  const severity = (level: "error" | "warning" | "info") => findings.filter((item) => item.severity === level).length;
  const cards = view.cards.filter((card) => cardIsOpen(card, now) || card.answer);
  const recentCards = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const render = view.media.latestRender;
  return {
    v: 1 as const,
    revision: view.revision,
    generatedAt: view.generatedAt,
    project: view.project,
    control: view.control,
    autonomy: view.autonomy,
    steps: view.steps.map((step) => ({
      id: step.id,
      status: step.status,
      ...(step.gate ? { gate: true } : {}),
      ...(step.reasons.length ? { reasons: step.reasons.slice(0, AGENT_VIEW_LIMITS.reasons) } : {}),
    })),
    ...(view.current ? { current: { step: view.current.step, why: clip(view.current.next.why, 400) } } : {}),
    waiting: {
      total: view.waiting.length,
      decisions: view.waiting.slice(0, AGENT_VIEW_LIMITS.waiting).map(trimDecision),
    },
    cards: {
      total: view.cards.length,
      open: view.cards.filter((card) => cardIsOpen(card, now)).length,
      items: recentCards.slice(0, AGENT_VIEW_LIMITS.cards).map((card) => trimCard(card, now)),
    },
    ...(view.agents.active ? { activeAgent: { name: view.agents.active.name, step: view.agents.active.step } } : {}),
    money: {
      ...(view.money.ceilingUsd !== undefined ? { ceilingUsd: view.money.ceilingUsd } : {}),
      reservedUsd: view.money.reservedUsd,
      spentUsd: view.money.spentUsd,
      unknownPriced: view.money.unknownPriced,
      runningJobs: view.money.jobs.filter((job) => ["submitting", "queued", "running"].includes(job.state)).length,
    },
    ...(render
      ? {
          latestRender: {
            root: render.root ?? "project",
            path: render.path,
            ...(render.stale !== undefined ? { stale: render.stale } : {}),
          },
        }
      : {}),
    qa: {
      errors: severity("error"),
      warnings: severity("warning"),
      ...(view.qa.delivery ? { delivery: { ok: view.qa.delivery.ok, checkedAt: view.qa.delivery.checkedAt } } : {}),
      top: findings
        .filter((item) => item.severity !== "info")
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
        .slice(0, AGENT_VIEW_LIMITS.findings)
        .map((item) => ({ severity: item.severity, source: item.source, message: clip(item.message, 300) })),
    },
    assets: view.assets.length,
    advisories: view.advisories.slice(0, AGENT_VIEW_LIMITS.advisories).map((text) => clip(text, 400)),
    ...(view.stepGuard ? { stepGuard: view.stepGuard } : {}),
  };
}

/**
 * The running console's address from `out/console/server.json`: alive in this boot, without a token or a health
 * probe (which would need the session file). A project adds its route fragment. Creates no file.
 */
export function consoleAddress(rootDir: string, project?: string): { running: boolean; url?: string; port?: number } {
  const lock = readLock(rootDir);
  if (!lock?.url || lockBeforeBoot(lock) || !pidAlive(lock.pid)) return { running: false };
  const base = lock.url.endsWith("/") ? lock.url : `${lock.url}/`;
  return { running: true, url: project ? `${base}#/projects/${project}` : base, port: lock.port };
}

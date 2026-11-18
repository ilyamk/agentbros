/**
 * Fixture mode (`?fixture=<name>`): the console without a server. Serves the contract fixtures from memory and
 * simulates the three POSTs so the §13 flows (approve a gate, answer a card, pause) can be exercised in development,
 * unit tests and Playwright. Nothing is written anywhere; a page reload starts over.
 */
import {
  CardSchema,
  DecisionSchema,
  EventsPageSchema,
  HOOKS_INSTALL_COMMAND,
  HooksResponseSchema,
  JobCancelResponseSchema,
  ProjectViewSchema,
  ProjectsResponseSchema,
  StudioStatusResponseSchema,
  type CardAnswerRequest,
  type ConsoleEvent,
  type ControlRequest,
  type ControlResponse,
  type Decision,
  type DecisionRequest,
  type EventsQuery,
  type HooksInstallResponse,
  type HooksStatus,
  type JobCancelRequest,
  type JobCancelResponse,
  type ProjectSummary,
  type ProjectView,
  type ProjectsResponse,
  type StudioOpenRequest,
  type StudioOpenResponse,
  type StudioStatusResponse,
} from "@contract";
import { fixtureMetrics } from "@/lib/metrics-fixture";
import { GITHUB_REPOSITORY, GITHUB_URL } from "../../../src/lib/console/github-schema";
import {
  FIXTURES,
  fixtureEvents,
  fixtureHooks,
  fixtureLibrary,
  fixtureProjects,
  fixtureViews,
  type FixtureName,
} from "@/lib/fixtures";
import { ApiFailure } from "./errors";
import type { ApiClient, StreamHandlers } from "./types";

const clone = <T>(value: T): T => structuredClone(value);

/** Summary of a view for the home page, when the fixture list does not have one. */
function summaryOf(view: ProjectView): ProjectSummary {
  const step = view.current?.step;
  const row = view.steps.find((item) => item.id === step);
  return {
    id: view.project.id,
    route: view.project.route,
    title: view.project.title,
    filmType: view.project.filmType,
    playbook: view.project.playbook,
    step,
    stepTitle: row?.title,
    stepStatus: row?.status,
    activeAgent: view.agents.active
      ? { name: view.agents.active.name, role: view.agents.active.role, since: view.agents.active.startedAt }
      : undefined,
    waiting: view.waiting.length,
    control: view.control.state,
    spentUsd: view.money.spentUsd,
    ceilingUsd: view.money.ceilingUsd ?? view.autonomy.ceilingUsd,
    latestRender: view.media.latestRender,
    updatedAt: view.generatedAt,
  };
}

export interface FixtureApiClientOptions {
  /** The fixture the page opened with; its view replaces the default one of the same project. */
  fixture?: FixtureName;
  /** Clock for decided-at times (fixture mode freezes it). */
  now?: () => number;
}

export class FixtureApiClient implements ApiClient {
  readonly mode = "fixture" as const;
  private readonly views = new Map<string, ProjectView>();
  private home: ProjectsResponse;
  private readonly listeners = new Set<{ project: string | undefined; handlers: StreamHandlers }>();
  private readonly now: () => number;
  private hooksState: HooksStatus = clone(fixtureHooks);
  private readonly studios = new Map<string, NonNullable<StudioStatusResponse["running"]>>();

  constructor(options: FixtureApiClientOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    for (const view of Object.values(fixtureViews)) this.views.set(view.project.id, clone(view));
    if (options.fixture && options.fixture !== "projects-response") {
      const view = FIXTURES[options.fixture];
      this.views.set(view.project.id, clone(view));
    }
    const home = clone(fixtureProjects);
    const listed = new Set(home.projects.map((project) => project.id));
    for (const view of this.views.values()) if (!listed.has(view.project.id)) home.projects.push(summaryOf(view));
    this.home = home;
  }

  /** The project a view fixture opens on (`undefined` for the home fixture). */
  static projectOf(fixture: FixtureName): string | undefined {
    return fixture === "projects-response" ? undefined : FIXTURES[fixture].project.id;
  }

  async start(): Promise<void> {}

  async library() {
    return clone(fixtureLibrary);
  }

  async projects() {
    return ProjectsResponseSchema.parse(clone(this.home));
  }

  async metrics() {
    return fixtureMetrics();
  }

  async github() {
    return { v: 1 as const, repository: GITHUB_REPOSITORY, url: GITHUB_URL, stars: 1284 };
  }

  async view(project: string) {
    const view = this.views.get(project);
    if (!view) throw new ApiFailure("PROJECT_NOT_FOUND", `No fixture project ${project}`, 404);
    return ProjectViewSchema.parse(clone(view));
  }

  async events(project: string, query: EventsQuery = {}) {
    const all = fixtureEvents.filter((event) => event.project === project);
    const start = query.since ? all.findIndex((event) => event.id === query.since) + 1 : 0;
    const limit = query.limit ?? 200;
    const page: ConsoleEvent[] = all.slice(start, start + limit);
    const next = start + limit < all.length ? (page.at(-1)?.id ?? null) : null;
    return EventsPageSchema.parse({ v: 1, events: clone(page), next });
  }

  async decide(project: string, request: DecisionRequest, options: { dryRun?: boolean } = {}) {
    if (request.kind === "policy") return this.policy(project, request, options);
    const view = this.mustView(project);
    const at = new Date(this.now()).toISOString();
    const pending = request.decisionId
      ? (view.waiting.find((item) => item.id === request.decisionId) ??
        this.home.waiting.find((item) => item.id === request.decisionId && item.project === project))
      : undefined;
    if (request.decisionId && !pending)
      throw new ApiFailure("VALIDATION", `Decision ${request.decisionId} is not pending`, 409);
    const option = pending?.options?.find((item) => item.id === request.choice);
    const argv = (option?.argv ?? ["pnpm", "feedback", "--project", project, "--answer", "<words>"]).map((arg) =>
      arg === "<words>" ? request.answer : arg,
    );
    const decision: Decision = DecisionSchema.parse({
      ...(pending ?? {
        v: 1,
        id: `dec-${request.kind}-${this.now()}`,
        project,
        kind: request.kind,
        step: request.step,
        title: request.kind ?? "decision",
        bindTo: [],
        createdAt: at,
      }),
      answer: request.answer,
      choice: request.choice,
      verdict: request.verdict,
      frameComments: request.frameComments,
      ratings: request.ratings,
      argv,
      actor: "user",
      channel: "console",
      status: "applied",
      decidedAt: at,
      result: { ok: true, outputs: [], elapsedMs: 0, metadata: { fixture: true } },
    });
    view.waiting = view.waiting.filter((item) => item.id !== decision.id);
    // A rating shows as the user's latest rating, as ratings.json does after ref:rate (WP9).
    for (const [rated, score] of Object.entries(request.kind === "rating" ? (request.ratings ?? {}) : {}))
      for (const frame of view.film?.look?.styleframes ?? []) if (frame.media.path === rated) frame.rating = score;
    if (decision.step) {
      const step = view.steps.find((item) => item.id === decision.step);
      if (step?.status === "awaiting-gate" && option?.id === "approve") step.status = "done";
    }
    this.home.waiting = this.home.waiting.filter((item) => item.id !== decision.id);
    this.touch(view);
    return { ok: true, decision };
  }

  /** A policy change as film:policy (film) or budget (a ceiling elsewhere) would apply it; the view follows. */
  private policy(project: string, request: DecisionRequest, options: { dryRun?: boolean }) {
    const view = this.mustView(project);
    const at = new Date(this.now()).toISOString();
    const change = request.policy ?? {};
    const film = ["film", "replica"].includes(view.project.route) || change.autonomy !== undefined;
    const argv = film
      ? [
          "pnpm",
          "film:policy",
          "--project",
          project,
          ...(change.autonomy ? ["--autonomy", change.autonomy] : []),
          `--answer=${request.answer}`,
          ...(change.ceilingUsd !== undefined ? ["--ceiling-usd", String(change.ceilingUsd)] : []),
        ]
      : [
          "pnpm",
          "budget",
          "--project",
          project,
          "--ceiling-usd",
          String(change.ceilingUsd),
          `--answer=${request.answer}`,
        ];
    const decision: Decision = DecisionSchema.parse({
      v: 1,
      id: `policy-${request.requestId ?? this.now()}`,
      project,
      kind: "policy",
      title: "Policy change",
      bindTo: [],
      policy: change,
      answer: request.answer,
      argv,
      actor: "user",
      channel: "console",
      status: options.dryRun ? "pending" : "applied",
      createdAt: at,
      ...(options.dryRun ? {} : { decidedAt: at, result: { ok: true, outputs: [], elapsedMs: 0 } }),
    });
    if (options.dryRun) return { ok: true, decision };
    if (change.autonomy) view.autonomy = { ...view.autonomy, mode: change.autonomy, source: "film:policy" };
    if (change.ceilingUsd !== undefined) {
      view.autonomy = { ...view.autonomy, ceilingUsd: change.ceilingUsd, ...(film ? { source: "film:policy" } : {}) };
      view.money = { ...view.money, ceilingUsd: change.ceilingUsd };
    }
    this.touch(view);
    return { ok: true, decision };
  }

  /** Cancels a fixture job the way job:cancel does: only a cancellable one, never faked. */
  async cancelJob(project: string, jobId: string, request: JobCancelRequest): Promise<JobCancelResponse> {
    const view = this.mustView(project);
    const job = view.money.jobs.find((item) => item.id === jobId);
    if (!job) throw new ApiFailure("NOT_FOUND", `No job ${jobId}`, 404);
    if (!job.cancellable)
      return JobCancelResponseSchema.parse({
        ok: true,
        outcome: "unavailable",
        job,
        message: job.cancelReason ?? `provider ${job.provider} offers no cancellation for this job`,
      });
    const cancelled = { ...job, state: "cancelled" as const, reservedUsd: 0, cancellable: false };
    view.money.jobs = view.money.jobs.map((item) => (item.id === jobId ? cancelled : item));
    this.touch(view);
    return JobCancelResponseSchema.parse({
      ok: true,
      outcome: "cancelled",
      job: cancelled,
      message: `Cancelled on your words: ${request.answer}`.slice(0, 4000),
    });
  }

  async hooks() {
    const plan = (["claude", "codex"] as const).map((harness) => ({
      harness,
      file: harness === "claude" ? ".claude/settings.local.json" : ".codex/hooks.json",
      action: this.hooksState[harness] === "installed" ? ("none" as const) : ("write" as const),
    }));
    return HooksResponseSchema.parse({ v: 1, status: clone(this.hooksState), command: HOOKS_INSTALL_COMMAND, plan });
  }

  async installHooks(): Promise<HooksInstallResponse> {
    this.hooksState = { claude: "installed", codex: "installed" };
    return {
      ok: true,
      status: clone(this.hooksState),
      trust: ["Claude Code: trust this workspace when it asks.", "Codex: review the hooks once with /hooks."],
    };
  }

  async control(project: string, request: ControlRequest): Promise<ControlResponse> {
    const view = this.mustView(project);
    const at = new Date(this.now()).toISOString();
    const change = {
      state: request.state,
      by: "user" as const,
      channel: "console" as const,
      at,
      answer: request.answer,
      reason: request.reason,
    };
    view.control = { state: request.state, by: "user", at, reason: request.reason };
    this.touch(view);
    const runningJobs =
      request.state === "stopped"
        ? view.money.jobs.filter((job) => ["submitting", "queued", "running", "reserved"].includes(job.state))
        : undefined;
    return { ok: true, control: { v: 1, ...change, history: [change] }, runningJobs };
  }

  async answerCard(project: string, cardId: string, request: CardAnswerRequest) {
    const view = this.mustView(project);
    const index = view.cards.findIndex((card) => card.id === cardId);
    const card = view.cards[index];
    if (!card) throw new ApiFailure("NOT_FOUND", `No card ${cardId}`, 404);
    if (!card.expectsAnswer || card.answer) throw new ApiFailure("VALIDATION", "This card takes no answer", 409);
    const answered = CardSchema.parse({ ...card, answer: { ...request, at: new Date(this.now()).toISOString() } });
    view.cards[index] = answered;
    this.touch(view);
    return { ok: true as const, card: answered };
  }

  /**
   * Remotion Studio, simulated: a film or replica opens its build composition, any other project its project.json
   * composition in its formats, a campaign container nothing. Nothing listens at the returned URL.
   */
  async studioStatus(project: string): Promise<StudioStatusResponse> {
    const view = this.mustView(project);
    if (view.project.route === "campaign")
      return StudioStatusResponseSchema.parse({
        ok: true,
        available: false,
        reason: "A campaign container has no composition of its own; open one of its members.",
      });
    const film = view.project.route === "film" || view.project.route === "replica";
    const running = this.studios.get(project);
    return StudioStatusResponseSchema.parse({
      ok: true,
      available: true,
      target: film
        ? { kind: "film", entry: "src/index.ts", composition: "Film" }
        : { kind: "project", entry: "project.json", composition: "ProjectVertical" },
      ...(film ? {} : { formats: view.project.formats?.length ? view.project.formats : ["vertical"] }),
      ...(running ? { running } : {}),
    });
  }

  async studioOpen(project: string, request: StudioOpenRequest): Promise<StudioOpenResponse> {
    const status = await this.studioStatus(project);
    if (!status.available || !status.target)
      throw new ApiFailure("VALIDATION", status.reason ?? "Studio cannot open this project", 409);
    const running = this.studios.get(project);
    const format = request.format ?? status.formats?.[0];
    const reused = !!running && running.format === format;
    const composition =
      status.target.kind === "project" && format
        ? `Project${format[0]!.toUpperCase()}${format.slice(1)}`
        : status.target.composition;
    const url = `http://127.0.0.1:3000/${composition}`;
    this.studios.set(project, {
      url,
      startedAt: running && reused ? running.startedAt : new Date(this.now()).toISOString(),
      ...(format && status.target.kind === "project" ? { format } : {}),
    });
    return { ok: true, url, reused };
  }

  async studioStop(project: string) {
    this.mustView(project);
    this.studios.delete(project);
    return this.studioStatus(project);
  }

  subscribe(project: string | undefined, handlers: StreamHandlers): () => void {
    const entry = { project, handlers };
    this.listeners.add(entry);
    queueMicrotask(() => handlers.open?.());
    return () => this.listeners.delete(entry);
  }

  private mustView(project: string): ProjectView {
    const view = this.views.get(project);
    if (!view) throw new ApiFailure("PROJECT_NOT_FOUND", `No fixture project ${project}`, 404);
    return view;
  }

  /** A simulated change: bumps the revision, refreshes the home summary and tells the stream listeners. */
  private touch(view: ProjectView) {
    view.revision += 1;
    view.generatedAt = new Date(this.now()).toISOString();
    const summary = this.home.projects.find((item) => item.id === view.project.id);
    if (summary) {
      summary.waiting = view.waiting.length;
      summary.control = view.control.state;
    }
    for (const { project, handlers } of this.listeners)
      if (!project || project === view.project.id)
        handlers.message({ type: "view.changed", project: view.project.id, revision: view.revision });
  }
}

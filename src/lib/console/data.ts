/**
 * What the console server reads and what it does, injected so the server core (RFC 0004 WP2) stays free of
 * domain logic: the projector (WP3) implements {@link ConsoleDataSource}; decisions (WP5), control (WP8) and agent
 * cards (WP11) implement {@link ConsoleActions}. Until they land, `createFileDataSource` (default-source.ts) and
 * {@link notImplementedActions} keep the server usable.
 */
import type { ConsoleDocument, ConsoleDocumentSave } from "../../types/console-document";
import type {
  CardAnswerRequest,
  CardAnswerResponse,
  ConsoleEvent,
  ControlRequest,
  ControlResponse,
  DecisionRequest,
  HooksInstallResponse,
  JobCancelRequest,
  JobCancelResponse,
  DecisionResponse,
  EventsPage,
  EventsQuery,
  ProjectsResponse,
  ProjectView,
  StudioOpenRequest,
  StudioOpenResponse,
  StudioStatusResponse,
} from "../../types/console";
import { HttpError } from "../local-server/errors";
import type { ConsoleMetrics } from "./metrics-schema";

/**
 * A change the stream delivers. `revision` is the data source's view revision after the change, the same number its
 * next `view()` returns (SSE carries it as the message id; a client that sees a gap refetches the view).
 */
export type ConsoleChange =
  | { type: "view.changed"; project?: string; revision: number }
  | { type: "event"; project?: string; event: ConsoleEvent; revision: number };

export interface ConsoleDataSource {
  /** Home page: every project's summary (`GET /api/projects`). */
  listProjects(): Promise<ProjectsResponse>;
  forgetProject?(project: string): void;
  /** The project's read model, or `undefined` when there is no such project (404). The id is already validated. */
  view(project: string): Promise<ProjectView | undefined>;
  /** A journal page, oldest first (`GET /api/projects/:id/events`). */
  events(project: string, query: EventsQuery): Promise<EventsPage>;
  /** Current revision of a project's view, or of the home page when `project` is undefined. */
  revision(project?: string): number;
  /**
   * Calls `onChange` on every change of a project (debounced file changes and new journal lines), or of any project
   * when `project` is undefined (home page). Returns the unsubscribe function; it must release every watcher.
   */
  watch(project: string | undefined, onChange: (change: ConsoleChange) => void): () => void;
  /** Interaction metrics over every project (`GET /api/metrics`, §12, WP12); absent: 501. */
  metrics?(): Promise<ConsoleMetrics>;
}

/**
 * The user's actions (D9, D12, D14). The server has already checked Host, Origin, the session, the CSRF header, the
 * project id and the body's strict schema. Throw {@link HttpError} for a status other than 400 (409 for a stale
 * `expect`, 404 for an unknown decision or card); any other error becomes 400 with its message.
 */
export interface ConsoleActions {
  /** With `dryRun` (`?dryRun=1`), nothing runs: the reply shows the argv that would (WP5). */
  decide(project: string, request: DecisionRequest, options?: { dryRun?: boolean }): Promise<DecisionResponse>;
  saveDocument?(project: string, request: ConsoleDocumentSave): Promise<ConsoleDocument>;
  control(project: string, request: ControlRequest): Promise<ControlResponse>;
  answerCard(project: string, cardId: string, answer: CardAnswerRequest): Promise<CardAnswerResponse>;
  /** The user cancels one paid job after a stop (D12, WP8); absent: 501. `jobId` is a valid operation id. */
  cancelJob?(project: string, jobId: string, request: JobCancelRequest): Promise<JobCancelResponse>;
  /** The user's yes to installing the harness hooks (§7.1 H3): `harness:setup --hooks --apply`; absent: 501. */
  installHooks?(): Promise<HooksInstallResponse>;
  /** Whether Remotion Studio can open the project and the running one (`GET …/studio`, read in-process); absent: 501. */
  studioStatus?(project: string): Promise<StudioStatusResponse>;
  /** The user's request to open the project in Remotion Studio (`studio:open`, §17 amendment of D21); absent: 501. */
  openStudio?(project: string, request: StudioOpenRequest): Promise<StudioOpenResponse>;
  /** Stops the project's Studio and answers the fresh status (`studio:open --stop`); absent: 501. */
  stopStudio?(project: string): Promise<StudioStatusResponse>;
}

const notImplemented = (what: string, wp: string) =>
  new HttpError(501, "NOT_IMPLEMENTED", `${what} is not implemented yet (RFC 0004 ${wp}).`);

/** Answers every action with 501 `NOT_IMPLEMENTED` until WP5, WP8 and WP11 provide real ones. */
export const notImplementedActions: ConsoleActions = {
  decide: () => Promise.reject(notImplemented("Applying a decision", "WP5")),
  control: () => Promise.reject(notImplemented("Project control", "WP8")),
  answerCard: () => Promise.reject(notImplemented("Answering a card", "WP11")),
};

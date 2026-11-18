import type {
  CardAnswerRequest,
  CardAnswerResponse,
  ConsoleStreamMessage,
  ControlRequest,
  ControlResponse,
  DecisionRequest,
  DecisionResponse,
  EventsPage,
  EventsQuery,
  HooksInstallResponse,
  HooksResponse,
  JobCancelRequest,
  JobCancelResponse,
  LibraryResponse,
  ProjectView,
  ProjectsResponse,
  StudioOpenRequest,
  StudioOpenResponse,
  StudioStatusResponse,
} from "@contract";
import type { CredentialList, CredentialSave } from "../../../src/types/console-credentials";
import type { ConsoleMetrics } from "../../../src/lib/console/metrics-schema";
import type { GithubRepoResponse } from "../../../src/lib/console/github-schema";
import type { ConsoleDocument, ConsoleDocumentLocator, ConsoleDocumentSave } from "../../../src/types/console-document";
import type { ApiFailure } from "./errors";

export interface StartOptions {
  /** Called before each attempt (1, 2, …) so the UI can say it is retrying. */
  onAttempt?: (attempt: number) => void;
}

export interface StreamHandlers {
  message: (message: ConsoleStreamMessage) => void;
  /** The stream (re)connected: the caller refetches what it shows, since messages may have been missed. */
  open?: () => void;
  /** The stream dropped. A failure describes a refusal which stops automatic retries. */
  error?: (failure?: ApiFailure) => void;
}

/**
 * The console's API (RFC 0004 §9.1). {@link HttpApiClient} talks to the local server; {@link FixtureApiClient} serves
 * the contract fixtures in memory (development, unit tests, Playwright). Every reply is parsed through the contract
 * schemas; a failure throws {@link ApiFailure}.
 */
/** A raw authenticated request (`x-console-token`, same-origin), its status and body text; network failures throw. */
export type TextTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

export interface ApiClient {
  /** `snapshot`: a static, read-only page written by `pnpm console:snapshot` (WP15, D18). */
  readonly mode: "http" | "fixture" | "snapshot";
  /**
   * Establishes the session (a token or a one-use pairing code from the URL fragment, or the token this tab stored),
   * retrying transient failures.
   */
  start(options?: StartOptions): Promise<void>;
  projects(signal?: AbortSignal): Promise<ProjectsResponse>;
  renameProject?(project: string, title: string): Promise<{ ok: true }>;
  removeProject?(project: string, confirm: string): Promise<{ ok: true }>;
  view(project: string, signal?: AbortSignal): Promise<ProjectView>;
  events(project: string, query?: EventsQuery, signal?: AbortSignal): Promise<EventsPage>;
  /** With `dryRun`, nothing runs: the reply's decision is pending with the argv that would run (D13 confirmation). */
  decide(project: string, request: DecisionRequest, options?: { dryRun?: boolean }): Promise<DecisionResponse>;
  document?(project: string, locator: ConsoleDocumentLocator, signal?: AbortSignal): Promise<ConsoleDocument>;
  saveDocument?(project: string, request: ConsoleDocumentSave): Promise<ConsoleDocument>;
  /** Cancels one paid job after a stop, on the user's per-job confirmation (D12, A9); absent in snapshot mode. */
  cancelJob?(project: string, jobId: string, request: JobCancelRequest): Promise<JobCancelResponse>;
  /** This checkout's harness hooks status (`GET /api/hooks`, §7.1 H3); absent in snapshot mode. */
  credentials?(signal?: AbortSignal): Promise<CredentialList>;
  openCredentialEditor?(signal?: AbortSignal): Promise<void>;
  revealCredential?(name: string, revision: string | null, signal?: AbortSignal): Promise<string | null>;
  saveCredentials?(request: CredentialSave, signal?: AbortSignal): Promise<CredentialList>;
  hooks?(signal?: AbortSignal): Promise<HooksResponse>;
  /** The user's yes to `harness:setup --hooks --apply` (`POST /api/hooks/install`, H3). */
  installHooks?(): Promise<HooksInstallResponse>;
  /** Whether Remotion Studio can open the project, and the running one (`GET …/studio`); absent in snapshot mode. */
  studioStatus?(project: string, signal?: AbortSignal): Promise<StudioStatusResponse>;
  /**
   * The user's request to open the project in Remotion Studio (`POST …/studio`, §17 amendment of D21): starts or reuses
   * a loopback Studio with the project's current props; the caller opens the returned URL in a new tab.
   */
  studioOpen?(project: string, request: StudioOpenRequest): Promise<StudioOpenResponse>;
  /** Stops the project's Studio (`POST …/studio/stop`); answers the fresh status. */
  studioStop?(project: string): Promise<StudioStatusResponse>;
  control(project: string, request: ControlRequest): Promise<ControlResponse>;
  answerCard(project: string, cardId: string, request: CardAnswerRequest): Promise<CardAnswerResponse>;
  /** The project's GitHub star count (`GET /api/github`, fetched and cached by the server); absent in snapshot mode. */
  github?(signal?: AbortSignal): Promise<GithubRepoResponse>;
  /** Interaction metrics (`GET /api/metrics`, §12, WP12); absent when the client has none. */
  metrics?(signal?: AbortSignal): Promise<ConsoleMetrics>;
  /** Subscribes to `/api/stream` for one project (or all when undefined); returns the unsubscribe function. */
  subscribe(project: string | undefined, handlers: StreamHandlers): () => void;
  /** The motion library catalogue (`GET /api/library`, WP15); absent where there is no server catalogue. */
  library?(signal?: AbortSignal): Promise<LibraryResponse>;
  /** Browsers paired through one-use links (`GET /api/session/pairings`); absent without a server. */
  pairings?(signal?: AbortSignal): Promise<{ at: string; agent: string }[]>;
  /** Raw requests for views with their own protocol (the timeline's `/api/review/…`, WP13); absent in fixture mode. */
  readonly text?: TextTransport;
}

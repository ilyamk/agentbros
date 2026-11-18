/** The console's HTTP client for the local server (RFC 0004 §9.1, D6, D15). */
import {
  CONSOLE_TOKEN_HEADER,
  CardAnswerRequestSchema,
  CardAnswerResponseSchema,
  ConsoleStreamMessageSchema,
  ControlRequestSchema,
  ControlResponseSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  EventsPageSchema,
  HooksInstallResponseSchema,
  HooksResponseSchema,
  JobCancelRequestSchema,
  JobCancelResponseSchema,
  LibraryResponseSchema,
  ProjectViewResponseSchema,
  ProjectsResponseSchema,
  SSE_EVENTS,
  StudioOpenRequestSchema,
  StudioOpenResponseSchema,
  StudioStatusResponseSchema,
  type CardAnswerRequest,
  type ControlRequest,
  type DecisionRequest,
  type EventsQuery,
  type JobCancelRequest,
  type StudioOpenRequest,
} from "@contract";
import type { z } from "zod";
import {
  ProjectRemovalSchema,
  ProjectRenameSchema,
  ProjectSettingsResponseSchema,
} from "../../../src/types/project-display";
import {
  ConsoleDocumentLocatorSchema,
  ConsoleDocumentSaveSchema,
  ConsoleDocumentSchema,
  type ConsoleDocumentLocator,
  type ConsoleDocumentSave,
} from "../../../src/types/console-document";
import {
  CREDENTIALS_HEADER,
  CredentialListSchema,
  CredentialValueReplySchema,
  type CredentialSave,
} from "../../../src/types/console-credentials";
import { ConsoleMetricsSchema } from "../../../src/lib/console/metrics-schema";
import { GithubRepoResponseSchema } from "../../../src/lib/console/github-schema";
import { ApiFailure, asFailure, failureFromBody } from "./errors";
import {
  clearStoredToken,
  PairReplySchema,
  readStoredToken,
  readStoredCredentials,
  storeCredentials,
  SessionPostReplySchema,
  storeToken,
  takeFragmentToken,
  type FragmentToken,
} from "./session";
import { openEventStream } from "./stream";
import type { ApiClient, StartOptions, StreamHandlers } from "./types";

export interface HttpApiClientOptions {
  /** Server origin; defaults to the page's. */
  base?: string;
  fetch?: typeof fetch;
  /** Token taken from the fragment at boot (see {@link takeFragmentToken}); read from the location when omitted. */
  fragment?: FragmentToken;
  /** Delays before each retry of the session request (ms). By default retries continue at a capped delay. */
  retryDelays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS = [500, 1000, 2000, 4000, 8000] as const;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Worth retrying: the server may come up (network error, 5xx other than 501). 401/403 never are. */
const transient = (failure: ApiFailure) =>
  failure.code === "NETWORK" || (failure.status !== undefined && failure.status >= 500 && failure.status !== 501);

export class HttpApiClient implements ApiClient {
  readonly mode = "http" as const;
  /** The session token: sent as `x-console-token` on every request and the stream; kept in the tab's sessionStorage. */
  private token: string | undefined;
  /** A fragment (or stored) token whose POST has not succeeded yet: kept for retries. */
  private pendingToken: string | undefined;
  /** A one-use pairing code from the fragment, until it is redeemed or refused. */
  private pendingPair: string | undefined;
  private credentialsToken: string | undefined;
  private readonly retryDelays?: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private fragment: FragmentToken | undefined;

  constructor(options: HttpApiClientOptions = {}) {
    this.base = options.base ?? "";
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.fragment = options.fragment;
    this.retryDelays = options.retryDelays;
    this.sleep = options.sleep ?? wait;
  }

  /**
   * POST /api/session with the fragment token or, after a reload, the token this tab stored (the server never hands it
   * back). The POST also re-sets the media cookie. A network error or 5xx is retried with backoff (the token stays in
   * memory, so a later `start()` can try again); 401/403 fail at once as UNAUTHORIZED and forget the stored token.
   */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.fragment === undefined && this.pendingToken === undefined && this.token === undefined)
      this.fragment = takeFragmentToken();
    if (this.fragment?.token || this.fragment?.pair) {
      this.credentialsToken = this.fragment.pair ? undefined : this.fragment.credentials;
      storeCredentials(this.credentialsToken);
    } else if (this.credentialsToken === undefined) {
      this.credentialsToken = readStoredCredentials();
    }
    if (this.fragment?.token) this.pendingToken = this.fragment.token;
    else if (this.pendingToken === undefined && this.token === undefined) this.pendingToken = readStoredToken();
    if (this.fragment?.pair) this.pendingPair = this.fragment.pair;
    this.fragment = {};
    for (let attempt = 1; ; attempt++) {
      options.onAttempt?.(attempt);
      try {
        await this.openSession();
        return;
      } catch (error) {
        const failure = asFailure(error);
        const delay = this.retryDelays
          ? this.retryDelays[attempt - 1]
          : (DEFAULT_RETRY_DELAYS[attempt - 1] ?? DEFAULT_RETRY_DELAYS.at(-1));
        if (!transient(failure) || delay === undefined) {
          if (failure.status === 401 || failure.status === 403) {
            this.forgetSession();
            throw new ApiFailure("UNAUTHORIZED", failure.message, failure.status);
          }
          throw failure;
        }
        await this.sleep(delay);
      }
    }
  }

  private forgetSession(): void {
    clearStoredToken();
    storeCredentials();
    this.token = undefined;
    this.credentialsToken = undefined;
    this.pendingToken = undefined;
  }

  private async openSession(): Promise<void> {
    if (this.pendingPair) {
      // A one-use code: refused (used, expired) falls back to a token this tab already has.
      const code = this.pendingPair;
      try {
        const reply = PairReplySchema.safeParse(await this.request("POST", "/api/session/pair", { code }));
        if (!reply.success) throw new ApiFailure("INVALID_RESPONSE", "Unexpected /api/session/pair reply");
        this.pendingPair = undefined;
        this.token = reply.data.token;
        this.pendingToken = undefined;
        storeToken(reply.data.token);
        return;
      } catch (error) {
        const failure = asFailure(error);
        if (transient(failure)) throw failure;
        this.pendingPair = undefined;
        if (!(this.pendingToken ?? this.token)) throw failure;
      }
    }
    const token = this.pendingToken ?? this.token;
    if (!token) throw new ApiFailure("UNAUTHORIZED", "No console session: open the console URL again.", 401);
    const reply = await this.request("POST", "/api/session", {}, token);
    if (!SessionPostReplySchema.safeParse(reply).success)
      throw new ApiFailure("INVALID_RESPONSE", "Unexpected /api/session reply");
    this.token = token;
    this.pendingToken = undefined;
    storeToken(token);
  }

  /** The browsers paired through one-use links (Settings; a new one shows a toast in open tabs). */
  async pairings(signal?: AbortSignal) {
    const body = (await this.request("GET", "/api/session/pairings", undefined, undefined, signal)) as {
      paired?: { at: string; agent: string }[];
    };
    return Array.isArray(body?.paired) ? body.paired : [];
  }

  /** True once the session is established. */
  get authenticated(): boolean {
    return this.token !== undefined;
  }

  async library(signal?: AbortSignal) {
    return parse(LibraryResponseSchema, await this.request("GET", "/api/library", undefined, undefined, signal));
  }

  async projects(signal?: AbortSignal) {
    return parse(ProjectsResponseSchema, await this.request("GET", "/api/projects", undefined, undefined, signal));
  }

  async renameProject(project: string, title: string) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/rename`,
      ProjectRenameSchema.parse({ title }),
      ProjectSettingsResponseSchema,
    );
  }

  async removeProject(project: string, confirm: string) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/remove`,
      ProjectRemovalSchema.parse({ confirm }),
      ProjectSettingsResponseSchema,
    );
  }

  async github(signal?: AbortSignal) {
    return parse(GithubRepoResponseSchema, await this.request("GET", "/api/github", undefined, undefined, signal));
  }

  async metrics(signal?: AbortSignal) {
    return parse(ConsoleMetricsSchema, await this.request("GET", "/api/metrics", undefined, undefined, signal));
  }

  async view(project: string, signal?: AbortSignal) {
    const body = await this.request(
      "GET",
      `/api/projects/${encodeURIComponent(project)}/view`,
      undefined,
      undefined,
      signal,
    );
    return parse(ProjectViewResponseSchema, body);
  }

  async events(project: string, query: EventsQuery = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (query.since) params.set("since", query.since);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.size ? `?${params}` : "";
    const body = await this.request(
      "GET",
      `/api/projects/${encodeURIComponent(project)}/events${suffix}`,
      undefined,
      undefined,
      signal,
    );
    return parse(EventsPageSchema, body);
  }

  async decide(project: string, request: DecisionRequest, options: { dryRun?: boolean } = {}) {
    const body = await this.post(
      `/api/projects/${encodeURIComponent(project)}/decisions${options.dryRun ? "?dryRun=1" : ""}`,
      DecisionRequestSchema.parse(request),
      DecisionResponseSchema,
    );
    return body;
  }

  async cancelJob(project: string, jobId: string, request: JobCancelRequest) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      JobCancelRequestSchema.parse(request),
      JobCancelResponseSchema,
    );
  }

  async document(project: string, locator: ConsoleDocumentLocator, signal?: AbortSignal) {
    const { path, root } = ConsoleDocumentLocatorSchema.parse(locator);
    const query = new URLSearchParams({ path, ...(root ? { root } : {}) });
    const body = await this.request(
      "GET",
      `/api/projects/${encodeURIComponent(project)}/document?${query}`,
      undefined,
      undefined,
      signal,
    );
    return parse(ConsoleDocumentSchema, body);
  }

  async saveDocument(project: string, request: ConsoleDocumentSave) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/document`,
      ConsoleDocumentSaveSchema.parse(request),
      ConsoleDocumentSchema,
    );
  }

  async credentials(signal?: AbortSignal) {
    return this.credentialRequest("GET", "/api/credentials", CredentialListSchema, undefined, signal);
  }

  async revealCredential(name: string, revision: string | null, signal?: AbortSignal) {
    const reply = await this.credentialRequest(
      "POST",
      "/api/credentials/reveal",
      CredentialValueReplySchema,
      { name, revision },
      signal,
    );
    return reply.value;
  }

  async openCredentialEditor(signal?: AbortSignal) {
    parse(SessionPostReplySchema, await this.request("POST", "/api/credentials/open", {}, undefined, signal));
  }

  async saveCredentials(request: CredentialSave, signal?: AbortSignal) {
    return this.credentialRequest("POST", "/api/credentials", CredentialListSchema, request, signal);
  }

  private async credentialRequest<T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<T>> {
    const { status, json } = await this.raw(method, path, body, this.token, signal, this.credentialsToken);
    if (status >= 400) throw failureFromBody(status, json);
    return parse(schema, json);
  }

  async hooks(signal?: AbortSignal) {
    return parse(HooksResponseSchema, await this.request("GET", "/api/hooks", undefined, undefined, signal));
  }

  async installHooks() {
    return this.post("/api/hooks/install", {}, HooksInstallResponseSchema);
  }

  async studioStatus(project: string, signal?: AbortSignal) {
    const body = await this.request(
      "GET",
      `/api/projects/${encodeURIComponent(project)}/studio`,
      undefined,
      undefined,
      signal,
    );
    return parse(StudioStatusResponseSchema, body);
  }

  async studioOpen(project: string, request: StudioOpenRequest) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/studio`,
      StudioOpenRequestSchema.parse(request),
      StudioOpenResponseSchema,
    );
  }

  async studioStop(project: string) {
    return this.post(`/api/projects/${encodeURIComponent(project)}/studio/stop`, {}, StudioStatusResponseSchema);
  }

  async control(project: string, request: ControlRequest) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/control`,
      ControlRequestSchema.parse(request),
      ControlResponseSchema,
    );
  }

  async answerCard(project: string, cardId: string, request: CardAnswerRequest) {
    return this.post(
      `/api/projects/${encodeURIComponent(project)}/cards/${encodeURIComponent(cardId)}/answer`,
      CardAnswerRequestSchema.parse(request),
      CardAnswerResponseSchema,
    );
  }

  /** `/api/stream` read with `fetch` and the token header (stream.ts); the cookie cannot open it. */
  subscribe(project: string | undefined, handlers: StreamHandlers): () => void {
    if (!this.token) return () => {};
    const url = `${this.base}/api/stream${project ? `?project=${encodeURIComponent(project)}` : ""}`;
    const events = new Set<string>([...SSE_EVENTS, "message"]);
    return openEventStream({
      url,
      headers: { [CONSOLE_TOKEN_HEADER]: this.token },
      fetch: this.fetchImpl,
      onMessage: (event, text) => {
        if (!events.has(event)) return;
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        const parsed = ConsoleStreamMessageSchema.safeParse(data);
        if (parsed.success) handlers.message(parsed.data);
      },
      onOpen: () => handlers.open?.(),
      onError: (status) => {
        if (status === undefined) {
          handlers.error?.();
        } else if (status === 401 || status === 403) {
          this.forgetSession();
          handlers.error?.(new ApiFailure("UNAUTHORIZED", "The console session has expired.", status));
        } else {
          handlers.error?.(failureFromBody(status, undefined));
        }
      },
    });
  }

  /**
   * A state-changing request. A reply that parses as the expected response is returned even with a non-2xx status: a
   * refused decision is an answer (the CLI's envelope is in it), not a transport error.
   */
  private async post<T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> {
    const { status, json } = await this.raw("POST", path, body, this.token);
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    if (status >= 400) throw failureFromBody(status, json);
    throw new ApiFailure("INVALID_RESPONSE", "Unexpected reply", status);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, token?: string, signal?: AbortSignal) {
    const { status, json } = await this.raw(method, path, body, token ?? this.token, signal);
    if (status >= 400) throw failureFromBody(status, json);
    return json;
  }

  /** See {@link ApiClient.text}: the session's token, no parsing; a network failure is `NETWORK`. */
  readonly text = async (method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (this.token) headers[CONSOLE_TOKEN_HEADER] = this.token;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiFailure("NETWORK", asFailure(error).message);
    }
    return { status: response.status, text: await response.text() };
  };

  private async raw(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
    credentialsToken?: string,
  ) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (token) headers[CONSOLE_TOKEN_HEADER] = token;
    if (credentialsToken) headers[CREDENTIALS_HEADER] = credentialsToken;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiFailure("NETWORK", asFailure(error).message);
    }
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiFailure("INVALID_RESPONSE", "Reply is not JSON", response.status);
      }
    }
    return { status: response.status, json };
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiFailure("INVALID_RESPONSE", parsed.error.issues[0]?.message ?? "Unexpected reply");
  return parsed.data;
}

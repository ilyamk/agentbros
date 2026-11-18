/**
 * Client of the console's campaign review routes (RFC 0004 WP13e, parity rows RU-CP01–06), served for a campaign
 * container under `/api/review/<campaign>/` (src/lib/console/review/campaign.ts): `GET campaign`, `POST selection`,
 * `GET file?path=`. Errors are {@link ReviewRequestError}s, so `runReviewTask` gives the same G1/G2 behaviour as the
 * timeline view: a 409 refreshes and nothing is re-sent.
 */
import type { TextTransport } from "@/api/types";
import { ReviewRequestError } from "../timeline/api";

export const CAMPAIGN_CHOICES = ["keep", "fix", "reject"] as const;
export type CampaignChoice = (typeof CAMPAIGN_CHOICES)[number];

/** A receipt pin of a rendered output: sent back exactly as received (the server compares digests). */
export interface CampaignPin {
  path: string;
  sha256: string;
}

export interface CampaignMember {
  id: string;
  heldForPilot: boolean;
  excluded: boolean;
  choice?: string;
  productId?: string;
  language: string;
  factors: Record<string, unknown>;
  tasks: { id: string; state: string }[];
  outputs: CampaignPin[];
}

export interface CampaignSelectionEntry {
  memberId: string;
  planHash: string;
  choice: string;
  note?: string;
  [key: string]: unknown;
}

export interface CampaignState {
  campaignId: string;
  planHash: string;
  selection: { revision: number; planHash: string; choices: CampaignSelectionEntry[] };
  members: CampaignMember[];
}

export interface CampaignSelectionBody {
  planHash: string;
  expectedRevision: number;
  memberId: string;
  choice: CampaignChoice;
  note: string;
  outputs: CampaignPin[];
}

/** Largest note the server accepts. */
export const NOTE_LIMIT = 2000;

const enc = encodeURIComponent;

export class CampaignReviewApi {
  readonly base: string;

  constructor(
    readonly project: string,
    private readonly transport: TextTransport,
  ) {
    this.base = `/api/review/${enc(project)}`;
  }

  private async call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    let reply: { status: number; text: string };
    try {
      reply = await this.transport(method, `${this.base}/${route}`, body);
    } catch (error) {
      const failure = error as { message?: string; code?: string; status?: number };
      throw new ReviewRequestError(failure.message ?? String(error), failure.code ?? "NETWORK", failure.status);
    }
    let json: unknown;
    try {
      json = reply.text ? JSON.parse(reply.text) : undefined;
    } catch {
      throw new ReviewRequestError(`Reply is not JSON (HTTP ${reply.status})`, "INVALID_RESPONSE", reply.status);
    }
    if (reply.status >= 400) {
      const failure = (json ?? {}) as { error?: unknown; message?: unknown };
      throw new ReviewRequestError(
        typeof failure.message === "string" ? failure.message : `HTTP ${reply.status}`,
        typeof failure.error === "string" ? failure.error : "HTTP_ERROR",
        reply.status,
      );
    }
    return json as T;
  }

  state() {
    return this.call<CampaignState>("GET", "campaign");
  }

  /** Saves one member's review draft; 409 when the plan, revision or outputs moved. */
  save(body: CampaignSelectionBody) {
    return this.call<CampaignState["selection"]>("POST", "selection", body);
  }

  /** `<video src>` of a pinned output (the session cookie authenticates it). */
  fileUrl(output: CampaignPin): string {
    return `${this.base}/file?path=${enc(output.path)}`;
  }
}

/** The last saved choice for this member under the current plan (RU-CP05). */
export function previousChoice(state: CampaignState, memberId: string): CampaignSelectionEntry | undefined {
  return [...state.selection.choices]
    .reverse()
    .find((entry) => entry.memberId === memberId && entry.planHash === state.planHash);
}

/** The form's starting choice: the last saved one for this plan, else `reject` when excluded, else `keep`. */
export function defaultChoice(state: CampaignState, member: CampaignMember): CampaignChoice {
  const saved = previousChoice(state, member.id)?.choice;
  if (saved && (CAMPAIGN_CHOICES as readonly string[]).includes(saved)) return saved as CampaignChoice;
  return member.excluded ? "reject" : "keep";
}

/** RU-CP03: a case-insensitive substring over the member's JSON. */
export function memberMatches(member: CampaignMember, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return !needle || JSON.stringify(member).toLowerCase().includes(needle);
}

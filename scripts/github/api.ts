import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CliErrorObject, parseArgs } from "../../src/lib/cli";
import { runOffline } from "../../src/lib/contrib/cli";

export type Fetch = typeof fetch;
export class GitHub {
  constructor(
    readonly repo: string,
    private readonly token: string,
    private readonly request: Fetch = fetch,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected owner/repository");
  }
  async call<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    if ((route !== "" && !route.startsWith("/")) || route.includes("..")) throw new Error("Invalid API route");
    const response = await this.request(`https://api.github.com/repos/${this.repo}${route}`, {
      method,
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new CliErrorObject({
        code: "NETWORK",
        message: `GitHub ${method} ${route}: ${response.status}`,
        details: { status: response.status },
      });
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  async pages<T>(route: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.call<T[]>(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("Expected a paginated API array");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error("API pagination limit reached; human review required");
  }
  async content(file: string, ref: string): Promise<{ text: string; sha: string } | undefined> {
    try {
      const value = await this.call<{ content: string; encoding: string; sha: string }>(
        `/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
      if (value.encoding !== "base64" || typeof value.content !== "string")
        throw new Error("Unsupported GitHub content encoding");
      return { text: Buffer.from(value.content, "base64").toString("utf8"), sha: value.sha };
    } catch (error) {
      if (error instanceof CliErrorObject && error.details?.status === 404) return undefined;
      throw error;
    }
  }
}
/** Untrusted or model prose is data: suppress mentions, HTML, code spans, Markdown links/images and bare autolinks. */
export function plainText(text: string): string {
  return text
    .replaceAll("@", "＠")
    .replaceAll("`", "ˋ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("[", "［")
    .replaceAll("]", "］")
    .replaceAll("://", ":∕∕")
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}․`);
}
export type Comment = { id: number; body: string; created_at: string; user: { login: string; type?: string } };
export const botComment = (comment: Comment) => comment.user.login === "github-actions[bot]";
export async function upsertComment(api: GitHub, pr: number, marker: string, body: string): Promise<void> {
  const comments = await api.pages<Comment>(`/issues/${pr}/comments`);
  const own = comments.find((comment) => botComment(comment) && comment.body.startsWith(marker));
  const text = `${marker}\n${body}`;
  if (own?.body === text) return;
  await api.call(own ? `/issues/comments/${own.id}` : `/issues/${pr}/comments`, own ? "PATCH" : "POST", { body: text });
}
export async function syncLabels(
  api: GitHub,
  pr: number,
  current: string[],
  wanted: string[],
  managed: (label: string) => boolean,
): Promise<void> {
  for (const label of current.filter((label) => managed(label) && !wanted.includes(label))) {
    await api.call(`/issues/${pr}/labels/${encodeURIComponent(label)}`, "DELETE");
  }
  const added = wanted.filter((label) => !current.includes(label));
  if (added.length) await api.call(`/issues/${pr}/labels`, "POST", { labels: added });
}
export const specs = [
  { name: "repo", description: "GitHub owner/repository; defaults to GITHUB_REPOSITORY" },
  { name: "pr", type: "number", description: "Pull request number" },
  {
    name: "run",
    type: "number",
    description: "Trusted workflow run ID; resolve PRs through GitHub, never artefact metadata",
  },
  { name: "event", description: "GitHub event JSON file; defaults to GITHUB_EVENT_PATH" },
  { name: "check", type: "boolean", description: "Validate without applying changes" },
  { name: "artefact", description: "Untrusted report directory; data only" },
  { name: "out", description: "Output directory for triage data files" },
] as const;
export function entry(
  file: string,
  main: (api: GitHub, args: ReturnType<typeof options>) => Promise<Record<string, unknown>>,
): void {
  if (!process.argv[1] || file !== pathToFileURL(process.argv[1]).href) return;
  // runScript loads .env; GitHub jobs use only explicitly supplied environment variables.
  void runOffline(async () => {
    const args = options();
    return {
      metadata: await main(
        new GitHub(args.repo ?? process.env.GITHUB_REPOSITORY ?? "", process.env.GH_TOKEN ?? ""),
        args,
      ),
    };
  });
}
export function options() {
  return parseArgs(specs);
}
export function eventData(args: { event?: string }): Record<string, unknown> {
  const file = args.event ?? process.env.GITHUB_EVENT_PATH;
  if (!file) throw new Error("GitHub event path required");
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
export async function prNumbers(api: GitHub, args: { run?: number; pr?: number; event?: string }): Promise<number[]> {
  if (args.run) {
    const run = await api.call<{ event: string; head_sha: string; pull_requests: { number: number }[] }>(
      `/actions/runs/${integer(args.run)}`,
    );
    if (run.event !== "pull_request") return [];
    if (!/^[a-f\d]{40}$/i.test(run.head_sha)) throw new Error("Invalid workflow head SHA");
    const associated = run.pull_requests.length
      ? run.pull_requests
      : await api.pages<{ number: number }>(`/commits/${run.head_sha}/pulls`);
    const numbers: number[] = [];
    await eachPr(
      api,
      associated.map((item) => integer(item.number)),
      async (number) => {
        const pr = await api.call<{ head: { sha: string } }>(`/pulls/${number}`);
        if (pr.head.sha === run.head_sha) numbers.push(number);
      },
    );
    return numbers;
  }
  if (args.pr) return [integer(args.pr)];
  const event = eventData(args) as { pull_request?: { number: number }; number?: number };
  return event.pull_request ? [integer(event.pull_request.number ?? event.number)] : [];
}
export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Expected a positive integer");
  return value;
}

/** One inaccessible or changing PR must not prevent independent maintenance. */
export async function eachPr<T>(api: GitHub, numbers: number[], action: (number: number) => Promise<T>) {
  const results: (T | { pr: number; skipped: true; needsHuman: boolean })[] = [];
  for (const number of numbers) {
    try {
      results.push(await action(number));
    } catch {
      let needsHuman = false;
      try {
        const issue = await api.call<{ labels: { name: string }[] }>(`/issues/${number}`);
        if (!issue.labels.some((label) => label.name === "needs-human"))
          await api.call(`/issues/${number}/labels`, "POST", { labels: ["needs-human"] });
        needsHuman = true;
      } catch {
        /* A failure to label this PR must not block other PRs. */
      }
      results.push({ pr: number, skipped: true, needsHuman });
    }
  }
  return results;
}

/**
 * The project's GitHub star count for the console's top-bar button (`GET /api/github`). The browser cannot reach
 * api.github.com under the console CSP (`connect-src 'self'`), so the server asks once and caches the answer: an hour
 * on success, ten minutes on failure. The request carries no user data; a failure answers `stars: null`.
 */
import { z } from "zod";
import { GITHUB_REPOSITORY, GITHUB_URL, type GithubRepoResponse } from "./github-schema";

export { GITHUB_URL, GithubRepoResponseSchema, type GithubRepoResponse } from "./github-schema";

const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

let cache: { stars: number | null; expires: number } | undefined;
let pending: Promise<number | null> | undefined;

async function fetchStars(fetcher: Fetch): Promise<number | null> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${GITHUB_REPOSITORY}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentbros-console" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = z.object({ stargazers_count: z.number().int().nonnegative() }).safeParse(await response.json());
    return body.success ? body.data.stargazers_count : null;
  } catch {
    return null;
  }
}

/** The cached star count, refreshed when stale; concurrent callers share one request. */
export async function githubRepo(options: { fetch?: Fetch; now?: number } = {}): Promise<GithubRepoResponse> {
  const now = options.now ?? Date.now();
  if (!cache || cache.expires <= now) {
    pending ??= fetchStars(options.fetch ?? fetch).finally(() => (pending = undefined));
    const stars = await pending;
    cache = { stars, expires: now + (stars === null ? FAIL_TTL_MS : OK_TTL_MS) };
  }
  return { v: 1, repository: GITHUB_REPOSITORY, url: GITHUB_URL, stars: cache.stars };
}

/** Test hook: forgets the cached count. */
export function resetGithubCache(): void {
  cache = undefined;
  pending = undefined;
}

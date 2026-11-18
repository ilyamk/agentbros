/** `GET /api/github`'s star count: parsed from GitHub's answer, cached, and null (not thrown) on failure. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { GITHUB_URL, githubRepo, resetGithubCache } from "../src/lib/console/github";

beforeEach(() => resetGithubCache());

const answer =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("reads stargazers_count and caches it for an hour", async () => {
  let calls = 0;
  const fetch = async () => (calls++, answer({ stargazers_count: 42 })());
  const first = await githubRepo({ fetch, now: 0 });
  assert.deepEqual(first, { v: 1, repository: "ilyamk/agentbros", url: GITHUB_URL, stars: 42 });
  await githubRepo({ fetch, now: 59 * 60 * 1000 });
  assert.equal(calls, 1);
  await githubRepo({ fetch, now: 61 * 60 * 1000 });
  assert.equal(calls, 2);
});

test("a failed or malformed answer gives null stars", async () => {
  assert.equal((await githubRepo({ fetch: answer({ message: "rate limited" }, 403), now: 0 })).stars, null);
  resetGithubCache();
  assert.equal((await githubRepo({ fetch: answer({ nope: 1 }), now: 0 })).stars, null);
  resetGithubCache();
  const offline = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  assert.equal((await githubRepo({ fetch: offline, now: 0 })).stars, null);
});

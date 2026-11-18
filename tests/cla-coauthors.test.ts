import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GitHub, type Fetch } from "../scripts/github/api";
import { claAuthors, type Pull } from "../scripts/github/gh-pr-facts";
import { CLA_STATEMENT, verifyCla } from "../scripts/github/gh-cla";
import { AGENT_COAUTHORS, agentCoauthorMatcher } from "../src/lib/contrib/agent-coauthors";
import { AgentCoauthorsFileSchema } from "../src/types/contrib";

type Commit = { author: { login: string } | null; commit: { author: { email: string }; message: string } };
const fixture = JSON.parse(readFileSync("tests/fixtures/github/responses.json", "utf8")) as {
  pr: Pull;
  registry: unknown;
  commits: Commit[];
};
const at = "@";
const noreply = (login: string, id = "") => `${id}${login}${at}users.noreply.github.com`;

/** A recorded-response GitHub for one PR (#7) whose commits carry the given messages; the registry signs only the PR author. */
function fake(messages: string[]) {
  const commits: Commit[] = messages.map((message) => ({
    author: { login: "alice" },
    commit: { author: { email: noreply("alice") }, message },
  }));
  const fetcher: Fetch = async (input, init) => {
    const route = new URL(String(input)).pathname.replace("/repos/example/repo", "") + new URL(String(input)).search;
    const method = init?.method ?? "GET";
    let value: unknown = {};
    if (method === "GET") {
      if (route === "/pulls/7") value = fixture.pr;
      else if (route.startsWith("/pulls/7/commits?")) value = commits;
      else if (route.startsWith("/contents/signatures.json?"))
        value = {
          content: Buffer.from(JSON.stringify(fixture.registry)).toString("base64"),
          encoding: "base64",
          sha: "registry",
        };
      else if (route.startsWith("/issues/7/comments?")) value = [];
      else throw new Error(`Unrecorded API call: ${method} ${route}`);
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return new GitHub("example/repo", "fixture-token", fetcher);
}
const trailer = (name: string, email: string) => `Change\n\nCo-authored-by: ${name} <${email}>`;

test("the repository CLA.md contains the short-form signing statement verbatim", () => {
  assert.ok(readFileSync("CLA.md", "utf8").includes(CLA_STATEMENT));
});

test("contrib/agent-coauthors.json validates and gives every agent a reason", () => {
  const file = AgentCoauthorsFileSchema.parse(JSON.parse(readFileSync("contrib/agent-coauthors.json", "utf8")));
  assert.deepEqual(
    file.agents.map((agent) => agent.tool),
    ["Claude Code", "OpenAI Codex", "GitHub Copilot", "Cursor agent"],
  );
  assert.ok(file.agents.every((agent) => agent.reason.length > 20));
  assert.throws(() =>
    AgentCoauthorsFileSchema.parse({ version: 1, agents: [{ tool: "X", emails: [], reason: "none listed" }] }),
  );
  assert.throws(() =>
    AgentCoauthorsFileSchema.parse({
      version: 1,
      agents: [{ tool: "X", emails: [`Upper${at}Example.com`], reason: "not lower-case" }],
    }),
  );
});

test("each listed agent trailer resolves the CLA to the PR author alone", async () => {
  const cases = AGENT_COAUTHORS.agents.flatMap((agent) => [
    ...agent.emails.flatMap((email) => [trailer(agent.tool, email), trailer(agent.tool, email.toUpperCase())]),
    ...(agent.githubLogins ?? []).flatMap((login) => [
      trailer(agent.tool, noreply(login)),
      trailer(agent.tool, noreply(login, "198982749+")),
      trailer(agent.tool, noreply(login.toLowerCase(), "223556219+")),
    ]),
  ]);
  assert.ok(cases.length >= 10);
  for (const message of cases) {
    const api = fake([message]);
    assert.deepEqual(await claAuthors(api, fixture.pr), { authors: ["alice"], unresolved: [] }, message);
    assert.deepEqual(await verifyCla(api, 7), { ok: true, missing: [], unresolvedCount: 0 }, message);
  }
  const api = fake(cases);
  assert.equal((await verifyCla(api, 7)).ok, true);
});

test("unknown co-authors still need resolution or a signature", async () => {
  const unknown = await verifyCla(fake([trailer("Someone", `someone${at}example.com`)]), 7);
  assert.deepEqual(unknown, { ok: false, missing: [], unresolvedCount: 1 });
  const lookalike = await verifyCla(fake([trailer("Fan", noreply("copilotfan", "5+"))]), 7);
  assert.deepEqual(lookalike, { ok: false, missing: ["copilotfan"], unresolvedCount: 0 });
  const isAgent = agentCoauthorMatcher();
  for (const email of [
    `noreply${at}anthropic.com.evil.test`,
    `x.noreply${at}openai.com`,
    noreply("Copilot-swe-agent"),
    `copilot${at}users.noreply.github.com.evil.test`,
  ])
    assert.equal(isAgent(email), false, email);
});

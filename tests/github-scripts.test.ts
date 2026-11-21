import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { GitHub, plainText, prNumbers, upsertComment, type Fetch, type Comment, eachPr } from "../scripts/github/api";
import { evaluate, getFacts, writeArtefact, type Pull } from "../scripts/github/gh-pr-facts";
import { applyIntake, gatesPassed } from "../scripts/github/gh-apply-intake";
import { closePr, maintainPrs } from "../scripts/github/gh-autoclose";
import { applyActions, handleCommand, getClaims, linksIssue } from "../scripts/github/gh-commands";
import {
  CLA_STATEMENT,
  ClaRefusal,
  parseSignature,
  recordSignature,
  verifyCla,
  rerunIntake,
} from "../scripts/github/gh-cla";
import { labelsSync } from "../scripts/github/gh-labels";
import { judgeEnv, reserveTriage, settleTriage, triageEligibility } from "../scripts/github/gh-triage-budget";
import { categoryPlan } from "../scripts/github/gh-category-gates";
import { lineDiff } from "../scripts/github/line-diff";
import type { SpendRecord } from "../src/types/triage";
import { readArtefact } from "../src/lib/triage/artefact";
import { applyTriage } from "../scripts/github/gh-apply-triage";

const fixture = JSON.parse(readFileSync("tests/fixtures/github/responses.json", "utf8")) as {
  pr: Pull;
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }[];
  changeEntry: string;
  registry: {
    version: number;
    signatures: { login: string; name: string; claCommit: string; commentId: number; signedAt: string }[];
  };
  commits: { author: { login: string } | null; commit: { author: { email: string }; message: string } }[];
  comments: Comment[];
  commandComment: Comment;
  signatureComment: Comment;
  label: { name: string; color: string; description: string };
};
const history = () => ({ merged: 0, closedAsSlop: 0, slopClosuresLast30Days: 0 });
function fake(custom?: (route: string, method: string, body: unknown) => unknown) {
  const data = structuredClone(fixture);
  const calls: { route: string; method: string; body: unknown }[] = [];
  const content = (value: string) => ({
    content: Buffer.from(value).toString("base64"),
    encoding: "base64",
    sha: "fixture-blob",
  });
  const fetcher: Fetch = async (input, init) => {
    assert.ok(String(input).startsWith("https://api.github.com/repos/example/repo"));
    const url = new URL(String(input));
    const route = url.pathname.replace("/repos/example/repo", "") + url.search;
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, method, body });
    const override = custom?.(route, method, body);
    if (override instanceof Response) return override;
    let value = override;
    if (value === undefined) {
      if (method !== "GET") value = {};
      else if (route === "") value = { default_branch: "main" };
      else if (route.startsWith("/git/ref/heads/")) value = { object: { sha: "b".repeat(40) } };
      else if (route === "/pulls/7") value = data.pr;
      else if (route.startsWith("/pulls/7/files?")) value = data.files;
      else if (route.startsWith("/pulls/7/commits?")) value = data.commits;
      else if (route.startsWith("/pulls?")) value = [data.pr];
      else if (route.startsWith("/contents/.changes/guide.md?")) value = content(data.changeEntry);
      else if (route.startsWith("/contents/.github/trust.json?")) value = content('{"version":1,"overrides":[]}');
      else if (route.startsWith("/contents/signatures.json?")) value = content(JSON.stringify(data.registry));
      else if (route.startsWith("/contents/CLA.md?")) value = content("Reviewed fixture CLA");
      else if (route.startsWith("/issues/7/comments?")) value = data.comments;
      else if (route === "/issues/comments/20") value = data.commandComment;
      else if (route === "/issues/comments/21") value = data.signatureComment;
      else if (route === "/issues/7") value = { state: "open", user: { login: "alice" }, labels: [], pull_request: {} };
      else if (route.startsWith("/issues?")) value = [];
      else if (route.startsWith("/labels?")) value = [];
      else throw new Error(`Unrecorded API call: ${method} ${route}`);
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { api: new GitHub("example/repo", "fixture-token", fetcher), calls, data };
}
const writes = <T extends { method: string }>(calls: T[]) => calls.filter((call) => call.method !== "GET");

test("facts use paginated API file data, signed authors, authoritative history and actual additions", async () => {
  const { api, calls } = fake();
  const facts = await getFacts(api, 7, history);
  assert.equal(facts.cla, true);
  assert.equal(facts.changedFiles[0]?.additions, 1);
  assert.equal(facts.changedFiles[1]?.content, fixture.changeEntry);
  assert.equal(facts.openPrCount, 1);
  assert.equal(facts.authorTier, 0);
  assert.equal(facts.leakHit, false);
  assert.ok(calls.some((call) => call.route.includes("per_page=100&page=1")));
  assert.equal(writes(calls).length, 0);
});
test("pagination reads subsequent pages and fails on incomplete GitHub file lists", async () => {
  const first = Array.from({ length: 100 }, (_, n) => n);
  const { api } = fake((route) =>
    route.startsWith("/pages?") ? (route.endsWith("page=1") ? first : [100]) : undefined,
  );
  assert.equal((await api.pages("/pages")).length, 101);
  const broken = fake();
  broken.data.pr.changed_files = 3;
  await assert.rejects(getFacts(broken.api, 7, history), /Incomplete/);
});
test("media extensions block; renamed .github paths require human review", async () => {
  const { api, data, calls } = fake();
  data.files[0]!.previous_filename = ".github/workflows/ci.yml";
  data.files[0]!.filename = "docs/image.png";
  delete data.files[0]!.patch;
  const facts = await getFacts(api, 7, history);
  assert.equal(facts.changedFiles[0]?.binary, true);
  const result = await applyIntake(api, facts, true);
  assert.equal(result.ready, false);
  assert.ok(result.labels.includes("needs-human"));
  assert.ok(!JSON.stringify(writes(calls)).includes('"ready-for-owner"'));
});
test("ready-for-owner needs successful required gates and cannot admit .github edits or likely-slop", async () => {
  for (const kind of ["gates", "github", "slop", "appealed", "human", "valid"]) {
    const { api, data } = fake();
    if (kind === "github") data.files[0]!.filename = ".github/workflows/evil.yml";
    if (kind === "slop") data.pr.labels.push({ name: "triage:likely-slop" });
    if (kind === "appealed") data.pr.labels.push({ name: "appealed" });
    if (kind === "human") data.pr.labels.push({ name: "needs-human" });
    const result = await applyIntake(api, await getFacts(api, 7, history), kind !== "gates");
    assert.equal(result.ready, kind === "valid", kind);
    assert.equal(result.labels.includes("ready-for-owner"), kind === "valid");
  }
});
test("gate runs must match PR/head and latest attempt, not an artefact verdict", async () => {
  let failed = false;
  const { api } = fake((route) =>
    route.startsWith("/actions/workflows/")
      ? {
          workflow_runs: [
            {
              id: 2,
              head_sha: fixture.pr.head.sha,
              event: "pull_request",
              status: "completed",
              conclusion: failed ? "failure" : "success",
              pull_requests: [{ number: 7 }],
            },
            {
              id: 1,
              head_sha: fixture.pr.head.sha,
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              pull_requests: [{ number: 7 }],
            },
          ],
        }
      : undefined,
  );
  const facts = await getFacts(api, 7, history);
  assert.equal(await gatesPassed(api, facts), true);
  failed = true;
  assert.equal(await gatesPassed(api, facts), false);
});
test("PR changes during a decision prevent label writes and closing", async () => {
  const { api, data, calls } = fake();
  const facts = await getFacts(api, 7, history);
  data.pr.head.sha = "c".repeat(40);
  await assert.rejects(applyIntake(api, facts, true), /changed/);
  await assert.rejects(closePr(api, facts), /changed/);
  assert.equal(writes(calls).length, 0);
});
test("status comments upsert the bot marker and never overwrite another user's comment", async () => {
  const { api, data, calls } = fake();
  data.comments.push(
    { id: 1, user: { login: "attacker" }, created_at: "2026-11-01Z", body: "<!-- agentbros:intake -->\nforged" },
    {
      id: 2,
      user: { login: "github-actions[bot]" },
      created_at: "2026-11-01Z",
      body: "<!-- agentbros:intake -->\nold",
    },
  );
  await upsertComment(api, 7, "<!-- agentbros:intake -->", "new");
  assert.equal(writes(calls)[0]?.route, "/issues/comments/2");
  assert.equal(writes(calls)[0]?.method, "PATCH");
});
test("CLA reminders close after seven days; forged reminders do not start the timer", async () => {
  for (const author of ["attacker", "github-actions[bot]"]) {
    const { api, data, calls } = fake();
    data.registry.signatures = [];
    data.comments.push({
      id: 5,
      user: { login: author },
      created_at: "2026-11-01T00:00:00Z",
      body: "<!-- agentbros:reminder:1 -->\nSign",
    });
    const decision = await closePr(api, await getFacts(api, 7, history), new Date("2026-11-09T00:00:00Z"));
    assert.equal(decision.close, author === "github-actions[bot]");
    assert.equal(
      writes(calls).some((call) => call.route === "/pulls/7"),
      author === "github-actions[bot]",
    );
  }
});
test("autoclose labels media closures as slop and still closes appealed PRs on rule 5", async () => {
  const { api, data, calls } = fake();
  data.files[0]!.filename = "docs/video.mp4";
  const decision = await closePr(api, await getFacts(api, 7, history));
  assert.equal(decision.rule, "5");
  assert.equal(decision.close, true);
  assert.match(JSON.stringify(writes(calls)), /clean branch/);
  assert.ok(writes(calls).some((call) => JSON.stringify(call.body) === JSON.stringify({ labels: ["closed:slop"] })));
  data.pr.labels.push({ name: "appealed" }, { name: "needs-human" });
  assert.equal((await closePr(api, await getFacts(api, 7, history))).rule, "5");
  // Without the appeal, needs-human still defers to a human.
  data.pr.labels = [{ name: "needs-human" }];
  assert.equal((await closePr(api, await getFacts(api, 7, history))).close, false);
});
test("an appealed PR is exempt from the appealed rule only, read from the bot's appeal record", async () => {
  const { api, data } = fake();
  data.registry.signatures = [];
  data.pr.labels.push({ name: "appealed" }, { name: "needs-human" });
  const reminder = {
    id: 5,
    user: { login: "github-actions[bot]" },
    created_at: "2026-11-01T00:00:00Z",
    body: "<!-- agentbros:reminder:1 -->\nSign",
  };
  const record = (rule: string, login = "github-actions[bot]") => ({
    id: 6,
    user: { login },
    created_at: "2026-11-02T00:00:00Z",
    body: `<!-- agentbros:appeal -->\nAppealed rule ${rule}: it no longer closes this PR.`,
  });
  const at = new Date("2026-11-09T00:00:00Z");
  data.comments.push(reminder, record("1"));
  const exempt = await closePr(api, await getFacts(api, 7, history), at);
  assert.equal(exempt.close, false);
  assert.equal(exempt.rule, null);
  data.comments = [reminder, record("6")];
  const closed = await closePr(api, await getFacts(api, 7, history), at);
  assert.equal(closed.rule, "1");
  assert.equal(closed.label, "closed:process");
  // A forged record does not name the rule; an unreadable record exempts every rule except 5.
  data.comments = [reminder, record("6", "attacker")];
  assert.equal((await closePr(api, await getFacts(api, 7, history), at)).close, false);
});
test("appeals are accepted only for a closure by the automation", async () => {
  for (const [actor, labels, accepted] of [
    ["github-actions[bot]", ["closed:process"], true],
    ["ilyamk", ["closed:process"], false],
    ["github-actions[bot]", ["closed:slop"], true],
    ["github-actions[bot]", [], true],
  ] as const) {
    let seen: string | undefined = "unset";
    const { api } = fake((route, method) => {
      if (method !== "GET") return undefined;
      if (route === "/issues/7")
        return {
          state: "closed",
          user: { login: "alice" },
          labels: labels.map((name) => ({ name })),
          pull_request: {},
        };
      if (route === "/issues/comments/20")
        return {
          id: 20,
          user: { login: "alice" },
          created_at: "2026-11-10T00:00:00Z",
          body: "/appeal the change entry exists",
        };
      if (route.startsWith("/issues/7/events?")) return [{ event: "closed", actor: { login: actor } }];
      if (route.startsWith("/issues/7/comments?"))
        return [
          {
            id: 8,
            user: { login: "github-actions[bot]" },
            created_at: "2026-11-09T00:00:00Z",
            body: "<!-- agentbros:autoclose -->\nRule 6: PR block or change entry still missing.",
          },
        ];
      return undefined;
    });
    await handleCommand(
      api,
      { action: "created", issue: { number: 7 }, comment: { id: 20 }, sender: { login: "alice" } },
      (input) => {
        seen = input.target.closedByRule;
        return [];
      },
      history,
    );
    assert.equal(seen, accepted ? "6" : undefined, `${actor} ${labels.join()}`);
  }
});
test("duplicate detection uses the API file set and added lines", async () => {
  const { api } = fake();
  const facts = await getFacts(api, 7, history);
  const earlier = structuredClone(facts);
  earlier.pr.number = 6;
  assert.equal((await closePr(api, facts, new Date(), [earlier])).rule, "3");
});
test("command adapter passes API-fetched comment, tier and claims to pure policy", async () => {
  const { api, calls } = fake();
  let seen = false;
  const result = await handleCommand(
    api,
    {
      action: "created",
      issue: { number: 7 },
      comment: { id: 20, body: "/appeal forged" },
      sender: { login: "alice" },
    },
    (input) => {
      seen = true;
      assert.equal(input.comment, "/claim");
      assert.equal(input.authorTier, 0);
      return [
        { type: "assign", author: input.author },
        { type: "label-add", label: "claimed" },
      ];
    },
    history,
  );
  assert.ok(seen && "actions" in result);
  assert.equal(writes(calls).length, 2);
});
test("command refusals cause no partial writes; actor mismatch is ignored", async () => {
  const { api, calls } = fake();
  await applyActions(api, 7, [
    { type: "assign", author: "alice" },
    { type: "refuse", reason: "tier too low" },
  ]);
  const result = await handleCommand(
    api,
    { action: "created", issue: { number: 7 }, comment: { id: 20 }, sender: { login: "mallory" } },
    () => {
      throw new Error("must not decide");
    },
    history,
  );
  assert.deepEqual(result, { ignored: true });
  assert.equal(writes(calls).length, 0);
});
test("claim expiry input uses claimed label events and linked draft PRs", async () => {
  const { api } = fake((route) => {
    if (route.startsWith("/issues?")) return [{ number: 7, assignees: [{ login: "alice" }] }];
    if (route.startsWith("/issues/7/events?"))
      return [{ event: "labeled", label: { name: "claimed" }, created_at: "2026-11-01T00:00:00Z" }];
    if (route.startsWith("/pulls?")) return [{ ...fixture.pr, draft: true, body: "Closes #7" }];
    return undefined;
  });
  assert.deepEqual(await getClaims(api), [
    { number: 7, author: "alice", claimedAt: "2026-11-01T00:00:00Z", linkedDraftPr: true },
  ]);
});
test("signature statement is bound to the commenting human and full commit hash", () => {
  assert.equal(parseSignature(fixture.signatureComment.body, "alice")?.name, "Alice Contributor");
  assert.equal(parseSignature(fixture.signatureComment.body, "mallory"), undefined);
  assert.equal(parseSignature(fixture.signatureComment.body.replace("b".repeat(40), "short"), "alice"), undefined);
});
test("CLA appends via contents API on cla-signatures and is idempotent", async () => {
  const { api, data, calls } = fake();
  assert.equal(await recordSignature(api, data.signatureComment), true);
  assert.equal(writes(calls).length, 0);
  data.registry.signatures = [];
  assert.equal(await recordSignature(api, data.signatureComment), true);
  const write = writes(calls)[0]!;
  assert.equal(write.route, "/contents/signatures.json");
  const body = write.body as { branch: string; content: string };
  assert.equal(body.branch, "cla-signatures");
  assert.equal(JSON.parse(Buffer.from(body.content, "base64").toString()).signatures[0].login, "alice");
});
test("CLA re-reads after a concurrent append conflict", async () => {
  let attempt = 0;
  const { api, data } = fake((route, method) =>
    route === "/contents/signatures.json" && method === "PUT" && attempt++ === 0
      ? new Response("{}", { status: 409 })
      : undefined,
  );
  data.registry.signatures = [];
  assert.equal(await recordSignature(api, data.signatureComment), true);
  assert.equal(attempt, 2);
});
test("co-authors must sign; unresolved co-author emails require human resolution", async () => {
  const { api, data } = fake();
  data.commits[0]!.commit.message += "\nCo-authored-by: Bob <bob@users.noreply.github.com>";
  assert.deepEqual((await verifyCla(api, 7)).missing, ["bob"]);
  data.commits[0]!.commit.message += "\nCo-authored-by: Unknown <person@example.com>";
  assert.equal((await verifyCla(api, 7)).unresolvedCount, 1);
  assert.equal((await getFacts(api, 7, history)).cla, false);
});
test("label sync creates missing labels, updates drift and leaves identical labels untouched", async () => {
  let existing: (typeof fixture.label)[] = [];
  const { api, calls } = fake((route) => (route.startsWith("/labels?") ? existing : undefined));
  assert.equal((await labelsSync(api, [fixture.label])).changed, 1);
  existing = [{ ...fixture.label, description: "old" }];
  assert.equal((await labelsSync(api, [fixture.label])).changed, 1);
  existing = [fixture.label];
  assert.equal((await labelsSync(api, [fixture.label])).changed, 0);
  assert.deepEqual(
    writes(calls).map((call) => call.method),
    ["POST", "PATCH"],
  );
});
test("triage only applies advisory labels and refuses close/merge shaped output", async () => {
  const { api, calls } = fake();
  const facts = await getFacts(api, 7, history);
  await assert.rejects(
    applyTriage(api, facts, { ok: true, metadata: { labels: ["ready-for-owner"], comment: "approve" } }),
    /Invalid triage/,
  );
  await applyTriage(api, facts, {
    ok: true,
    metadata: { labels: ["triage:needs-human"], comment: "Judges disagree." },
  });
  assert.ok(!writes(calls).some((call) => call.route.startsWith("/pulls/")));
});
test("triage artefacts are bounded data files with a summary; no generated code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-artefact-"));
  try {
    const { api } = fake();
    const facts = await getFacts(api, 7, history);
    facts.rawFiles[0]!.patch = "+" + "x".repeat(100000);
    writeArtefact(facts, dir);
    assert.deepEqual(readdirSync(dir).sort(), ["body.md", "change.md", "diff.patch", "metadata.json"]);
    assert.ok(Buffer.byteLength(readFileSync(path.join(dir, "diff.patch"))) <= 61440);
    const artefact = readArtefact(dir, 61440);
    assert.equal(artefact.truncated, true);
    assert.equal(artefact.files.length, facts.changedFiles.length);
    assert.ok(artefact.files.some((file) => file.includes(facts.changedFiles.at(-1)!.path)));
    assert.match(artefact.material, /omitted content is not reviewed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("every production GitHub CLI emits one JSON line for help and invalid input without credentials", () => {
  const scripts = [
    "gh-pr-facts",
    "gh-apply-intake",
    "gh-autoclose",
    "gh-commands",
    "gh-cla",
    "gh-labels",
    "gh-apply-triage",
    "gh-category-gates",
    "gh-triage-budget",
    "codeowners",
  ];
  const dir = mkdtempSync(path.join(tmpdir(), "github-cli-"));
  try {
    for (const script of scripts)
      for (const arg of ["--help", "--unknown"]) {
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            path.resolve("node_modules/tsx/dist/loader.mjs"),
            path.resolve(`scripts/github/${script}.ts`),
            arg,
          ],
          { cwd: dir, env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH }, encoding: "utf8" },
        );
        assert.equal(result.status, arg === "--help" ? 0 : 1, `${script}: ${result.stderr}`);
        const lines = result.stdout.trim().split("\n");
        assert.equal(lines.length, 1);
        assert.equal(JSON.parse(lines[0]!).ok, arg === "--help");
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omitted text patches and truncated patches defer to human review without binary autoclose", async () => {
  const { api, data } = fake((route) =>
    route.startsWith("/contents/docs/guide.md?")
      ? { content: Buffer.from("text").toString("base64"), encoding: "base64", sha: "blob" }
      : undefined,
  );
  delete data.files[0]!.patch;
  const facts = await getFacts(api, 7, history);
  assert.equal(facts.changedFiles[0]?.binary, false);
  assert.deepEqual(facts.uncertainFiles, ["docs/guide.md"]);
  assert.equal((await applyIntake(api, facts, true)).ready, false);
  assert.equal((await closePr(api, facts)).close, false);
  data.files[0]!.patch = "@@ -1 +1 @@\n+short";
  assert.ok((await getFacts(api, 7, history)).uncertainFiles.length);
});
test("an omitted patch of a large text file is rebuilt from merge base and head, checked against GitHub's counts and leak-scanned", async () => {
  const blob = "c".repeat(40),
    mergeBase = "d".repeat(40);
  const base = 'version = 1\n[[package]]\nname = "torch"\nversion = "2.11.0"\n';
  const encoded = (text: string, sha: string) => ({
    content: Buffer.from(text).toString("base64"),
    encoding: "base64",
    sha,
  });
  const setup = (head: string, additions: number, deletions: number) => {
    const fixtureApi = fake((route) => {
      if (route.startsWith("/contents/uv.lock?ref=" + fixture.pr.head.sha))
        return { content: "", encoding: "none", sha: blob }; // GitHub's answer for a file over 1 MB
      if (route === `/git/blobs/${blob}`) return encoded(head, blob);
      if (route.startsWith(`/compare/${fixture.pr.base.sha}...${fixture.pr.head.sha}`))
        return { merge_base_commit: { sha: mergeBase } };
      if (route.startsWith(`/contents/uv.lock?ref=${mergeBase}`)) return encoded(base, "e".repeat(40));
      return undefined;
    });
    fixtureApi.data.files[0] = { filename: "uv.lock", status: "modified", additions, deletions };
    return fixtureApi;
  };
  const updated = base.replace('version = "2.11.0"', 'version = "2.11.0+cpu"');
  const clean = setup(updated, 1, 1);
  const facts = await getFacts(clean.api, 7, history);
  assert.deepEqual(facts.uncertainFiles, []);
  assert.equal(facts.changedFiles[0]?.patch, '@@ -4,1 +4,1 @@\n-version = "2.11.0"\n+version = "2.11.0+cpu"');
  assert.equal(facts.leakHit, false);
  assert.ok(clean.calls.some((call) => call.route === `/git/blobs/${blob}`));
  // Added lines of a rebuilt patch go through the same leak scan as any other patch.
  // Assembled at run time so this source does not itself contain the home-path pattern the leak scan looks for.
  const leaking = setup(updated + `path = '${["", "Users", "someone", "wheel"].join("/")}'\n`, 2, 1);
  assert.equal((await getFacts(leaking.api, 7, history)).leakHit, true);
  // GitHub's Myers counts may pair more lines than the minimal diff; the same net change is the same file pair.
  const heuristic = setup(updated, 3, 3);
  const heuristicFacts = await getFacts(heuristic.api, 7, history);
  assert.deepEqual(heuristicFacts.uncertainFiles, []);
  // The rebuilt patch carries its own counts, so intake's complete-patch check (models-refresh route) accepts it.
  assert.deepEqual([heuristicFacts.changedFiles[0]?.additions, heuristicFacts.changedFiles[0]?.deletions], [1, 1]);
  // Past GitHub's diff limits a modified file is listed with neither patch nor counts; the rebuilt diff stands alone.
  const uncounted = await getFacts(setup(updated, 0, 0).api, 7, history);
  assert.deepEqual(uncounted.uncertainFiles, []);
  assert.equal(uncounted.changedFiles[0]?.patch, '@@ -4,1 +4,1 @@\n-version = "2.11.0"\n+version = "2.11.0+cpu"');
  assert.deepEqual([uncounted.changedFiles[0]?.additions, uncounted.changedFiles[0]?.deletions], [1, 1]);
  // A rebuilt diff that disagrees with GitHub's counts (for example, another merge base) stays for human review.
  const mismatch = setup(updated, 2, 1);
  assert.deepEqual((await getFacts(mismatch.api, 7, history)).uncertainFiles, ["uv.lock"]);
  // Fewer lines than the minimal diff cannot describe the same pair of files.
  const smaller = setup(updated + "a\nb\n", 2, 0);
  assert.deepEqual((await getFacts(smaller.api, 7, history)).uncertainFiles, ["uv.lock"]);
});
test("API routes refuse dot path segments but allow dots inside a segment", async () => {
  const { api } = fake((route) => (route.startsWith("/compare/") ? { ok: true } : undefined));
  assert.deepEqual(await api.call("/compare/a...b"), { ok: true });
  for (const route of ["/../x", "/a/..", "/a/%2E%2e/b", "/a\\..\\b", "/a/.?x", "pulls"])
    await assert.rejects(api.call(route), /Invalid API route/, route);
});
test("lineDiff matches git's minimal counts, keeps line terminators and refuses oversized edit distances", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nc\nd\n"), {
    patch: "@@ -2,1 +2,0 @@\n-b\n@@ -4,0 +3,1 @@\n+d",
    additions: 1,
    deletions: 1,
  });
  assert.deepEqual(lineDiff("", ""), { patch: "", additions: 0, deletions: 0 });
  // A last line without a newline differs from the same text with one, as in git.
  assert.deepEqual(lineDiff("a\nb", "a\nb\n"), { patch: "@@ -2,1 +2,1 @@\n-b\n+b", additions: 1, deletions: 1 });
  assert.equal(lineDiff("a\nb\nc\n", "x\ny\nz\n", 5), undefined);
});
test("workflow-run PR discovery ignores stale revisions and resolves fork runs via commit association", async () => {
  let head = fixture.pr.head.sha;
  const { api } = fake((route) =>
    route === "/actions/runs/12"
      ? { event: "pull_request", head_sha: head, pull_requests: [] }
      : route.startsWith("/commits/")
        ? [{ number: 7 }]
        : undefined,
  );
  const args = { run: 12, check: false };
  assert.deepEqual(await prNumbers(api, args), [7]);
  head = "f".repeat(40);
  assert.deepEqual(await prNumbers(api, args), []);
});
test("draft claim links require a PR issue field or explicit issue reference, never bare prose numbers", () => {
  assert.equal(linksIssue("I have 7 questions", 7, "example/repo"), false);
  assert.equal(linksIssue("Closes #7", 7, "example/repo"), true);
  assert.equal(linksIssue("Closes #70", 7, "example/repo"), false);
  assert.equal(linksIssue("https://github.com/example/repo/issues/7", 7, "example/repo"), true);
});
test("reopening records a permanent appeal marker before changing PR state", async () => {
  const { api, calls } = fake();
  await applyActions(api, 7, [{ type: "reopen", rule: "6" }]);
  assert.deepEqual(writes(calls)[0]?.body, { labels: ["appealed", "needs-human"] });
  assert.match(JSON.stringify(writes(calls)[1]?.body), /^\{"body":"<!-- agentbros:appeal -->\\nAppealed rule 6:/);
  assert.deepEqual(writes(calls)[2]?.body, { state: "open" });
});
test("category wrapper selects the shared category gate names without inventing a group flag", () => {
  let seen: string[] = [];
  const result = categoryPlan(["docs/guide.md"], "base", (categories) => {
    seen = categories;
    return [
      { name: "lint", command: ["pnpm", "lint"] },
      { name: "category:typecheck", command: ["pnpm", "typecheck"] },
    ];
  });
  assert.ok(seen.includes("docs"));
  assert.deepEqual(
    result.map((gate) => gate.name),
    ["category:typecheck"],
  );
  categoryPlan(
    ["tests/repair.test.ts"],
    "base",
    (categories) => {
      assert.deepEqual(categories, ["fix"]);
      return [];
    },
    ["fix"],
  );
});
test("remote triage reservation precedes spending and survives retries/cancellation without resetting the month", async () => {
  const state = { version: 1, reservations: [] as { operation: string; at: string; boundUsd: number }[] };
  const { api, calls } = fake((route, method, body) => {
    if (route.startsWith("/contents/triage-budget.json?") && method === "GET")
      return { encoding: "base64", sha: "state", content: Buffer.from(JSON.stringify(state)).toString("base64") };
    if (route === "/contents/triage-budget.json" && method === "PUT") {
      const value = body as { content: string; branch: string };
      assert.equal(value.branch, "automation-state");
      state.reservations = JSON.parse(Buffer.from(value.content, "base64").toString()).reservations;
      return {};
    }
    return undefined;
  });
  const caps = { perPrCapUsd: 0.5, monthlyCapUsd: 1 };
  const now = new Date("2026-11-01T00:00:00Z");
  await reserveTriage(api, caps, "12:1:pr", now, "example/repo#7");
  await assert.rejects(reserveTriage(api, caps, "12:1:pr", now, "example/repo#7"), /already reserved/);
  await assert.rejects(reserveTriage(api, caps, "13:1:pr", now, "example/repo#7"), /per-PR cap/);
  await reserveTriage(api, caps, "13:1:audit", now);
  await assert.rejects(reserveTriage(api, caps, "14:1:pr", now, "example/repo#8"), /monthly cap/);
  assert.equal(writes(calls).length, 2);
  await assert.rejects(reserveTriage(api, { ...caps, monthlyCapUsd: null }, "15:1:pr", now), /explicit positive/);
});
test("missing or conflicted durable triage state refuses execution", async () => {
  const missing = fake((route) =>
    route.startsWith("/contents/triage-budget.json?") ? new Response("{}", { status: 404 }) : undefined,
  );
  await assert.rejects(
    reserveTriage(missing.api, { perPrCapUsd: 0.5, monthlyCapUsd: 1 }, "12:1:pr", new Date(), "example/repo#7"),
    /Initialise/,
  );
  const conflict = fake((route, method) =>
    route.startsWith("/contents/triage-budget.json?")
      ? { content: Buffer.from('{"version":1,"reservations":[]}').toString("base64"), encoding: "base64", sha: "old" }
      : route === "/contents/triage-budget.json" && method === "PUT"
        ? new Response("{}", { status: 409 })
        : undefined,
  );
  await assert.rejects(
    reserveTriage(conflict.api, { perPrCapUsd: 0.5, monthlyCapUsd: 1 }, "12:1:pr", new Date(), "example/repo#7"),
    /409/,
  );
});

test("a fresh CLA signature can rerun failed unprivileged intake without running fork code in the signature job", async () => {
  const { api, calls } = fake((route) =>
    route.startsWith("/actions/workflows/")
      ? {
          workflow_runs: [
            {
              id: 12,
              head_sha: fixture.pr.head.sha,
              event: "pull_request",
              status: "completed",
              conclusion: "failure",
              pull_requests: [{ number: 7 }],
            },
            {
              id: 13,
              head_sha: "c".repeat(40),
              event: "pull_request",
              status: "completed",
              conclusion: "failure",
              pull_requests: [{ number: 7 }],
            },
          ],
        }
      : undefined,
  );
  await rerunIntake(api, 7);
  assert.deepEqual(
    writes(calls).map((call) => call.route),
    ["/actions/runs/12/rerun", "/actions/runs/12/rerun"],
  );
});

test("repeated release preparation retains current base ancestry after a squash merge", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-release-history-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    mkdirSync(path.join(dir, ".changes"));
    writeFileSync(path.join(dir, ".changes/first.md"), "First change");
    writeFileSync(path.join(dir, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n");
    git("add", ".");
    git("commit", "-m", "Base");
    git("switch", "-c", "bot/release");
    unlinkSync(path.join(dir, ".changes/first.md"));
    writeFileSync(path.join(dir, "package.json"), '{"version":"1.1.0"}');
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n## 1.1.0\nFirst change\n");
    git("add", "--update");
    git("commit", "-m", "Release 1");
    git("switch", "main");
    git("merge", "--squash", "bot/release");
    git("commit", "-m", "Squash release 1");
    mkdirSync(path.join(dir, ".changes"), { recursive: true });
    writeFileSync(path.join(dir, ".changes/second.md"), "Second change");
    git("add", ".");
    git("commit", "-m", "Second contribution");
    git("switch", "bot/release");
    git("merge", "--strategy=ours", "--no-commit", "--no-ff", "main");
    git("restore", "--source", "main", "--staged", "--worktree", "--", ".");
    unlinkSync(path.join(dir, ".changes/second.md"));
    writeFileSync(path.join(dir, "package.json"), '{"version":"1.2.0"}');
    writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n## 1.2.0\nSecond change\n## 1.1.0\nFirst change\n");
    git("add", "--update");
    git("commit", "-m", "Release 2");
    git("merge-base", "--is-ancestor", "main", "bot/release");
    git("switch", "main");
    git("merge", "--squash", "bot/release");
    assert.match(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), /1.2.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one failed facts lookup is labelled once while other PR maintenance continues", async () => {
  const labels: { name: string }[] = [];
  const { api, calls } = fake((route, method) => {
    if (route === "/issues/8" && method === "GET") return { labels };
    if (route === "/issues/8/labels" && method === "POST") {
      labels.push({ name: "needs-human" });
      return {};
    }
    return undefined;
  });
  const facts = await getFacts(api, 7, history),
    processed: number[] = [];
  const results = await maintainPrs(
    api,
    [{ ...facts.pr, number: 8 }, facts.pr],
    new Date(),
    async (_api, number) => {
      if (number === 8) throw new Error("Incomplete PR files");
      return facts;
    },
    async (_api, fact) => {
      processed.push(fact.pr.number);
      return { close: false, rule: null, message: "fixture" };
    },
  );
  assert.deepEqual(processed, [7]);
  assert.ok(results.some((result) => "skipped" in result && result.pr === 8 && result.needsHuman));
  await eachPr(api, [8], async () => {
    throw new Error("failure again");
  });
  assert.equal(writes(calls).filter((call) => call.route === "/issues/8/labels").length, 1);
  // A PR already deferred to a human does not receive another label write.
  await eachPr(api, [7], async () => {
    throw new Error("failure");
  });
  assert.equal(writes(calls).filter((call) => call.route === "/issues/7/labels").length, 1);
});

test("trusted release PR uses API identity, requires human review and skips autoclose", async () => {
  const pkg = (version: string) => `{\n  "version": "${version}"\n}\n`;
  const readme = (value: string) => `# Project\n<!-- metrics:start -->\n${value}\n<!-- metrics:end -->\n`;
  const { api, data, calls } = fake((route) => {
    const content = (text: string) => ({
      content: Buffer.from(text).toString("base64"),
      encoding: "base64",
      sha: "blob",
    });
    if (route.startsWith("/contents/contrib/release.json?"))
      return content('{"version":1,"botLogins":["agentbros-release[bot]"],"headBranch":"bot/release"}');
    if (route.startsWith("/contents/package.json?"))
      return content(pkg(route.includes(fixture.pr.head.sha) ? "0.2.0" : "0.1.0"));
    if (route.startsWith("/contents/README.md?"))
      return content(readme(route.includes(fixture.pr.head.sha) ? "New" : "Old"));
    return undefined;
  });
  data.pr.user.login = "agentbros-release[bot]";
  data.pr.body = "Automated release; human review required.";
  data.pr.head = { ...data.pr.head, ref: "bot/release", repo: { full_name: "example/repo" } };
  data.pr.base = { ...data.pr.base, repo: { full_name: "example/repo" } };
  data.files = [
    {
      filename: "package.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: '@@ -1,3 +1,3 @@\n {\n-  "version": "0.1.0"\n+  "version": "0.2.0"\n }',
    },
    {
      filename: "CHANGELOG.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+## 0.2.0\n Old",
    },
    { filename: ".changes/guide.md", status: "removed", additions: 0, deletions: 3 },
    {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -2,3 +2,3 @@\n <!-- metrics:start -->\n-Old\n+New\n <!-- metrics:end -->",
    },
  ];
  data.pr.changed_files = data.files.length;
  const facts = await getFacts(api, 7, history);
  assert.equal(facts.cla, false);
  const result = await applyIntake(api, facts, true);
  assert.equal(result.ready, false);
  assert.ok(result.labels.includes("release"));
  assert.ok(result.labels.includes("needs-human"));
  assert.ok(!result.labels.includes("ready-for-owner"));
  assert.equal((await closePr(api, facts)).rule, "release-route");
  assert.ok(!writes(calls).some((call) => call.route === "/pulls/7"));
  for (const change of [
    () => {
      data.pr.head.repo = { full_name: "fork/repo" };
    },
    () => {
      data.pr.user.login = "mallory";
    },
    () => {
      data.pr.head.ref = "feature";
    },
    () => {
      data.files.push({
        filename: "scripts/extra.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+evil",
      });
    },
  ]) {
    const saved = structuredClone(data);
    change();
    data.pr.changed_files = data.files.length;
    const rejected = await applyIntake(api, await getFacts(api, 7, history), true);
    assert.ok(!rejected.labels.includes("release"));
    Object.assign(data, saved);
  }
});

function remoteBudget() {
  const state: {
    version: number;
    reservations: {
      operation: string;
      at: string;
      boundUsd: number;
      settled?: boolean;
      settledUsd?: number;
      headSha?: string;
      owner?: string;
      prIdentity?: string;
    }[];
  } = { version: 1, reservations: [] };
  let conflicts = 0;
  let puts = 0;
  const { api } = fake((route, method, body) => {
    if (route.startsWith("/contents/triage-budget.json?") && method === "GET")
      return { encoding: "base64", sha: `sha-${puts}`, content: Buffer.from(JSON.stringify(state)).toString("base64") };
    if (route === "/contents/triage-budget.json" && method === "PUT") {
      puts++;
      if (conflicts > 0) {
        conflicts--;
        return new Response("{}", { status: 409 });
      }
      state.reservations = JSON.parse(
        Buffer.from((body as { content: string }).content, "base64").toString(),
      ).reservations;
      return {};
    }
  });
  return {
    api,
    state,
    conflict: (count: number) => {
      conflicts = count;
    },
    puts: () => puts,
  };
}
const budgetDate = new Date("2026-11-01T00:00:00Z");
const reservationEvidence = (runId: string, settled = true): SpendRecord[] => [
  {
    event: "reserve",
    id: "call-1",
    runId,
    at: budgetDate.toISOString(),
    label: "Claude",
    provider: "openrouter",
    model: "anthropic/test",
    costUsd: 0.08,
  },
  ...(settled
    ? [
        {
          event: "settle" as const,
          id: "call-1",
          at: budgetDate.toISOString(),
          costUsd: 0.02,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]
    : []),
];

test("remote settlement releases unused cost, retries SHA conflicts and admits new heads within cumulative caps", async () => {
  const remote = remoteBudget();
  const caps = { perPrCapUsd: 0.25, monthlyCapUsd: 0.25, maxRunsPerPr: 2 };
  const reserve = (op: string, pr: number, head: string) =>
    reserveTriage(remote.api, caps, op, budgetDate, `example/repo#${pr}`, {
      headSha: head.repeat(40),
      owner: "Alice",
      boundUsd: 0.1,
    });
  await reserve("1:1:pr", 7, "a");
  remote.conflict(2);
  await settleTriage(remote.api, "1:1:pr", reservationEvidence("1:1:pr"), 0);
  assert.equal(remote.state.reservations[0]!.settledUsd, 0.02);
  assert.equal(remote.state.reservations[0]!.settled, true);
  assert.equal(remote.puts(), 4);
  await assert.rejects(reserve("2:1:pr", 7, "a"), /head SHA/);
  await reserve("2:1:pr", 7, "b");
  await assert.rejects(reserve("3:1:pr", 7, "c"), /Maximum triage runs/);
  await reserve("3:1:pr", 8, "c");
  assert.equal(remote.state.reservations.length, 3);
  assert.equal(remote.state.reservations[1]!.owner, "alice");
  await assert.rejects(reserve("4:1:pr", 9, "d"), /monthly cap/);
});

test("ambiguous runs keep their full remote bound; fully settled failures retain known actual charges", async () => {
  for (const kind of ["pending", "no evidence", "unrelated evidence", "mixed", "settled failure"]) {
    const remote = remoteBudget();
    await reserveTriage(remote.api, { perPrCapUsd: 0.25, monthlyCapUsd: 10 }, "1:1:pr", budgetDate, "example/repo#7", {
      headSha: "a".repeat(40),
      boundUsd: 0.1,
    });
    const evidence =
      kind === "pending"
        ? reservationEvidence("1:1:pr", false)
        : kind === "no evidence"
          ? []
          : kind === "unrelated evidence"
            ? reservationEvidence("other")
            : reservationEvidence("1:1:pr");
    if (kind === "mixed") evidence.push({ ...reservationEvidence("1:1:pr", false)[0]!, id: "call-2" });
    await settleTriage(remote.api, "1:1:pr", evidence, 1);
    assert.equal(remote.state.reservations[0]!.settled, kind === "settled failure" ? true : undefined, kind);
    assert.equal(remote.state.reservations[0]!.boundUsd, 0.1);
  }
});

test("remote cumulative per-PR and owner monthly quotas use settled amounts and reservation counts", async () => {
  const remote = remoteBudget();
  const caps = { perPrCapUsd: 0.15, monthlyCapUsd: 10, perOwnerMonthlyRuns: 2 };
  await reserveTriage(remote.api, caps, "1:1:pr", budgetDate, "example/repo#7", {
    headSha: "a".repeat(40),
    owner: "alice",
    boundUsd: 0.1,
  });
  await settleTriage(remote.api, "1:1:pr", reservationEvidence("1:1:pr"), 0);
  await assert.rejects(
    reserveTriage(remote.api, caps, "2:1:pr", budgetDate, "example/repo#7", {
      headSha: "b".repeat(40),
      owner: "alice",
      boundUsd: 0.14,
    }),
    /per-PR cap/,
  );
  await reserveTriage(remote.api, caps, "2:1:pr", budgetDate, "example/repo#8", {
    headSha: "b".repeat(40),
    owner: "Alice",
    boundUsd: 0.1,
  });
  await assert.rejects(
    reserveTriage(remote.api, caps, "3:1:pr", budgetDate, "example/repo#9", {
      headSha: "c".repeat(40),
      owner: "ALICE",
      boundUsd: 0.1,
    }),
    /owner monthly triage quota/,
  );
  await reserveTriage(remote.api, caps, "3:1:pr", budgetDate, "example/repo#9", {
    headSha: "c".repeat(40),
    owner: "bob",
    boundUsd: 0.1,
  });
});

test("triage admission re-runs intake, CLA, draft and tier checks without trusting labels or artefacts", async () => {
  const { api } = fake();
  const initial = await getFacts(api, 7, history);
  const config = { minTierForAutoTriage: 1 };
  assert.match((await triageEligibility(api, initial, config))!, /maintainer triage request/);
  const trusted = { ...initial, authorTier: 1 as const };
  assert.equal(await triageEligibility(api, trusted, config), undefined);
  for (const changed of [
    { ...trusted, cla: false },
    { ...trusted, leakHit: true },
    { ...trusted, uncertainFiles: ["x.ts"] },
    { ...trusted, pr: { ...trusted.pr, body: "forged intake passed" } },
  ])
    assert.match((await triageEligibility(api, changed, config))!, /Intake is blocked/);
  for (const pr of [
    { ...trusted.pr, draft: true },
    { ...trusted.pr, state: "closed" },
  ])
    assert.match((await triageEligibility(api, { ...trusted, pr }, config))!, /closed or draft/);
});

for (const permission of ["write", "maintain", "admin", "triage", "read"])
  test(`tier-zero triage request checks label actor permission: ${permission}`, async () => {
    const { api, calls } = fake((route) => {
      if (route.startsWith("/issues/7/events?"))
        return [{ event: "labeled", label: { name: "triage:requested" }, actor: { login: "maintainer" } }];
      if (route === "/collaborators/maintainer/permission") return { permission };
    });
    const facts = await getFacts(api, 7, history);
    facts.labels.push("triage:requested");
    const reason = await triageEligibility(api, facts, { minTierForAutoTriage: 1 });
    if (["write", "maintain", "admin"].includes(permission)) assert.equal(reason, undefined);
    else assert.match(reason!, /not applied by a maintainer/);
    assert.equal(writes(calls).length, 0);
  });

test("skipped or stale triage reports cause no advisory labels or comments", async () => {
  const { api, calls } = fake();
  const facts = await getFacts(api, 7, history);
  await applyTriage(api, facts, { ok: true, metadata: { skipped: "triage disabled" } });
  await applyTriage(api, facts, {
    ok: true,
    metadata: { headSha: "stale", labels: ["triage:promising"], comment: "old" },
  });
  assert.equal(writes(calls).length, 0);
});

test("ambiguous settlement raises the retained bound to known charges plus pending calls", async () => {
  const remote = remoteBudget();
  await reserveTriage(remote.api, { perPrCapUsd: 0.25, monthlyCapUsd: 10 }, "1:1:pr", budgetDate, "example/repo#7", {
    boundUsd: 0.1,
    headSha: "a".repeat(40),
  });
  const evidence = reservationEvidence("1:1:pr");
  evidence[1]!.costUsd = 0.5;
  evidence.push({ ...reservationEvidence("1:1:pr", false)[0]!, id: "pending" });
  await settleTriage(remote.api, "1:1:pr", evidence, 1);
  assert.equal(remote.state.reservations[0]!.boundUsd, 0.58);
  assert.equal(remote.state.reservations[0]!.settled, undefined);
});

test("model refresh API route always needs human review and skips autoclose before labels", async () => {
  const { api, data, calls } = fake((route) => {
    if (route.startsWith("/contents/contrib/release.json?"))
      return {
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            botLogins: ["agentbros-release[bot]"],
            headBranch: "bot/release",
            modelsRefreshHeadBranch: "bot/models-refresh",
          }),
        ).toString("base64"),
        encoding: "base64",
        sha: "blob",
      };
    if (route.startsWith("/contents/src/lib/models/model-slots.json?"))
      return { content: Buffer.from("{}\n").toString("base64"), encoding: "base64", sha: "blob" };
    return undefined;
  });
  data.pr.user.login = "agentbros-release[bot]";
  data.pr.body = "Automated refresh";
  data.pr.head = { ...data.pr.head, ref: "bot/models-refresh", repo: { full_name: "example/repo" } };
  data.pr.base = { ...data.pr.base, repo: { full_name: "example/repo" } };
  data.files = [
    {
      filename: "src/lib/models/model-slots.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ];
  data.pr.changed_files = 1;
  const facts = await getFacts(api, 7, history);
  assert.equal((await closePr(api, facts)).rule, "models-refresh-route");
  const result = await applyIntake(api, facts, true);
  assert.equal(result.ready, false);
  assert.ok(result.labels.includes("models-refresh-route"));
  assert.ok(result.labels.includes("needs-human"));
  assert.ok(!result.labels.includes("ready-for-owner"));
  assert.ok(!writes(calls).some((call) => call.route === "/pulls/7"));
  assert.ok(calls.some((call) => call.route.includes(`/contents/contrib/release.json?ref=${data.pr.base.sha}`)));
  for (const change of [
    () => {
      data.pr.head.repo = { full_name: "fork/repo" };
    },
    () => {
      data.pr.user.login = "mallory";
    },
    () => {
      data.pr.head.ref = "feature";
    },
    () => {
      data.files.push({
        filename: "scripts/extra.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+evil",
      });
    },
    () => {
      data.files[0]!.patch = "@@ -1 +1 @@\n+new";
    },
    () => {
      data.files[0]!.patch = "@@ -1 +1 @@\n-old\n+new\0";
    },
    () => {
      delete data.files[0]!.patch;
    },
    () => {
      data.files[0]!.status = "renamed";
    },
  ]) {
    const saved = structuredClone(data);
    change();
    data.pr.changed_files = data.files.length;
    const rejected = await applyIntake(api, await getFacts(api, 7, history), true);
    assert.ok(!rejected.labels.includes("models-refresh-route"));
    Object.assign(data, saved);
  }
});

const claFile = (sha: string, text = `How to sign\n\n${CLA_STATEMENT}\n`) => ({
  content: Buffer.from(text).toString("base64"),
  encoding: "base64",
  sha,
});
test("the CLA.md statement signs; the record binds the current CLA.md blob, not a moving main head", async () => {
  const { api, data, calls } = fake((route) =>
    route.startsWith("/contents/CLA.md?") ? claFile("blob-current") : undefined,
  );
  data.registry.signatures = [];
  const comment = { ...data.signatureComment, body: "I have read the CLA and I agree to it." };
  assert.deepEqual(parseSignature(comment.body, "alice"), { name: "alice" });
  assert.equal(await recordSignature(api, comment), true);
  const written = JSON.parse(Buffer.from((writes(calls)[0]!.body as { content: string }).content, "base64").toString())
    .signatures[0];
  assert.deepEqual([written.login, written.claCommit, written.claBlob], ["alice", "b".repeat(40), "blob-current"]);
});
test("long-form signatures naming an older commit pass when CLA.md is unchanged and are refused when it changed", async () => {
  for (const [olderBlob, accepted] of [
    ["blob-current", true],
    ["blob-old", false],
  ] as const) {
    const { api, data, calls } = fake((route) =>
      route.startsWith("/contents/CLA.md?")
        ? claFile(route.includes("c".repeat(40)) ? "blob-current" : olderBlob)
        : route.startsWith("/git/ref/heads/")
          ? { object: { sha: "c".repeat(40) } }
          : undefined,
    );
    data.registry.signatures = [];
    if (accepted) assert.equal(await recordSignature(api, data.signatureComment), true);
    else
      await assert.rejects(
        recordSignature(api, data.signatureComment),
        (error: Error) => error instanceof ClaRefusal && /changed after/.test(error.message),
      );
    assert.equal(writes(calls).length, accepted ? 1 : 0);
  }
});
test("signature-shaped comments that cannot be recorded are refused with an explanation, and ordinary comments are ignored", async () => {
  const { api, data } = fake();
  await assert.rejects(
    recordSignature(api, { ...data.signatureComment, body: "I have read the CLA, I think I agree" }),
    ClaRefusal,
  );
  await assert.rejects(
    recordSignature(api, { ...data.signatureComment, user: { login: "mallory", type: "User" } }),
    ClaRefusal,
  );
  assert.equal(await recordSignature(api, { ...data.signatureComment, body: "Thanks for the review" }), false);
  assert.equal(
    await recordSignature(api, { ...data.signatureComment, body: CLA_STATEMENT, user: { login: "bot", type: "Bot" } }),
    false,
  );
});
test("the repository owner (Licensor) needs no signature and agent co-author trailers are not signatories", async () => {
  const { api, data } = fake();
  data.registry.signatures = [];
  data.pr.user.login = "example";
  data.pr.body = data.pr.body!.replace("owner: alice", "owner: example");
  const at = "@";
  data.commits = [
    {
      author: { login: "example" },
      commit: {
        author: { email: `1+example${at}users.noreply.github.com` },
        message: `Change\n\nCo-Authored-By: Claude <noreply${at}anthropic.com>`,
      },
    },
  ];
  assert.equal((await getFacts(api, 7, history)).cla, true);
  assert.equal((await verifyCla(api, 7)).ok, true);
  data.commits[0]!.commit.message += "\nCo-authored-by: Bob <bob@users.noreply.github.com>";
  assert.deepEqual((await verifyCla(api, 7)).missing, ["bob"]);
});
test("tier 3 maintainer PRs pass protected-path intake and are never autoclosed", async () => {
  const { api, data, calls } = fake();
  data.files[0]!.filename = "scripts/github/api.ts";
  const facts = await getFacts(api, 7, () => ({
    merged: 0,
    closedAsSlop: 0,
    slopClosuresLast30Days: 0,
    grant: 3 as const,
  }));
  assert.equal(facts.authorTier, 3);
  assert.deepEqual(evaluate(facts).facts.protectedPathsTouched, ["scripts/github/api.ts"]);
  assert.ok(!evaluate(facts).findings.some((finding) => finding.rule === "protected-paths"));
  assert.ok(evaluate({ ...facts, authorTier: 2 }).findings.some((finding) => finding.rule === "protected-paths"));
  const decision = await closePr(api, { ...facts, cla: false, leakHit: true });
  assert.equal(decision.close, false);
  assert.ok(!writes(calls).some((call) => call.route === "/pulls/7" || call.route.startsWith("/issues/7/comments")));
});
test("Dependabot PRs pass intake without CLA or PR block, always need a human and skip autoclose", async () => {
  const { api, data, calls } = fake((route) =>
    route.startsWith("/contents/package.json?")
      ? {
          content: Buffer.from('{"devDependencies":{"zod":"4.0.1"}}').toString("base64"),
          encoding: "base64",
          sha: "blob",
        }
      : route.startsWith("/contents/pnpm-lock.yaml?")
        ? { content: Buffer.from("lockfileVersion: '9.0'\n").toString("base64"), encoding: "base64", sha: "blob" }
        : route.startsWith("/contents/contrib/release.json?")
          ? {
              content: Buffer.from(readFileSync("contrib/release.json")).toString("base64"),
              encoding: "base64",
              sha: "blob",
            }
          : undefined,
  );
  data.registry.signatures = [];
  data.pr.user.login = "dependabot[bot]";
  data.pr.body = "Bumps zod from 4.0.0 to 4.0.1.";
  data.pr.head = { ...data.pr.head, ref: "dependabot/npm_and_yarn/zod-4.0.1", repo: { full_name: "example/repo" } };
  data.pr.base = { ...data.pr.base, repo: { full_name: "example/repo" } };
  data.commits = [
    {
      author: { login: "dependabot[bot]" },
      commit: { author: { email: "49699333+dependabot[bot]@users.noreply.github.com" }, message: "Bump zod" },
    },
  ];
  data.files = [
    {
      filename: "package.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-"zod": "4.0.0"\n+"zod": "4.0.1"',
    },
    { filename: "pnpm-lock.yaml", status: "modified", additions: 2, deletions: 2 },
  ];
  data.pr.changed_files = 2;
  const facts = await getFacts(api, 7, history);
  assert.equal(facts.cla, false);
  assert.equal(evaluate(facts).facts.dependabotRoute, true);
  assert.ok(!evaluate(facts).findings.some((finding) => finding.severity === "block"));
  const result = await applyIntake(api, facts, true);
  assert.equal(result.ready, false);
  assert.ok(result.labels.includes("needs-human"));
  assert.equal((await closePr(api, facts)).rule, "dependabot-route");
  assert.ok(!writes(calls).some((call) => call.route === "/pulls/7"));
});
test("triage comments render model text as inert plain text", async () => {
  const { api, calls } = fake();
  const facts = await getFacts(api, 7, history);
  await applyTriage(api, facts, {
    ok: true,
    metadata: {
      labels: ["triage:needs-work"],
      comment:
        "See [here](https://evil.example/x) ![i](https://evil.example/i.png) <img src=x> `code` www.evil.example @owner",
    },
  });
  const body = (writes(calls).find((call) => call.route.includes("/comments"))!.body as { body: string }).body;
  for (const forbidden of ["](", "![", "<img", "://", "`", "@owner", "www.evil"])
    assert.ok(!body.includes(forbidden), forbidden);
  assert.equal(plainText("a@b <c> [d](e://f)"), "a＠b ‹c› ［d］(e:∕∕f)");
});
test("autoclose maintenance reuses one repository PR list for every PR's history", async () => {
  const { api } = fake();
  const all = [fixture.pr];
  const seen: unknown[] = [];
  await maintainPrs(
    api,
    all,
    new Date(),
    async (_api, _number, _history, _now, pulls) => {
      seen.push(pulls);
      return getFacts(api, 7, history, new Date(), pulls);
    },
    async () => ({ close: false, rule: null, message: "fixture" }),
    all,
  );
  assert.deepEqual(seen, [all]);
});

test("the triage judge subprocess gets its vendor keys but no GitHub or Actions credential", () => {
  const env = judgeEnv(
    {
      PATH: "/bin",
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      ACTIONS_RUNTIME_TOKEN: "t",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      ACTIONS_ID_TOKEN_REQUEST_URL: "u",
      AUTOMATION_APP_PRIVATE_KEY: "k",
      TRIAGE_ANTHROPIC_API_KEY: "a",
      TRIAGE_OPENAI_API_KEY: "o",
    },
    { TRIAGE_LEDGER: "/l", TRIAGE_RUN_ID: "r" },
  );
  assert.deepEqual(Object.keys(env).sort(), [
    "PATH",
    "TRIAGE_ANTHROPIC_API_KEY",
    "TRIAGE_LEDGER",
    "TRIAGE_OPENAI_API_KEY",
    "TRIAGE_RUN_ID",
  ]);
});

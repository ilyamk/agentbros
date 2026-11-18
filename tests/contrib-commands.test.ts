import test from "node:test";
import assert from "node:assert/strict";
import {
  activeClaims,
  decideCommentCommand,
  parseCommentCommand,
  type CommandContext,
} from "../src/lib/contrib/commands";

const now = new Date("2026-11-15T00:00:00Z");
const context = (changes: Partial<CommandContext> = {}): CommandContext => ({
  comment: "/claim",
  author: "tester",
  authorTier: 0,
  now,
  target: { kind: "issue", number: 1, state: "open", author: "tester" },
  claims: [],
  ...changes,
});
const refusal = (input: CommandContext) => decideCommentCommand(input).some((action) => action.type === "refuse");
test("comment parser accepts exact standalone commands and a one-line appeal", () => {
  for (const name of ["claim", "unclaim", "bench-lite"] as const)
    assert.deepEqual(parseCommentCommand(` /${name}\n`), { name });
  assert.deepEqual(parseCommentCommand("/appeal please review"), { name: "appeal", reason: "please review" });
  for (const text of ["/appeal", "/claim extra", "quoted /claim", "```\n/claim\n```", "/appeal first\nsecond"])
    assert.equal(parseCommentCommand(text), null);
  assert.deepEqual(decideCommentCommand(context({ comment: "ordinary prose" })), []);
});
test("claims expire at seven days unless linked to a draft PR", () => {
  const expired = { author: "other", number: 1, claimedAt: "2026-11-08T00:00:00Z", linkedDraftPr: false };
  assert.deepEqual(activeClaims([expired], now), []);
  assert.equal(activeClaims([{ ...expired, linkedDraftPr: true }], now).length, 1);
  const actions = decideCommentCommand(context({ claims: [expired] }));
  assert.deepEqual(actions[0], { type: "unassign", author: "other" });
  assert.ok(actions.some((action) => action.type === "assign"));
  assert.ok(refusal(context({ claims: [{ ...expired, linkedDraftPr: true }] })));
  assert.throws(() => activeClaims([{ ...expired, claimedAt: "bad" }], now));
  assert.throws(() => activeClaims([], new Date("bad")));
});
test("claim limits follow all four tier open-PR limits and case-insensitive owners", () => {
  for (const [tier, count] of [
    [0, 2],
    [1, 5],
    [2, 10],
    [3, 20],
  ] as const) {
    const claims = Array.from({ length: count }, (_, i) => ({
      author: "TESTER",
      number: i + 2,
      claimedAt: now.toISOString(),
      linkedDraftPr: false,
    }));
    assert.equal(refusal(context({ authorTier: tier, claims })), tier !== 3);
  }
  assert.ok(
    refusal(context({ claims: [{ author: "tester", number: 1, claimedAt: now.toISOString(), linkedDraftPr: false }] })),
  );
  assert.ok(refusal(context({ target: { kind: "issue", number: 1, state: "closed", author: "tester" } })));
});
test("unclaim requires claimant or maintainer; bench-lite is tier checked", () => {
  const claims = [{ author: "other", number: 1, claimedAt: now.toISOString(), linkedDraftPr: false }];
  assert.ok(refusal(context({ comment: "/unclaim", claims })));
  assert.deepEqual(decideCommentCommand(context({ comment: "/unclaim", claims, authorTier: 3 })), [
    { type: "unassign", author: "other" },
    { type: "label-remove", label: "claimed" },
  ]);
  const target = { kind: "pr" as const, number: 1, state: "open" as const, author: "tester" };
  for (const tier of [0, 1, 2, 3] as const)
    assert.equal(refusal(context({ comment: "/bench-lite", authorTier: tier, target })), tier < 2);
});
test("appeals reopen once per closure and only by the PR owner", () => {
  const target = { kind: "pr" as const, number: 1, state: "closed" as const, author: "tester", closedByRule: "6" };
  const input = context({ comment: "/appeal deterministic check was wrong", target });
  assert.deepEqual(decideCommentCommand(input).slice(0, 2), [
    { type: "reopen", rule: "6" },
    { type: "label-add", label: "needs-human" },
  ]);
  assert.match(JSON.stringify(decideCommentCommand(input)), /Appeal of rule 6 from @tester/);
  assert.ok(refusal({ ...input, target: { ...target, appealed: true } }));
  assert.ok(refusal({ ...input, author: "someone-else" }));
});
test("appeals apply only to bot closures and never to rule 5", () => {
  const target = { kind: "pr" as const, number: 1, state: "closed" as const, author: "tester" };
  const input = context({ comment: "/appeal please review", target });
  // A manual closure (no bot rule) and an unknown rule id are refused.
  assert.ok(refusal(input));
  assert.ok(refusal({ ...input, target: { ...target, closedByRule: "9" } }));
  assert.ok(refusal({ ...input, target: { ...target, closedByRule: "5" } }));
  for (const rule of ["1", "2", "3", "4", "6", "7"])
    assert.equal(refusal({ ...input, target: { ...target, closedByRule: rule } }), false, rule);
  assert.ok(refusal({ ...input, target: { ...target, state: "open", closedByRule: "6" } }));
});

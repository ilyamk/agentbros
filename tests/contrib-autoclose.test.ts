import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLOSURE_LABEL, autoclose, type PrSnapshot } from "../src/lib/contrib/autoclose";
const now = new Date("2026-11-15T00:00:00Z");
const clean: PrSnapshot = {
  cla: true,
  authorTier: 0,
  openPrCount: 1,
  newestPr: true,
  protectedPaths: [],
  labels: [],
  mediaBinary: false,
  leakHit: false,
  hasPrBlock: true,
  hasChangeEntry: true,
  size: "S",
  approvedProposal: false,
};
const cases: Partial<PrSnapshot>[] = [
  { cla: false, claReminderAt: "2026-11-08T00:00:00Z" },
  { openPrCount: 3 },
  { duplicate: { open: true, sameChangedFiles: true, identicalAddedLines: 0.9 } },
  { protectedPaths: ["AGENTS.md"], protectedReminderAt: "2026-11-08T00:00:00Z" },
  { mediaBinary: true },
  { hasChangeEntry: false, structureReminderAt: "2026-11-08T00:00:00Z" },
  { size: "L" },
];
for (const [i, state] of cases.entries())
  test(`deterministic closing rule ${i + 1}`, () => {
    const result = autoclose({ ...clean, ...state }, now);
    assert.equal(result.close, true);
    assert.equal(result.rule, String(i + 1));
    assert.match(result.message, i + 1 === 5 ? /cannot be appealed/ : /\/appeal/);
    assert.equal(result.label, CLOSURE_LABEL[String(i + 1) as keyof typeof CLOSURE_LABEL]);
  });
test("closure labels: only duplicates and media/leak hits are slop; procedural rules are process closures", () => {
  assert.deepEqual(CLOSURE_LABEL, {
    "1": "closed:process",
    "2": "closed:process",
    "3": "closed:slop",
    "4": "closed:process",
    "5": "closed:slop",
    "6": "closed:process",
    "7": "closed:process",
  });
  const labels = (JSON.parse(readFileSync(".github/labels.json", "utf8")) as { name: string }[]).map(
    (label) => label.name,
  );
  for (const label of new Set(Object.values(CLOSURE_LABEL))) assert.ok(labels.includes(label), label);
});
test("an appeal exempts only the rule that closed the PR, never rule 5", () => {
  for (const [i, state] of cases.entries()) {
    const rule = String(i + 1);
    const result = autoclose({ ...clean, ...state, appealedRule: rule }, now);
    assert.equal(result.close, rule === "5", `rule ${rule}`);
    // Another rule still closes an appealed PR.
    assert.equal(autoclose({ ...clean, ...state, appealedRule: rule === "7" ? "1" : "7" }, now).rule, rule);
  }
  // A media hit behind an exempted earlier rule is still reached.
  const duplicate = { duplicate: { open: true, sameChangedFiles: true, identicalAddedLines: 1 } };
  assert.equal(autoclose({ ...clean, ...duplicate, mediaBinary: true, appealedRule: "3" }, now).rule, "5");
  // An unreadable appeal record exempts every rule except 5.
  assert.equal(autoclose({ ...clean, ...duplicate, appealedRule: "unknown" }, now).close, false);
  assert.equal(autoclose({ ...clean, leakHit: true, appealedRule: "unknown" }, now).rule, "5");
  // The appealed rule's reminder is not posted again.
  assert.equal(autoclose({ ...clean, hasPrBlock: false, appealedRule: "6" }, now).rule, null);
});
test("reminders, timer boundaries, duplicate boundaries and explicit approvals", () => {
  assert.equal(autoclose(clean, now).close, false);
  assert.equal(autoclose({ ...clean, cla: false }, now).reminder, true);
  assert.equal(autoclose({ ...clean, hasPrBlock: false }, now).reminder, true);
  assert.equal(autoclose({ ...clean, cla: false, claReminderAt: "2026-11-08T00:00:00.001Z" }, now).close, false);
  assert.equal(autoclose({ ...clean, hasPrBlock: false, structureReminderAt: "2026-11-08T00:00:00Z" }, now).rule, "6");
  assert.equal(autoclose({ ...clean, leakHit: true }, now).rule, "5");
  for (const state of [
    { openPrCount: 3, newestPr: false },
    { authorTier: 3 as const, openPrCount: 100 },
    { size: "L" as const, approvedProposal: true },
    { protectedPaths: ["package.json"], labels: ["design-approved"] },
    { duplicate: { open: true, sameChangedFiles: true, identicalAddedLines: 0.8999 } },
    { duplicate: { open: false, sameChangedFiles: true, identicalAddedLines: 1 } },
    { duplicate: { open: true, sameChangedFiles: false, identicalAddedLines: 1 } },
  ])
    assert.equal(autoclose({ ...clean, ...state }, now).close, false);
  assert.throws(() => autoclose(clean, new Date("invalid")));
  assert.throws(() => autoclose({ ...clean, cla: false, claReminderAt: "invalid" }, now));
});
test("protected paths get a seven-day reminder; each timed rule posts its own reminder", () => {
  const fresh = autoclose({ ...clean, protectedPaths: ["package.json"] }, now);
  assert.equal(fresh.close, false);
  assert.equal(fresh.rule, "4");
  assert.equal(fresh.reminder, true);
  assert.equal(
    autoclose({ ...clean, protectedPaths: ["package.json"], protectedReminderAt: "2026-11-08T00:00:00.001Z" }, now)
      .close,
    false,
  );
  // An unsigned CLA no longer hides the protected-path and structure reminders.
  const both = { ...clean, cla: false, protectedPaths: ["package.json"], hasPrBlock: false };
  assert.equal(autoclose(both, now).rule, "1");
  assert.equal(autoclose({ ...both, claReminderAt: "2026-11-14T00:00:00Z" }, now).rule, "4");
  const last = autoclose(
    { ...both, claReminderAt: "2026-11-14T00:00:00Z", protectedReminderAt: "2026-11-14T00:00:00Z" },
    now,
  );
  assert.equal(last.rule, "6");
  assert.equal(last.reminder, true);
  assert.equal(
    autoclose(
      {
        ...both,
        claReminderAt: "2026-11-14T00:00:00Z",
        protectedReminderAt: "2026-11-14T00:00:00Z",
        structureReminderAt: "2026-11-14T00:00:00Z",
      },
      now,
    ).reminder,
    false,
  );
});
test("tier 3 maintainer PRs are never closed or reminded", () => {
  for (const state of cases) {
    const result = autoclose({ ...clean, ...state, authorTier: 3 }, now);
    assert.equal(result.close, false);
    assert.equal(result.reminder, undefined);
  }
});

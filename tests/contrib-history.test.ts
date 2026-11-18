import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { historySummary } from "../src/lib/contrib/history";
import { computeTier } from "../src/lib/contrib/tiers";
import { TrustOverridesSchema } from "../src/types/contrib-tools";

const now = new Date("2026-11-15T00:00:00Z");
const pr = (patch: Record<string, unknown> = {}) => ({
  state: "closed",
  merged_at: null,
  closed_at: "2026-11-10T00:00:00Z",
  labels: [],
  ...patch,
});
test("GitHub history distinguishes merges, open PRs and slop closures, with a bounded window", () => {
  const history = historySummary(
    [
      ...Array.from({ length: 3 }, () => pr({ merged_at: "2026-11-01T00:00:00Z" })),
      pr(),
      pr({ state: "open", closed_at: null, labels: ["closed:slop"] }),
      pr({ labels: [{ name: "closed:slop" }] }),
      pr({ labels: ["closed:slop"], closed_at: "2026-10-15T00:00:00Z" }),
      pr({ labels: ["closed:slop"], closed_at: "2026-11-16T00:00:00Z" }),
    ],
    now,
  );
  // Future-dated closures are ignored by both windows.
  assert.deepEqual(history, { merged: 3, closedAsSlop: 2, slopClosuresLast30Days: 1 });
  assert.equal(computeTier(history), 0);
  assert.throws(() => historySummary([pr({ closed_at: "yesterday" })], now));
  assert.throws(() => historySummary([], new Date("bad")));
});
test("only closed:slop within 90 days counts; closed:process never affects the tier", () => {
  const merged = Array.from({ length: 3 }, () => pr({ merged_at: "2026-11-01T00:00:00Z" }));
  const process = Array.from({ length: 5 }, () => pr({ labels: ["closed:process"] }));
  assert.deepEqual(historySummary([...merged, ...process], now), {
    merged: 3,
    closedAsSlop: 0,
    slopClosuresLast30Days: 0,
  });
  assert.equal(computeTier(historySummary([...merged, ...process], now)), 1);
  const old = pr({ labels: ["closed:slop"], closed_at: "2026-08-17T00:00:00Z" });
  const edge = pr({ labels: ["closed:slop"], closed_at: "2026-08-17T00:00:00.001Z" });
  assert.equal(historySummary([old], now).closedAsSlop, 0);
  assert.equal(historySummary([edge], now).closedAsSlop, 1);
  // An old slop closure no longer holds back tier 1; a recent one still does.
  assert.equal(computeTier(historySummary([...merged, old], now)), 1);
  assert.equal(computeTier(historySummary([...merged, edge], now)), 0);
  // Two slop closures in 30 days still drop a tier.
  const recent = Array.from({ length: 2 }, () => pr({ labels: ["closed:slop"] }));
  const many = Array.from({ length: 20 }, () => pr({ merged_at: "2026-11-01T00:00:00Z" }));
  assert.equal(historySummary([...many, ...recent], now).slopClosuresLast30Days, 2);
  assert.equal(computeTier(historySummary([...many, ...recent], now)), 0);
});
test("trust grants are explicit, case insensitive, expire and feed the existing tier computation", () => {
  const overrides = {
    version: 1,
    overrides: [{ handle: "Tester", tier: 2, reason: "Maintainer grant", until: "2026-12-01T00:00:00Z" }],
  };
  const prs = Array.from({ length: 10 }, () => pr({ merged_at: "2026-11-01T00:00:00Z" }));
  assert.equal(computeTier(historySummary(prs, now, overrides, "tester")), 2);
  assert.equal(historySummary(prs, new Date("2026-12-01T00:00:00Z"), overrides, "tester").grant, undefined);
  assert.equal(historySummary(prs, now, overrides, "another").grant, undefined);
  assert.throws(() =>
    TrustOverridesSchema.parse({
      ...overrides,
      overrides: [...overrides.overrides, { handle: "tester", tier: 3, reason: "Duplicate" }],
    }),
  );
  assert.throws(() => TrustOverridesSchema.parse({ version: 1, overrides: [{ handle: "a", tier: 4, reason: "" }] }));
  // The shipped file grants only the sole maintainer tier 3, without expiry.
  const shipped = TrustOverridesSchema.parse(JSON.parse(readFileSync(".github/trust.json", "utf8")));
  assert.deepEqual(
    shipped.overrides.map(({ handle, tier, until }) => ({ handle, tier, until })),
    [{ handle: "ilyamk", tier: 3, until: undefined }],
  );
  assert.equal(computeTier(historySummary([], now, shipped, "ilyamk")), 3);
});

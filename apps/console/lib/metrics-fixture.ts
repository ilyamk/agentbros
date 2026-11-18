/**
 * Fixture mode's metrics (`?fixture=…`, then `#/metrics`): a plausible month of the fixture projects, parsed through
 * the metrics schema so it cannot drift from the server's reply. Times are relative to the fixtures' frozen clock.
 */
import { ConsoleMetricsSchema, type ConsoleMetrics } from "../../../src/lib/console/metrics-schema";
import { fixtureNow } from "./fixtures";

const MIN = 60_000;

export function fixtureMetrics(): ConsoleMetrics {
  return ConsoleMetricsSchema.parse({
    v: 1,
    generatedAt: new Date(fixtureNow()).toISOString(),
    revision: 14,
    truncated: false,
    decisions: {
      decided: 23,
      console: 18,
      cli: 5,
      consoleShare: 18 / 23,
      refused: 2,
      timeToDecision: { count: 18, medianMs: 6 * MIN, p90Ms: 41 * MIN },
      waiting: { count: 2, oldestMs: 64 * MIN, medianMs: 5 * MIN },
    },
    rework: { reopened: 4, gates: 15, rate: 4 / 15 },
    refusals: [
      { code: "PAUSED", count: 3 },
      { code: "STEP_GUARD", count: 2 },
      { code: "VALIDATION", count: 1 },
    ],
    steps: [
      {
        step: "script",
        decided: 2,
        rounds: 2,
        refused: 0,
        timeToDecision: { count: 2, medianMs: 12 * MIN, p90Ms: 18 * MIN },
        agentMs: 46 * MIN,
      },
      {
        step: "build",
        decided: 1,
        rounds: 1,
        refused: 1,
        timeToDecision: { count: 1, medianMs: 3 * MIN, p90Ms: 3 * MIN },
        agentMs: 128 * MIN,
      },
      {
        step: "4-approve",
        decided: 1,
        rounds: 1,
        refused: 0,
        timeToDecision: { count: 1, medianMs: 22 * MIN, p90Ms: 22 * MIN },
        agentMs: 0,
      },
      {
        step: "material",
        decided: 2,
        rounds: 0,
        refused: 1,
        timeToDecision: { count: 2, medianMs: 2 * MIN, p90Ms: 4 * MIN },
        agentMs: 19 * MIN,
      },
      {
        step: "look",
        decided: 1,
        rounds: 0,
        refused: 0,
        timeToDecision: { count: 1, medianMs: 9 * MIN, p90Ms: 9 * MIN },
        agentMs: 33 * MIN,
      },
    ],
    spend: {
      spentUsd: 7.84,
      reservedUsd: 1.4,
      unknownPriced: 1,
      unreadable: 1,
      months: [
        { month: "2026-11", spentUsd: 5.12, unknownPriced: 1, unreadable: 1 },
        { month: "2026-10", spentUsd: 2.72, unknownPriced: 0, unreadable: 0 },
        { month: "2026-09", spentUsd: 0, unknownPriced: 0, unreadable: 0 },
        { month: "2026-08", spentUsd: 0, unknownPriced: 0, unreadable: 0 },
        { month: "2026-07", spentUsd: 0, unknownPriced: 0, unreadable: 0 },
        { month: "2026-06", spentUsd: 0, unknownPriced: 0, unreadable: 0 },
      ],
    },
    agents: {
      runs: 31,
      totalMs: 226 * MIN,
      byAgent: [
        { name: "motion-engineer", runs: 6, totalMs: 128 * MIN },
        { name: "script-writer", runs: 9, totalMs: 46 * MIN },
        { name: "design-director", runs: 4, totalMs: 33 * MIN },
        { name: "footage-editor", runs: 12, totalMs: 19 * MIN },
      ],
    },
    verdicts: { delivered: 2, withVerdict: 1, byPlaybook: [{ playbook: "promo", count: 1, meanScore: 8 }] },
    projects: [
      {
        project: "promo-acme",
        route: "film",
        playbook: "promo",
        decided: 17,
        waiting: 1,
        refused: 1,
        spentUsd: 7.42,
        reservedUsd: 1.4,
        unknownPriced: 1,
        spendUnreadable: false,
        ceilingUsd: 10,
        truncated: false,
      },
      {
        project: "talk-recut",
        route: "footage",
        playbook: "talk-recut",
        decided: 6,
        waiting: 1,
        refused: 1,
        spentUsd: 0.42,
        reservedUsd: 0,
        unknownPriced: 0,
        spendUnreadable: true,
        ceilingUsd: 2,
        truncated: false,
      },
    ],
  });
}

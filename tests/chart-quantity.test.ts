import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LeftPanelSchema, ProjectConfigSchema } from "../src/types/video";
import { ChartQuantitySchema } from "../src/types/chart-quantity";
import { resolveChart, type ChartPanel } from "../src/lib/chart-domain";
import { checkChartQuantities, formatChartPercent, sameChartQuantity } from "../src/lib/chart-quantity";
const quantity = {
  kind: "return-percent-v1" as const,
  unit: "%" as const,
  subjectId: "dca",
  basisId: "nominal",
  methodId: "buy-hold",
  period: { start: "2015-01-01", end: "2025-01-01" },
};
const population = {
  ...quantity,
  kind: "population-outperformed-percent-v1" as const,
  cohortId: "trader-cohort",
  comparatorId: "dca-vs-traders",
};
const panel = (overrides = {}): ChartPanel =>
  LeftPanelSchema.parse({
    kind: "chart",
    yUnit: "%",
    quantity,
    data: [{ value: 8 }, { value: 96 }],
    callout: {
      value: "+96%",
      binding: { version: 1, kind: "point-value-label-v1", expectedQuantity: quantity, formatter: "signed-percent-v1" },
    },
    ...overrides,
  }) as ChartPanel;
const errors = (p: ChartPanel) => checkChartQuantities(p).filter((f) => f.severity === "error");
test("closed quantity identities reject unknown metrics, approval fields, invalid calendar/period and omitted population identity", () => {
  assert.equal(ChartQuantitySchema.safeParse(quantity).success, true);
  for (const q of [
    { ...quantity, kind: "percentile-v1" },
    { ...quantity, approved: true },
    { ...quantity, period: { start: "2025-02-30", end: "2025-03-01" } },
    { ...quantity, period: { start: "2026-01-01", end: "2025-01-01" } },
    { ...quantity, kind: population.kind },
  ])
    assert.equal(ChartQuantitySchema.safeParse(q).success, false);
});
test("same 95 percentage does not make return equal population share; exact cohort/method/period/subject matter", () => {
  assert.equal(sameChartQuantity(quantity, population), false);
  for (const q of [
    { ...population, cohortId: "other" },
    { ...population, methodId: "other" },
    { ...population, comparatorId: "other" },
    { ...population, subjectId: "other" },
    { ...population, basisId: "other" },
    { ...population, period: { ...population.period, end: "2024-01-01" } },
  ])
    assert.equal(sameChartQuantity(population, q), false);
  assert.equal(sameChartQuantity(quantity, { ...quantity, subjectId: "other" }, false), true);
  assert.ok(
    errors(
      panel({
        callout: {
          value: "+96%",
          binding: {
            version: 1,
            kind: "point-value-label-v1",
            expectedQuantity: population,
            formatter: "signed-percent-v1",
          },
        },
      }),
    ).length,
  );
});
test("actual hero series and default last point, precedence and explicit anchor drive exact numeric callout", () => {
  const p = panel({
    series: [
      { label: "not hero", isHero: false, quantity: { ...quantity, subjectId: "other" }, data: [{ value: 25 }] },
      { label: "hero", isHero: true, quantity, data: [{ value: 96 }] },
    ],
  });
  assert.equal(resolveChart(p).heroIndex, 1);
  assert.equal(resolveChart(p).calloutTarget?.value, 96);
  assert.deepEqual(errors(p), []);
  assert.deepEqual(errors(panel({ series: [] })), []);
  assert.deepEqual(errors(panel({ callout: { ...p.callout, anchorIndex: 0, value: "+8%" } })), []);
  assert.ok(
    errors(panel({ callout: { ...p.callout, value: "+95%" } })).some((f) => f.path.join(".") === "callout.value"),
  );
  for (const anchorIndex of [-1, 2])
    assert.ok(
      errors(panel({ callout: { ...p.callout, anchorIndex } })).some((f) => f.code === "CHART_CALLOUT_TARGET_INVALID"),
    );
});
test("shared axis rejects mixed quantity and missing identities; population range only applies to population declarations", () => {
  for (const q of [undefined, population, { ...quantity, methodId: "different" }])
    assert.ok(
      errors(
        panel({
          series: [
            { label: "a", quantity, data: [{ value: 96 }] },
            { label: "b", quantity: q, data: [{ value: 25 }] },
          ],
        }),
      ).length,
    );
  assert.ok(errors(panel({ yUnit: "$" })).length);
  assert.deepEqual(errors(panel({ data: [{ value: -120 }, { value: 2500 }], callout: undefined })), []);
  for (const value of [-1, 101])
    assert.ok(errors(panel({ quantity: population, data: [{ value }], callout: undefined })).length);
});
test("formatter is deterministic without rounding; malformed format fields rejected", () => {
  assert.equal(formatChartPercent(-0, "signed-percent-v1"), "0%");
  assert.equal(formatChartPercent(-2.25, "signed-percent-v1"), "-2.25%");
  assert.equal(formatChartPercent(2.25, "signed-percent-v1"), "+2.25%");
  assert.throws(() => formatChartPercent(Infinity, "percent-v1"), /Finite/);
  assert.equal(
    LeftPanelSchema.safeParse({
      ...panel(),
      callout: {
        ...panel().callout,
        binding: { ...panel().callout!.binding, formatter: "expression", expression: "value*2" },
      },
    }).success,
    false,
  );
});
test("legacy BTC callout95 against96 remains informational and every existing project parses without byte changes", () => {
  const directory = path.resolve("public/projects");
  for (const id of readdirSync(directory)) {
    const file = path.join(directory, id, "project.json");
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    const project = ProjectConfigSchema.parse(JSON.parse(bytes.toString()));
    for (const scene of project.scenes)
      if (scene.leftPanel?.kind === "chart") {
        assert.deepEqual(errors(scene.leftPanel), []);
        assert.ok(checkChartQuantities(scene.leftPanel).some((f) => f.code === "CHART_QUANTITY_REVIEW_REQUIRED"));
      }
    assert.deepEqual(readFileSync(file), bytes);
  }
  const legacy = panel({ quantity: undefined, callout: { value: "+95%" } });
  assert.equal(resolveChart(legacy).calloutTarget?.value, 96);
  assert.deepEqual(errors(legacy), []);
});

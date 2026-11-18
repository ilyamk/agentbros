import { chartProofEntrySource, assertChartProofEntrySyntax } from "./helpers/chart-domain-proof";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { LeftPanelSchema, ProjectConfigSchema } from "../src/types/video";
import { StoryboardSceneSchema } from "../src/types/pipeline";
import { checkChartDomains, resolveChart, type ChartPanel } from "../src/lib/chart-domain";
const point = (year: number, value = 35) => ({
  label: String(year),
  value,
  domain: { kind: "year-v1" as const, year },
});
const panel = (changes: Partial<ChartPanel> = {}): ChartPanel =>
  LeftPanelSchema.parse({
    kind: "chart",
    data: [point(2019), point(2020)],
    annotations: [
      {
        dataIndex: 0,
        text: "2019",
        binding: { version: 1, kind: "domain-label-v1", expectedDomain: { kind: "year-v1", year: 2019 } },
      },
    ],
    ...changes,
  }) as ChartPanel;
const errors = (chart: ChartPanel) => checkChartDomains(chart).filter((f) => f.severity === "error");
test("explicit matching year target, visible axis and canonical annotation succeed without human truth claim", () => {
  assert.deepEqual(checkChartDomains(panel()), []);
  assert.deepEqual(resolveChart(panel()).axisLabels, ["2019", "2020"]);
});
test("explicit 2020 on 2019 fails; claimed2019 metadata cannot hide visible March20 or overridden2020 axis", () => {
  const wrong = panel();
  wrong.annotations![0].binding!.expectedDomain.year = 2020;
  wrong.annotations![0].text = "2020";
  assert.ok(errors(wrong).some((f) => f.path.join(".") === "annotations.0.binding.expectedDomain"));
  const march = panel();
  march.annotations![0].text = "Март ’20";
  assert.ok(errors(march).some((f) => f.path.join(".") === "annotations.0.text"));
  assert.ok(errors(panel({ axisLabels: ["2020", "2020"] })).some((f) => f.path.join(".") === "axisLabels.0"));
  const mislabeled = panel();
  mislabeled.data![0].label = "March20";
  assert.ok(errors(mislabeled).some((f) => f.path.join(".") === "data.0.label"));
});
test("annotation defaults to series0 independently of hero; nonempty series takes precedence and empty series falls back", () => {
  const chart = panel({
    series: [
      { label: "other", isHero: false, data: [point(2019)] },
      { label: "hero", isHero: true, data: [point(2019)] },
    ],
    data: [point(2020)],
  });
  const resolved = resolveChart(chart, "#123456");
  assert.equal(resolved.source, "series");
  assert.equal(resolved.heroIndex, 1);
  assert.equal(resolved.annotations[0].targetSeries, resolved.series[0]);
  assert.equal(resolved.annotations[0].targetPoint!.domain!.year, 2019);
  assert.equal(resolved.series[1].color, "#123456");
  assert.equal(resolved.series[0].color, chart.color);
  assert.deepEqual(errors(chart), []);
  assert.equal(resolveChart(panel({ series: [] })).source, "data");
});
test("legacy hero axis labels and explicit per-index overrides resolve exactly without enforcing year guesses", () => {
  const chart = LeftPanelSchema.parse({
    kind: "chart",
    series: [
      { label: "a", isHero: false, data: [{ label: "first", value: 1 }] },
      {
        label: "b",
        isHero: true,
        data: [
          { label: "hero", value: 2 },
          { label: "second", value: 3 },
        ],
      },
    ],
    axisLabels: ["override"],
    annotations: [{ dataIndex: 0, text: "Launch 2020 product" }],
  }) as ChartPanel;
  const resolved = resolveChart(chart);
  assert.deepEqual(resolved.axisLabels, ["override", "second"]);
  assert.equal(checkChartDomains(chart)[0].code, "CHART_SEMANTICS_REVIEW_REQUIRED");
  assert.deepEqual(errors(chart), []);
  const positional = LeftPanelSchema.parse({ kind: "chart", data: [{ value: 10 }] }) as ChartPanel;
  assert.deepEqual(resolveChart(positional).axisLabels, ["1"]);
});
test("negative/out-of-range series and data indices identify deterministic structural errors, including no series", () => {
  for (const [seriesIndex, dataIndex] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 2],
    [0, 100],
  ]) {
    const chart = panel();
    chart.annotations = [{ seriesIndex, dataIndex, text: "freeform" }];
    assert.deepEqual(
      checkChartDomains(chart)
        .filter((f) => f.code === "CHART_ANNOTATION_TARGET_INVALID")
        .map((f) => [f.severity, f.path]),
      [["error", ["annotations", 0]]],
    );
  }
  const empty = panel({ data: [] });
  assert.ok(checkChartDomains(empty).some((f) => f.code === "CHART_ANNOTATION_TARGET_INVALID"));
});
test("typed shared axes reject unequal lengths, mixed missing domains, contradictory years and extra axis labels", () => {
  for (const series of [
    [
      { label: "one", data: [point(2019), point(2020)] },
      { label: "two", data: [point(2019)] },
    ],
    [
      { label: "one", data: [point(2019)] },
      { label: "two", data: [{ label: "2019", value: 12 }] },
    ],
    [
      { label: "one", data: [point(2019)] },
      { label: "two", data: [point(2020)] },
    ],
  ])
    assert.ok(errors(panel({ series })).length > 0);
  assert.ok(errors(panel({ axisLabels: ["2019", "2020", "2021"] })).some((f) => f.path.join(".") === "axisLabels"));
  const implicit = panel();
  delete implicit.data![0].domain;
  assert.ok(errors(implicit).some((f) => f.path.join(".") === "annotations.0.binding.expectedDomain"));
});
test("year domain schema rejects unsupported/date kinds, fractional/out-of-bound years and unknown binding fields", () => {
  for (const domain of [
    { kind: "date-v1", year: 2019 },
    { kind: "year-v1", year: 2019.5 },
    { kind: "year-v1", year: 0 },
    { kind: "year-v1", year: 10000 },
    { kind: "year-v1", year: 2019, sourceApproved: true },
  ])
    assert.throws(() => panel({ data: [{ value: 1, domain } as never] }));
  assert.throws(() =>
    panel({
      annotations: [
        {
          dataIndex: 0,
          text: "2019",
          binding: {
            version: 1,
            kind: "domain-label-v1",
            expectedDomain: { kind: "year-v1", year: 2019 },
            approved: true,
          } as never,
        },
      ],
    }),
  );
});
test("existing project configs parse read-only; untyped/freeform charts have no inferred date-domain errors", () => {
  for (const entry of readdirSync("tests/fixtures/legacy", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(`tests/fixtures/legacy/${entry.name}/project.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = ProjectConfigSchema.parse(JSON.parse(bytes.toString()));
    for (const scene of parsed.scenes)
      if (scene.leftPanel?.kind === "chart")
        assert.equal(
          errors(scene.leftPanel).filter((f) => f.code === "CHART_DOMAIN_BINDING_MISMATCH").length,
          0,
          entry.name,
        );
    assert.deepEqual(readFileSync(`tests/fixtures/legacy/${entry.name}/project.json`), bytes);
  }
});
test("daily-practice repair retains actual2019/value35, illustrative series/callout and spoken claim; duplicate legacy annotation removed", () => {
  const raw = JSON.parse(readFileSync("tests/fixtures/legacy/daily-practice/project.json", "utf8"));
  const scene = raw.scenes.find((s: { leftPanel?: { kind: string } }) => s.leftPanel?.kind === "chart");
  assert.deepEqual(scene.leftPanel.series[0].data[2], { label: "2019", value: 35 });
  assert.equal(scene.leftPanel.callout.value, "+95%");
  assert.deepEqual(scene.leftPanel.annotations, []);
  assert.ok(scene.text.includes("девяносто пять процентов остальных"));
  assert.equal(scene.durationInFrames, 192);
  assert.ok(!readFileSync("src/Root.tsx", "utf8").includes("Март ’20"));
  const authored = StoryboardSceneSchema.parse(
    JSON.parse(readFileSync("tests/fixtures/legacy/daily-practice/pipeline/storyboard.json", "utf8")).scenes.find(
      (s: { id: string }) => s.id === "s03-proof",
    ),
  );
  assert.equal(authored.leftPanel?.kind, "chart");
  if (authored.leftPanel?.kind !== "chart") throw Error("Expected authored proof chart");
  assert.deepEqual(authored.leftPanel.annotations, [], "Composer must not restore the unsupported authored annotation");
  assert.deepEqual(authored.leftPanel.series![0]!.data[2], { label: "2019", value: 35 });
});

test("additive year/binding fields survive reused storyboard and project schemas", () => {
  const chart = panel();
  const scene = StoryboardSceneSchema.parse({
    id: "proof",
    beatId: "proof",
    voiceoverText: "Illustrative graphic only.",
    durationSec: 4,
    musicIntensity: "low",
    leftPanel: chart,
  });
  assert.deepEqual(scene.leftPanel, chart);
  const project = ProjectConfigSchema.parse({
    name: "Typed chart test",
    productName: "Technical fixture",
    colors: { accent: "#ffffff", background: "#000000", text: "#ffffff" },
    scenes: [{ id: "proof", text: "Illustrative", visualType: "title", durationInFrames: 120, leftPanel: chart }],
  });
  assert.deepEqual(project.scenes[0].leftPanel, chart);
});

test("absence of typed domain/binding remains explicitly unverified, including no annotations and empty data", () => {
  for (const raw of [
    { kind: "chart", data: [{ label: "2019", value: 35 }] },
    { kind: "chart", data: [] },
    { kind: "chart" },
  ]) {
    const legacy = LeftPanelSchema.parse(raw) as ChartPanel;
    const findings = checkChartDomains(legacy);
    assert.ok(
      findings.some(
        (f) => f.code === "CHART_SEMANTICS_REVIEW_REQUIRED" && f.severity === "info" && f.path.length === 0,
      ),
    );
    assert.deepEqual(errors(legacy), []);
    assert.equal(resolveChart(legacy).series.length, legacy.data?.length ? 1 : 0);
  }
  assert.deepEqual(checkChartDomains(panel()), [], "Explicit consistency is checked without asserting factual truth");
});

test("exact generated browser proof entry compiles as TSX before resource allocation", () => {
  for (const duration of [1, 450]) {
    const source = chartProofEntrySource("/absolute/local code root", duration);
    assert.doesNotThrow(() => assertChartProofEntrySyntax(source));
    const malformed = source.replace(`durationInFrames={${duration}}`, `durationInFrames=${duration}`);
    assert.throws(() => assertChartProofEntrySyntax(malformed), /Expected.*\{/);
  }
  assert.throws(() => chartProofEntrySource("/root", 0), /Positive integer/);
});

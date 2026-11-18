import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutTerminalLabels } from "../src/templates/leftpanel/chart-label-layout";
import { resolveChart } from "../src/lib/chart-domain";
const bounds = { left: 108, right: 1184, top: 108, bottom: 682 };
const measure = (text: string) => [...text].reduce((sum, char) => sum + (char === "W" ? 13 : char === " " ? 4 : 8), 0);
function verify(labels: ReturnType<typeof layoutTerminalLabels>) {
  for (const [i, box] of labels.entries()) {
    assert.equal(box.lines.join(""), box.text);
    assert.ok(box.left >= bounds.left);
    assert.ok(box.left + box.width <= bounds.right);
    assert.ok(box.top >= bounds.top);
    assert.ok(box.top + box.height <= bounds.bottom);
    assert.ok(box.lines.every((line) => measure(line) <= box.width - 12));
    if (i) assert.ok(box.top >= labels[i - 1].top + labels[i - 1].height + 8);
  }
}
test("actual BTC label remains complete left of right edge with source endpoint preserved", () => {
  const labels = layoutTerminalLabels(
    [{ seriesIndex: 1, text: "Активные трейдеры", x: 1120, y: 576 }],
    measure,
    bounds,
  );
  verify(labels);
  assert.equal(labels[0].x, 1120);
  assert.equal(labels[0].y, 576);
  assert.ok(labels[0].left + labels[0].width <= 1108);
});
test("long English/Russian words wrap without truncation, shrinking or character loss", () => {
  const inputs = [
    "Long English comparison label with meaningful spaces and terminal value",
    "Очень длинная русская подпись сравнительного ряда без сокращений",
    "СверхдлинноенеразделённоесловодляпроверкиразбивкиWWWWWWWWWW",
  ];
  for (const [i, text] of inputs.entries()) {
    const labels = layoutTerminalLabels([{ seriesIndex: i, text, x: 1120, y: 390 }], measure, bounds);
    verify(labels);
    assert.ok(labels[0].lines.length > 1);
    assert.ok(labels[0].width <= 280);
  }
});
test("clustered terminal points distribute deterministic distinct complete boxes, stable series association", () => {
  const input = Array.from({ length: 9 }, (_, seriesIndex) => ({
    seriesIndex,
    text: "Series " + seriesIndex,
    x: 1120,
    y: seriesIndex % 2 ? 679 : 678,
  }));
  const original = structuredClone(input),
    labels = layoutTerminalLabels(input, measure, bounds);
  verify(labels);
  assert.deepEqual(input, original);
  assert.deepEqual(labels, layoutTerminalLabels(input, measure, bounds));
  assert.deepEqual(
    labels.map((l) => l.seriesIndex).sort((a, b) => a - b),
    input.map((i) => i.seriesIndex),
  );
});
test("single-point/left-edge and top/bottom endpoints remain bounded", () => {
  verify(
    layoutTerminalLabels(
      [
        { seriesIndex: 1, text: "left boundary", x: 100, y: 100 },
        { seriesIndex: 2, text: "right boundary", x: 1120, y: 690 },
      ],
      measure,
      bounds,
    ),
  );
});
test("impossible readable capacity and invalid measurements refuse rather than clip", () => {
  assert.throws(
    () =>
      layoutTerminalLabels(
        Array.from({ length: 24 }, (_, seriesIndex) => ({ seriesIndex, text: "label", x: 1120, y: 400 })),
        measure,
        bounds,
      ),
    /cannot fit/,
  );
  assert.throws(
    () => layoutTerminalLabels([{ seriesIndex: 1, text: "W", x: 1120, y: 400 }], () => NaN, bounds),
    /measurement/,
  );
  assert.throws(
    () => layoutTerminalLabels([{ seriesIndex: 1, text: "W", x: 1120, y: 400 }], () => 1000, bounds),
    /glyph cannot fit/,
  );
  assert.throws(
    () => layoutTerminalLabels([{ seriesIndex: 1, text: "A".repeat(2049), x: 1120, y: 400 }], measure, bounds),
    /supported layout/,
  );
});
test("legacy data-only retains same hero/axis resolution and component coregeometry/reveal", () => {
  const panel = {
    kind: "chart" as const,
    entrance: "fade" as const,
    chartType: "line" as const,
    color: "#F7931A",
    data: [
      { label: "2019", value: 10 },
      { label: "2020", value: 30 },
    ],
  };
  const resolved = resolveChart(panel);
  assert.equal(resolved.series.length, 1);
  assert.equal(resolved.series[0].isHero, true);
  assert.deepEqual(resolved.axisLabels, ["2019", "2020"]);
  assert.deepEqual(layoutTerminalLabels([], measure, bounds), []);
  const source = readFileSync("src/templates/leftpanel/AnimatedLineChart.tsx", "utf8");
  assert.match(source, /MARGIN = \{ left: 100, right: 80, top: 100, bottom: 110 \}/);
  assert.match(source, /start: 18 \+ index \* 8/);
  assert.match(source, /strokeDashoffset=\{pathLen - drawn\}/);
  assert.match(source, /data-terminal-series/);
  assert.ok(!source.includes("points[points.length - 1].x + 12"));
});

test("wrapping retains source TAB/newline and surrounding spaces exactly", () => {
  const text = "Long English\tcomparison with clustered terminal point\nand full source label  ";
  const labels = layoutTerminalLabels([{ seriesIndex: 1, text, x: 1120, y: 400 }], measure, bounds);
  verify(labels);
  assert.equal(labels[0].lines.join(""), text);
  assert.ok(labels[0].lines.join("").includes("\t"));
  assert.ok(labels[0].lines.join("").includes("\n"));
  assert.ok(labels[0].lines.join("").endsWith("  "));
});

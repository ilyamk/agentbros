import type { LeftPanel } from "../types/video";
export type ChartPanel = Extract<LeftPanel, { kind: "chart" }>;
export type ChartDomainFindingCode =
  "CHART_ANNOTATION_TARGET_INVALID" | "CHART_DOMAIN_BINDING_MISMATCH" | "CHART_SEMANTICS_REVIEW_REQUIRED";
export interface ChartDomainFinding {
  code: ChartDomainFindingCode;
  severity: "error" | "info";
  path: (string | number)[];
  message: string;
}
/** The renderer and semantic checks consume the same precedence, axis and annotation targets. */
export function resolveChart(panel: ChartPanel, mutedColor = "#B5B5B5") {
  const heroColor = panel.color ?? "#F7931A";
  const source = panel.series?.length ? ("series" as const) : ("data" as const);
  const series =
    source === "series"
      ? panel.series!.map((s, index) => ({
          ...s,
          color: s.color ?? (index === 0 ? heroColor : mutedColor),
          isHero: s.isHero ?? index === 0,
        }))
      : panel.data?.length
        ? [{ label: "", color: heroColor, isHero: true, data: panel.data, quantity: panel.quantity }]
        : [];
  const heroIndex = Math.max(
    0,
    series.findIndex((s) => s.isHero),
  );
  const heroSeries = series[heroIndex];
  const xAxisCount = series.length ? Math.max(...series.map((s) => s.data.length)) : 0;
  const axisLabels = Array.from(
    { length: xAxisCount },
    (_, index) => panel.axisLabels?.[index] ?? heroSeries?.data[index]?.label ?? String(index + 1),
  );
  const annotations = (panel.annotations ?? []).map((annotation, index) => {
    const seriesIndex = annotation.seriesIndex ?? 0;
    const targetSeries = Number.isInteger(seriesIndex) && seriesIndex >= 0 ? series[seriesIndex] : undefined;
    const targetPoint =
      Number.isInteger(annotation.dataIndex) && annotation.dataIndex >= 0
        ? targetSeries?.data[annotation.dataIndex]
        : undefined;
    return { annotation, index, seriesIndex, targetSeries, targetPoint };
  });
  const calloutIndex = panel.callout?.anchorIndex ?? (heroSeries ? heroSeries.data.length - 1 : -1);
  const calloutTarget =
    Number.isInteger(calloutIndex) && calloutIndex >= 0 ? heroSeries?.data[calloutIndex] : undefined;
  return { source, series, heroIndex, heroSeries, xAxisCount, axisLabels, annotations, calloutIndex, calloutTarget };
}
/** Checks explicit declarations, not inferred dates, factual truth, quantity meaning or human approval. */
export function checkChartDomains(panel: ChartPanel): ChartDomainFinding[] {
  const chart = resolveChart(panel),
    findings: ChartDomainFinding[] = [];
  const error = (path: (string | number)[], message: string) =>
    findings.push({ code: "CHART_DOMAIN_BINDING_MISMATCH", severity: "error", path, message });
  const pointPath = (series: number, point: number) =>
    chart.source === "series" ? ["series", series, "data", point] : ["data", point];
  const typed =
    chart.series.some((s) => s.data.some((point) => point.domain)) ||
    chart.annotations.some((a) => a.annotation.binding);
  if (!typed)
    findings.push({
      code: "CHART_SEMANTICS_REVIEW_REQUIRED",
      severity: "info",
      path: [],
      message: "Chart has no explicitly typed domain/binding; semantic meaning is unverified and requires review.",
    });
  if (typed) {
    if (panel.axisLabels && panel.axisLabels.length !== chart.xAxisCount)
      error(["axisLabels"], "Typed year domains require axisLabels cardinality to match the rendered shared axis.");
    for (const [seriesIndex, series] of chart.series.entries()) {
      if (series.data.length !== chart.xAxisCount)
        error(
          chart.source === "series" ? ["series", seriesIndex, "data"] : ["data"],
          "Typed domains require equal series lengths; independent unequal x positions cannot share one year axis.",
        );
      for (const [pointIndex, point] of series.data.entries()) {
        const location = pointPath(seriesIndex, pointIndex);
        if (!point.domain) {
          error(
            [...location, "domain"],
            "Every point on an explicitly typed shared year axis requires its own year-v1 domain.",
          );
          continue;
        }
        const canonical = String(point.domain.year);
        if (point.label !== undefined && point.label !== canonical)
          error([...location, "label"], `Point label must display canonical year ${canonical}.`);
        if (chart.axisLabels[pointIndex] !== canonical)
          error(
            panel.axisLabels?.[pointIndex] !== undefined
              ? ["axisLabels", pointIndex]
              : [...pointPath(chart.heroIndex, pointIndex), "label"],
            `Rendered shared axis label must display canonical year ${canonical}.`,
          );
        const first = chart.series[0]?.data[pointIndex]?.domain;
        if (first && first.year !== point.domain.year)
          error([...location, "domain"], "Series domains disagree at the same shared-axis position.");
      }
    }
  }
  for (const { annotation, index, targetPoint, targetSeries } of chart.annotations) {
    const location = ["annotations", index];
    if (!targetSeries || !targetPoint) {
      findings.push({
        code: "CHART_ANNOTATION_TARGET_INVALID",
        severity: "error",
        path: location,
        message: "Annotation seriesIndex/dataIndex does not identify an existing rendered point.",
      });
      continue;
    }
    if (!annotation.binding) {
      findings.push({
        code: "CHART_SEMANTICS_REVIEW_REQUIRED",
        severity: "info",
        path: location,
        message: "Freeform annotation has no explicit domain binding; semantic meaning requires review.",
      });
      continue;
    }
    const expected = annotation.binding.expectedDomain;
    if (!targetPoint.domain || targetPoint.domain.kind !== expected.kind || targetPoint.domain.year !== expected.year)
      error(
        [...location, "binding", "expectedDomain"],
        "Annotation expected year does not match the exact rendered target point domain.",
      );
    if (annotation.text !== String(expected.year))
      error([...location, "text"], `Bound domain-label annotation must display canonical year ${expected.year}.`);
  }
  return findings;
}

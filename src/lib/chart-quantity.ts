import type { ChartQuantity } from "../types/chart-quantity";
import { resolveChart, type ChartPanel } from "./chart-domain";
export type ChartQuantityFindingCode =
  | "CHART_QUANTITY_MISMATCH"
  | "CHART_QUANTITY_REVIEW_REQUIRED"
  | "CHART_CALLOUT_TARGET_INVALID"
  | "CHART_SOURCE_MISMATCH"
  | "CHART_SOURCE_REVIEW_REQUIRED";
export type ChartQuantityFinding = {
  code: ChartQuantityFindingCode;
  severity: "error" | "info";
  path: (string | number)[];
  message: string;
};
export function sameChartQuantity(a: ChartQuantity, b: ChartQuantity, includeSubject = true): boolean {
  return (
    a.kind === b.kind &&
    a.unit === b.unit &&
    (!includeSubject || a.subjectId === b.subjectId) &&
    a.basisId === b.basisId &&
    a.methodId === b.methodId &&
    a.period.start === b.period.start &&
    a.period.end === b.period.end &&
    (a.kind !== "population-outperformed-percent-v1" ||
      (b.kind === a.kind && a.cohortId === b.cohortId && a.comparatorId === b.comparatorId))
  );
}
/** Direct finite numeric value only; no rounding, NLP, expressions or unit guessing. */
export function formatChartPercent(value: number, formatter: "percent-v1" | "signed-percent-v1"): string {
  if (!Number.isFinite(value)) throw new Error("Finite numeric chart value required");
  return `${formatter === "signed-percent-v1" && value > 0 ? "+" : ""}${Object.is(value, -0) ? 0 : value}%`;
}
export function checkChartQuantities(panel: ChartPanel): ChartQuantityFinding[] {
  const chart = resolveChart(panel),
    findings: ChartQuantityFinding[] = [];
  const error = (path: (string | number)[], message: string) =>
    findings.push({ code: "CHART_QUANTITY_MISMATCH", severity: "error", path, message });
  const typed = chart.series.some((s) => s.quantity) || Boolean(panel.callout?.binding);
  if (!typed)
    findings.push({
      code: "CHART_QUANTITY_REVIEW_REQUIRED",
      severity: "info",
      path: [],
      message: "Quantity meaning is undeclared; percentage prose is not statistical support.",
    });
  if (typed) {
    if (panel.yUnit !== "%") error(["yUnit"], "Explicit percentage measurements require the rendered percent unit.");
    const shared = chart.series.find((s) => s.quantity)?.quantity;
    for (const [index, series] of chart.series.entries()) {
      const location = chart.source === "series" ? ["series", index] : [];
      if (!series.quantity) {
        error(
          [...location, "quantity"],
          "All rendered series on an explicitly typed quantity axis need a measurement identity.",
        );
        continue;
      }
      if (shared && !sameChartQuantity(shared, series.quantity, false))
        error(
          [...location, "quantity"],
          "Shared-axis measurement kinds, periods, basis, methods or population identities differ.",
        );
      for (const [pointIndex, point] of series.data.entries()) {
        if (
          !Number.isFinite(point.value) ||
          (series.quantity.kind === "population-outperformed-percent-v1" && (point.value < 0 || point.value > 100))
        )
          error(
            [...location, "data", pointIndex, "value"],
            "Value is invalid for the explicitly declared measurement.",
          );
      }
    }
  }
  if (panel.callout) {
    if (!panel.callout.binding)
      findings.push({
        code: "CHART_QUANTITY_REVIEW_REQUIRED",
        severity: "info",
        path: ["callout"],
        message: "Freeform callout is unbound; no point-value correspondence is inferred.",
      });
    else if (!chart.calloutTarget)
      findings.push({
        code: "CHART_CALLOUT_TARGET_INVALID",
        severity: "error",
        path: ["callout", "anchorIndex"],
        message: "Bound callout must target an existing actual hero-series point.",
      });
    else {
      if (
        !chart.heroSeries?.quantity ||
        !sameChartQuantity(chart.heroSeries.quantity, panel.callout.binding.expectedQuantity)
      )
        error(["callout", "binding", "expectedQuantity"], "Callout quantity differs from actual hero measurement.");
      if (panel.callout.value !== formatChartPercent(chart.calloutTarget.value, panel.callout.binding.formatter))
        error(["callout", "value"], "Bound callout text must exactly format its actual hero point value.");
    }
  }
  return findings;
}

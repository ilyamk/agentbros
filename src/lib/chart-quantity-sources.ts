import { inspectVizEvidence } from "./viz/evidence";
import { ChapterInspectionInputs } from "./longform/inspection-inputs";
import path from "node:path";
import { ChartQuantityBindingsSchema, ChartQuantitySourceSchema } from "../types/chart-quantity";
import { ProjectConfigSchema, SceneSchema, type Scene } from "../types/video";
import { workflowClaims } from "./workflows/claims";
import { readWorkflowEvidence, workflowEvidenceExists } from "./workflows/local-evidence";
import { generationInputHash } from "./jobs/runner";
import { resolveChart, type ChartPanel } from "./chart-domain";
import { checkChartQuantities, sameChartQuantity, type ChartQuantityFinding } from "./chart-quantity";
import { compileTimelineIR } from "./timeline-ir/compiler";
import { parseTimelineEditDocument } from "./timeline-ir/store";
export const chartQuantityHash = (panel: ChartPanel) => generationInputHash(JSON.parse(JSON.stringify(panel)));
/** Read-only local declaration/source correspondence. Does not authenticate sources, claims or reviewers. */
export function inspectChartQuantitySources(
  root: string,
  projectId: string,
  options: { timeline?: boolean; readonlyInspection?: ChapterInspectionInputs } = {},
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(projectId)) throw new Error("Invalid chart project ID");
  if (options.readonlyInspection && !(options.readonlyInspection instanceof ChapterInspectionInputs))
    throw Error("Invalid internal readonly quantity capture");
  const project = path.resolve(root, "public/projects", projectId),
    inputs = new Map<string, { sha256: string; maxBytes: number }>();
  const capture = (input: ReturnType<typeof readWorkflowEvidence>, maxBytes: number) => {
    const previous = inputs.get(input.path);
    if (previous && previous.sha256 !== input.sha256) throw new Error("Chart evidence changed between consumed reads");
    inputs.set(input.path, { sha256: input.sha256, maxBytes });
  };
  const read = (file: string, maxBytes = 2 * 1024 * 1024) => {
    const input = options.readonlyInspection
      ? options.readonlyInspection.read(file, project, maxBytes)
      : readWorkflowEvidence(file, project, maxBytes);
    capture(input, maxBytes);
    return input;
  };
  const config = ProjectConfigSchema.parse(JSON.parse(read(path.join(project, "project.json"), 8 * 1024 * 1024).text));
  let scenes: Scene[] = config.scenes;
  let vizConsumed: unknown = config;
  if (options.timeline) {
    const doc = parseTimelineEditDocument(
      JSON.parse(read(path.join(project, "pipeline/timeline-edit.json"), 8 * 1024 * 1024).text),
    );
    vizConsumed = doc.timeline;
    if (doc.timeline.projectId !== projectId) throw new Error("Quantity timeline belongs to another project");
    scenes = compileTimelineIR(doc.timeline)
      .tracks.filter((t) => t.kind === "visual")
      .flatMap((t) =>
        t.clips.filter((c) => c.assetId.startsWith("scene:")).map((c) => SceneSchema.parse(c.payload?.scene)),
      );
  }
  const charts = scenes.filter(
    (s): s is Scene & { leftPanel: ChartPanel } =>
      config.talkingHead?.enabled === true && s.leftPanel?.kind === "chart",
  );
  const findings: ChartQuantityFinding[] = charts.flatMap((s) =>
    checkChartQuantities(s.leftPanel).map((f) => ({ ...f, path: ["scenes", s.id, "leftPanel", ...f.path] })),
  );
  const vizReport = inspectVizEvidence(root, projectId, vizConsumed);
  findings.push(...vizReport.findings);
  const fail = (message: string, location: (string | number)[] = []) =>
    findings.push({ code: "CHART_SOURCE_MISMATCH", severity: "error", path: location, message });
  const matched = new Set<string>(),
    correspondence: {
      sceneId: string;
      chartHash: string;
      claimId: string;
      seriesIndex: number;
      dataIndex: number;
      sourceHash: string;
      recordId: string;
    }[] = [];
  const artifactFile = path.join(project, "pipeline/evidence/chart-quantity-bindings.json");
  if (options.readonlyInspection) options.readonlyInspection.absent(artifactFile, project);
  if (!options.readonlyInspection && workflowEvidenceExists(artifactFile)) {
    try {
      const artifact = ChartQuantityBindingsSchema.parse(JSON.parse(read(artifactFile).text));
      if (artifact.projectId !== projectId) throw new Error("Quantity bridge belongs to another project");
      const claims = workflowClaims(root, projectId, { capture });
      for (const [index, binding] of artifact.bindings.entries()) {
        const location = ["bindings", index],
          owners = charts.filter((c) => c.id === binding.sceneId);
        if (!owners.length || owners.some((c) => chartQuantityHash(c.leftPanel) !== binding.chartHash)) {
          fail("Binding does not identify every current active chart payload for its owning scene.", location);
          continue;
        }
        const chart = resolveChart(owners[0]!.leftPanel),
          series = chart.series[binding.seriesIndex],
          point = series?.data[binding.dataIndex];
        if (!point || !series?.quantity) {
          fail("Binding target is missing or has no explicit rendered quantity.", location);
          continue;
        }
        if (!sameChartQuantity(binding.quantity, series.quantity) || binding.value !== point.value) {
          fail("Declared claim quantity/value differs from exact rendered target.", location);
          continue;
        }
        const claim = claims.find((c) => c.id === binding.claimId && c.sceneId === binding.sceneId);
        if (
          !claim ||
          !claim.evidence.some(
            (e) =>
              e.path === binding.source.path &&
              e.sha256 === binding.source.sha256 &&
              e.excerpt === binding.source.excerpt,
          )
        ) {
          fail("Binding must reference an exact existing owning workflow claim/source entry.", location);
          continue;
        }
        const source = read(path.resolve(root, "public", binding.source.path));
        if (source.sha256 !== binding.source.sha256 || !source.text.includes(binding.source.excerpt)) {
          fail("Quantity source hash/excerpt differs from consumed bytes.", location);
          continue;
        }
        const normalized = ChartQuantitySourceSchema.parse(JSON.parse(source.text)),
          record = normalized.records.find((r) => r.id === binding.source.recordId);
        if (!record || !sameChartQuantity(record.quantity, binding.quantity) || record.value !== binding.value) {
          fail(
            "Normalized source record quantity/value does not match the authored claim/target declaration.",
            location,
          );
          continue;
        }
        matched.add(JSON.stringify([binding.sceneId, binding.chartHash, binding.seriesIndex, binding.dataIndex]));
        correspondence.push({
          sceneId: binding.sceneId,
          chartHash: binding.chartHash,
          claimId: binding.claimId,
          seriesIndex: binding.seriesIndex,
          dataIndex: binding.dataIndex,
          sourceHash: source.sha256,
          recordId: record.id,
        });
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Invalid quantity source bridge");
    }
  }
  for (const scene of charts)
    for (const [seriesIndex, series] of resolveChart(scene.leftPanel).series.entries())
      if (series.quantity) {
        for (const dataIndex of series.data.keys())
          if (!matched.has(JSON.stringify([scene.id, chartQuantityHash(scene.leftPanel), seriesIndex, dataIndex])))
            findings.push({
              code: "CHART_SOURCE_REVIEW_REQUIRED",
              severity: "info",
              path: [
                "scenes",
                scene.id,
                "leftPanel",
                ...(resolveChart(scene.leftPanel).source === "series" ? ["series", seriesIndex] : []),
                "data",
                dataIndex,
              ],
              message:
                "Explicit quantity lacks current local claim/source correspondence; inherited or omitted bridge is unverified.",
            });
      }
  // Finite read consistency, not a claim of hostile-filesystem ABA immunity.
  for (const [file, pin] of inputs)
    if (
      (options.readonlyInspection
        ? options.readonlyInspection.read(file, project, pin.maxBytes)
        : readWorkflowEvidence(file, project, pin.maxBytes)
      ).sha256 !== pin.sha256
    )
      throw new Error("Chart quantity input changed before report capture");
  options.readonlyInspection?.assertUnchanged();
  return {
    status: findings.some((f) => f.severity === "error")
      ? ("blocked" as const)
      : !charts.length && !vizReport.active.length
        ? ("not-applicable" as const)
        : findings.length
          ? ("unverified" as const)
          : ("declared-correspondence" as const),
    findings,
    correspondence,
    inputs: [...inputs].map(([file, p]) => ({
      path: path.relative(path.resolve(root), file).split(path.sep).join("/"),
      sha256: p.sha256,
    })),
    activeVisualisations: vizReport.active.map((a) => ({ sceneId: a.sceneId, revision: a.bundle.hash })),
    activeCharts: charts.map((s) => ({ sceneId: s.id, chartHash: chartQuantityHash(s.leftPanel) })),
    factualTruth: "unverified" as const,
    humanApproval: "not-inferred" as const,
  };
}

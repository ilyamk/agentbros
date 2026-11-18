import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext } from "node:test";
import { ProjectConfigSchema, LeftPanelSchema } from "../../src/types/video";
import type { ChartQuantity } from "../../src/types/chart-quantity";
import { type ChartPanel } from "../../src/lib/chart-domain";
import { chartQuantityHash } from "../../src/lib/chart-quantity-sources";
import { PIPELINE_STAGES } from "../../src/types/pipeline";
import { TimelineEditStore } from "../../src/lib/timeline-ir/store";
export const quantity = {
  kind: "return-percent-v1" as const,
  unit: "%" as const,
  subjectId: "dca",
  basisId: "nominal",
  methodId: "buy-hold",
  period: { start: "2015-01-01", end: "2025-01-01" },
};
export const population = {
  ...quantity,
  kind: "population-outperformed-percent-v1" as const,
  cohortId: "synthetic-cohort",
  comparatorId: "synthetic-comparator",
};
export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function chartRoutesFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "chart routes ")),
    project = path.join(root, "public/projects/test");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(project, "pipeline/evidence"), { recursive: true });
  const panel = LeftPanelSchema.parse({
    kind: "chart",
    yUnit: "%",
    quantity,
    data: [{ value: 95 }],
    callout: {
      value: "+95%",
      binding: { version: 1, kind: "point-value-label-v1", expectedQuantity: quantity, formatter: "signed-percent-v1" },
    },
  }) as ChartPanel;
  const scene = {
    id: "proof",
    text: "",
    visualType: "title",
    headline: "",
    durationInFrames: 30,
    presenterStartSec: 0,
    presenterEndSec: 1,
    leftPanel: panel,
  };
  const config = ProjectConfigSchema.parse({
    name: "Synthetic chart route fixture",
    formats: ["landscape"],
    productName: "test",
    colors: {},
    musicVolume: 0,
    voiceoverEnabled: false,
    talkingHead: { enabled: true, presenterVideo: "projects/test/presenter.mp4" },
    scenes: [scene],
  });
  const write = (file: string, value: unknown) => writeFileSync(path.join(project, file), JSON.stringify(value));
  write("project.json", config);
  writeFileSync(path.join(project, "presenter.mp4"), "source identity only, no video rendering");
  const source = { version: 1, records: [{ id: "synthetic", quantity, value: 95 }] };
  write("pipeline/evidence/source.json", source);
  const sourceCitation = {
    path: "projects/test/pipeline/evidence/source.json",
    sha256: digest(JSON.stringify(source)),
    excerpt: '"value":95',
  };
  write("pipeline/workflow-claims.json", {
    version: 1,
    projectId: "test",
    claims: [
      {
        id: "claim:proof",
        text: "Synthetic declared quantity only",
        sceneId: "proof",
        sourceUrls: [],
        evidence: [sourceCitation],
      },
    ],
  });
  const bridge = {
    version: 1,
    projectId: "test",
    bindings: [
      {
        sceneId: "proof",
        chartHash: chartQuantityHash(panel),
        seriesIndex: 0,
        dataIndex: 0,
        claimId: "claim:proof",
        quantity: quantity as ChartQuantity,
        value: 95,
        source: { ...sourceCitation, recordId: "synthetic" },
      },
    ],
  };
  const saveBridge = () => write("pipeline/evidence/chart-quantity-bindings.json", bridge);
  saveBridge();
  const storyboard = {
    scenes: [
      { id: "proof", beatId: "proof", voiceoverText: "", durationSec: 1, musicIntensity: "none", leftPanel: panel },
    ],
  };
  write("pipeline/storyboard.json", storyboard);
  write("pipeline/pipeline-state.json", {
    projectId: "test",
    currentStage: "brief",
    stages: Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [
        stage,
        { status: stage === "storyboard" ? "done" : "pending", attempts: stage === "storyboard" ? 1 : 0 },
      ]),
    ),
    history: [],
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
  });
  const r = (num: number) => ({ num, den: 1 });
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  const initializeTimeline = (active = scene) =>
    store.initialize({
      version: 1,
      projectId: "test",
      timebase: r(30),
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: [
            {
              id: "proof",
              assetId: "scene:proof",
              start: r(0),
              source: { start: r(0), end: r(30), timebase: r(30) },
              rate: r(1),
              transition: { kind: "cut" },
              captions: [],
              payload: { scene: active },
            },
          ],
        },
      ],
    });
  return {
    root,
    project,
    config,
    panel,
    scene,
    bridge,
    source,
    storyboard,
    write,
    saveBridge,
    store,
    initializeTimeline,
  };
}
export function projectPins(project: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (statSync(file).isDirectory()) visit(file);
      else result[path.relative(project, file)] = digest(readFileSync(file));
    }
  };
  visit(project);
  return result;
}

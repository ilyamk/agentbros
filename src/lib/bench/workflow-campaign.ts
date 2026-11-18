import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CampaignProductionPlanSchema } from "../../types/campaign-production";
import { digest, fail } from "./io";
import { observedHandoff } from "./workflow-assertions";
import type { WorkflowObserver } from "./workflow-observer";

export const CAMPAIGN_WORKFLOW_SCENARIOS = [
  "campaign-ad-experiments",
  "campaign-catalogue-videos",
  "campaign-reference-family",
  "campaign-localise-campaign",
  "campaign-content-series",
];
/** A real CLI plan-to-next handoff; no fixture approval or model invocation is needed. */
export async function contractCampaign(observer: WorkflowObserver): Promise<string> {
  const scenario = observer.scenario.id.slice("campaign-".length),
    count =
      scenario === "ad-experiments"
        ? 20
        : scenario === "catalogue-videos"
          ? 100
          : scenario === "reference-family"
            ? 5
            : scenario === "content-series"
              ? 30
              : 3;
  const write = (file: string, value: unknown) => {
    const target = path.join(observer.workspace, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  await observer.operation(
    "fixture:campaign-request",
    [],
    ["campaign-request.json"],
    () => {
      const members = Array.from({ length: count }, (_, index) => ({
        id: `item-${index + 1}`,
        projectId: `campaign-item-${index + 1}`,
        language: "en",
        ...(scenario === "catalogue-videos" ? { productId: `sku-${index + 1}` } : {}),
        ...(scenario === "content-series" ? { scheduledFor: `2026-12-${String(index + 1).padStart(2, "0")}` } : {}),
        factors: { fixture: String(index + 1) },
        adapter: {
          kind: "recipe",
          request: {
            projectId: `campaign-item-${index + 1}`,
            recipeId: "ad-direct",
            topic: `Synthetic fixture ${index + 1}`,
            formats: ["vertical"],
          },
        },
      }));
      let reference: { path: string; sha256: string } | undefined;
      if (scenario === "reference-family") {
        const file = "reference-blueprint.json";
        write(file, {
          schemaVersion: 1,
          referenceId: "campaign-fixture",
          format: { width: 1080, height: 1920, fps: 30 },
          durationSec: 3,
          slots: [
            {
              id: "hook",
              role: "hook",
              startSec: 0,
              durationSec: 3,
              visualRecipe: "Original product evidence",
              motionRecipe: "Hold for reading",
              soundRecipe: "Declared silence",
            },
          ],
          rhythm: { cutGrid: "One held beat" },
          style: "Synthetic contract fixture",
          transferRules: { keep: ["Narrative function"], mustChange: ["Product facts"] },
        });
        reference = { path: file, sha256: digest(readFileSync(path.join(observer.workspace, file))) };
      }
      write("campaign-request.json", {
        version: 1,
        id: "campaign",
        revision: 1,
        scenario,
        brief:
          "Explicit synthetic contract fixture; no live model, human creative acceptance or finished video is claimed",
        members,
        ...(reference ? { reference } : {}),
      });
    },
    { authority: "fixture", kind: "preparation" },
  );
  const created = await observer.execute("campaign:production", [
    "--project",
    "campaign",
    "--action",
    "init",
    "--request",
    "campaign-request.json",
  ]);
  if (!created.event.passed) fail("Campaign public CLI creation failed");
  const output = created.event.outputs.find((pin) => pin.path.includes("/plans/"));
  if (!output) fail("Campaign creation did not publish an immutable plan");
  const consumer = await observer.execute("campaign:next", ["--project", "campaign"], { inputs: [output.path] });
  if (!consumer.event.passed) fail("Campaign next-step consumer failed");
  observedHandoff(observer.events, consumer.event, output.path);
  await observer.operation("@campaign/independent-plan-check", [output.path], ["campaign-check.json"], () => {
    const plan = CampaignProductionPlanSchema.parse(JSON.parse(observer.read(output.path).toString()));
    if (
      plan.members.length !== count ||
      plan.request.scenario !== scenario ||
      plan.request.spend !== "forbid" ||
      plan.allocation.owners.reduce((sum, owner) => sum + owner.quotaUsd, 0) !== 0
    )
      fail("Campaign member, scenario or no-spend contract differs");
    const next = consumer.envelope.metadata;
    if (next?.action !== "ask" || next.planHash !== plan.planHash)
      fail("Campaign must retain the concrete human plan gate");
    write("campaign-check.json", {
      memberCount: count,
      planHash: plan.planHash,
      producerEvent: created.event.id,
      consumerEvent: consumer.event.id,
      result: "user-action",
      paidCalls: 0,
      finishedVideos: false,
      liveAgent: false,
    });
  });
  return "user-action";
}

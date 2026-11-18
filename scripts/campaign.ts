import { readFileSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { planCampaign, createCampaignProjects, campaignCostReport, storeOutcome } from "../src/lib/campaigns";
import { createLocalizedProject, planLocalization, reviewLocalization } from "../src/lib/campaigns/localization";
import path from "node:path";
import { assertProjectId } from "../src/lib/render-plan";
import { TranslationSchema } from "../src/types/campaigns";
runScript(async () => {
  const args = parseArgs([
    {
      name: "manifest",
      required: true,
      description: "Supplied campaign/translation/outcome JSON",
    },
    {
      name: "action",
      choices: ["plan", "create", "cost-report", "localize-plan", "localize-create", "localize-review", "outcome"],
      default: "plan",
      description: "Local operation; never generates or publishes",
    },
    { name: "output", description: "New outcome evidence JSON" },
  ]);
  try {
    const raw = JSON.parse(readFileSync(String(args.manifest), "utf8"));
    if (args.action === "create")
      return {
        ...createCampaignProjects(raw),
        metadata: { generationRequests: 0 },
      };
    if (args.action === "cost-report") return { metadata: campaignCostReport(raw) };
    if (args.action === "localize-create")
      return {
        ...createLocalizedProject(raw),
        metadata: { generationRequests: 0 },
      };
    if (args.action === "localize-review") {
      assertProjectId(String(raw.projectId));
      return {
        metadata: reviewLocalization(path.join("public/projects", raw.projectId), raw),
      };
    }
    if (args.action === "localize-plan") {
      const translation = TranslationSchema.parse(raw);
      const source = path.join("public/projects", translation.sourceProjectId, "project.json");
      return {
        metadata: planLocalization(JSON.parse(readFileSync(source, "utf8")), raw),
      };
    }
    if (args.action === "outcome") {
      if (!args.output) throw new Error("Outcome storage requires --output");
      return {
        outputs: [String(args.output)],
        metadata: storeOutcome(raw, String(args.output)),
      };
    }
    return { metadata: planCampaign(raw) };
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

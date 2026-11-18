import { writeFileSync } from "node:fs";
import path from "node:path";
import { BenchConfigSchema } from "../src/types/bench";
import { z } from "zod";
import { parseArgs, runScript } from "../src/lib/cli";
import { json, writeJson } from "../src/lib/bench/io";
import { rateCampaign, ratingsMarkdown } from "../src/lib/bench/rate";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "campaign",
      required: true,
      description: "Judging directory with packets.json, judgements.json and private-key.json",
    },
    { name: "output", required: true, description: "New ratings JSON file (a Markdown sibling is also written)" },
  ] as const);
  const campaign = path.resolve(args.campaign!);
  const protocol = z.object({ config: BenchConfigSchema }).parse(json(path.join(campaign, "protocol.json")));
  const config = protocol.config;
  const result = rateCampaign(
    json(path.join(campaign, "packets.json")),
    json(path.join(campaign, "judgements.json")),
    json(path.join(campaign, "private-key.json")),
    {
      seed: config.noise.seed,
      bootstrapSamples: config.noise.bootstrapSamples,
      noiseFloor: config.noise.floor,
      expectedJudges: config.judging.models.map((model) => `${model.vendor}:${model.model}`),
    },
  );
  const output = path.resolve(args.output!),
    markdown = `${output}.md`;
  writeJson(output, result);
  writeFileSync(markdown, ratingsMarkdown(result), { flag: "wx" });
  return {
    outputs: [output, markdown],
    metadata: { task: result.task, noiseFloor: result.noiseFloor, cells: result.ratings.length },
  };
});

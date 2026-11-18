import path from "node:path";
import { z } from "zod";
import { parseArgs, runScript } from "../src/lib/cli";
import { admitJudge } from "../src/lib/bench/calibration";
import { judgePackets, prepareJudgeCampaign } from "../src/lib/bench/judge";
import { fail, json, loadBenchConfig, writeJson } from "../src/lib/bench/io";
void runScript(async () => {
  const args = parseArgs([
    { name: "bundles", required: true, description: "JSON array of signed bundle directories from one task" },
    { name: "allowed-signers", required: true, description: "Trusted local allowed_signers" },
    { name: "calibration", required: true, description: "Maintainer-controlled calibration record array" },
    {
      name: "output",
      required: true,
      description: "New campaign output directory; private-key.json must stay private",
    },
    { name: "suite", description: "Pinned suite manifest" },
    {
      name: "seed",
      type: "number",
      required: true,
      description: "Private seeded anonymisation key; pre-register privately before a campaign",
    },
    { name: "recordings", description: "Replay triage vendor response recordings offline with an isolated ledger" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Check admission and prepare packets without vendor calls or spend",
    },
  ] as const);
  const root = process.cwd(),
    config = loadBenchConfig(root);
  if (config.judging.monthlyCapUsd === null) fail("Judging monthlyCapUsd is undecided (null); judging refuses");
  const calibration = z.array(z.unknown()).parse(json(args.calibration!));
  const campaign = await prepareJudgeCampaign(
    root,
    z.array(z.string()).min(2).parse(json(args.bundles!)),
    args["allowed-signers"]!,
    args.seed,
    args.suite,
  );
  for (const model of config.judging.models) {
    const judge = `${model.vendor}:${model.model}`;
    admitJudge(
      config,
      calibration.find((record) => (record as { judge?: unknown })?.judge === judge),
      judge,
      campaign.suiteVersion,
    );
  }
  const output = path.resolve(args.output!);
  writeJson(path.join(output, "packets.json"), campaign.packets);
  writeJson(path.join(output, "private-key.json"), {
    version: 1,
    mapping: campaign.mapping,
    bundles: campaign.bundles,
    seed: args.seed,
  });
  writeJson(path.join(output, "protocol.json"), {
    version: 1,
    config,
    suiteVersion: campaign.suiteVersion,
    calibration,
    modality: "picture",
    replay: Boolean(args.recordings),
  });
  const outputs = ["packets.json", "private-key.json", "protocol.json"].map((name) => path.join(output, name));
  if (args["dry-run"]) return { outputs, metadata: { dryRun: true, packets: campaign.packets.length, ready: true } };
  const result = await judgePackets(
    root,
    campaign.packets,
    calibration,
    campaign.suiteVersion,
    config,
    args.recordings,
  );
  writeJson(path.join(output, "judgements.json"), result.judgements);
  return {
    outputs: [...outputs, path.join(output, "judgements.json")],
    metadata: { runId: result.runId, ledger: result.ledger, replay: result.replay },
  };
});

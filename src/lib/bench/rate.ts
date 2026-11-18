import { z } from "zod";
import {
  BenchBundleSchema,
  BenchJudgementSchema,
  BenchPacketSchema,
  BenchRatingResultsSchema,
} from "../../types/bench";
import { fit, ratePreferences, type Preference } from "./bradley-terry";
import { digest, fail } from "./io";

export function rateCampaign(
  packetInput: unknown,
  judgementInput: unknown,
  keyInput: unknown,
  options: { seed: number; bootstrapSamples: number; noiseFloor: number | null; expectedJudges: string[] },
) {
  const packets = z.array(BenchPacketSchema).min(1).parse(packetInput),
    judgements = z.array(BenchJudgementSchema).min(1).parse(judgementInput);
  const key = z
    .object({
      version: z.literal(1),
      mapping: z.record(z.string(), z.string()),
      bundles: z.array(BenchBundleSchema),
      seed: z.number().int(),
    })
    .strict()
    .parse(keyInput);
  if (
    new Set(packets.map((packet) => packet.task)).size !== 1 ||
    new Set(packets.map((packet) => packet.id)).size !== packets.length
  )
    fail("Rating requires unique packets within one task");
  const cells = new Map<string, string>(),
    runs = new Map<string, typeof key.bundles>();
  for (const bundle of key.bundles) {
    const { task, harness, model, harnessCommit, run } = bundle.cell;
    const id = `${task}-${harness}-${digest(model).slice(0, 8)}-${harnessCommit.slice(0, 8)}-${run}`;
    const cell = `${harness} / ${model} / ${harnessCommit}`;
    if (cells.has(id) || task !== packets[0]!.task) fail("Duplicate run or mismatched task in private key");
    cells.set(id, cell);
    runs.set(cell, [...(runs.get(cell) ?? []), bundle]);
  }
  if ([...runs.values()].some((values) => values.length < 3))
    fail("At least three runs per cell are required for noise estimation");
  if (
    Object.keys(key.mapping).length !== cells.size ||
    new Set(Object.values(key.mapping)).size !== cells.size ||
    Object.values(key.mapping).some((id) => !cells.has(id))
  )
    fail("Private mapping must cover every registered run exactly once");
  const orderedPairs = new Set<string>();
  for (const packet of packets) {
    if (!key.mapping[packet.left.key] || !key.mapping[packet.right.key]) fail("Packet refers to an unregistered run");
    const pair = `${packet.left.key}:${packet.right.key}`;
    if (orderedPairs.has(pair)) fail("Duplicate ordered run pair");
    orderedPairs.add(pair);
  }
  if (orderedPairs.size !== cells.size * (cells.size - 1))
    fail("Packets must cover every ordered pair of registered runs");
  const byId = new Map(packets.map((packet) => [packet.id, packet])),
    seen = new Set<string>();
  const preferences: Preference[] = judgements.map((judgement) => {
    const packet = byId.get(judgement.packetId);
    if (!packet || judgement.task !== packet.task) fail("Judgement does not match a packet");
    const identity = `${judgement.judge}:${packet.id}`;
    if (seen.has(identity)) fail("Duplicate judge/packet judgement");
    seen.add(identity);
    const a = key.mapping[packet.left.key],
      b = key.mapping[packet.right.key];
    if (!a || !b || !cells.has(a) || !cells.has(b)) fail("Blind key does not resolve to registered runs");
    return {
      a,
      b,
      winner: judgement.winner === "tie" ? "tie" : judgement.winner === "left" ? "a" : "b",
      block: [a, b].sort().join(":"),
    };
  });
  const judges = new Set(judgements.map((judgement) => judgement.judge));
  if (
    !options.expectedJudges.length ||
    new Set(options.expectedJudges).size !== options.expectedJudges.length ||
    judges.size !== options.expectedJudges.length ||
    options.expectedJudges.some((judge) => !judges.has(judge))
  )
    fail("Judgements must contain exactly the pre-registered judge panel");
  if (!judges.size || [...judges].some((judge) => packets.some((packet) => !seen.has(`${judge}:${packet.id}`))))
    fail("Every judge must evaluate every packet in both orders");
  for (const packet of packets)
    if (!packets.some((other) => other.left.key === packet.right.key && other.right.key === packet.left.key))
      fail("Missing reverse-order packet");
  const perRun = fit(preferences);
  const noiseDeltas = Object.keys(perRun)
    .flatMap((a, i, ids) =>
      ids
        .slice(i + 1)
        .filter((b) => cells.get(a) === cells.get(b))
        .map((b) => Math.abs(perRun[a]! - perRun[b]!)),
    )
    .sort((a, b) => a - b);
  if (!noiseDeltas.length) fail("Noise floor requires repeated identical cells");
  const measuredNoise = noiseDeltas[Math.ceil((noiseDeltas.length - 1) * 0.95)]!;
  const noiseFloor = Math.max(options.noiseFloor ?? 0, measuredNoise);
  const cellPreferences = preferences
    .filter((pair) => cells.get(pair.a) !== cells.get(pair.b))
    .map((pair) => ({ ...pair, a: cells.get(pair.a)!, b: cells.get(pair.b)! }));
  const result = ratePreferences(cellPreferences, { ...options, noiseFloor });
  const ratings = result.ratings.map((row) => {
    const bundles = runs.get(row.id)!;
    const cost = bundles.every((bundle) => bundle.spendUsd !== null)
      ? bundles.reduce((sum, bundle) => sum + bundle.spendUsd!, 0) / bundles.length
      : null;
    const minutes = bundles.reduce((sum, bundle) => sum + bundle.wallTimeSec / 60, 0) / bundles.length;
    const quality = 1 / (1 + Math.exp(-row.rating));
    return {
      ...row,
      qualityPerUsd: cost !== null && cost > 0 ? quality / cost : null,
      qualityPerMinute: minutes > 0 ? quality / minutes : null,
    };
  });
  return BenchRatingResultsSchema.parse({
    version: 1,
    protocolVersion: 1,
    task: packets[0]!.task,
    noiseFloor,
    bootstrapSamples: options.bootstrapSamples,
    seed: options.seed,
    ratings,
    deltas: result.deltas,
  });
}
export function ratingsMarkdown(result: z.infer<typeof BenchRatingResultsSchema>): string {
  const escape = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `# Benchmark: ${result.task}`,
    "",
    `Picture only. Log-ability scale; 95% block-bootstrap intervals. Noise floor: ${result.noiseFloor.toFixed(4)} (95th percentile of absolute repeated-cell run differences, or higher pre-registered floor).`,
    "",
    "| Cell | Rating | 95% interval | Quality / USD | Quality / minute |",
    "|---|---:|---|---:|---:|",
    ...result.ratings.map(
      (row) =>
        `| ${escape(row.id)} | ${row.rating.toFixed(4)} | ${row.interval95.map((value) => value.toFixed(4)).join(" to ")} | ${row.qualityPerUsd?.toFixed(4) ?? "unknown / no billed spend"} | ${row.qualityPerMinute?.toFixed(4) ?? "unknown"} |`,
    ),
    "",
    "Normalised quality is the fitted probability against the geometric-mean candidate. Ledger spend excludes harness subscriptions and unknown external billing.",
    "",
    ...result.deltas.map(
      (delta) =>
        `- ${escape(delta.a)} versus ${escape(delta.b)}: ${delta.delta.toFixed(4)} [${delta.interval95.map((value) => value.toFixed(4)).join(", ")}], **${delta.interpretation}**.`,
    ),
    "",
    "Community signatures do not prove truthful execution. Reproduction and human sound review remain separate.",
    "",
  ].join("\n");
}

import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BenchJudgementSchema, BenchPacketSchema, type BenchConfig, type BenchPacket } from "../../types/bench";
import { TriageConfigSchema } from "../../types/triage";
import { createJudge, loadConfig, preflightJudges } from "../triage/vendors";
import { admitJudge, PICTURE_SYSTEM } from "./calibration";
import { contained, fail, loadBenchConfig } from "./io";
import { makePackets, type Candidate } from "./pairs";
import { verifyBundle } from "./sign";

const verdict = z.object({ winner: z.enum(["left", "right", "tie"]) }).strict();
function prompt(packetInput: unknown) {
  const packet = BenchPacketSchema.parse(packetInput);
  return { system: PICTURE_SYSTEM, user: JSON.stringify(packet), schema: z.toJSONSchema(verdict) };
}
/** Reuse triage's pricing, admission, durable ledger and decoding, adding only
 * the vendor's image content transport. Data URLs never become tool calls. */
export function pictureTransport(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (Array.isArray(body.messages)) {
      const messages = body.messages as { content: unknown; role: string }[];
      const packet = BenchPacketSchema.parse(JSON.parse(String(messages[0]!.content)));
      messages[0]!.content = imageContent(packet, "anthropic");
    } else {
      const messages = body.input as { content: unknown; role: string }[];
      const packet = BenchPacketSchema.parse(JSON.parse(String(messages[0]!.content)));
      messages[0]!.content = imageContent(packet, "openai");
    }
    return baseFetch(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch;
}
function imageContent(packet: BenchPacket, vendor: "anthropic" | "openai") {
  const content: unknown[] = [];
  for (const [side, candidate] of [
    ["left", packet.left],
    ["right", packet.right],
  ] as const) {
    const text = `${side}: ${JSON.stringify(candidate.technical)}`;
    content.push(vendor === "anthropic" ? { type: "text", text } : { type: "input_text", text });
    for (const still of candidate.stills)
      content.push(
        vendor === "anthropic"
          ? { type: "image", source: { type: "base64", media_type: "image/png", data: still.split(",")[1] } }
          : { type: "input_image", image_url: still },
      );
  }
  return content;
}
export async function judgePackets(
  root: string,
  packets: BenchPacket[],
  calibration: unknown[],
  suiteVersion: number,
  config: BenchConfig = loadBenchConfig(root),
  recordings?: string,
) {
  if (!packets.length || new Set(packets.map((packet) => packet.task)).size !== 1)
    fail("Judging needs packets from one task");
  const models = config.judging.models;
  if (models.length !== 2 || new Set(models.map((model) => model.vendor)).size !== 2)
    fail("Picture judging requires one model from each vendor");
  for (const model of models) {
    const id = `${model.vendor}:${model.model}`;
    const record = calibration.find((value) => (value as { judge?: unknown })?.judge === id);
    admitJudge(config, record, id, suiteVersion);
  }
  const triage = TriageConfigSchema.parse({
    ...loadConfig(root),
    enabled: true,
    judges: models.map((model) => ({ label: model.vendor, provider: model.vendor, model: model.model })),
    perPrCapUsd: config.judging.campaignCapUsd,
    monthlyCapUsd: config.judging.monthlyCapUsd,
  });
  const ledger = path.join(root, recordings ? ".cache/bench/recordings" : ".cache/bench/judging", "ledger.jsonl"),
    runId = randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ambient triage recordings must not silently turn an official campaign into replay.
  delete env.TRIAGE_RECORDINGS;
  if (recordings) env.TRIAGE_RECORDINGS = path.resolve(recordings);
  const prompts = packets.map(prompt);
  preflightJudges(triage, ledger, runId, prompts, env);
  const results = [];
  for (const [index, model] of models.entries()) {
    const judge = createJudge(triage.judges[index]!, { config: triage, ledger, runId, env, fetch: pictureTransport() });
    for (let i = 0; i < packets.length; i++) {
      const result = await judge.judge(prompts[i]!);
      if (result.abstain)
        fail(`Judge abstained: ${result.abstain}; inspect retained ledger reservations before retrying`);
      results.push(
        BenchJudgementSchema.parse({
          version: 1,
          protocolVersion: 1,
          task: packets[i]!.task,
          packetId: packets[i]!.id,
          judge: `${model.vendor}:${model.model}`,
          winner: verdict.parse(result.json).winner,
          modality: "picture",
        }),
      );
    }
  }
  return { judgements: results, runId, ledger, replay: Boolean(recordings) };
}
export async function prepareJudgeCampaign(
  root: string,
  bundles: string[],
  allowedSigners: string,
  seed: number,
  suite?: string,
) {
  const candidates: Candidate[] = [],
    verified = [];
  for (const bundleName of bundles) {
    const bundle = path.resolve(bundleName);
    const result = await verifyBundle({ root, bundle, allowedSigners, suite });
    if (!result.recomputed) fail("Picture judging requires a private original with recomputed measurements");
    const recomputed = result.recomputed;
    verified.push(result.manifest);
    const render = result.manifest.files.find((file) => /^out\/[^/]+\/[^/]+\.mp4$/.test(file.path));
    if (!render) fail("Picture judging requires an included render");
    const file = contained(bundle, render.path);
    const { spawnSync } = await import("node:child_process");
    const stills = [0.1, 0.5, 0.9].map((fraction) => {
      const duration = recomputed.technical[`${render.path}:durationSec`];
      if (!duration) fail("Render duration missing");
      const frame = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          String(duration * fraction),
          "-i",
          file,
          "-an",
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-c:v",
          "png",
          "pipe:1",
        ],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      );
      if (frame.status !== 0) fail("Could not extract blind still");
      return frame.stdout;
    });
    const technical = Object.fromEntries(
      Object.entries(recomputed.technical)
        .filter(
          ([key]) =>
            key.startsWith(`${render.path}:`) &&
            ["durationSec", "fps", "width", "height", "integratedLufs", "truePeakDb"].includes(
              key.slice(render.path.length + 1),
            ),
        )
        .map(([key, value]) => [key.slice(render.path.length + 1), value]),
    );
    candidates.push({ id: path.basename(bundle), task: result.manifest.cell.task, stills, technical });
  }
  const cells = new Map<string, Set<number>>();
  for (const manifest of verified) {
    const { task, harness, model, harnessCommit, run } = manifest.cell;
    const key = JSON.stringify([task, harness, model, harnessCommit]);
    const runs = cells.get(key) ?? new Set<number>();
    if (runs.has(run)) fail("Duplicate run within cell");
    runs.add(run);
    cells.set(key, runs);
  }
  const config = loadBenchConfig(root);
  if ([...cells.values()].some((runs) => runs.size < config.minRuns))
    fail("Every judged cell needs at least minRuns distinct runs");
  return { ...makePackets(candidates, seed), suiteVersion: verified[0]!.suiteVersion, bundles: verified };
}

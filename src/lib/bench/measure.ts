import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { BenchClaimsSchema, type BenchTask } from "../../types/bench";
import { FORMAT_CONFIGS } from "../../types/video";
import { totalUsd, type CostEntry } from "../cli/cost-log";
import { DeliveryManifestSchema, DeliverySnapshotSchema } from "../../types/delivery";
import { checkDelivery } from "../delivery/service";
import { measureFlashesInFile } from "../sensors/flash";
import { checkRender, probeRender } from "../sensors/render-file";
import { mediaProbe, analyzeAudio } from "../audio/analysis";
import { contained, filesIn, json } from "./io";

/** Usage is observed at completed turns/messages; cached input is counted once. */
export function transcriptCounts(transcript: string, harness: "claude-code" | "codex") {
  let input = 0,
    output = 0,
    usageSeen = false,
    toolCalls = 0;
  let transcriptState: "complete" | "truncated" | "invalid" = "complete";
  const seen = new Set<string>(),
    messages = new Map<string, { input: number; output: number }>();
  let claudeTotal: { input: number; output: number } | undefined;
  const usageSchema = z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  });
  const lines = transcript.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (transcriptState !== "invalid")
        transcriptState = index === lines.length - 1 && !transcript.endsWith("\n") ? "truncated" : "invalid";
      continue;
    }
    try {
      event = z.record(z.string(), z.unknown()).parse(value);
    } catch {
      transcriptState = "invalid";
      continue;
    }
    try {
      if (harness === "codex") {
        if (event.type === "turn.completed" && event.usage) {
          const usage = usageSchema.parse(event.usage);
          input += usage.input_tokens;
          output += usage.output_tokens;
          usageSeen = true;
        }
        if (event.type === "item.completed") {
          const item = event.item as { id?: string; type?: string } | undefined;
          if (
            item &&
            ["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(item.type ?? "") &&
            item.id &&
            !seen.has(item.id)
          ) {
            seen.add(item.id);
            toolCalls++;
          }
        }
      } else {
        if (event.type === "result" && event.usage) {
          const usage = usageSchema.parse(event.usage);
          claudeTotal = {
            input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens,
          };
          usageSeen = true;
        }
        if (event.type !== "assistant") continue;
        const message = event.message as
          | { id?: string; usage?: unknown; content?: { type: string; id?: string }[] }
          | undefined;
        if (!message) continue;
        if (message.usage && message.id) {
          const usage = usageSchema.parse(message.usage),
            previous = messages.get(message.id);
          messages.set(message.id, {
            input: Math.max(
              previous?.input ?? 0,
              usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            ),
            output: Math.max(previous?.output ?? 0, usage.output_tokens),
          });
          usageSeen = true;
        }
        for (const item of message.content ?? [])
          if (item.type === "tool_use" && item.id && !seen.has(item.id)) {
            seen.add(item.id);
            toolCalls++;
          }
      }
    } catch {
      transcriptState = "invalid";
    }
  }
  if (harness === "claude-code") {
    const total =
      claudeTotal ??
      [...messages.values()].reduce(
        (sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output }),
        { input: 0, output: 0 },
      );
    input = total.input;
    output = total.output;
  }
  return { tokens: usageSeen ? { input, output } : null, toolCalls, transcriptState };
}

function replayDelivery(root: string, names: string[]): "passed" | "failed" | "unavailable" {
  const reports = names.filter((name) =>
    /^public\/projects\/[^/]+\/pipeline\/delivery\/reports\/[^/]+\.json$/.test(name),
  );
  if (!reports.length) return "unavailable";
  const scratch = mkdtempSync(path.join(tmpdir(), "bench-delivery-"));
  try {
    // The existing delivery service writes reports/releases. Replay on a disposable
    // copy so verification never changes a submitted bundle or executes its code.
    for (const name of names) {
      const target = contained(scratch, name);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(contained(root, name), target, { recursive: false });
    }
    let passed = false;
    for (const report of reports) {
      const manifest = DeliveryManifestSchema.parse(json(contained(root, report)));
      const snapshotFile = `public/projects/${manifest.projectId}/pipeline/delivery/snapshots/${manifest.snapshotId}.json`;
      if (
        !existsSync(contained(root, snapshotFile)) ||
        manifest.outputs.some((out) => !existsSync(contained(root, out.path)))
      )
        return "unavailable";
      const snapshot = DeliverySnapshotSchema.parse(json(contained(root, snapshotFile)));
      const result = checkDelivery(manifest.request, snapshot, { rootDir: scratch });
      passed ||= result.productionReady;
    }
    return passed ? "passed" : "failed";
  } catch {
    return "failed";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function measure(
  root: string,
  task: BenchTask,
  trustedRoot: string,
  transcript: string,
  harness: "claude-code" | "codex",
) {
  const names = filesIn(root).filter((name) => !["manifest.json", "manifest.json.sig"].includes(name));
  const ledgers = names.filter((name) => /^public\/projects\/[^/]+\/pipeline\/cost-ledger\.jsonl$/.test(name));
  const costs = ledgers.flatMap((name) =>
    readFileSync(contained(root, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CostEntry),
  );
  const spendUsd = totalUsd(costs);
  const delivery = replayDelivery(root, names);
  const technical: Record<string, number> = {};
  for (const name of names.filter((name) => /^out\/[^/]+\/[^/]+\.mp4$/.test(name))) {
    const file = contained(root, name),
      probe = mediaProbe(file),
      video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = analyzeAudio(file),
      [num, den] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
    const durationSec = Number(probe.format.duration),
      fps = num! / den!;
    // File-only motion:check layers; never bundle or execute a submitter's scene.
    if (
      durationSec > 0 &&
      durationSec <= Math.min(task.constraints.durationSec[1] + 1, 120) &&
      Math.abs(fps - 30) < 1e-6
    ) {
      const flash = measureFlashesInFile(file, fps),
        render = probeRender(file),
        format = FORMAT_CONFIGS[task.constraints.format];
      technical[`${name}:flashRiskRanges`] = flash.ranges.length;
      technical[`${name}:frameCount`] = render.frameCount;
      technical[`${name}:renderSensorFindings`] = checkRender(file, render, {
        codec: "h264",
        width: format.width,
        height: format.height,
        fps: 30,
        durationInFrames: Math.round(durationSec * 30),
        lastFrame: Math.max(0, Math.round(durationSec * 30) - 1),
      }).length;
    }
    for (const [key, value] of Object.entries({
      durationSec: Number(probe.format.duration),
      fps: num! / den!,
      width: video?.width,
      height: video?.height,
      integratedLufs: audio.integratedLufs,
      truePeakDb: audio.truePeakDb,
    })) {
      if (typeof value === "number" && Number.isFinite(value)) technical[`${name}:${key}`] = value;
    }
  }
  const criteria = task.criteria.map((criterion) => {
    const check = criterion.check;
    let passed = false;
    if (check.type === "delivery") passed = delivery === "passed";
    else if (check.type === "no-spend") passed = spendUsd === 0;
    else if (check.type === "file-sensors") {
      const renders = Object.keys(technical)
        .filter((key) => key.endsWith(":durationSec"))
        .map((key) => key.slice(0, -":durationSec".length));
      passed =
        renders.length > 0 &&
        renders.every(
          (render) => technical[`${render}:flashRiskRanges`] === 0 && technical[`${render}:renderSensorFindings`] === 0,
        );
    } else if (check.type === "constraints") {
      const renders = Object.keys(technical)
        .filter((key) => key.endsWith(":durationSec"))
        .map((key) => key.slice(0, -":durationSec".length));
      const format = FORMAT_CONFIGS[task.constraints.format],
        [min, max] = task.constraints.durationSec;
      passed =
        renders.length > 0 &&
        renders.every(
          (render) =>
            technical[`${render}:durationSec`]! >= min - 1 / 30 &&
            technical[`${render}:durationSec`]! <= max + 1 / 30 &&
            technical[`${render}:width`] === format.width &&
            technical[`${render}:height`] === format.height &&
            Math.abs(technical[`${render}:fps`]! - 30) < 1e-6,
        );
    } else if (check.type === "file") {
      const file = contained(root, check.path);
      passed =
        existsSync(file) && (check.contains === undefined || readFileSync(file, "utf8").includes(check.contains));
    } else {
      // Only the selected, hash-pinned suite's local check is executed, never a
      // submitted bundle's script. The script receives the bundle as data.
      const result = spawnSync(process.execPath, [contained(trustedRoot, check.path), root], {
        cwd: trustedRoot,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      passed = result.status === 0 && !result.error;
    }
    return { id: criterion.id, passed };
  });
  return BenchClaimsSchema.parse({ ...transcriptCounts(transcript, harness), spendUsd, delivery, criteria, technical });
}

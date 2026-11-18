/**
 * Real engines behind `pnpm matte`, gated: RUN_MATTE_TESTS=1. Vision runs on macOS once `pnpm media:prepare --engines
 * matte` has prepared the worker; ONNX once `pnpm assets:sync --id models:birefnet-general-lite` has fetched the
 * weights (a CPU frame takes seconds). Input is a synthetic picture made here with ffmpeg; the checks are the rmbg
 * output contract and the receipt, not matte quality (docs/matte.md has the quality evaluation).
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { engineFacts } from "../src/lib/matte";
import { MatteReceiptSchema } from "../src/types/matte";

const enabled = process.env.RUN_MATTE_TESTS === "1";
let facts: Awaited<ReturnType<typeof engineFacts>> | undefined;

/** True when the engine can run here; otherwise marks the test skipped with the reason. */
async function ready(t: TestContext, engine: "vision" | "onnx"): Promise<boolean> {
  if (!enabled) {
    t.skip("set RUN_MATTE_TESTS=1");
    return false;
  }
  facts ??= await engineFacts();
  const state = facts[engine];
  if (!state.available) t.skip(`${engine} unavailable: ${state.reason}`);
  return state.available;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function probe(file: string) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file],
    { encoding: "utf8" },
  );
  return (JSON.parse(result.stdout) as { streams: { width: number; height: number; pix_fmt: string }[] }).streams[0]!;
}

/** A lit orange disc (the subject) on a grey studio gradient, 480x360. */
function picture(file: string, frames = 1) {
  const disc =
    "geq=r='if(lt(hypot(X-240-T*20,Y-190),110),235,90+Y/6)':g='if(lt(hypot(X-240-T*20,Y-190),110),120,90+Y/6)':b='if(lt(hypot(X-240-T*20,Y-190),110),40,95+Y/6)'";
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=480x360:r=30:d=${frames / 30}`,
    "-vf",
    `${disc},format=rgb24`,
    ...(frames === 1 ? ["-frames:v", "1"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12"]),
    file,
  ]);
}

function matte(args: string[]) {
  const result = spawnSync("pnpm", ["exec", "tsx", "scripts/matte.ts", ...args], {
    encoding: "utf8",
    env: {
      AGENTBROS_NO_DOTENV: "1",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
    },
    timeout: 900_000,
  });
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as { ok: boolean; outputs: string[]; metadata: { receipt: string } };
  assert.equal(parsed.ok, true, line + result.stderr.slice(-800));
  return parsed;
}

function checkImage(engine: "vision" | "onnx", kind: "subject" | "person") {
  const work = mkdtempSync(path.join(tmpdir(), "matte-engine-"));
  try {
    const input = path.join(work, "still.png");
    picture(input);
    const output = path.join(work, "cut", "still.png");
    const result = matte(["--input", input, "--output", output, "--engine", engine, "--kind", kind]);
    // The rmbg contract: an RGBA PNG at the source's size where --output names it.
    assert.ok(existsSync(output));
    assert.deepEqual(probe(output), { width: 480, height: 360, pix_fmt: "rgba" });
    assert.ok(existsSync(output.replace(/\.png$/, ".alpha.png")));
    const receipt = MatteReceiptSchema.parse(JSON.parse(readFileSync(result.metadata.receipt, "utf8")));
    assert.equal(receipt.engine.name, engine);
    assert.equal(receipt.input.kind, "image");
    assert.equal(receipt.kind, kind);
    return receipt;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("vision: subject and person stills follow the rmbg contract", async (t) => {
  if (!(await ready(t, "vision"))) return;
  const subject = checkImage("vision", "subject");
  assert.equal(subject.engine.model, "apple-vision-foreground-instance");
  const person = checkImage("vision", "person");
  assert.equal(person.engine.quality, "accurate");
});

test("vision: a clip gives per-frame cut-outs, smoothed alpha, flicker numbers and ProRes 4444", async (t) => {
  if (!(await ready(t, "vision"))) return;
  const work = mkdtempSync(path.join(tmpdir(), "matte-engine-"));
  try {
    const input = path.join(work, "clip.mp4");
    picture(input, 8);
    const out = path.join(work, "out");
    const result = matte(["--input", input, "--out", out, "--start-frame", "2", "--end-frame", "7", "--prores"]);
    const receipt = MatteReceiptSchema.parse(JSON.parse(readFileSync(result.metadata.receipt, "utf8")));
    assert.equal(receipt.input.startFrame, 2);
    assert.equal(receipt.input.frames, 5);
    for (let frame = 2; frame < 7; frame++) {
      const name = `frame-${String(frame).padStart(5, "0")}.png`;
      assert.equal(probe(path.join(out, "cutout", name)).pix_fmt, "rgba");
      assert.equal(probe(path.join(out, "alpha", name)).pix_fmt, "gray");
    }
    assert.equal(receipt.temporal.mode, "ema");
    assert.equal(receipt.temporal.flickerBefore?.pairs, 4);
    assert.ok(receipt.temporal.flickerAfter);
    assert.match(probe(path.join(out, "cutout.mov")).pix_fmt, /^yuva444p1[02]le$/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("onnx: a still follows the rmbg contract on the CPU provider", async (t) => {
  if (!(await ready(t, "onnx"))) return;
  const receipt = checkImage("onnx", "subject");
  assert.match(receipt.engine.runtime, /CPUExecutionProvider/);
  assert.ok(receipt.coverage.mean > 0.05 && receipt.coverage.mean < 0.5, `disc coverage ${receipt.coverage.mean}`);
});

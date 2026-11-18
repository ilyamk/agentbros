/** The Blender craft kit and the six directed twins: static contracts always; with RUN_BLENDER_TESTS=1, one real frame of each twin, CPU determinism and F-curve parity of kit.anim.key_intent. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const runner = path.join(root, "node_modules/tsx/dist/cli.mjs");
const script = path.join(root, "scripts/blender-run.ts");
const TWINS = {
  glossy_orb: "glossy-orb",
  plush_character: "plush-character",
  glass_dome: "glass-dome",
  printing_slip: "printing-slip",
  card_fan: "card-fan",
  device_array: "device-array",
} as const;
const real = { skip: process.env.RUN_BLENDER_TESTS ? false : "Set RUN_BLENDER_TESTS=1 to run real Blender" };
const blenderFile = (name: string) => readFileSync(path.join(root, "scripts/blender", name), "utf8");

function run(args: string[], directory: string) {
  const result = spawnSync(process.execPath, [runner, script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 900000,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
  });
  const envelope = JSON.parse(result.stdout.trim().split("\n").pop()!);
  assert.equal(
    envelope.ok,
    true,
    `${args.join(" ")}: ${envelope.message}\n${existsSync(path.join(directory, "blender.log")) ? readFileSync(path.join(directory, "blender.log"), "utf8").slice(-2000) : ""}`,
  );
  return envelope;
}

/** Raw RGBA pixels of a PNG, decoded by ffmpeg, so PNG metadata never counts. */
function pixels(file: string): Buffer {
  const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    maxBuffer: 1 << 28,
  });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

test("twins are directed shots on the kit, safe to run repeatedly in one Blender process", () => {
  for (const name of Object.keys(TWINS)) {
    const source = blenderFile(`${name}.py`);
    assert.match(source, /from kit import/, `${name} uses the craft kit`);
    assert.doesNotMatch(source, /sys\.exit|os\._exit/, `${name} must not exit: blender:live runs it in-process`);
  }
  for (const file of [
    "curves.py",
    "anim.py",
    "camera.py",
    "light.py",
    "presets.py",
    "look.py",
    "stage.py",
    "character.py",
  ]) {
    const source = blenderFile(`kit/${file}`);
    assert.doesNotMatch(
      source,
      /sys\.exit|import random\b|random\.random\(/,
      `kit/${file}: no exits, no unseeded randomness`,
    );
  }
});

test("each plate recipe renders the whole shot its twin directs", () => {
  const sources = JSON.parse(readFileSync(path.join(root, "public/shared/3d/plates/sources.json"), "utf8"));
  for (const [name, plate] of Object.entries(TWINS)) {
    const recipe = sources.assets.find((asset: { name: string }) => asset.name === plate);
    assert.ok(recipe, plate);
    const command: string[] = recipe.source.command;
    const frames = command[command.indexOf("--frames") + 1];
    const shot = Number(/"frames":\s*(\d+)/.exec(blenderFile(`${name}.py`))![1]);
    assert.equal(frames, `1-${shot}`, `${plate}: the recipe's frames are the twin's default shot length`);
  }
});

test("real Blender: one frame of every twin renders and writes its craft report", real, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "blender-craft-"));
  try {
    for (const name of Object.keys(TWINS)) {
      const missing = name === "device_array" && !existsSync(path.join(root, "public/shared/3d/phone.glb"));
      await t.test(
        name,
        { skip: missing ? "needs public/shared/3d/phone.glb: pnpm assets:sync --id 3d:phone" : false },
        () => {
          const output = path.join(directory, name);
          const envelope = run(
            [
              "--script",
              `scripts/blender/${name}.py`,
              "--output",
              output,
              "--frames",
              "30-30",
              "--samples",
              "2",
              "--resolution",
              "160x90",
              "--device",
              "cpu",
            ],
            output,
          );
          assert.equal(envelope.metadata.frames.length, 1, name);
          assert.ok(existsSync(path.join(output, "craft-report.json")), `${name} writes craft-report.json`);
        },
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real Blender: a frame rendered alone equals the same frame inside a range on CPU", real, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "blender-craft-det-"));
  try {
    const flags = ["--samples", "2", "--resolution", "96x54", "--device", "cpu"];
    for (const name of ["plush_character", "printing_slip"]) {
      const range = path.join(directory, `${name}-range`);
      const alone = path.join(directory, `${name}-alone`);
      run(["--script", `scripts/blender/${name}.py`, "--output", range, "--frames", "40-42", ...flags], range);
      run(["--script", `scripts/blender/${name}.py`, "--output", alone, "--frames", "42-42", ...flags], alone);
      assert.ok(
        pixels(path.join(range, "frame-000042.png")).equals(pixels(path.join(alone, "frame-000042.png"))),
        `${name}: frame 42 alone differs from frame 42 in a range`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real Blender: kit.anim.key_intent F-curves follow the intent curves", real, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "blender-craft-keys-"));
  try {
    const probe = path.join(directory, "keys.py");
    writeFileSync(
      probe,
      `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, "scripts/blender"))})
import bpy
from kit import anim, curves
bpy.ops.wm.read_factory_settings(use_empty=True)
worst = {}
for index, intent in enumerate(["snap", "brake", "glide", "float", "punch"]):
    obj = bpy.data.objects.new(intent, None)
    bpy.context.scene.collection.objects.link(obj)
    anim.key_intent(obj, "empty_display_size", 0, 1.0, 30, 11.0, intent)  # block frames 0 and 30: Blender frames 1 and 31
    curve = anim.fcurve(obj, "empty_display_size", 0)
    worst[intent] = max(abs(curve.evaluate(1 + f) - 1.0 - 10.0 * curves.progress(f, 0, 30, intent)) for f in [x * 0.5 for x in range(61)])
bad = {k: v for k, v in worst.items() if v > 0.15}
assert not bad, f"F-curve differs from the intent curve by more than 1.5% of the move: {bad}"
`,
    );
    const output = path.join(directory, "run");
    run(["--script", probe, "--output", output, "--no-render"], output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

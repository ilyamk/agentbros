import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blenderArguments } from "../src/lib/backends/blender-run";
import {
  extensionEnvironment,
  extensionProcess,
  readExtensions,
  trialExtension,
} from "../src/lib/blender-arsenal/extensions";

const root = process.cwd();
const enabled = process.env.RUN_BLENDER_EXTENSION_TRIALS === "1";
const executable = process.env.BLENDER_PATH ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const argv = [
  "--background",
  "--factory-startup",
  "--disable-autoexec",
  "--offline-mode",
  "--python-exit-code",
  "1",
  "--python",
  path.join(root, "tests/fixtures/blender-extension-exercise.py"),
];
const pixels = (file: string) => {
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    maxBuffer: 1024 * 1024,
  });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stdout.length, 64 * 64 * 4);
  return decoded.stdout;
};

test(
  "researched add-ons: isolated operator exercise and frame-alone/range determinism",
  { skip: !enabled },
  async (t) => {
    mkdirSync(path.join(root, "blender-arsenal/local/research"), { recursive: true });
    const results: Array<Record<string, unknown>> = [];
    const session = `acceptance-${Date.now()}`;
    for (const entry of readExtensions(root).extensions.filter((item) => item.recommendation === "adopt")) {
      await t.test(entry.id, () => {
        const archive = path.join(root, "blender-arsenal/local/downloads", entry.archive.sha256 + ".zip");
        assert.ok(existsSync(archive), `Fetch ${entry.id} first with explicit consent; tests never download.`);
        const trial = trialExtension(root, archive, `${session}-${entry.id}`, executable);
        const exercise = (
          name: string,
          range: boolean,
          seed = 42,
        ): Record<string, unknown> & { output: string; processMs: number } => {
          const output = path.join(path.dirname(trial.profile), name);
          mkdirSync(output, { recursive: true });
          const processResult = extensionProcess(executable, argv, {
            ...extensionEnvironment(root, trial.profile),
            AGENTBROS_EXERCISE_ID: entry.id,
            AGENTBROS_EXERCISE_OUTPUT: output,
            AGENTBROS_EXERCISE_RANGE: range ? "1" : "0",
            AGENTBROS_EXERCISE_SEED: String(seed),
          });
          const report = JSON.parse(readFileSync(path.join(output, "result.json"), "utf8")) as Record<string, unknown>;
          return { ...report, processMs: processResult.elapsedMs, output };
        };
        let alone, range;
        try {
          alone = exercise("alone", false);
          range = exercise("range", true);
        } catch (error) {
          results.push({ id: entry.id, version: entry.version, trial, error: String(error) });
          writeFileSync(
            path.join(root, "blender-arsenal/local/research/adoption-acceptance.json"),
            JSON.stringify(results, null, 2),
          );
          throw error;
        }
        const left = pixels(path.join(alone.output, "frame-20.png")),
          right = pixels(path.join(range.output, "frame-20.png"));
        let differingPixels = 0;
        for (let offset = 0; offset < left.length; offset += 4)
          if (!left.subarray(offset, offset + 4).equals(right.subarray(offset, offset + 4))) differingPixels++;
        const result: Record<string, unknown> = {
          id: entry.id,
          version: entry.version,
          trial,
          alone,
          range,
          differingPixels,
          comparedPixels: 4096,
        };
        if (entry.id === "camera_shakify") {
          const output = path.join(path.dirname(trial.profile), "reopened");
          mkdirSync(output, { recursive: true });
          const requestFile = path.join(output, "request.json");
          const blend = path.join(alone.output, "shake.blend");
          const request = {
            blend,
            output,
            extensions: [{ id: entry.id, version: entry.version }],
            frames: [20, 20],
            format: "png",
            device: "cpu",
            noRender: false,
            resume: false,
            resultFile: path.join(output, "result.json"),
          };
          writeFileSync(requestFile, JSON.stringify({ ...request, blend: undefined, extensions: undefined }));
          const env = { ...extensionEnvironment(root, trial.profile), AGENTBROS_BLENDER_REQUEST: requestFile };
          assert.throws(
            () => extensionProcess(executable, blenderArguments({ blend, factoryStartup: true, scriptArgs: [] }), env),
            /not enabled/,
          );
          writeFileSync(requestFile, JSON.stringify(request));
          extensionProcess(
            executable,
            blenderArguments({ blend, factoryStartup: true, scriptArgs: [], extensions: entry.id }),
            env,
          );
          assert.deepEqual(
            pixels(path.join(output, "frame-000020.png")),
            left,
            "Saved shake must reproduce when the pin is enabled before loading",
          );
          result.reopen = { missingAddonRejected: true, enabledDifferingPixels: 0 };
        }
        if (entry.id === "cell_fracture") {
          const otherSeed = exercise("seed43", false, 43);
          result.otherSeed = otherSeed;
          assert.notEqual(
            otherSeed.geometrySha256,
            alone.geometrySha256,
            "Changing the fracture seed must change geometry",
          );
        }
        results.push(result);
        writeFileSync(
          path.join(root, "blender-arsenal/local/research/adoption-acceptance.json"),
          JSON.stringify(results, null, 2),
        );
        assert.deepEqual(alone.geometrySha256, range.geometrySha256, "Geometry must reproduce in a fresh process");
        assert.equal(differingPixels, 0, "Frame 20 alone must match frame 20 after frame 19");
        console.error(
          JSON.stringify({
            id: entry.id,
            installMs: trial.installMs,
            enableMs: trial.enabled[0]?.enableMs,
            operatorMs: alone.operatorMs,
            renderMs: alone.renderMs,
            differingPixels,
            comparedPixels: 4096,
            extra: alone.extra,
          }),
        );
      });
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { followThrough, hierarchy, intentCurves, type IntentName } from "../src/motion/timing";
import { spacing } from "../src/lib/design-tokens";

/** The Blender craft kit's pure maths (scripts/blender/kit/curves.py) keeps the browser's contract: same intents, same follow-through, same hierarchy. */
const sample = (code: string): unknown =>
  JSON.parse(
    execFileSync(
      "python3",
      ["-c", `import json, sys\nsys.path.insert(0, "scripts/blender")\nfrom kit import curves as c\n${code}`],
      { encoding: "utf8" },
    ),
  );

test("the kit's maths passes its own Python tests", () => {
  const run = spawnSync("python3", ["tests/blender-kit-maths.test.py"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("intent curves match timing.ts intentCurves", () => {
  const names = Object.keys(intentCurves) as IntentName[];
  const ts = Array.from({ length: 41 }, (_, i) => i / 40);
  const python = sample(
    `print(json.dumps({n: [c.curve(n)(i / 40) for i in range(41)] for n in ${JSON.stringify(names)}}))`,
  ) as Record<string, number[]>;
  for (const name of names) {
    ts.forEach((t, i) =>
      assert.ok(
        Math.abs(python[name]![i]! - intentCurves[name](t)) < 1e-4,
        `${name} at ${t}: ${python[name]![i]} vs ${intentCurves[name](t)}`,
      ),
    );
  }
});

test("follow-through matches timing.ts followThrough", () => {
  const python = sample(
    `print(json.dumps([c.follow_through(f, 10, amplitude=6, damping=5, frequency=2.5) for f in range(60)]))`,
  ) as number[];
  python.forEach((value, frame) =>
    assert.ok(
      Math.abs(value - followThrough(frame, 10, { amplitude: 6, damping: 5, frequency: 2.5 })) < 1e-9,
      `frame ${frame}`,
    ),
  );
});

test("hierarchy matches timing.ts hierarchy", () => {
  for (const [roles, options] of [
    [{ hero: 1, support: 3, detail: 4 }, {}],
    [
      { hero: 2, support: 0, detail: 2 },
      { at: 6, fps: 60 },
    ],
    [{ hero: 0, support: 2 }, { at: 3 }],
  ] as const) {
    const py = sample(
      `print(json.dumps(c.hierarchy(hero=${roles.hero}, support=${roles.support ?? 0}, detail=${"detail" in roles ? roles.detail : 0}, at=${"at" in options ? options.at : 0}, fps=${"fps" in options ? options.fps : 30})))`,
    );
    assert.deepEqual(py, hierarchy(roles, options));
  }
});

test("safe frames are the design tokens' safe zones", () => {
  const py = sample(`print(json.dumps(c.SAFE))`) as Record<string, { top: number; bottom: number; sides: number }>;
  for (const format of ["vertical", "square", "landscape"] as const) {
    assert.equal(py[format]!.top, spacing.safeTop[format]);
    assert.equal(py[format]!.bottom, spacing.safeBottom[format]);
    assert.equal(py[format]!.sides, spacing.sidePadding[format]);
  }
});

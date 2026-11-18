import { test } from "node:test";
import assert from "node:assert/strict";
import { VizSpecSchema, VizPlanSchema, VIZ_RECIPES } from "../src/types/viz";
import { validateViz } from "../src/lib/viz/validate";
import { compileViz } from "../src/lib/viz/compile";
import { exampleViz, prepareViz, readViz } from "../src/lib/viz/store";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("every recipe produces deterministic finite plans in three formats", async () => {
  for (const recipe of VIZ_RECIPES)
    for (const format of ["landscape", "vertical", "square"] as const) {
      const spec = exampleViz(recipe);
      const plan = await compileViz(spec, format);
      assert.deepEqual(await compileViz(spec, format), plan);
      assert.ok(plan.primitives.length);
      assert.equal(new Set(plan.primitives.map((primitive) => primitive.id)).size, plan.primitives.length);
      for (const p of plan.primitives) {
        assert.ok(Number.isFinite(p.x));
        assert.ok(Number.isFinite(p.y));
        assert.ok(!p.d?.includes("NaN"));
      }
    }
});
test("strict schemas and semantic validation reject malformed scenes", () => {
  const spec = exampleViz("bars");
  assert.throws(() => VizSpecSchema.parse({ ...spec, code: "alert(1)" }));
  assert.throws(() => validateViz({ ...spec, data: [spec.data[0]!, spec.data[0]!] }), /Duplicate/);
  assert.throws(
    () => validateViz({ ...spec, edges: [], scale: "log", data: [{ id: "one", label: "zero", value: 0 }] }),
    /positive/,
  );
  assert.throws(
    () => validateViz({ ...spec, events: [{ action: "reveal", target: "missing", frame: 0, duration: 1 }] }),
    /Unknown/,
  );
  assert.throws(
    () => validateViz({ ...spec, edges: [], recipe: "donut", data: [{ id: "one", label: "negative", value: -1 }] }),
    /nonnegative/,
  );
  assert.throws(
    () =>
      validateViz({
        ...spec,
        recipe: "sankey",
        edges: [
          { id: "a", source: "one", target: "two" },
          { id: "b", source: "two", target: "one" },
        ],
      }),
    /Cyclic/,
  );
});
test("force layout uses seeded fixed iterations", async () => {
  const spec = { ...exampleViz("network"), layout: "force" as const };
  assert.deepEqual(await compileViz(spec, "landscape"), await compileViz(spec, "landscape"));
});
test("revision preparation is immutable and checks expected revision; dry-run writes nothing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-test-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const spec = exampleViz("bars");
    const dry = await prepareViz("demo", spec, { dryRun: true });
    assert.throws(() => readViz("demo", "example"));
    const first = await prepareViz("demo", spec);
    assert.equal(first.bundle.hash, dry.bundle.hash);
    assert.equal(readViz("demo", "example").bundle.hash, first.bundle.hash);
    await assert.rejects(prepareViz("demo", { ...spec, title: "Revised" }), /revision conflict/);
    const second = await prepareViz("demo", { ...spec, title: "Revised" }, { expectedRevision: first.bundle.hash });
    assert.notEqual(second.bundle.hash, first.bundle.hash);
    assert.equal(readViz("demo", "example", first.bundle.hash).bundle.hash, first.bundle.hash);
    writeFileSync(first.path, "{}");
    assert.throws(() => readViz("demo", "example", first.bundle.hash));
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("numeric whitespace and malformed source values never become zero; BOM CSV is supported", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-source-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const spec = exampleViz("bars");
    const fromSource = {
      ...spec,
      data: [],
      edges: [],
      source: { path: "data.csv", format: "csv", columns: { id: "id", label: "label", value: "value" } },
    };
    writeFileSync("data.csv", "\uFEFFid,label,value\none,First,10");
    assert.equal((await prepareViz("demo", fromSource, { dryRun: true })).bundle.plans[0]!.spec.data[0]!.value, 10);
    writeFileSync("data.csv", "id,label,value\none,First,   ");
    await assert.rejects(prepareViz("demo", fromSource, { dryRun: true }), /Invalid numeric/);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("stacks reject missing series, duplicate cells and negative/null values", () => {
  const spec = exampleViz("stacked-bars");
  assert.throws(() => validateViz({ ...spec, data: [{ id: "a", label: "A", value: -1 }], edges: [] }), /nonnegative/);
  assert.throws(
    () =>
      validateViz({
        ...spec,
        data: [
          { id: "a", label: "A", value: 1 },
          { id: "b", label: "A", value: 2 },
        ],
        edges: [],
      }),
    /Duplicate stack/,
  );
  assert.throws(
    () =>
      validateViz({
        ...spec,
        data: [
          { id: "a", label: "A", value: 1, series: "s1" },
          { id: "b", label: "B", value: 2, series: "s2" },
        ],
        edges: [],
      }),
    /all series/,
  );
  assert.throws(
    () => validateViz({ ...exampleViz("bars"), data: [{ id: "a", label: "A", value: null }], edges: [] }),
    /numeric observation/,
  );
});
test("numeric x spacing is shared and changes actual line geometry", async () => {
  const base = {
    ...exampleViz("line"),
    edges: [],
    data: [
      { id: "a", label: "A", value: 1, x: 0 },
      { id: "b", label: "B", value: 2, x: 1 },
      { id: "c", label: "C", value: 3, x: 100 },
    ],
  };
  const a = await compileViz(base, "landscape");
  const b = await compileViz({ ...base, data: base.data.map((d, i) => ({ ...d, x: i })) }, "landscape");
  assert.notEqual(
    a.primitives.find((p) => p.id.startsWith("series-"))!.d,
    b.primitives.find((p) => p.id.startsWith("series-"))!.d,
  );
});

test("revision writers reject output symlink escapes before writing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-scope-"));
  const outside = mkdtempSync(path.join(tmpdir(), "viz-outside-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo/pipeline", { recursive: true });
    symlinkSync(outside, "public/projects/demo/pipeline/viz");
    await assert.rejects(prepareViz("demo", exampleViz("bars")), /escapes|symlinks/);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("every consumed occurrence must match the pinned revision, independent of traversal order", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-active-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const prepared = await prepareViz("demo", exampleViz("bars"));
    const { collectActiveViz } = await import("../src/lib/viz/usage");
    const genuine = {
      plans: prepared.bundle.plans,
      vizBinding: { sceneId: "example", revision: prepared.bundle.hash },
    };
    const altered = structuredClone(genuine);
    altered.plans[0]!.spec.data[0]!.value = 999;
    assert.equal(collectActiveViz(root, "demo", genuine).length, 1);
    assert.throws(() => collectActiveViz(root, "demo", [altered, genuine]), /Displayed/);
    assert.throws(() => collectActiveViz(root, "demo", [genuine, altered]), /Displayed/);
    assert.throws(() => collectActiveViz(root, "demo", { plans: genuine.plans }), /pinned binding/);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("mesh states use circle diameter and shared target events", async () => {
  const { vizObjectGeometry, vizElementState } = await import("../src/motion/viz/state");
  const plan = await compileViz(
    { ...exampleViz("network-3d"), events: [{ action: "reveal", target: "client", frame: 80, duration: 20 }] },
    "landscape",
  );
  const p = plan.primitives.find((p) => p.kind === "circle")!;
  assert.equal(vizObjectGeometry(plan, p).width, (p.radius! * 2) / 200);
  assert.equal(vizElementState(plan, p, 70).opacity, 0);
  assert.equal(vizElementState(plan, p, 100).opacity, 1);
});
test("stacked axes use the sum domain, not individual segment maxima", async () => {
  const plan = await compileViz(
    {
      ...exampleViz("stacked-bars"),
      edges: [],
      data: [
        { id: "a", label: "Category", value: 10, series: "a" },
        { id: "b", label: "Category", value: 20, series: "b" },
      ],
    },
    "landscape",
  );
  const tick = plan.primitives.find((p) => p.kind === "text" && p.text === "30");
  assert.ok(tick);
  const upper = plan.primitives.find((p) => p.id === "b")!;
  assert.equal(tick.y, upper.y + 8);
  assert.throws(() => validateViz({ ...plan.spec, scale: "log" }), /does not support/);
});
test("SVG anchors match Three camera projections during pushes and trucks", async () => {
  const { OrthographicCamera, Vector3 } = await import("three");
  const { vizScreenTransform, vizProjection, vizCameraState } = await import("../src/motion/viz/state");
  for (const move of ["push", "truck"] as const)
    for (const frame of [0, 60, 149]) {
      const spec = exampleViz("bars-3d");
      spec.camera = { ...spec.camera, move, amount: 0.2 };
      const plan = await compileViz(spec, "landscape");
      const cameraState = vizCameraState(plan, frame);
      const camera = new OrthographicCamera(
        -plan.width / 2,
        plan.width / 2,
        plan.height / 2,
        -plan.height / 2,
        0.1,
        100,
      );
      const position = vizProjection(plan).position;
      camera.position.set(position[0] - cameraState.panX / 200, position[1], position[2]);
      camera.lookAt(-cameraState.panX / 200, 0, 0);
      camera.zoom = 200 * cameraState.zoom;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const [a, b, c, d, e, f] = vizScreenTransform(plan, frame);
      for (const [x, y] of [
        [plan.width / 2, plan.height / 2],
        [400, 300],
      ]) {
        const world = new Vector3((x! - plan.width / 2) / 200, (plan.height / 2 - y!) / 200, 0).project(camera);
        assert.ok(Math.abs(((world.x + 1) / 2) * plan.width - (a * x! + c * y! + e)) < 1e-7);
        assert.ok(Math.abs(((1 - world.y) / 2) * plan.height - (b * x! + d * y! + f)) < 1e-7);
      }
    }
});
test("archived source expansion round-trips above the request-size limit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-large-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const raw = JSON.stringify([{ id: "one", label: "First", value: 10, padding: "\n".repeat(3 * 1024 * 1024) }]);
    writeFileSync("large.json", raw);
    assert.ok(Buffer.byteLength(raw) < 8 * 1024 * 1024);
    const prepared = await prepareViz("demo", {
      version: 1,
      sceneId: "large",
      recipe: "bars",
      source: { path: "large.json", format: "json", columns: { id: "id", label: "label", value: "value" } },
    });
    assert.ok(readFileSync(prepared.path).length > 8 * 1024 * 1024);
    assert.equal(readViz("demo", "large").bundle.plans[0]!.spec.data[0]!.value, 10);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("UTC dates are canonical and preserve unequal temporal spacing", async () => {
  const spec = exampleViz("line");
  spec.edges = [];
  spec.xScale = "utc";
  spec.data = [
    { id: "a", label: "Jan", value: 1, date: "2026-01-01" },
    { id: "b", label: "Feb", value: 2, date: "2026-02-01" },
    { id: "c", label: "Dec", value: 3, date: "2026-12-01" },
  ];
  assert.ok((await compileViz(spec, "landscape")).primitives.some((p) => p.id === "series-main"));
  assert.throws(
    () => validateViz({ ...spec, data: [{ id: "a", label: "Bad", value: 1, date: "2026-02-31" }] }),
    /canonical/,
  );
});
test("render variant selection is explicit and replacement clears stale bindings", async () => {
  const { selectVizVariants } = await import("../src/lib/viz/timeline");
  const { applyEdit } = await import("../src/lib/timeline-ir/commands");
  const binding = { sceneId: "example", revision: "a".repeat(64) };
  const timeline = {
    version: 1 as const,
    projectId: "demo",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "visual",
        kind: "visual" as const,
        clips: [
          {
            id: "clip",
            assetId: "old",
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 150, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" as const },
            captions: [],
            payload: {
              other: "kept",
              vizBinding: binding,
              vizRenderVariants: {
                landscape: { assetId: "landscape", vizBinding: binding },
                vertical: { assetId: "vertical", vizBinding: binding },
              },
            },
          },
        ],
      },
    ],
  };
  assert.equal(selectVizVariants(timeline, "vertical").tracks[0]!.clips[0]!.assetId, "vertical");
  assert.equal(timeline.tracks[0]!.clips[0]!.assetId, "old");
  assert.throws(() => selectVizVariants(timeline, "square"), /no rendered/);
  const replaced = applyEdit(timeline, {
    type: "replace",
    trackId: "visual",
    clipId: "clip",
    assetId: "plain",
    source: timeline.tracks[0]!.clips[0]!.source,
  });
  assert.equal(replaced.tracks[0]!.clips[0]!.payload?.vizBinding, undefined);
  assert.equal(replaced.tracks[0]!.clips[0]!.payload?.vizRenderVariants, undefined);
  assert.equal(replaced.tracks[0]!.clips[0]!.payload?.other, "kept");
});
test("collector uses actual template owner and ignores inactive canonical scenes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-owner-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const prepared = await prepareViz("demo", exampleViz("bars"));
    const { collectActiveViz } = await import("../src/lib/viz/usage");
    const props = { plans: prepared.bundle.plans, vizBinding: { sceneId: "example", revision: prepared.bundle.hash } };
    assert.equal(
      collectActiveViz(root, "demo", {
        scenes: [{ id: "actual-owner", template: { id: "scene.visualisation", props } }],
      })[0]!.ownerSceneId,
      "actual-owner",
    );
    const corrupt = structuredClone(props);
    corrupt.plans[0]!.spec.data[0]!.value = 999;
    assert.equal(
      collectActiveViz(root, "demo", {
        scenes: [{ id: "stale", template: { props: corrupt } }],
        timeline: { tracks: [], overlays: [{ block: "viz-scene", props }] },
      }).length,
      1,
    );
    assert.throws(() => collectActiveViz(root, "demo", { ...props, plateSrc: "unbound.mp4" }), /Internal plate/);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("raw derived visualisations copy before source cleanup and missing layouts refuse early", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-derived-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const prepared = await prepareViz("demo", exampleViz("bars"));
    const { planDerivedViz, writeDerivedVizFiles } = await import("../src/lib/viz/derive");
    const { collectActiveViz } = await import("../src/lib/viz/usage");
    const timeline = {
      tracks: [],
      overlays: [
        {
          block: "viz-scene",
          props: { plans: prepared.bundle.plans, vizBinding: { sceneId: "example", revision: prepared.bundle.hash } },
        },
      ],
    };
    assert.throws(() => planDerivedViz(root, "demo", "derived", timeline, ["vertical"]), /separately prepared/);
    mkdirSync("public/projects/derived", { recursive: true });
    const derived = planDerivedViz(root, "demo", "derived", timeline, ["landscape"]);
    writeDerivedVizFiles(path.join(process.cwd(), "public/projects/derived"), derived.files);
    rmSync("public/projects/demo", { recursive: true });
    assert.equal(collectActiveViz(root, "derived", derived.timeline)[0]!.bundle.hash, prepared.bundle.hash);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("generic quantities retain metric identity and require matching displayed units", async () => {
  const { VizQuantitySourceSchema } = await import("../src/types/viz");
  const quantity = {
    kind: "metric-v1" as const,
    metricId: "latency",
    subjectId: "service",
    unit: "ms",
    methodId: "p95",
    period: { start: "2026-01-01", end: "2026-02-01" },
  };
  assert.equal(
    VizQuantitySourceSchema.parse({ version: 1, records: [{ id: "sample", quantity, value: 24 }] }).records[0]!.quantity
      .kind,
    "metric-v1",
  );
  const spec = {
    ...exampleViz("bars"),
    unit: "ms",
    data: [{ id: "sample", label: "Latency", value: 24, quantity }],
    edges: [],
  };
  assert.doesNotThrow(() => validateViz(spec));
  assert.throws(() => validateViz({ ...spec, unit: "s" }), /unit/);
  assert.throws(() =>
    VizQuantitySourceSchema.parse({
      version: 1,
      records: [
        { id: "sample", quantity: { ...quantity, period: { start: "2026-02-31", end: "2026-03-31" } }, value: 24 },
      ],
    }),
  );
});
test("mixed legacy and generic source records cannot reuse an identity", async () => {
  const { VizQuantitySourceSchema } = await import("../src/types/viz");
  const period = { start: "2026-01-01", end: "2026-02-01" };
  assert.throws(
    () =>
      VizQuantitySourceSchema.parse({
        version: 1,
        records: [
          {
            id: "same",
            value: 10,
            quantity: { kind: "metric-v1", metricId: "latency", subjectId: "app", unit: "ms", methodId: "p95" },
          },
          {
            id: "same",
            value: 99,
            quantity: {
              kind: "return-percent-v1",
              unit: "%",
              subjectId: "app",
              basisId: "basis",
              methodId: "method",
              period,
            },
          },
        ],
      }),
    /Duplicate source/,
  );
  const spec = exampleViz("bars-3d");
  assert.throws(
    () => validateViz({ ...spec, camera: { ...spec.camera, move: "push", startFrame: 999 } }),
    /Camera motion/,
  );
});
test("a render receipt cannot be relabelled as another equal-duration revision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "viz-receipt-"));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/demo", { recursive: true });
    const first = await prepareViz("demo", exampleViz("bars"));
    const second = await prepareViz(
      "demo",
      {
        ...exampleViz("bars"),
        title: "Different values",
        data: [{ id: "one", label: "Changed", value: 999 }],
        edges: [],
      },
      { expectedRevision: first.bundle.hash },
    );
    const { createVizRenderReceipt, validateVizRenderReceipt } = await import("../src/lib/viz/receipt");
    const { captureVizRenderInputs } = await import("../src/lib/viz/render-inputs");
    const plan = first.bundle.plans[0]!;
    const receipt = createVizRenderReceipt(
      {
        revision: first.bundle.hash,
        format: "landscape",
        backend: "svg",
        source: first.path,
        renderInputs: captureVizRenderInputs(root, first.path, plan),
        output: "synthetic.mp4",
        sha256: "a".repeat(64),
        assetId: "synthetic",
        id: "VizScene",
        width: 1920,
        height: 1080,
        fps: 30,
        durationInFrames: 150,
        firstFrame: 0,
        lastFrame: 149,
        frameCount: 150,
      },
      plan,
    );
    assert.doesNotThrow(() => validateVizRenderReceipt(receipt, first.bundle, first.path));
    assert.throws(
      () => validateVizRenderReceipt({ ...receipt, revision: second.bundle.hash }, second.bundle, second.path),
      /input identity/,
    );
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("compound ELK groups and fixed-side ports produce routed, bounded per-format plans", async () => {
  const spec = VizSpecSchema.parse({
    version: 1,
    sceneId: "compound",
    recipe: "process",
    groups: [
      { id: "outer", label: "Process" },
      { id: "inner", label: "Inputs", parent: "outer" },
    ],
    data: [
      { id: "input", label: "Входные данные", group: "inner", ports: [{ id: "out-port", side: "EAST" }] },
      { id: "output", label: "Результат", group: "outer", ports: [{ id: "in-port", side: "WEST" }] },
    ],
    edges: [{ id: "route", source: "input", target: "output", sourcePort: "out-port", targetPort: "in-port" }],
  });
  for (const format of ["vertical", "square", "landscape"] as const) {
    const plan = await compileViz(spec, format);
    assert.deepEqual(plan, await compileViz(spec, format));
    for (const id of ["outer", "inner", "out-port", "in-port", "route"])
      assert.ok(plan.primitives.some((p) => p.id === id));
    const route = plan.primitives.find((p) => p.id === "route")!;
    assert.match(route.d!, /^M/);
    const port = plan.primitives.find((p) => p.id === "out-port")!;
    const start = route.d!.match(/^M([^,]+),([^ L]+)/)!;
    assert.ok(Math.hypot(Number(start[1]) - port.x, Number(start[2]) - port.y) <= 8, JSON.stringify({ route, port }));
    for (const p of plan.primitives)
      if (p.kind !== "path") assert.ok(p.x >= 0 && p.x <= plan.width && p.y >= 0 && p.y <= plan.height);
  }
  const invalid = structuredClone(spec);
  invalid.edges[0]!.sourcePort = "in-port";
  assert.throws(() => validateViz(invalid), /belong/);
  const cyclic = structuredClone(spec);
  cyclic.groups![0]!.parent = "inner";
  assert.throws(() => validateViz(cyclic), /acyclic/);
  assert.throws(() => validateViz({ ...spec, layout: "force" }), /layered/);
});

test("layered network ports meet visible circles and transparent 3D containers use valid colours", async () => {
  const spec = VizSpecSchema.parse({
    version: 1,
    sceneId: "ports",
    recipe: "network",
    data: [
      { id: "a", label: "A", ports: [{ id: "out", side: "EAST" }] },
      { id: "b", label: "B", ports: [{ id: "in", side: "WEST" }] },
    ],
    edges: [{ id: "edge", source: "a", target: "b", sourcePort: "out", targetPort: "in" }],
  });
  const plan = await compileViz(spec, "landscape");
  const node = plan.primitives.find((p) => p.id === "a")!,
    port = plan.primitives.find((p) => p.id === "out")!;
  assert.equal(Math.hypot(node.x - port.x, node.y - port.y), node.radius! + port.radius!);
  const grouped = VizSpecSchema.parse({
    ...spec,
    recipe: "process-3d",
    groups: [{ id: "group", label: "Group" }],
    data: spec.data.map((d) => ({ ...d, group: "group" })),
    theme: { background: "transparent" },
  });
  const compiled = await compileViz(grouped, "landscape");
  const { bakeVizStates } = await import("../src/motion/viz/state");
  const state = bakeVizStates(compiled)
    .at(-1)!
    .find((p) => p.id === "group")!;
  assert.match(state.fill, /^#[0-9a-f]{6}$/i);
  assert.equal(state.opacity, 0);
});

test("compiled and supplied plan IDs reject generated-name and event-alias collisions", async () => {
  const bars = exampleViz("bars");
  for (const [id, value] of [
    ["axis-y-0", 10],
    ["tick-0", null],
    ["tick-0-label", 10],
  ] as const) {
    const spec = {
      ...bars,
      edges: [],
      data: [
        { id, label: "Conflicting", value },
        { id: "other", label: "Other", value: 20 },
      ],
    };
    await assert.rejects(() => compileViz(spec, "landscape"), /Generated visualisation ID.*rename/);
  }
  await assert.rejects(
    () =>
      compileViz(
        {
          ...bars,
          edges: [],
          data: [
            { id: "other-label", label: "Missing", value: null },
            { id: "other", label: "Other", value: 20 },
          ],
        },
        "landscape",
      ),
    /other-label.*rename/,
  );
  const line = exampleViz("line");
  await assert.rejects(
    () =>
      compileViz(
        {
          ...line,
          edges: [],
          data: [
            { id: "series-main", label: "Missing", value: null },
            { id: "other", label: "Other", value: 20 },
          ],
          events: [{ action: "highlight", target: "series-main", frame: 10, duration: 10 }],
        },
        "landscape",
      ),
    /series-main.*rename/,
  );
  await assert.rejects(
    () =>
      compileViz({ ...bars, unit: "ms", edges: [], data: [{ id: "unit", label: "Latency", value: 20 }] }, "landscape"),
    /unit.*rename/,
  );
  await assert.rejects(
    () =>
      compileViz(
        { ...bars, edges: [], data: [{ id: "legend-0", label: "Value", value: 20, series: "stable" }] },
        "landscape",
      ),
    /legend-0.*rename/,
  );
  await assert.rejects(
    () =>
      compileViz(
        { ...bars, recipe: "donut", edges: [], data: [{ id: "legend-swatch-0", label: "Share", value: 20 }] },
        "landscape",
      ),
    /legend-swatch-0.*rename/,
  );
  const tree = exampleViz("tree");
  await assert.rejects(
    () => compileViz({ ...tree, edges: [{ id: "edge-two", source: "one", target: "two" }] }, "landscape"),
    /edge-two.*rename/,
  );
  const grouped = VizSpecSchema.parse({
    version: 1,
    sceneId: "collision",
    recipe: "process",
    groups: [{ id: "group", label: "Group" }],
    data: [{ id: "first", label: "First", group: "group", ports: [{ id: "group-label", side: "EAST" }] }],
  });
  await assert.rejects(() => compileViz(grouped, "landscape"), /group-label.*rename/);
  const plan = await compileViz(bars, "landscape");
  assert.throws(
    () => VizPlanSchema.parse({ ...plan, primitives: [...plan.primitives, plan.primitives[0]] }),
    /primitive IDs must be unique/,
  );
  const ordinary = await compileViz(
    {
      ...bars,
      edges: [],
      data: [
        { id: "unit", label: "Unit", value: 10 },
        { id: "series-main", label: "Series", value: 20 },
      ],
    },
    "landscape",
  );
  assert.ok(ordinary.primitives.some((primitive) => primitive.id === "unit"));
});

test("layered layouts accept caller root IDs in all three formats", async () => {
  const spec = VizSpecSchema.parse({
    ...exampleViz("process"),
    data: [
      { id: "root", label: "Root" },
      { id: "leaf", label: "Leaf" },
    ],
    groups: [],
    edges: [{ id: "link", source: "root", target: "leaf" }],
  });
  for (const format of ["vertical", "square", "landscape"] as const) {
    const plan = await compileViz(spec, format);
    assert.ok(plan.primitives.some((primitive) => primitive.id === "root" && primitive.kind === "rect"));
    assert.ok(plan.primitives.some((primitive) => primitive.id === "link"));
    assert.equal(new Set(plan.primitives.map((primitive) => primitive.id)).size, plan.primitives.length);
  }
});

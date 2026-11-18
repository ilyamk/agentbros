import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { listFalGuards, registerFalGuard } from "../src/lib/providers/fal-guards/all";
import { fail } from "../src/lib/providers/fal-errors";

const url = "https://example.com/reference.png";
useTempFalCatalog([{ endpoint: "bytedance/seedream/v5/lite/edit" }, { endpoint: "meshy/v7/image-to-3d" }]);

test("built-in guards run references first, family guards in order, generic warnings last", () => {
  const ids = listFalGuards().map((guard) => guard.id);
  assert.deepEqual(ids.slice(0, 6), [
    "reference-urls",
    "gpt-image-2.5",
    "flux-2",
    "nano-banana-2.1",
    "kling",
    "seedance-2.5",
  ]);
  assert.ok(ids.includes("generated-3d"));
  assert.equal(ids.at(-1), "generic-warnings");
});

test("generic guards apply to catalogue endpoints", () => {
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "bytedance/seedream/v5/lite/edit",
        input: { prompt: "Edit", image_urls: ["public/projects/demo/a.png"] },
      }),
    /local path/,
  );
  assert.throws(
    () => buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: { image_url: "file:///tmp/a.png" } }),
    /protocol/,
  );
  const plan = buildFalOperation({
    endpoint: "bytedance/seedream/v5/lite/edit",
    input: { prompt: "Edit", image_urls: [url], sync_mode: true },
  });
  assert.ok(plan.warnings.some((warning) => /sync_mode/.test(warning)));
  assert.ok(plan.warnings.some((warning) => /lack local size\/duration metadata/.test(warning)));
  assert.ok(
    !buildFalOperation({
      endpoint: "bytedance/seedream/v5/lite/edit",
      input: { prompt: "Edit", image_urls: [url] },
      context: { media: { [url]: { bytes: 10 } } },
    }).warnings.some((warning) => /metadata/.test(warning)),
  );
});

test("legacy family guards still fire, and only for their family", () => {
  assert.throws(
    () =>
      buildFalOperation({
        family: "kling-v3",
        operation: "text-to-video",
        input: { prompt: "A", multi_prompt: [{ prompt: "B", duration: "5" }] },
      }),
    /mutually exclusive/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        family: "gpt-image-2.5",
        operation: "text-to-image",
        input: { prompt: "A", background: "transparent", output_format: "jpeg" },
      }),
    /Transparent/,
  );
  assert.equal(
    buildFalOperation({
      family: "seedance-2.5",
      operation: "text-to-video",
      input: { prompt: "A", draft: true, resolution: "1080p" },
    }).input.resolution,
    "480p",
  );
  // A catalogue endpoint never matches a legacy family guard.
  assert.doesNotThrow(() =>
    buildFalOperation({ endpoint: "bytedance/seedream/v5/lite/edit", input: { prompt: "Edit", image_urls: [url] } }),
  );
});

test("registerFalGuard extends the registry by category or prefix and rejects duplicates", () => {
  const seen: string[] = [];
  registerFalGuard({
    id: "test-image-to-3d",
    match: (info) => info.category === "image-to-3d",
    check: (input, _ctx, warnings, info) => {
      seen.push(info.endpoint);
      if (input.target_polycount === 1) fail("test guard: polycount too low.");
      warnings.push("test guard ran");
    },
  });
  registerFalGuard({
    id: "test-late",
    phase: "after",
    match: (info) => info.endpoint.startsWith("meshy/"),
    check: (_input, _ctx, warnings) => warnings.push("late"),
  });
  assert.throws(
    () => registerFalGuard({ id: "test-image-to-3d", match: () => false, check: () => {} }),
    /already registered/,
  );
  const ids = listFalGuards().map((guard) => guard.id);
  assert.ok(
    ids.indexOf("test-image-to-3d") < ids.indexOf("generic-warnings") &&
      ids.indexOf("generic-warnings") < ids.indexOf("test-late"),
  );
  const plan = buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: { image_url: url } });
  assert.deepEqual(seen, ["meshy/v7/image-to-3d"]);
  assert.ok(plan.warnings.includes("test guard ran"));
  assert.equal(plan.warnings.at(-1), "late");
  assert.throws(
    () => buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: { image_url: url, target_polycount: 1 } }),
    /polycount too low|minimum/,
  );
  const before = seen.length;
  buildFalOperation({ endpoint: "bytedance/seedream/v5/lite/edit", input: { prompt: "Edit", image_urls: [url] } });
  assert.equal(seen.length, before, "an image-to-image endpoint does not match the image-to-3d guard");
});

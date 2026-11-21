import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "./fixtures/provider-contracts/fal-valid.json";
import {
  buildFalOperation,
  listFalOperationAdapters,
  requireExecutableFalOperation,
  validateFalOperationResult,
  FalOperationError,
} from "../src/lib/providers/fal-operations";
import type { FalOperationRequest } from "../src/types/generation";
for (const fixture of fixtures) {
  test(`exact schema contract ${fixture.endpoint}`, () => {
    const request = fixture.request as FalOperationRequest;
    const plan = buildFalOperation(request);
    assert.equal(plan.endpoint, fixture.endpoint);
    assert.deepEqual(plan.input, request.input);
    assert.equal(plan.verification.live, false);
    assert.throws(
      () => buildFalOperation({ ...request, input: { ...request.input, unsupported_provider_option: true } }),
      /unsupported field/,
    );
    assert.doesNotThrow(() => requireExecutableFalOperation(plan));
    if (plan.transport === "stream" || plan.transport === "realtime")
      assert.ok(plan.warnings.some((warning) => /bounded/.test(warning)));
  });
}
const url = "https://example.com/reference.png";
function request(
  family: FalOperationRequest["family"],
  operation: string,
  input: Record<string, unknown>,
  extras: Partial<FalOperationRequest> = {},
): FalOperationRequest {
  return { family, operation, input, ...extras };
}
test("GPT sizes, transparency, compression, edit mask and current ten-output limit", () => {
  const valid = {
    prompt: "Create a product card",
    image_size: { width: 1024, height: 1024 },
    quality: "max",
    num_images: 10,
    background: "transparent",
    output_format: "webp",
    output_compression: 90,
  };
  assert.deepEqual(buildFalOperation(request("gpt-image-2.5", "text-to-image", valid)).input, valid);
  for (const patch of [
    { image_size: { width: 1000, height: 1024 } },
    { num_images: 11 },
    { output_format: "jpeg" },
    { output_format: "png" },
  ])
    assert.throws(() => buildFalOperation(request("gpt-image-2.5", "text-to-image", { ...valid, ...patch })));
  assert.equal(
    buildFalOperation(request("gpt-image-2.5", "edit", { prompt: "Repair label", image_urls: [url], mask_url: url }))
      .input.mask_url,
    url,
  );
  assert.throws(
    () => buildFalOperation(request("gpt-image-2.5", "edit", { prompt: "Repair label", image_urls: [] })),
    /at least one/,
  );
});
test("Nano supports context-only edit and rejects unsupported mask and oversized context", () => {
  const input = {
    prompt: "Illustrate this explanation",
    video_url: "https://example.com/context.mp4",
    resolution: "4K",
    thinking_level: "high",
    enable_web_search: true,
  };
  assert.equal(buildFalOperation(request("nano-banana-2.1", "edit", input)).input.video_url, input.video_url);
  assert.throws(
    () => buildFalOperation(request("nano-banana-2.1", "edit", { ...input, mask_url: url })),
    /unsupported field/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("nano-banana-2.1", "edit", input, {
          context: { media: { [input.video_url]: { bytes: 16 * 1024 * 1024 } } },
        }),
      ),
    /15 MB/,
  );
  assert.throws(() => buildFalOperation(request("nano-banana-2.1", "edit", { prompt: "Illustrate" })), /requires/);
});
test("Kling regional, native speech, exact start image and shot constraints", () => {
  assert.throws(
    () => buildFalOperation(request("kling-v3", "text-to-video", { prompt: "Scene" }, { variant: "4k" })),
    (error: unknown) => error instanceof FalOperationError && error.code === "REGION_RESTRICTED",
  );
  assert.equal(
    buildFalOperation(request("kling-v3", "text-to-video", { prompt: "Scene" }, { variant: "4k", region: "singapore" }))
      .endpoint,
    "fal-ai/kling-video/v3/4k/text-to-video",
  );
  assert.throws(
    () => buildFalOperation(request("kling-v3", "image-to-video", { prompt: "Scene", image_url: url })),
    /required|unsupported/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request(
          "kling-v3",
          "image-to-video",
          { prompt: "Scene", start_image_url: url },
          { context: { speechLanguage: "ru" } },
        ),
      ),
    /translated/,
  );
  assert.doesNotThrow(() =>
    buildFalOperation(
      request(
        "kling-v3",
        "image-to-video",
        { prompt: "Scene", start_image_url: url, generate_audio: false },
        { context: { speechLanguage: "ru" } },
      ),
    ),
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("kling-v3", "text-to-video", { prompt: "Scene", multi_prompt: [{ prompt: "Second", duration: "5" }] }),
      ),
    /mutually exclusive/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("kling-v3", "text-to-video", { duration: "10", multi_prompt: [{ prompt: "Second", duration: "5" }] }),
      ),
    /sum/,
  );
});
test("nested element and motion media constraints cannot be bypassed by anyOf", () => {
  assert.throws(
    () =>
      buildFalOperation(
        request("kling-v3", "image-to-video", {
          start_image_url: url,
          prompt: "Scene",
          elements: [{ frontal_image_url: url, reference_image_urls: [url], unknown: true }],
        }),
      ),
    /schema alternatives/,
  );
  const input = { image_url: url, video_url: "https://example.com/motion.mp4", character_orientation: "image" };
  assert.throws(
    () =>
      buildFalOperation(
        request("kling-v3", "motion-control", input, {
          context: { media: { [input.video_url]: { durationSec: 11 } } },
        }),
      ),
    /duration limit/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request(
          "kling-v3",
          "image-to-video",
          { start_image_url: url, end_image_url: url, prompt: "Scene" },
          { context: { media: { [url]: { bytes: 100 * 1024 * 1024 } } } },
        ),
      ),
    /media constraints/,
  );
});
test("Seedance draft, US routing, reference editing and duration limits", () => {
  assert.equal(
    buildFalOperation(request("seedance-2.5", "text-to-video", { prompt: "Scene", draft: true, resolution: "1080p" }))
      .input.resolution,
    "480p",
  );
  const editing = {
    task: "editing",
    prompt: "Edit",
    video_urls: ["https://example.com/ref.mp4"],
    duration: "10",
    aspect_ratio: "16:9",
  };
  const normalized = buildFalOperation(request("seedance-2.5", "reference-to-video", editing, { region: "us" }));
  assert.equal(normalized.endpoint, "bytedance/seedance-2.5/us/reference-to-video");
  assert.equal(normalized.input.duration, "auto");
  assert.equal(normalized.input.aspect_ratio, "auto");
  assert.throws(
    () =>
      buildFalOperation(
        request("seedance-2.5", "reference-to-video", { prompt: "Scene", image_urls: Array(31).fill(url) }),
      ),
    /count/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("seedance-2.5", "reference-to-video", editing, {
          context: { media: { [editing.video_urls[0]]: { durationSec: 31 } } },
        }),
      ),
    /duration/,
  );
  const draft = { id: "draft", createdAt: "2026-10-01T00:00:00.000Z", callerId: "caller" };
  // Drafts live 14 days since the 2026-11-21 schemas: day 10 completes, day 15 is refused.
  const completion = (now: string, resolution = "4k") =>
    buildFalOperation(
      request(
        "seedance-2.5",
        "complete",
        { draft_id: "draft", resolution },
        { variant: "draft", context: { draft, callerId: "caller", now } },
      ),
    );
  assert.equal(completion("2026-10-11T00:00:00.000Z").input.resolution, "4k");
  assert.throws(() => completion("2026-10-16T00:00:00.000Z"), /14 days/);
  assert.throws(
    () =>
      buildFalOperation(
        request(
          "seedance-2.5",
          "complete",
          { draft_id: "draft" },
          { variant: "draft", context: { draft, callerId: "other" } },
        ),
      ),
    /original caller/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("seedance-2.5", "complete", { draft_id: "draft", resolution: "720p" }, { variant: "draft" }),
      ),
    /1080p/,
  );
});
test("Seedance 2.5 accepts 4k but refuses MOV output, an implicit task and drafts on the US endpoints", () => {
  const prompt = { prompt: "A lighthouse at dusk" };
  assert.equal(
    buildFalOperation(request("seedance-2.5", "text-to-video", { ...prompt, resolution: "4k" })).input.resolution,
    "4k",
  );
  assert.equal(
    buildFalOperation(request("seedance-2.5", "text-to-video", { ...prompt, output_format: "mp4" })).input
      .output_format,
    "mp4",
  );
  assert.throws(
    () => buildFalOperation(request("seedance-2.5", "text-to-video", { ...prompt, output_format: "mov" })),
    /output_format must be mp4/,
  );
  assert.throws(
    () =>
      buildFalOperation(
        request("seedance-2.5", "reference-to-video", {
          ...prompt,
          task: "auto",
          image_urls: ["https://example.com/reference.png"],
        }),
      ),
    /task must be explicit/,
  );
  assert.equal(
    buildFalOperation(request("seedance-2.5", "text-to-video", { ...prompt, draft: true })).input.resolution,
    "480p",
  );
  assert.throws(
    () => buildFalOperation(request("seedance-2.5", "text-to-video", { ...prompt, draft: true }, { region: "us" })),
    /global endpoints only/,
  );
});
test("FLUX training and result schemas remain separate from image inference", () => {
  const plan = buildFalOperation(
    request(
      "flux-2",
      "train",
      { image_data_url: "https://example.com/dataset.zip", steps: 1000, default_caption: "Brand" },
      { variant: "dev" },
    ),
  );
  assert.equal(plan.transport, "training");
  assert.equal(plan.endpoint, "fal-ai/flux-2-trainer");
  assert.throws(
    () =>
      buildFalOperation(
        request(
          "flux-2",
          "train",
          { image_data_url: "https://example.com/dataset.zip", steps: 150 },
          { variant: "dev" },
        ),
      ),
    /multiple/,
  );
  assert.throws(() => validateFalOperationResult("openai/gpt-image-2.5/flare/text-to-image", {}), /required/);
  assert.deepEqual(
    validateFalOperationResult("openai/gpt-image-2.5/flare/text-to-image", { images: [{ url }], provider_extra: true }),
    { images: [{ url }], provider_extra: true },
  );
});
test("adapter inventory distinguishes schema support from live execution", () => {
  const entries = listFalOperationAdapters();
  assert.equal(entries.length, 102);
  assert.ok(entries.every((entry) => entry.verification.schema && !entry.verification.live));
  assert.equal(entries.filter((entry) => entry.transport === "stream" && entry.executable).length, 6);
  assert.equal(entries.filter((entry) => entry.transport === "realtime" && entry.executable).length, 1);
  assert.throws(
    () => buildFalOperation(request("flux-2", "text-to-image", { prompt: "Scene" }, { variant: "invented" })),
    /verified schema/,
  );
});
test("local references require upload and dangerous URI schemes fail before submit", () => {
  for (const reference of ["public/projects/demo/image.png", "file:///tmp/image.png", "javascript:alert(1)"]) {
    assert.throws(
      () => buildFalOperation(request("gpt-image-2.5", "edit", { prompt: "Edit", image_urls: [reference] })),
      /reference|protocol/,
    );
  }
});

for (const variant of ["flare", "sunburst"]) {
  test(`GPT 2.6 ${variant} semantic guards and result contract`, () => {
    const endpoint = `openai/gpt-image-2.6/${variant}/edit`;
    const input = { prompt: "Repair label", image_urls: [url] };
    assert.doesNotThrow(() => buildFalOperation({ endpoint, input }));
    for (const patch of [
      { image_urls: [] },
      { background: "transparent", output_format: "jpeg" },
      { output_format: "png", output_compression: 90 },
      { output_format: "gif", output_compression: 90 },
      { image_size: { width: 1000, height: 1024 } },
      { num_images: 11 },
    ]) {
      assert.throws(() => buildFalOperation({ endpoint, input: { ...input, ...patch } }));
    }
    assert.throws(() => validateFalOperationResult(endpoint, {}), /required/);
    assert.deepEqual(validateFalOperationResult(endpoint, { images: [{ url }] }), { images: [{ url }] });
  });
}

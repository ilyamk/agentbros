import assert from "node:assert/strict";
import test from "node:test";
import { higgsfieldMediaCapabilities, mediaUrlFields } from "../src/lib/providers/higgsfield/media-fields";
import { prepareHiggsfieldInput } from "../src/lib/providers/higgsfield/uploads";
import { assertHiggsfieldPublicInput, createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";

test("every cached Higgsfield URL input survives estimate/submit preparation without upload", async () => {
  const models = higgsfieldMediaCapabilities();
  assert.ok(models.length >= 88);
  assert.ok(models.filter((model) => model.fields.length).length >= 59);
  for (const model of models.filter((row) => row.fields.length)) {
    const input: Record<string, unknown> = {};
    for (const field of model.fields) {
      const keys = field
        .split("/")
        .slice(1)
        .map((value) => (value === "*" ? "0" : value));
      let parent = input;
      for (let index = 0; index < keys.length - 1; index++) {
        parent[keys[index]] ??= keys[index + 1] === "0" ? [] : {};
        parent = parent[keys[index]] as Record<string, unknown>;
      }
      parent[keys.at(-1)!] = `https://cdn.example.com/original/${encodeURIComponent(field)}?signature=test`;
    }
    assertHiggsfieldPublicInput(input);
    const prepared = await prepareHiggsfieldInput(input, {
      client: {
        createUpload: async () => {
          throw Error(`Unexpected upload: ${model.endpoint}`);
        },
        putUpload: async () => {
          throw Error("Unexpected PUT");
        },
      },
      uploads: [],
      persistUpload: () => {
        throw Error("Unexpected saved upload");
      },
    });
    assert.deepEqual(prepared, input, model.endpoint);
    let body: unknown;
    const client = createHiggsfieldClient({
      credentials: "fixture:secret",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ request_id: "fixture" }), { status: 200 });
      },
    });
    await client.submit(model.endpoint, prepared, { idempotencyKey: "fixture-operation" });
    assert.deepEqual(body, input, model.endpoint);
  }
  assert.deepEqual(models.find((row) => row.endpoint === "v1/custom-references")?.fields, [
    "/input_images/*/image_url",
  ]);
  assert.ok(models.filter((row) => row.schema === "unavailable").every((row) => row.fields.length === 0));
});

test("media URL discovery handles nested schema refs/compositions and guards reject unsafe public inputs", () => {
  assert.deepEqual(
    mediaUrlFields({
      type: "object",
      $defs: { Ref: { type: "object", properties: { image_url: { type: "string", format: "uri" } } } },
      properties: {
        objects: { type: "array", items: { $ref: "#/$defs/Ref" } },
        video_urls: { anyOf: [{ type: "array", items: { type: "string", format: "uri" } }] },
      },
    }),
    ["/objects/*/image_url", "/video_urls/*"],
  );
  for (const value of [
    "http://127.0.0.1/video",
    "file:///video",
    "https://user:pass@example.com/a",
    "https://cdn.example.com/a#fragment",
  ])
    assert.throws(() => assertHiggsfieldPublicInput({ input_images: [{ image_url: value }] }), /public HTTP/);
  assert.doesNotThrow(() =>
    assertHiggsfieldPublicInput({
      prompt: "See file:///reference in the description",
      image_urls: ["https://cdn.example.com/image.jpg"],
    }),
  );
});

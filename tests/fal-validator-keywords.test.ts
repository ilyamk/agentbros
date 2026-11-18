import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { snapshotFromOpenApi, type FalApiModel } from "../src/lib/providers/fal-openapi";
import {
  exampleFromSchema,
  resolveSchema,
  unsupportedKeywords,
  validateJsonSchema,
  validateMediaConstraints,
  type JsonSchema,
  type SchemaComponents,
} from "../src/lib/providers/json-schema-validate";
import { FalOperationError } from "../src/lib/providers/fal-operations";

const fixtures = path.join(import.meta.dirname, "fixtures/fal-catalog");
const manifest = JSON.parse(readFileSync(path.join(fixtures, "manifest.json"), "utf8")) as {
  endpoints: Record<string, { sha256: string; category: string }>;
};
const none: SchemaComponents = {};
const check = (schema: JsonSchema, value: unknown, components = none) =>
  validateJsonSchema(schema, value, { components });
const invalid = (error: unknown) => error instanceof FalOperationError && error.code === "INVALID_INPUT";

test("nullable accepts null and keeps the type check for other values", () => {
  check({ type: "array", items: { type: "string" }, nullable: true }, null);
  check({ type: "array", items: { type: "string" }, nullable: true }, ["a"]);
  assert.throws(() => check({ type: "array", nullable: true }, "a"), /expected array/);
  assert.throws(() => check({ type: "array" }, null), /expected array/);
});

test("discriminator picks the mapped branch and falls back to oneOf for unmapped tags", () => {
  const components: SchemaComponents = {
    Cat: {
      type: "object",
      properties: { kind: { const: "cat" }, lives: { type: "integer", minimum: 1 } },
      required: ["kind", "lives"],
    },
    Dog: { type: "object", properties: { kind: { const: "dog" }, bark: { type: "boolean" } }, required: ["kind"] },
  };
  const schema: JsonSchema = {
    oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
    discriminator: {
      propertyName: "kind",
      mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
    },
  };
  check(schema, { kind: "cat", lives: 9 }, components);
  check(schema, { kind: "dog" }, components);
  // The chosen branch reports its own field error, not the generic alternatives message.
  assert.throws(() => check(schema, { kind: "cat", lives: 0 }, components), /input\.lives: below minimum 1/);
  assert.throws(() => check(schema, { kind: "cat" }, components), /lives: required/);
  assert.throws(() => check(schema, { kind: "cow" }, components), /schema alternatives/);
  // Without a mapping the tag is the schema name: "Cat" selects the Cat branch, whose own const then rejects it.
  const unmapped: JsonSchema = { oneOf: schema.oneOf, discriminator: { propertyName: "kind" } };
  assert.throws(() => check(unmapped, { kind: "Cat", lives: 9 }, components), /input\.kind: expected cat/);
  check(unmapped, { kind: "dog" }, components);
});

test("minProperties and maxProperties count object keys", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: { type: "string" },
    minProperties: 2,
    maxProperties: 3,
  };
  check(schema, { a: "1", b: "2" });
  assert.throws(() => check(schema, { a: "1" }), /too few properties/);
  assert.throws(() => check(schema, { a: "1", b: "2", c: "3", d: "4" }), /too many properties/);
});

test("format checks uri and date-time and ignores unknown formats", () => {
  check({ type: "string", format: "uri" }, "https://example.com/a.png");
  assert.throws(() => check({ type: "string", format: "uri" }, "not a uri"), /absolute URI/);
  check({ type: "string", format: "date-time" }, "2026-11-15T10:00:00Z");
  check({ type: "string", format: "date-time" }, "2026-11-15T10:00:00.123+03:00");
  assert.throws(() => check({ type: "string", format: "date-time" }, "15 Nov 2026"), /ISO date-time/);
  assert.throws(() => check({ type: "string", format: "date-time" }, "2026-13-45T10:00:00Z"), /ISO date-time/);
  check({ type: "string", format: "password" }, "anything");
});

test("exclusiveMaximum, uniqueItems and prefixItems", () => {
  check({ type: "number", exclusiveMaximum: 1 }, 0.99);
  assert.throws(() => check({ type: "number", exclusiveMaximum: 1 }, 1), /must be below 1/);
  assert.throws(() => check({ type: "number", maximum: 1, exclusiveMaximum: true }, 1), /must be below 1/);
  check({ type: "array", uniqueItems: true }, [1, 2, { a: 1 }, { a: 2 }]);
  assert.throws(
    () =>
      check({ type: "array", uniqueItems: true }, [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    /unique/,
  );
  const tuple: JsonSchema = {
    type: "array",
    prefixItems: [{ type: "number" }, { anyOf: [{ type: "number" }, { type: "null" }] }],
    minItems: 2,
    maxItems: 2,
  };
  check(tuple, [0, null]);
  assert.throws(() => check(tuple, ["a", 1]), /\[0\]: expected finite number/);
});

test("documentation and UI keywords never change the verdict", () => {
  const schema: JsonSchema = {
    type: "string",
    title: "T",
    description: "D",
    examples: ["x"],
    example: "x",
    default: "x",
    "x-fal-order-properties": [],
    _fal_ui_field: "image",
    field: "image",
    limit_description: "l",
    ui: { field: "image" },
    deprecated: true,
    readOnly: true,
    writeOnly: true,
  };
  check(schema, "value");
  assert.throws(() => check(schema, 1), /expected string/);
  assert.deepEqual(unsupportedKeywords(schema, none), []);
});

test("unsupportedKeywords walks subschemas, not property names or opaque values", () => {
  const components: SchemaComponents = {
    Node: {
      type: "object",
      properties: { next: { $ref: "#/components/schemas/Node" }, format: { type: "string" }, ui: { type: "string" } },
      patternProperties: {},
    },
  };
  assert.deepEqual(unsupportedKeywords({ $ref: "#/components/schemas/Node" }, components), ["patternProperties"]);
  assert.deepEqual(
    unsupportedKeywords({ anyOf: [{ not: { type: "null" } }], enum: [{ weird: 1 }], default: { if: 1 } }, none),
    ["not"],
  );
  assert.deepEqual(unsupportedKeywords({ $ref: "#/components/schemas/Missing" }, none), [
    "$ref:#/components/schemas/Missing",
  ]);
});

test("an unresolved reference is an unsupported operation, not invalid input", () => {
  assert.throws(
    () => check({ $ref: "#/components/schemas/Missing" }, {}),
    (error: unknown) => error instanceof FalOperationError && error.code === "UNSUPPORTED_OPERATION",
  );
  // Inside alternatives it must propagate rather than count as a failed branch.
  assert.throws(
    () => check({ anyOf: [{ $ref: "#/components/schemas/Missing" }, { type: "string" }] }, "a"),
    (error: unknown) => error instanceof FalOperationError && error.code === "UNSUPPORTED_OPERATION",
  );
});

test("file limits outside x-fal apply only when the URL has media metadata", () => {
  const url = "https://example.com/a.png";
  const schema: JsonSchema = {
    type: "object",
    properties: {
      image_url: { type: "string", max_file_size: 1000, max_pixels: 10000, max_width: 200 },
      clip_url: {
        anyOf: [{ type: "string" }, { type: "null" }],
        min_duration: 2,
        max_duration: 10,
        min_aspect_ratio: 0.5,
        max_aspect_ratio: 2,
      },
      area_url: { type: "string", min_area: 100, max_area: 400 },
    },
  };
  const media = (meta: Record<string, Record<string, number>>) =>
    validateMediaConstraints(
      schema,
      { image_url: url, clip_url: url, area_url: url },
      { components: none, media: meta },
    );
  media({});
  media({ [url]: { bytes: 900, width: 15, height: 15, durationSec: 5 } });
  assert.throws(
    () => media({ [url]: { bytes: 1001 } }),
    (error: unknown) => invalid(error) && /bytes exceeds/.test(String(error)),
  );
  assert.throws(() => media({ [url]: { width: 201, height: 1 } }), /width exceeds|aspect ratio|area/);
  assert.throws(() => media({ [url]: { durationSec: 11 } }), /durationSec exceeds/);
  assert.throws(() => media({ [url]: { durationSec: 1 } }), /durationSec exceeds/);
  assert.throws(() => media({ [url]: { width: 30, height: 10 } }), /aspect ratio/);
  assert.throws(() => media({ [url]: { width: 9, height: 9 } }), /area exceeds/);
  assert.throws(
    () =>
      validateMediaConstraints(schema.properties!.image_url!, url, {
        components: none,
        media: { [url]: { width: 101, height: 100 } },
      }),
    /pixels exceeds/,
  );
});

test("exampleFromSchema honours bounds, defaults and placeholders", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["count", "ratio", "steps", "name", "image_url", "mode", "maybe", "tags"],
    properties: {
      count: { type: "integer", minimum: 3, maximum: 9 },
      ratio: { type: "number", exclusiveMinimum: 0, maximum: 0.5 },
      steps: { type: "integer", minimum: 101, multipleOf: 10 },
      name: { type: "string", minLength: 12 },
      image_url: { type: "string" },
      mode: { type: "string", enum: ["a", "b"], default: "b" },
      maybe: { anyOf: [{ type: "null" }, { type: "integer" }] },
      tags: { type: "array", items: { type: "string" }, minItems: 2 },
      optional: { type: "string" },
    },
  };
  const example = exampleFromSchema(schema, none) as Record<string, unknown>;
  check(schema, example);
  assert.equal(example.count, 3);
  assert.equal(example.steps, 110);
  assert.equal(example.mode, "b");
  assert.match(String(example.image_url), /^https:\/\//);
  assert.ok(!("optional" in example));
  const custom = exampleFromSchema(schema, none, {
    placeholders: { name: "a twelve char", image_url: "https://cdn.example/x.png" },
  }) as Record<string, unknown>;
  assert.equal(custom.image_url, "https://cdn.example/x.png");
  check(schema, custom);
});

const recorded = Object.entries(manifest.endpoints).map(([endpoint, { sha256 }]) => {
  const model = JSON.parse(readFileSync(path.join(fixtures, "schemas", `${sha256}.json`), "utf8")) as FalApiModel;
  let snapshot;
  try {
    snapshot = snapshotFromOpenApi(model, "2026-11-15", sha256);
  } catch {
    snapshot = undefined;
  }
  return { endpoint, snapshot };
});

test("the recorded fixtures cover queue schemas and schema-less realtime", () => {
  assert.ok(recorded.filter((item) => item.snapshot).length >= 50);
  assert.ok(recorded.some((item) => !item.snapshot && /realtime/.test(item.endpoint)));
});

for (const { endpoint, snapshot } of recorded) {
  if (!snapshot) continue;
  test(`recorded schema ${endpoint}: keywords supported, minimal input valid, extra field rejected`, () => {
    const components = snapshot.schemas as SchemaComponents;
    const input = snapshot.input as JsonSchema,
      output = snapshot.output as JsonSchema;
    assert.deepEqual(unsupportedKeywords(input, components), [], "input schema");
    assert.deepEqual(unsupportedKeywords(output, components), [], "output schema");
    const example = exampleFromSchema(input, components);
    assert.doesNotThrow(() => validateJsonSchema(input, example, { components, strict: true }));
    assert.doesNotThrow(() =>
      validateJsonSchema(
        output,
        exampleFromSchema(output, components, {
          placeholders: endpoint === "mirelo-ai/sfx2.0/video-to-audio" ? { model: "sfx-2.0" } : {},
        }),
        { components, strict: false },
      ),
    );
    if (resolveSchema(input, components).additionalProperties === undefined) {
      assert.throws(
        () =>
          validateJsonSchema(
            input,
            { ...(example as object), avc_unexpected_field: true },
            { components, strict: true },
          ),
        /unsupported field/,
      );
    }
  });
}

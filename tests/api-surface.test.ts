import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareSurfaces,
  extractCliContract,
  extractFlags,
  SURFACE_PATH,
  type ApiSurface,
} from "../src/lib/api-surface";
import { stableJson, withSources } from "../src/lib/api-surface/source";

const fixture = (): ApiSurface => ({
  version: 1,
  commands: [
    {
      alias: "demo",
      script: "scripts/demo.ts",
      section: "dev",
      spend: "none",
      flags: [{ name: "mode", required: false, type: "string", choices: ["one", "two"] }],
      unknown: [],
    },
  ],
  schemas: [
    {
      id: "Example",
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          nested: { type: "object", properties: { mode: { enum: ["a", "b"] } } },
        },
        required: [],
      },
    },
  ],
  blocks: [{ id: "example", props: ["text"], schema: { type: "object", properties: { text: { type: "string" } } } }],
  mcpTools: [{ name: "avc_demo", script: "scripts/demo.ts", schema: {} }],
  playbooks: ["example"],
  environmentVariables: ["EXAMPLE_KEY"],
  cliContract: { successRequired: ["ok", "outputs"] },
  unknown: [],
});

const breaking: [string, (surface: ApiSurface) => void][] = [
  [
    "command removed",
    (surface) => {
      surface.commands = [];
    },
  ],
  [
    "flag removed",
    (surface) => {
      surface.commands[0]!.flags = [];
    },
  ],
  [
    "required flag added",
    (surface) => {
      surface.commands[0]!.flags.push({ name: "input", type: "string", required: true });
    },
  ],
  [
    "flag made required",
    (surface) => {
      surface.commands[0]!.flags[0]!.required = true;
    },
  ],
  [
    "flag enum narrowed",
    (surface) => {
      surface.commands[0]!.flags[0]!.choices = ["one"];
    },
  ],
  [
    "schema field removed",
    (surface) => {
      delete (surface.schemas[0]!.schema.properties as Record<string, unknown>).text;
    },
  ],
  [
    "schema field made required",
    (surface) => {
      surface.schemas[0]!.schema.required = ["text"];
    },
  ],
  [
    "nested enum narrowed",
    (surface) => {
      (
        (surface.schemas[0]!.schema.properties as Record<string, Record<string, Record<string, unknown>>>).nested!
          .properties!.mode as Record<string, unknown>
      ).enum = ["a"];
    },
  ],
  [
    "block removed",
    (surface) => {
      surface.blocks = [];
    },
  ],
  [
    "block prop removed",
    (surface) => {
      surface.blocks[0]!.props = [];
    },
  ],
  [
    "MCP tool removed",
    (surface) => {
      surface.mcpTools = [];
    },
  ],
  [
    "CLI contract field removed",
    (surface) => {
      surface.cliContract.successRequired = ["ok"];
    },
  ],
  [
    "schema bound tightened",
    (surface) => {
      (surface.schemas[0]!.schema.properties as Record<string, Record<string, unknown>>).text!.maxLength = 10;
    },
  ],
];
for (const [name, mutate] of breaking)
  test(`comparison is breaking: ${name}`, () => {
    const before = fixture();
    const after = fixture();
    mutate(after);
    const report = compareSurfaces(before, after);
    assert.equal(report.classification, "breaking");
    assert.ok(report.breaking.length > 0);
  });

test("optional flag, command, block and schema property additions are minor", () => {
  for (const mutate of [
    (surface: ApiSurface) => {
      surface.commands[0]!.flags.push({ name: "optional", required: false, type: "boolean" });
    },
    (surface: ApiSurface) => {
      surface.commands.push({ ...surface.commands[0]!, alias: "new" });
    },
    (surface: ApiSurface) => {
      surface.blocks.push({ id: "new", props: [], schema: {} });
    },
    (surface: ApiSurface) => {
      (surface.schemas[0]!.schema.properties as Record<string, unknown>).extra = { type: "string" };
    },
    (surface: ApiSurface) => {
      surface.commands[0]!.flags[0]!.choices!.push("three");
    },
  ]) {
    const after = fixture();
    mutate(after);
    assert.equal(compareSurfaces(fixture(), after).classification, "minor");
  }
});

test("identical, descriptions and defaults-only changes are patch; breaking wins over additions", () => {
  assert.equal(compareSurfaces(fixture(), fixture()).classification, "patch");
  const after = fixture();
  after.schemas[0]!.schema.description = "New description";
  after.commands[0]!.flags[0]!.default = "one";
  assert.equal(compareSurfaces(fixture(), after).classification, "patch");
  after.blocks = [];
  after.playbooks.push("new");
  assert.equal(compareSurfaces(fixture(), after).classification, "breaking");
  assert.equal(stableJson({ b: 1, a: { d: 1, c: 2 } }), stableJson({ a: { c: 2, d: 1 }, b: 1 }));
});

test("static flags handle inline arrays, SPECS, spreads and unresolved expressions without execution", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "api-flags-"));
  try {
    writeFileSync(path.join(directory, "tsconfig.json"), '{"include":["*.ts"]}');
    writeFileSync(
      path.join(directory, "flags.ts"),
      `
const BASE = [{name: 'input', required: true, short: 'i', choices: ['a', 'b']}];
const SPECS = [...BASE, {name: 'force', type: 'boolean'}, DYNAMIC];
parseArgs(SPECS); parseArgs([{name: 'count', type: 'number', default: 3}]);
throw new Error('must never execute');`,
    );
    const result = withSources(directory, ["flags.ts"], (sources) => extractFlags(sources.get("flags.ts")!));
    assert.deepEqual(
      result.flags.map((flag) => flag.name),
      ["count", "force", "help", "input"],
    );
    assert.deepEqual(
      result.flags.find((flag) => flag.name === "input"),
      { name: "input", type: "string", required: true, short: "i", choices: ["a", "b"] },
    );
    assert.ok(result.unknown.includes("DYNAMIC"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reference changes, array/map restrictions and union/intersection changes are classified", () => {
  const run = (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const old = fixture();
    const current = fixture();
    old.schemas[0]!.schema = before;
    current.schemas[0]!.schema = after;
    return compareSurfaces(old, current).classification;
  };
  assert.equal(run({ $ref: "#/$defs/Loose" }, { $ref: "#/$defs/Strict" }), "breaking");
  assert.equal(run({ type: "array" }, { type: "array", items: { type: "string" } }), "breaking");
  assert.equal(
    run({ additionalProperties: { type: "string" } }, { additionalProperties: { type: "string", maxLength: 4 } }),
    "breaking",
  );
  assert.equal(run({ prefixItems: [{ enum: ["a", "b"] }] }, { prefixItems: [{ enum: ["a"] }] }), "breaking");
  for (const union of ["anyOf", "oneOf"]) {
    const old = { [union]: [{ type: "string" }] };
    const current = { [union]: [{ type: "string" }, { type: "number" }] };
    assert.equal(run(old, current), "minor");
    assert.equal(run(current, old), "breaking");
  }
  const old = { allOf: [{ type: "string" }] };
  const current = { allOf: [{ type: "string" }, { maxLength: 4 }] };
  assert.equal(run(old, current), "breaking");
  assert.equal(run(current, old), "minor");
});

test("CLI envelope fields are derived from the shared type declarations", () => {
  const contract = withSources(process.cwd(), ["src/lib/cli/types.ts"], (sources) =>
    extractCliContract(sources.get("src/lib/cli/types.ts")!),
  );
  assert.deepEqual(contract.successRequired, ["elapsedMs", "metadata", "ok", "outputs"]);
  assert.deepEqual(contract.errorOptional, ["details", "metadata", "outputs", "retryAfterMs"]);
  assert.deepEqual((JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as ApiSurface).cliContract, contract);
});

test("generated surface is complete, stable and --check passes with one JSON line", () => {
  const snapshot = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as ApiSurface;
  assert.ok(snapshot.schemas.length > 300);
  assert.ok(snapshot.blocks.length > 100);
  assert.ok(snapshot.mcpTools.length > 50);
  assert.ok(
    snapshot.commands.find((command) => command.alias === "api:surface")?.flags.some((flag) => flag.name === "check"),
  );
  assert.ok(
    snapshot.commands
      .find((command) => command.alias === "generate:model")
      ?.flags.some((flag) => flag.name === "operation-id"),
  );
  assert.ok(snapshot.schemas.some((schema) => schema.id === "src/types/playbook.ts#PlaybookSchema"));
  assert.equal(stableJson(snapshot), readFileSync(SURFACE_PATH, "utf8"));
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/api-surface.ts", "--check"], {
    encoding: "utf8",
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
    timeout: 120000,
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(child.stdout).ok, true);
});

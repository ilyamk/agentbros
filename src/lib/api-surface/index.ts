import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SyntaxKind as K, type SourceFile } from "typescript/unstable/ast";
import { COMMAND_REGISTRY } from "../cli/commands";
import { COMMANDS } from "../../mcp/catalog";
import type { Catalogue } from "../library/catalogue";
import {
  children,
  evaluator,
  filesUnder,
  readSource,
  stableJson,
  walk,
  withSources,
  type Evaluation,
  type Literal,
} from "./source";

export const SURFACE_PATH = "docs/api/surface.json";
export type JsonSchema = Record<string, unknown>;
export interface SurfaceFlag {
  name: string;
  type: string;
  required: boolean;
  short?: string;
  choices?: string[];
  default?: Literal;
}
export interface SurfaceCommand {
  alias: string | null;
  script: string | null;
  section: string;
  spend: string;
  flags: SurfaceFlag[];
  unknown: string[];
}
export interface ApiSurface {
  version: 1;
  commands: SurfaceCommand[];
  cliContract: Record<string, string[]>;
  schemas: { id: string; schema: JsonSchema }[];
  blocks: { id: string; props: string[]; schema: JsonSchema }[];
  mcpTools: { name: string; script: string; schema: JsonSchema }[];
  playbooks: string[];
  environmentVariables: string[];
  unknown: string[];
}

function importedValue(
  file: string,
  name: string,
  sources: Map<string, SourceFile>,
  seen: Set<string>,
): Evaluation | undefined {
  const key = `${file}:${name}`;
  if (seen.has(key)) return { unknown: [key] };
  const source = sources.get(file);
  if (!source) return undefined;
  for (const node of children(source).filter((node) => node.kind === K.ImportDeclaration)) {
    const parts = children(node);
    const module = parts
      .find((part) => part.kind === K.StringLiteral)
      ?.getText(source)
      .slice(1, -1);
    if (!module?.startsWith(".")) continue;
    let imported: string | undefined;
    walk(node, (part) => {
      if (part.kind !== K.ImportSpecifier) return;
      const names = children(part).map((child) => child.getText(source));
      if (names.at(-1) === name) imported = names[0];
    });
    if (!imported) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), module)).replace(/\.js$/, "");
    const target = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => sources.has(candidate));
    if (!target) return { unknown: [key] };
    const targetSource = sources.get(target)!;
    const nextSeen = new Set([...seen, key]);
    const reader = evaluator(targetSource, (other) => importedValue(target, other, sources, nextSeen));
    const declaration = reader.declarations.get(imported);
    return declaration ? reader.value(declaration) : { unknown: [key] };
  }
  return undefined;
}

/** The snapshot follows the shared envelope declarations, including optional fields. */
export function extractCliContract(source: SourceFile): Record<string, string[]> {
  const contract: Record<string, string[]> = {};
  walk(source, (node) => {
    if (node.kind !== K.TypeAliasDeclaration) return;
    const parts = children(node);
    const name = parts.find((part) => part.kind === K.Identifier)?.getText(source);
    const prefix = name === "CliSuccess" ? "success" : name === "CliError" ? "error" : undefined;
    if (!prefix) return;
    const literal = parts.find((part) => part.kind === K.TypeLiteral);
    if (!literal) throw new Error(`CLI contract ${name} must remain a type literal.`);
    contract[`${prefix}Required`] = [];
    contract[`${prefix}Optional`] = [];
    for (const field of children(literal).filter((part) => part.kind === K.PropertySignature)) {
      const properties = children(field);
      const optional = properties.some((part) => part.kind === K.QuestionToken);
      contract[`${prefix}${optional ? "Optional" : "Required"}`]!.push(properties[0]!.getText(source));
    }
  });
  if (!contract.successRequired || !contract.errorRequired)
    throw new Error("Shared CLI contract declarations not found.");
  for (const fields of Object.values(contract)) fields.sort();
  return contract;
}

export function extractFlags(
  source: SourceFile,
  resolve?: (name: string) => Evaluation | undefined,
): { flags: SurfaceFlag[]; unknown: string[] } {
  const reader = evaluator(source, resolve);
  const flags = new Map<string, SurfaceFlag>();
  const unknown: string[] = [];
  let found = false;
  walk(source, (node) => {
    if (node.kind !== K.CallExpression) return;
    const parts = children(node);
    if (parts[0]?.getText(source) !== "parseArgs" || !parts[1]) return;
    found = true;
    const result = reader.value(parts[1]);
    unknown.push(...result.unknown);
    if (!Array.isArray(result.value)) return;
    for (const value of result.value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.name !== "string") {
        unknown.push("Unresolved flag specification");
        continue;
      }
      flags.set(value.name, {
        name: value.name,
        type: typeof value.type === "string" ? value.type : "string",
        required: value.required === true,
        ...(typeof value.short === "string" ? { short: value.short } : {}),
        ...(Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === "string")
          ? { choices: value.choices as string[] }
          : {}),
        ...(value.default !== undefined ? { default: value.default } : {}),
      });
    }
  });
  if (found) flags.set("help", { name: "help", type: "boolean", required: false, short: "h" });
  else unknown.push("No static parseArgs specification; flags are unknown");
  return {
    flags: [...flags.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unknown: [...new Set(unknown)].sort(),
  };
}

export async function buildSurface(root = process.cwd()): Promise<ApiSurface> {
  const files = [
    ...filesUnder(root, "src", /\.tsx?$/).filter((file) => !file.startsWith("src/projects/")),
    ...filesUnder(root, "scripts", /\.ts$/),
  ];
  const staticData = withSources(root, files, (sources) => {
    const environmentVariables = new Set<string>();
    for (const source of sources.values())
      walk(source, (node) => {
        const parts = children(node);
        if (node.kind === K.PropertyAccessExpression && parts[0]?.getText(source) === "process.env")
          environmentVariables.add(parts.at(-1)!.getText(source));
        if (
          node.kind === K.ElementAccessExpression &&
          parts[0]?.getText(source) === "process.env" &&
          parts[1]?.kind === K.StringLiteral
        )
          environmentVariables.add(parts[1].getText(source).slice(1, -1));
      });
    const commands = COMMAND_REGISTRY.map((entry) => {
      const source = entry.script ? sources.get(entry.script) : undefined;
      const specs = source
        ? extractFlags(source, (name) => importedValue(entry.script!, name, sources, new Set()))
        : {
            flags: [],
            unknown: entry.script ? ["Script source unavailable"] : ["Direct tool alias; flags are unknown"],
          };
      return { alias: entry.alias, script: entry.script, section: entry.section, spend: entry.paid, ...specs };
    }).sort((a, b) => (a.alias ?? a.script ?? "").localeCompare(b.alias ?? b.script ?? ""));
    return {
      commands,
      cliContract: extractCliContract(sources.get("src/lib/cli/types.ts")!),
      environmentVariables: [...environmentVariables].sort(),
    };
  });
  const schemas: ApiSurface["schemas"] = [];
  const unknown: string[] = [];
  // Zod 4 provides toJSONSchema. Only schema modules are imported; CLI sources are never executed.
  for (const file of filesUnder(root, "src/types", /\.ts$/)) {
    const exports = (await import(pathToFileURL(path.join(root, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports).sort()) {
      if (!(value instanceof z.ZodType)) continue;
      try {
        schemas.push({
          id: `${file}#${name}`,
          schema: z.toJSONSchema(value, { io: "input", unrepresentable: "any", cycles: "ref", reused: "ref" }),
        });
      } catch (error) {
        unknown.push(`${file}#${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const catalogue = JSON.parse(readSource(root, "docs/library/catalogue.json")) as Catalogue;
  const playbooks = filesUnder(root, "playbooks", /\/playbook\.json$/)
    .map((file) => (JSON.parse(readSource(root, file)) as { id: string }).id)
    .sort();
  return {
    version: 1,
    ...staticData,
    schemas,
    blocks: catalogue.items
      .map((item) => ({
        id: item.id,
        props: Object.keys((item.propsSchema as { properties?: object }).properties ?? {}).sort(),
        schema: item.propsSchema as JsonSchema,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    mcpTools: COMMANDS.map((tool) => ({
      name: `avc_${tool.name}`,
      script: `scripts/${tool.script}`,
      schema: z.toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" }),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    playbooks,
    unknown: [
      ...unknown,
      "JSON Schema cannot represent custom refinements or transforms; unrepresentable types are emitted as {}.",
      "Environment scan covers literal process.env reads in src/ (excluding projects) and scripts/; dynamic keys and native workers are unknown.",
    ],
  };
}

export interface SurfaceComparison {
  classification: "breaking" | "minor" | "patch";
  breaking: string[];
  added: string[];
}
/** Narrowing: removals, newly required inputs, reduced enums/types, tighter bounds or closed additional properties. Recurses into properties, items and definitions. */
export function compareSurfaces(before: ApiSurface, after: ApiSurface): SurfaceComparison {
  const breaking: string[] = [];
  const added: string[] = [];
  const names = (old: string[], current: string[], at: string) => {
    old.filter((name) => !current.includes(name)).forEach((name) => breaking.push(`${at}: removed ${name}`));
    current.filter((name) => !old.includes(name)).forEach((name) => added.push(`${at}: added ${name}`));
  };
  const schema = (old: JsonSchema, current: JsonSchema, at: string) => {
    if (old.$ref !== current.$ref && current.$ref !== undefined) breaking.push(`${at}: schema reference changed`);
    const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
    if (Array.isArray(old.enum) && currentEnum && old.enum.some((value) => !currentEnum.includes(value)))
      breaking.push(`${at}: enum narrowed`);
    if (Array.isArray(old.enum) && currentEnum && currentEnum.some((value) => !(old.enum as unknown[]).includes(value)))
      added.push(`${at}: enum values added`);
    if (!old.enum && current.enum) breaking.push(`${at}: enum restriction added`);
    if ("const" in current && (!("const" in old) || stableJson(old.const) !== stableJson(current.const)))
      breaking.push(`${at}: constant changed`);
    const oldRequired = Array.isArray(old.required) ? (old.required as string[]) : [];
    const newRequired = Array.isArray(current.required) ? (current.required as string[]) : [];
    newRequired
      .filter((name) => !oldRequired.includes(name))
      .forEach((name) => breaking.push(`${at}: ${name} made required`));
    if (
      current.type &&
      (!old.type ||
        (Array.isArray(old.type) ? old.type : [old.type]).some(
          (type) => !(Array.isArray(current.type) ? current.type : [current.type]).includes(type),
        ))
    )
      breaking.push(`${at}: type narrowed`);
    for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"])
      if (typeof current[key] === "number" && (typeof old[key] !== "number" || current[key] > old[key]))
        breaking.push(`${at}: ${key} increased`);
    for (const key of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"])
      if (typeof current[key] === "number" && (typeof old[key] !== "number" || current[key] < old[key]))
        breaking.push(`${at}: ${key} decreased`);
    if (current.additionalProperties === false && old.additionalProperties !== false)
      breaking.push(`${at}: additional properties closed`);
    for (const key of ["properties", "$defs", "definitions"]) {
      const previous = (old[key] ?? {}) as Record<string, JsonSchema>;
      const next = (current[key] ?? {}) as Record<string, JsonSchema>;
      names(Object.keys(previous), Object.keys(next), `${at}.${key}`);
      for (const name of Object.keys(previous)) if (next[name]) schema(previous[name]!, next[name]!, `${at}.${name}`);
    }
    if (current.items && typeof current.items === "object" && !Array.isArray(current.items))
      schema((old.items ?? {}) as JsonSchema, current.items as JsonSchema, `${at}[]`);
    if (current.additionalProperties && typeof current.additionalProperties === "object")
      schema(
        (typeof old.additionalProperties === "object" ? old.additionalProperties : {}) as JsonSchema,
        current.additionalProperties as JsonSchema,
        `${at}.*`,
      );
    const oldTuple = old.prefixItems as JsonSchema[] | undefined;
    const newTuple = current.prefixItems as JsonSchema[] | undefined;
    if (newTuple)
      for (let index = 0; index < newTuple.length; index++)
        schema(oldTuple?.[index] ?? {}, newTuple[index]!, `${at}[${index}]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const previous = old[key] as JsonSchema[] | undefined;
      const next = current[key] as JsonSchema[] | undefined;
      if (!previous && !next) continue;
      if (key === "allOf") {
        if ((next?.length ?? 0) > (previous?.length ?? 0)) breaking.push(`${at}: allOf constraints added`);
        if ((next?.length ?? 0) < (previous?.length ?? 0)) added.push(`${at}: allOf constraints relaxed`);
      } else {
        if (!previous && next) breaking.push(`${at}: ${key} restriction added`);
        else if (previous && (!next || next.length > previous.length))
          added.push(`${at}: ${key} alternatives broadened`);
        if (previous && next && next.length < previous.length) breaking.push(`${at}: ${key} alternatives removed`);
      }
      if (previous && next && previous.length === next.length)
        for (let index = 0; index < previous.length; index++)
          schema(previous[index]!, next[index]!, `${at}.${key}[${index}]`);
      else if (previous && next) {
        const removed = previous.filter(
          (branch) => !next.some((candidate) => stableJson(candidate) === stableJson(branch)),
        );
        const inserted = next.filter(
          (branch) => !previous.some((candidate) => stableJson(candidate) === stableJson(branch)),
        );
        if (key === "allOf" ? inserted.length > 0 : removed.length > 0)
          breaking.push(`${at}: ${key} constraints changed`);
      }
    }
  };
  const rows = <T>(
    old: T[],
    current: T[],
    id: (row: T) => string,
    at: string,
    check: (a: T, b: T, key: string) => void,
  ) => {
    const next = new Map(current.map((row) => [id(row), row]));
    names(old.map(id), current.map(id), at);
    for (const row of old) {
      const key = id(row);
      const found = next.get(key);
      if (found) check(row, found, `${at}.${key}`);
    }
  };
  rows(
    before.commands,
    after.commands,
    (row) => row.alias ?? row.script!,
    "commands",
    (a, b, at) => {
      rows(
        a.flags,
        b.flags,
        (flag) => flag.name,
        at,
        (old, current, key) => {
          if (!old.required && current.required) breaking.push(`${key}: flag made required`);
          schema(
            { type: old.type, ...(old.choices ? { enum: old.choices } : {}) },
            { type: current.type, ...(current.choices ? { enum: current.choices } : {}) },
            key,
          );
          if (old.short && old.short !== current.short) breaking.push(`${key}: short flag removed`);
        },
      );
      for (const flag of b.flags)
        if (flag.required && !a.flags.some((old) => old.name === flag.name))
          breaking.push(`${at}.${flag.name}: required flag added`);
    },
  );
  rows(
    before.schemas,
    after.schemas,
    (row) => row.id,
    "schemas",
    (a, b, at) => schema(a.schema, b.schema, at),
  );
  rows(
    before.blocks,
    after.blocks,
    (row) => row.id,
    "blocks",
    (a, b, at) => {
      names(a.props, b.props, at);
      schema(a.schema, b.schema, at);
    },
  );
  rows(
    before.mcpTools,
    after.mcpTools,
    (row) => row.name,
    "mcpTools",
    (a, b, at) => schema(a.schema, b.schema, at),
  );
  names(before.playbooks, after.playbooks, "playbooks");
  names(before.environmentVariables, after.environmentVariables, "environmentVariables");
  for (const [key, value] of Object.entries(before.cliContract))
    names(value, after.cliContract[key] ?? [], `cliContract.${key}`);
  return {
    classification: breaking.length ? "breaking" : added.length ? "minor" : "patch",
    breaking: [...new Set(breaking)].sort(),
    added: [...new Set(added)].sort(),
  };
}

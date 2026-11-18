import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { z } from "zod";
import { ProbeSchema } from "./libraries/blender";
import { RecipeMetaSchema } from "./recipe-schema";
import { listRecipes } from "./recipes";
import { ExtensionsManifestSchema } from "../../types/blender-extensions";
import { CollectionSchema, IndexSchema, ManifestSchema } from "./libraries/schemas";

const FlagSchema = z
  .object({
    name: z.string(),
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    choices: z.array(z.string()).nullable(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    short: z.string().nullable(),
  })
  .strict();
export const CheckoutInventorySchema = z
  .object({
    commands: z.record(
      z.string(),
      z
        .object({
          script: z.string().nullable(),
          flags: z.array(FlagSchema),
          actions: z.array(z.string()),
          positionalAction: z.boolean(),
          sourceHash: z.string(),
        })
        .strict(),
    ),
    recipes: z.array(RecipeMetaSchema),
    assets: z.array(z.object({ id: z.string(), licence: z.string(), sourceStatus: z.string() }).strict()),
    collections: z.record(z.string(), z.array(z.string())),
    extensions: z.array(z.object({ id: z.string(), status: z.string() }).strict()),
  })
  .strict();
export type CheckoutInventory = z.infer<typeof CheckoutInventorySchema>;
export type FlagContract = z.infer<typeof FlagSchema>;
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
}
function literal(
  node: ts.Expression | undefined,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): unknown {
  if (!node) return undefined;
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    return literal(constants.get(node.text), constants, seen);
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((e) => (ts.isExpression(e) ? literal(e, constants, new Set(seen)) : undefined));
  return undefined;
}
function contracts(file: string, ast: ts.SourceFile) {
  const constants = new Map<string, ts.Expression>(),
    flags: FlagContract[] = [],
    actions = new Set<string>();
  walk(ast, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
      constants.set(n.name.text, n.initializer);
  });
  walk(ast, (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, ts.Expression>();
      for (const prop of node.properties)
        if (ts.isPropertyAssignment(prop)) props.set(prop.name.getText(ast).replaceAll(/["']/g, ""), prop.initializer);
      const name = literal(props.get("name"), constants);
      if (typeof name !== "string" || !props.has("description")) return;
      const type = literal(props.get("type"), constants),
        choices = literal(props.get("choices"), constants),
        def = literal(props.get("default"), constants),
        short = literal(props.get("short"), constants);
      flags.push({
        name,
        type: type === "boolean" || type === "number" ? type : "string",
        required: literal(props.get("required"), constants) === true,
        choices: Array.isArray(choices) && choices.every((v) => typeof v === "string") ? choices : null,
        defaultValue: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? def : null,
        short: typeof short === "string" ? short : null,
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments[0]?.getText(ast) === "action"
    ) {
      const values = literal(node.expression.expression, constants);
      if (Array.isArray(values)) for (const v of values) if (typeof v === "string") actions.add(v);
    }
  });
  for (const name of ["actions", "ACTIONS"]) {
    const value = literal(constants.get(name), constants);
    if (Array.isArray(value)) for (const action of value) if (typeof action === "string") actions.add(action);
  }
  const code = readFileSync(file, "utf8");
  return {
    flags: [...new Map(flags.map((f) => [f.name, f])).values()],
    actions: [...actions],
    positionalAction: /(?:unshift\(['"]--action|splice\(2, 1, ['"]--action|const action = tokens\[0\])/.test(code),
    sourceHash: digest(code),
  };
}

/** Inspect the target checkout as data: never execute its registry, CLI or recipe code. */
export function inspectCheckout(root: string): CheckoutInventory {
  const registryPath = path.join(root, "src/lib/cli/commands.ts");
  const api = new API({ cwd: root });
  try {
    const scriptDirectory = path.join(root, "scripts");
    const files = [
      registryPath,
      ...(existsSync(scriptDirectory)
        ? readdirSync(scriptDirectory)
            .filter((n) => n.endsWith(".ts"))
            .map((n) => path.join(scriptDirectory, n))
        : []),
    ];
    const snapshot = api.updateSnapshot({ openFiles: files });
    const sourceFile = (file: string) => {
      const source = snapshot
        .getProjects()
        .map((project) => project.program.getSourceFile(file))
        .find(Boolean);
      if (!source) throw new Error(`Cannot statically parse ${file}`);
      return source;
    };
    const registry = sourceFile(registryPath),
      commands: CheckoutInventory["commands"] = {};
    walk(registry, (node) => {
      if (!ts.isCallExpression(node) || node.expression.getText(registry) !== "c") return;
      const alias = literal(node.arguments[0], new Map()),
        script = literal(node.arguments[1], new Map());
      if (typeof alias !== "string") return;
      const relative = typeof script === "string" ? (script.includes("/") ? script : `scripts/${script}`) : null;
      commands[alias] =
        relative && existsSync(path.join(root, relative))
          ? { script: relative, ...contracts(path.join(root, relative), sourceFile(path.join(root, relative))) }
          : { script: relative, flags: [], actions: [], positionalAction: false, sourceHash: "" };
    });
    const librariesFile = path.join(root, "blender-arsenal/libraries.json");
    const libraries = existsSync(librariesFile) ? ManifestSchema.parse(read(librariesFile)) : null;
    const assets = new Map<string, CheckoutInventory["assets"][number]>();
    for (const item of libraries?.items ?? [])
      assets.set(item.id, {
        id: item.id,
        licence: item.licence,
        sourceStatus: libraries!.sources.find((s) => item.id.startsWith(`${s.id}:`))?.status ?? "unknown",
      });
    const index = path.join(root, "blender-arsenal/local/library/index.json");
    if (existsSync(index))
      for (const item of IndexSchema.parse(read(index)).assets)
        assets.set(item.id, {
          id: item.id,
          licence: item.licence,
          sourceStatus: libraries?.sources.find((s) => s.id === item.source)?.status ?? "local",
        });
    const bundledFile = path.join(root, "blender-arsenal/local/library/blender-bundled.json");
    if (existsSync(bundledFile)) {
      const bundled = ProbeSchema.parse(read(bundledFile));
      for (const file of bundled.files) {
        const relative = path.relative(bundled.systemRoot, file.path).split(path.sep).join("/");
        if (relative.startsWith("../") || path.isAbsolute(relative))
          throw new Error("Bundled inventory path escapes its system root");
        const id = `essentials:${digest(relative).slice(0, 24)}`;
        if (file.assets.length && !assets.has(id)) assets.set(id, { id, licence: "CC0-1.0", sourceStatus: "bundled" });
      }
    }
    const collections: Record<string, string[]> = {},
      directory = path.join(root, "blender-arsenal/collections");
    if (existsSync(directory))
      for (const name of readdirSync(directory).filter((n) => n.endsWith(".json"))) {
        const collection = CollectionSchema.parse(read(path.join(directory, name)));
        collections[collection.name] = collection.items;
        for (const id of collection.items)
          if (!assets.has(id)) assets.set(id, { id, licence: "unknown", sourceStatus: "unknown" });
      }
    const extFile = path.join(root, "blender-arsenal/extensions.json");
    const extensions = existsSync(extFile)
      ? ExtensionsManifestSchema.parse(read(extFile)).extensions.map((e) => ({ id: e.id, status: e.status }))
      : [];
    return CheckoutInventorySchema.parse({
      commands,
      recipes: existsSync(path.join(root, "scripts/blender/recipes")) ? listRecipes(root) : [],
      assets: [...assets.values()],
      collections,
      extensions,
    });
  } finally {
    api.close();
  }
}

export function parsePlannedCommand(argv: string[], inventory: CheckoutInventory) {
  const faults: string[] = [],
    values: Record<string, string | boolean | number> = {};
  const alias = argv[1] ?? "",
    contract = inventory.commands[alias];
  if (argv[0] !== "pnpm" || !contract)
    return { alias, values, action: "", faults: [`Unknown checkout command: ${argv.slice(0, 2).join(" ")}`] };
  if (!contract.script || !contract.sourceHash || !contract.flags.length)
    faults.push(`${alias}: no statically verifiable parser contract`);
  const tokens = argv.slice(2);
  if (tokens[0] === "--") tokens.shift();
  let action = "";
  if (tokens[0] && !tokens[0].startsWith("-")) {
    action = tokens.shift()!;
    if (
      !contract.positionalAction ||
      ![...contract.actions, ...(contract.flags.find((f) => f.name === "action")?.choices ?? [])].includes(action)
    )
      faults.push(`${alias}: unsupported positional action ${action}`);
  }
  for (const spec of contract.flags) if (spec.defaultValue !== null) values[spec.name] = spec.defaultValue;
  if (action && contract.flags.some((f) => f.name === "action")) values.action = action;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!,
      eq = token.indexOf("="),
      flag = eq < 0 ? token : token.slice(0, eq);
    if (flag === "--help" || flag === "-h") {
      values.help = true;
      continue;
    }
    const direct = contract.flags.find((f) => flag === `--${f.name}` || (f.short && flag === `-${f.short}`));
    const negate = !direct && flag.startsWith("--no-"),
      spec =
        direct ?? (negate ? contract.flags.find((f) => f.name === flag.slice(5) && f.type === "boolean") : undefined);
    if (!spec) {
      faults.push(`${alias}: unknown flag ${flag}`);
      continue;
    }
    let raw: string | undefined;
    if (negate) {
      if (eq >= 0) faults.push(`${alias}: negated flag takes no value`);
      values[spec.name] = false;
      continue;
    }
    if (spec.type === "boolean" && eq < 0) {
      values[spec.name] = true;
      continue;
    }
    raw = eq >= 0 ? token.slice(eq + 1) : tokens[++i];
    if (raw === undefined || (eq < 0 && raw.startsWith("--"))) {
      faults.push(`${alias}: missing value for ${flag}`);
      continue;
    }
    if (spec.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) faults.push(`${alias}: ${flag} requires a finite number`);
      else values[spec.name] = value;
    } else if (spec.type === "boolean") {
      if (!["true", "false", "1", "0"].includes(raw)) faults.push(`${alias}: ${flag} requires a boolean`);
      else values[spec.name] = raw === "true" || raw === "1";
    } else {
      if (spec.choices && !spec.choices.includes(raw)) faults.push(`${alias}: ${flag} rejects ${raw}`);
      values[spec.name] = raw;
    }
  }
  if (action && values.action !== undefined && values.action !== action) faults.push(`${alias}: conflicting actions`);
  action ||= typeof values.action === "string" ? values.action : "";
  if (!values.help)
    for (const spec of contract.flags)
      if (spec.required && values[spec.name] === undefined) faults.push(`${alias}: --${spec.name} required`);
  return { alias, values, action, faults };
}

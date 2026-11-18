import * as acorn from "acorn";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest } from "../jobs/model-artifacts";

/** Node-side analysis only. Never evaluates or rewrites authored source. */
const parserRoot = dirname(createRequire(import.meta.url).resolve("acorn/package.json"));
const parserHash = (name: string) => {
  const file = join(parserRoot, name),
    stat = statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw Error("Instance parser provenance regular file/byte bound");
  return digest(readFileSync(file));
};
if (acorn.version !== "8.19.0") throw Error("Instance parser requires reviewed Acorn8.19.0");
export const INSTANCE_PARSER_PIN = Object.freeze({
  name: "acorn",
  version: "8.19.0",
  esmSha256: "76254fc76529713b4dfd2532972d17a991ffd9aafeebb1f977445b5506b9fb0b",
  cjsSha256: "b95392d79457d0357555c5ed3e56302d074b92dff119bcf3b44179500b10e9df",
  packageSha256: "04d6fecaafb5e3d20a38fc3b64fed84bb3830a7759a8c00400ebcb87331fec00",
  licenseSha256: "76a876cf886ff9be2a8b5e2e86514fed06223c8c9f0c1e9ee9606e93841e00b7",
});
const observedParser = {
  name: "acorn",
  version: acorn.version,
  esmSha256: parserHash("dist/acorn.mjs"),
  cjsSha256: parserHash("dist/acorn.js"),
  packageSha256: parserHash("package.json"),
  licenseSha256: parserHash("LICENSE"),
};
export function validateInstanceParserProvenance(value: unknown) {
  if (JSON.stringify(value) !== JSON.stringify(INSTANCE_PARSER_PIN))
    throw Error("Instance parser source/provenance mismatch");
}
validateInstanceParserProvenance(observedParser);
export const INSTANCE_PARSER_OPTIONS = Object.freeze({
  ecmaVersion: 2022,
  sourceType: "script",
  allowReturnOutsideFunction: false,
  allowAwaitOutsideFunction: false,
  allowImportExportEverywhere: false,
  allowHashBang: false,
} as const);
export const INSTANCE_SCRIPT_LIMITS = Object.freeze({ bytes: 32 * 1024, calls: 128, targets: 32 });
const eases = new Set([
  "none",
  "power1.in",
  "power1.out",
  "power1.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.in",
  "power3.out",
  "power3.inOut",
  "power4.in",
  "power4.out",
  "power4.inOut",
  "sine.in",
  "sine.out",
  "sine.inOut",
]);
const ranges: Record<string, readonly [number, number]> = {
  opacity: [0, 1],
  scale: [0, 8],
  scaleX: [0, 8],
  scaleY: [0, 8],
  rotation: [-3600, 3600],
};
const colors = new Set(["color", "backgroundColor", "borderColor"]);
const fail = (message: string): never => {
  throw Error("Instance script: " + message);
};
const literalString = (node: acorn.Node): node is acorn.Literal & { value: string } =>
  node.type === "Literal" && typeof (node as acorn.Literal).value === "string";
const identifier = (node: acorn.Node, name: string): node is acorn.Identifier =>
  node.type === "Identifier" && (node as acorn.Identifier).name === name;
const number = (node: acorn.Expression): number => {
  let value: number;
  if (node.type === "Literal" && typeof node.value === "number") value = node.value;
  else if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number"
  )
    value = -node.argument.value;
  else return fail("requires finite literal number");
  if (!Number.isFinite(value) || Math.abs(value) > 36001) return fail("numeric bound");
  return value;
};
const members = (node: acorn.Expression) => {
  if (node.type !== "ObjectExpression" || node.properties.length > 16) return fail("requires bounded literal object");
  const result = new Map<string, acorn.Expression>();
  for (const member of node.properties) {
    if (
      member.type !== "Property" ||
      member.computed ||
      member.method ||
      member.shorthand ||
      member.kind !== "init" ||
      (member.key.type !== "Identifier" && !literalString(member.key))
    )
      return fail("computed/spread/method property unsupported");
    const key = member.key.type === "Identifier" ? member.key.name : String((member.key as acorn.Literal).value);
    if (result.has(key)) return fail("duplicate property");
    result.set(key, member.value as acorn.Expression);
  }
  return result;
};
const property = (node: acorn.Node, owner: string, name: string): node is acorn.MemberExpression =>
  node.type === "MemberExpression" &&
  !(node as acorn.MemberExpression).computed &&
  !(node as acorn.MemberExpression).optional &&
  identifier((node as acorn.MemberExpression).object, owner) &&
  identifier((node as acorn.MemberExpression).property, name);

export function validateInstanceScript(
  source: string,
  context: { authoredId: string; ownedTargetIds: readonly string[]; duration: number },
) {
  if (Buffer.byteLength(source) > INSTANCE_SCRIPT_LIMITS.bytes) return fail("source byte bound");
  if (!Number.isFinite(context.duration) || context.duration <= 0 || context.duration > 36001)
    return fail("duration bound");
  let ast: acorn.Program;
  try {
    ast = acorn.parse(source, INSTANCE_PARSER_OPTIONS);
  } catch {
    return fail("syntax error");
  }
  const statements = ast.body;
  if (statements.length < 3 || statements.length > INSTANCE_SCRIPT_LIMITS.calls + 2) return fail("statement count");
  const first = statements[0];
  if (first.type !== "VariableDeclaration" || first.kind !== "const" || first.declarations.length !== 1)
    return fail("requires one const timeline declaration");
  const declaration = first.declarations[0],
    init = declaration.init;
  if (
    !identifier(declaration.id, "timeline") ||
    !init ||
    init.type !== "CallExpression" ||
    init.optional ||
    !property(init.callee, "gsap", "timeline") ||
    init.arguments.length !== 1 ||
    init.arguments[0].type === "SpreadElement"
  )
    return fail("requires local paused gsap timeline");
  const options = members(init.arguments[0]);
  const paused = options.get("paused");
  if (options.size !== 1 || paused?.type !== "Literal" || paused.value !== true)
    return fail("requires only paused=true");
  const last = statements[statements.length - 1];
  if (
    last.type !== "ExpressionStatement" ||
    last.directive ||
    last.expression.type !== "AssignmentExpression" ||
    last.expression.operator !== "="
  )
    return fail("requires exact own timeline publication");
  const assignment = last.expression,
    left = assignment.left;
  if (
    left.type !== "MemberExpression" ||
    !left.computed ||
    left.optional ||
    !property(left.object, "window", "__timelines") ||
    !literalString(left.property) ||
    left.property.value !== context.authoredId ||
    !identifier(assignment.right, "timeline")
  )
    return fail("requires exact own timeline publication");
  const owned = new Set(context.ownedTargetIds),
    targets = new Set<string>();
  let end = 0;
  for (const statement of statements.slice(1, -1)) {
    if (
      statement.type !== "ExpressionStatement" ||
      statement.directive ||
      statement.expression.type !== "CallExpression"
    )
      return fail("only timeline calls allowed");
    const call = statement.expression,
      method = call.callee;
    if (
      call.optional ||
      method.type !== "MemberExpression" ||
      method.computed ||
      method.optional ||
      !identifier(method.object, "timeline") ||
      method.property.type !== "Identifier" ||
      !["set", "to", "from", "fromTo"].includes(method.property.name) ||
      call.arguments.some((arg) => arg.type === "SpreadElement")
    )
      return fail("unsupported timeline method");
    const args = call.arguments as acorn.Expression[],
      fromTo = method.property.name === "fromTo",
      expected = fromTo ? 4 : 3;
    if (args.length !== expected) return fail("requires explicit bounded absolute position");
    const target = args[0];
    if (
      !literalString(target) ||
      !/^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(target.value) ||
      !owned.has(target.value.slice(1))
    )
      return fail("selector outside own declared targets");
    targets.add(target.value.slice(1));
    if (targets.size > INSTANCE_SCRIPT_LIMITS.targets) return fail("target count");
    const position = number(args[expected - 1]);
    if (position < 0) return fail("negative position");
    let duration = 0;
    for (let i = 1; i < expected - 1; i++) {
      const vars = members(args[i]);
      let animated = 0;
      for (const [key, value] of vars) {
        if (Object.hasOwn(ranges, key)) {
          const n = number(value),
            [min, max] = ranges[key];
          if (n < min || n > max) return fail("animation property bound");
          animated++;
        } else if (colors.has(key)) {
          if (!literalString(value) || !/^#[0-9a-fA-F]{6}$/.test(value.value))
            return fail("requires literal six-digit color");
          animated++;
        } else if (key === "duration" && i === expected - 2 && method.property.name !== "set") {
          duration = number(value);
          if (duration <= 0) return fail("positive duration required");
        } else if (key === "ease" && i === expected - 2 && method.property.name !== "set") {
          if (!literalString(value) || !eases.has(value.value)) return fail("unsupported literal ease");
        } else return fail("property outside closed animation whitelist");
      }
      if (!animated) return fail("empty animation vars");
      if (i === expected - 2 && method.property.name !== "set" && !vars.has("duration"))
        return fail("explicit duration required");
    }
    if (position + duration > context.duration) return fail("animation exceeds own duration");
    end = Math.max(end, position + duration);
  }
  if (end <= 0) return fail("requires positive timeline duration");
  return {
    scriptSha256: digest(source),
    parser: INSTANCE_PARSER_PIN,
    parserOptions: INSTANCE_PARSER_OPTIONS,
    targets: [...targets].sort(),
    duration: end,
    calls: statements.length - 2,
  };
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind as K, type Node, type SourceFile } from "typescript/unstable/ast";

/** Deliberately excludes projects, generated outputs, credentials and symlinks. */
export function filesUnder(root: string, directory: string, pattern: RegExp): string[] {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.posix.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, file, pattern) : entry.isFile() && pattern.test(file) ? [file] : [];
    })
    .sort();
}
export const readSource = (root: string, file: string): string => readFileSync(path.join(root, file), "utf8");
export function children(node: Node): Node[] {
  const result: Node[] = [];
  node.forEachChild((child) => {
    result.push(child);
  });
  return result;
}
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}
export function withSources<T>(root: string, files: string[], inspect: (sources: Map<string, SourceFile>) => T): T {
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files.map((file) => path.join(root, file)) });
    const sources = new Map<string, SourceFile>();
    for (const file of files) {
      const source = snapshot
        .getProjects()
        .map((project) => project.program.getSourceFile(path.join(root, file)))
        .find(Boolean);
      if (!source) throw new Error(`TypeScript source unavailable: ${file}`);
      sources.set(file, source);
    }
    return inspect(sources);
  } finally {
    api.close();
  }
}
export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };
export type Evaluation = { value?: Literal; unknown: string[] };

/** Reads data expressions only. Calls, getters and script bodies are never executed. */
export function evaluator(
  source: SourceFile,
  resolve?: (name: string) => Evaluation | undefined,
): { value: (node: Node, seen?: Set<string>) => Evaluation; declarations: Map<string, Node> } {
  const declarations = new Map<string, Node>();
  walk(source, (node) => {
    if (node.kind !== K.VariableDeclaration) return;
    const parts = children(node);
    if (parts[0]?.kind === K.Identifier && parts.length > 1) declarations.set(parts[0].getText(source), parts.at(-1)!);
  });
  const value = (node: Node, seen = new Set<string>()): Evaluation => {
    const text = node.getText(source);
    const parts = children(node);
    if (
      [K.AsExpression, K.SatisfiesExpression, K.ParenthesizedExpression, K.TypeAssertionExpression].includes(node.kind)
    )
      return value(parts[0]!, seen);
    if ([K.StringLiteral, K.NoSubstitutionTemplateLiteral].includes(node.kind))
      return { value: text.slice(1, -1), unknown: [] };
    if (node.kind === K.NumericLiteral) return { value: Number(text), unknown: [] };
    if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword) return { value: text === "true", unknown: [] };
    if (node.kind === K.NullKeyword) return { value: null, unknown: [] };
    if (node.kind === K.Identifier && declarations.has(text) && !seen.has(text))
      return value(declarations.get(text)!, new Set([...seen, text]));
    if (node.kind === K.Identifier && !declarations.has(text)) {
      const external = resolve?.(text);
      if (external) return external;
    }
    if (node.kind === K.ArrayLiteralExpression) {
      const result: Literal[] = [];
      const unknown: string[] = [];
      for (const part of parts) {
        const spread = part.kind === K.SpreadElement;
        const row = value(spread ? children(part)[0]! : part, seen);
        unknown.push(...row.unknown);
        if (spread && Array.isArray(row.value)) result.push(...row.value);
        else if (row.value !== undefined) result.push(row.value);
      }
      return { value: result, unknown };
    }
    if (node.kind === K.ObjectLiteralExpression) {
      const result: Record<string, Literal> = {};
      const unknown: string[] = [];
      for (const part of parts) {
        const fields = children(part);
        if (part.kind === K.SpreadAssignment) {
          const row = value(fields[0]!, seen);
          unknown.push(...row.unknown);
          if (row.value && typeof row.value === "object" && !Array.isArray(row.value)) Object.assign(result, row.value);
        } else if (part.kind === K.PropertyAssignment) {
          const key = fields[0]!.getText(source).replace(/^['"]|['"]$/g, "");
          const row = value(fields.at(-1)!, seen);
          unknown.push(...row.unknown);
          if (row.value !== undefined) result[key] = row.value;
        } else unknown.push(part.getText(source));
      }
      return { value: result, unknown };
    }
    if (node.kind === K.BinaryExpression && /\*/.test(text)) {
      const left = value(parts[0]!, seen);
      const right = value(parts.at(-1)!, seen);
      if (parts[1]?.getText(source) === "*" && typeof left.value === "number" && typeof right.value === "number")
        return { value: left.value * right.value, unknown: [] };
    }
    return { unknown: [text] };
  };
  return { value, declarations };
}

/** Sort object keys recursively; array order is meaningful and is preserved. */
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, sort(child)]),
          )
        : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

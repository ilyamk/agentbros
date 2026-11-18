/**
 * The front matter of a memory entry: a strict YAML subset that this module writes and reads.
 * One `key: value` per line; `scope:` and `source:` are maps indented by two spaces. Values are JSON
 * (valid YAML flow); a bare word or number is accepted for hand edits. Anything else is an error.
 */

const TOP = /^([A-Za-z]+):(?:[ \t]+([^\n]*))?$/;
const NESTED = /^ {2}([A-Za-z]+):[ \t]+([^\n]*)$/;
/** JSON.stringify leaves U+2028 and U+2029 raw; escape them so every value stays on its line. */
const json = (value: unknown) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function parseValue(raw: string, line: number): unknown {
  const value = raw.trim();
  if (/^["[{]/.test(value) || /^-?\d+(\.\d+)?$/.test(value) || ["true", "false", "null"].includes(value)) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`line ${line}: not a JSON value: ${value}`);
    }
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 _.:+-]*$/.test(value)) return value;
  throw new Error(`line ${line}: quote this value as a JSON string: ${value}`);
}

/** Splits `---` front matter from the body and parses it; throws with a line number on anything outside the subset. */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalised = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalised);
  if (!match) throw new Error("no front matter: the file must start with --- and close it with ---");
  const data: Record<string, unknown> = {};
  let map: Record<string, unknown> | null = null;
  match[1]!.split("\n").forEach((line, index) => {
    const number = index + 2;
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const nested = NESTED.exec(line);
    if (nested) {
      if (!map) throw new Error(`line ${number}: an indented key outside a map`);
      if (nested[1]! in map) throw new Error(`line ${number}: duplicate key ${nested[1]}`);
      map[nested[1]!] = parseValue(nested[2]!, number);
      return;
    }
    const top = TOP.exec(line);
    if (!top) throw new Error(`line ${number}: expected "key: value"`);
    if (top[1]! in data) throw new Error(`line ${number}: duplicate key ${top[1]}`);
    if (top[2] === undefined || !top[2].trim()) {
      map = {};
      data[top[1]!] = map;
    } else {
      map = null;
      data[top[1]!] = parseValue(top[2], number);
    }
  });
  return { data, body: normalised.slice(match[0].length).replace(/^\n/, "") };
}

/** Writes `data` (one level of nested maps) as front matter, every value as JSON, followed by the body. */
export function serialiseFrontMatter(data: Record<string, unknown>, body = ""): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue !== undefined) lines.push(`  ${inner}: ${json(innerValue)}`);
      }
    } else {
      lines.push(`${key}: ${json(value)}`);
    }
  }
  lines.push("---");
  const text = body.trim();
  return `${lines.join("\n")}\n${text ? `\n${text}\n` : ""}`;
}

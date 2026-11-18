import { PrBlockSchema, type PrBlock } from "../../types/contrib";

/** Deliberately small subset: scalar values, inline scalar lists and comments. */
export function parseFields(source: string): Record<string, unknown> {
  const fields: Record<string, unknown> = Object.create(null);
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    let quote = "";
    let line = "";
    for (const char of raw) {
      if (quote) {
        if (char === quote) quote = "";
      } else if ((char === "'" || char === '"') && /(?:^|[:\[,]\s*)$/.test(line)) quote = char;
      else if (char === "#" && (!line || /\s$/.test(line))) break;
      line += char;
    }
    if (quote) throw new Error(`Unclosed quote on line ${index + 1}`);
    if (!line.trim()) continue;
    const match = /^([a-z][a-zA-Z]*):\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error(`Expected key: value on line ${index + 1}`);
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate field: ${key}`);
    const scalar = (value: string): unknown => {
      const trimmed = value.trim();
      if (!trimmed) throw new Error(`Empty value for ${key}`);
      if (/^"[^"\r\n]*"$|^'[^'\r\n]*'$/.test(trimmed)) return trimmed.slice(1, -1);
      if (/[\[\]{}]/.test(trimmed) || /^["'|>&*!]/.test(trimmed)) throw new Error(`Unsupported value for ${key}`);
      if (trimmed === "true" || trimmed === "false") return trimmed === "true";
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      return trimmed;
    };
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      fields[key] = inner ? inner.split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/).map(scalar) : [];
    } else fields[key] = scalar(rawValue);
  }
  return fields;
}

export function parsePrBlock(body: string): PrBlock {
  const starts = [...body.matchAll(/<!--\s*agentbros:pr\b/g)];
  if (starts.length !== 1) throw new Error("Expected exactly one agentbros:pr block");
  const match = /^\s*<!-- agentbros:pr\s*\r?\n([\s\S]*?)-->/.exec(body);
  if (!match) throw new Error("The PR body must start with a complete agentbros:pr block");
  return PrBlockSchema.parse(parseFields(match[1]!));
}

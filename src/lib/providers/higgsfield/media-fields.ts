import { loadProviderCatalog, resolveProviderSnapshot } from "../../models/fal-catalog";
import { resolveSchema, type JsonSchema, type SchemaComponents } from "../json-schema-validate";

export const isMediaUrlKey = (key: string): boolean => /(?:^|_)urls?$/.test(key);
export function mediaKindForKey(key: string): "video" | "audio" | "image" | undefined {
  if (!isMediaUrlKey(key)) return undefined;
  if (/video/.test(key)) return "video";
  if (/audio/.test(key)) return "audio";
  if (/image|frame|mask/.test(key)) return "image";
  return undefined;
}
/** Paths are JSON pointers; '*' denotes a repeated attachment, never a fabricated provider field. */
export function mediaUrlFields(input: JsonSchema, components: SchemaComponents = {}): string[] {
  const paths = new Set<string>();
  const walk = (raw: JsonSchema, pointer: string, key: string, ancestors: Set<JsonSchema>) => {
    const schema = resolveSchema(raw, { ...input.$defs, ...components });
    if (ancestors.has(schema)) return;
    const next = new Set(ancestors).add(schema);
    if ((schema.type === "string" || schema.format === "uri") && isMediaUrlKey(key)) paths.add(pointer);
    for (const [name, child] of Object.entries(schema.properties ?? {}))
      walk(child, `${pointer}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, name, next);
    if (schema.items) walk(schema.items, `${pointer}/*`, key, next);
    for (const branch of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])])
      walk(branch, pointer, key, next);
  };
  walk(input, "", "", new Set());
  return [...paths].sort();
}
export function higgsfieldMediaCapabilities() {
  return [...loadProviderCatalog("higgsfield").values()].map((entry) => {
    const snapshot = resolveProviderSnapshot("higgsfield", entry.endpoint);
    return {
      endpoint: entry.endpoint,
      schema: snapshot ? "cached" : "unavailable",
      fields: snapshot ? mediaUrlFields(snapshot.input, snapshot.schemas) : [],
      ...(snapshot ? {} : { note: "No input fields or remote-media support are inferred without an exact schema." }),
    };
  });
}

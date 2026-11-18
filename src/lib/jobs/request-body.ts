export function generationRequestBody(value: unknown, locale?: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item) => generationRequestBody(item, locale)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error("Generation input must contain plain JSON objects");
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, locale))
      .map(([key, field]) => `${JSON.stringify(key)}:${generationRequestBody(field, locale)}`)
      .join(",")}}`;
  }
  throw new Error("Generation input must be finite JSON without undefined values");
}

/** V2 identity only; legacy receipt digests and frozen wire bodies keep their original encoding. */
export function canonicalRequestBody(value: unknown): string {
  const active = new Set<object>();
  const encode = (item: unknown): string => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null)
      throw new Error("Generation input must be finite JSON without undefined values");
    if (active.has(item)) throw new Error("Generation input must not contain cycles");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new Error("Generation input must contain plain JSON objects");
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (
        Object.getOwnPropertySymbols(item).length ||
        Object.entries(descriptors).some(
          ([key, field]) => !(Array.isArray(item) && key === "length") && (!field.enumerable || !("value" in field)),
        )
      )
        throw new Error("Generation input must contain enumerable JSON data properties");
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).length !== item.length + 1)
          throw new Error("Generation input arrays must be dense JSON without extra properties");
        return `[${Array.from({ length: item.length }, (_, index) => encode(descriptors[String(index)]?.value)).join(",")}]`;
      }
      return `{${Object.keys(descriptors)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(descriptors[key]!.value)}`)
        .join(",")}}`;
    } finally {
      active.delete(item);
    }
  };
  return encode(value);
}

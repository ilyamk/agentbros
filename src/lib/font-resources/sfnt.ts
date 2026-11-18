/** Inspect actual SFNT outlines/cmap; compressed WOFF and collections require a decoder. */
export function inspectSfnt(buffer: Buffer) {
  const signature = buffer.subarray(0, 4).toString("hex");
  if (!["00010000", "4f54544f"].includes(signature))
    throw new Error("Only real single-face TTF/OTF SFNT fonts are supported; WOFF2/TTC need a decoder");
  const tables = new Map<string, Buffer>();
  const count = buffer.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16,
      start = buffer.readUInt32BE(p + 8),
      length = buffer.readUInt32BE(p + 12);
    if (start + length > buffer.length) throw new Error("Truncated font table");
    tables.set(buffer.toString("ascii", p, p + 4), buffer.subarray(start, start + length));
  }
  if (tables.has("fvar")) throw new Error("Variable-font axes are unsupported; import an actual static instance");
  const name = tables.get("name");
  if (!name) throw new Error("Missing font names");
  const names: { id: number; value: string }[] = [];
  for (let i = 0; i < name.readUInt16BE(2); i++) {
    const p = 6 + i * 12,
      platform = name.readUInt16BE(p),
      id = name.readUInt16BE(p + 6),
      length = name.readUInt16BE(p + 8),
      start = name.readUInt16BE(4) + name.readUInt16BE(p + 10);
    if (start + length > name.length) throw new Error("Truncated font name");
    const bytes = Buffer.from(name.subarray(start, start + length));
    if ((platform === 0 || platform === 3) && bytes.length % 2 === 0)
      names.push({ id, value: bytes.swap16().toString("utf16le") });
  }
  const family = names.find((n) => n.id === 16)?.value ?? names.find((n) => n.id === 1)?.value;
  if (!family) throw new Error("Missing Unicode family name");
  const os2 = tables.get("OS/2"),
    head = tables.get("head");
  if (!os2 || !head) throw new Error("Missing weight/style metadata");
  const weight = os2.readUInt16BE(4),
    style = head.readUInt16BE(44) & 2 ? "italic" : "normal";
  const cmap = tables.get("cmap");
  if (!cmap) throw new Error("Missing character map");
  const mappings: Buffer[] = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const p = 4 + i * 8,
      platform = cmap.readUInt16BE(p),
      encoding = cmap.readUInt16BE(p + 2),
      offset = cmap.readUInt32BE(p + 4);
    if (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) mappings.push(cmap.subarray(offset));
  }
  const glyph = (point: number): number => {
    for (const map of mappings) {
      const format = map.readUInt16BE(0);
      if (format === 12) {
        for (let i = 0; i < map.readUInt32BE(12); i++) {
          const p = 16 + i * 12,
            start = map.readUInt32BE(p),
            end = map.readUInt32BE(p + 4);
          if (point >= start && point <= end) return map.readUInt32BE(p + 8) + point - start;
        }
      } else if (format === 4 && point <= 65535) {
        const n = map.readUInt16BE(6) / 2;
        for (let i = 0; i < n; i++) {
          const end = map.readUInt16BE(14 + i * 2),
            start = map.readUInt16BE(16 + n * 2 + i * 2);
          if (point < start || point > end) continue;
          const delta = map.readInt16BE(16 + n * 4 + i * 2),
            rangePos = 16 + n * 6 + i * 2,
            range = map.readUInt16BE(rangePos);
          if (!range) return (point + delta) & 65535;
          const at = rangePos + range + (point - start) * 2;
          if (at + 2 > map.length) throw new Error("Corrupt glyph range");
          const id = map.readUInt16BE(at);
          return id ? (id + delta) & 65535 : 0;
        }
      }
    }
    return 0;
  };
  const maxp = tables.get("maxp");
  if (!maxp) throw new Error("Missing glyph count");
  const glyphCount = maxp.readUInt16BE(4);
  return {
    family,
    weight,
    style,
    missing: (text: string) =>
      [...new Set([...text].map((c) => c.codePointAt(0)!))].filter(
        (point) => !/[\s]/u.test(String.fromCodePoint(point)) && (glyph(point) === 0 || glyph(point) >= glyphCount),
      ),
  };
}

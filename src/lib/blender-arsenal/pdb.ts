import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { arsenalPaths } from "./paths";
import { assertPathWithin } from "../cli";

export const PdbReceiptSchema = z
  .object({
    id: z.string().regex(/^[0-9][A-Z0-9]{3}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    source: z.string().url(),
    record: z.string().url(),
    licence: z.literal("CC0-1.0"),
    licenceEvidence: z.literal("https://www.wwpdb.org/about/usage-policies"),
    attribution: z.string().min(1),
    fetchedAt: z.string().datetime(),
  })
  .strict();
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Public structures are acquired before Blender starts; renders stay offline and retain exact bytes. */
export async function acquirePdb(id: string, root = process.cwd(), fetcher: typeof fetch = fetch) {
  const normalised = id.toUpperCase();
  if (!/^[0-9][A-Z0-9]{3}$/.test(normalised)) throw new Error("Expected a four-character public PDB id");
  const directory = path.join(arsenalPaths(root).local, "generated/molecularnodes");
  const pointer = path.join(directory, `${normalised}.json`);
  assertPathWithin(root, directory);
  assertPathWithin(root, pointer);
  if (existsSync(pointer)) {
    const receipt = PdbReceiptSchema.parse(JSON.parse(readFileSync(pointer, "utf8")));
    const file = path.join(directory, receipt.sha256, `${normalised}.pdb`);
    assertPathWithin(root, file);
    if (receipt.id === normalised && existsSync(file) && digest(readFileSync(file)) === receipt.sha256)
      return { file, receipt, reused: true };
  }
  const source = `https://files.rcsb.org/download/${normalised}.pdb`;
  const response = await fetcher(source, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`RCSB structure acquisition failed: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("RCSB returned no structure body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16 * 1024 * 1024)
        throw new Error("PDB exceeds the 16 MiB acquisition bound; supply a local CIF instead");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const data = Buffer.concat(chunks);
  const text = data.toString("utf8");
  if (!/^ATOM  |^HETATM/m.test(text)) throw new Error("Response contains no PDB atom records");
  const sha256 = digest(data);
  const attribution = `RCSB PDB ${normalised}\n${text
    .split("\n")
    .filter((line) => /^(TITLE |AUTHOR|JRNL  )/.test(line))
    .join("\n")}`;
  const receipt = PdbReceiptSchema.parse({
    id: normalised,
    sha256,
    bytes,
    source,
    record: `https://www.rcsb.org/structure/${normalised}`,
    licence: "CC0-1.0",
    licenceEvidence: "https://www.wwpdb.org/about/usage-policies",
    attribution,
    fetchedAt: new Date().toISOString(),
  });
  const destination = path.join(directory, sha256);
  assertPathWithin(root, destination);
  mkdirSync(destination, { recursive: true });
  const file = path.join(destination, `${normalised}.pdb`);
  assertPathWithin(root, file);
  assertPathWithin(root, path.join(destination, "source.json"));
  writeFileSync(file, data);
  writeFileSync(path.join(destination, "source.json"), JSON.stringify(receipt, null, 2));
  const temporary = `${pointer}.${process.pid}.tmp`;
  assertPathWithin(root, temporary);
  writeFileSync(temporary, JSON.stringify(receipt, null, 2));
  renameSync(temporary, pointer);
  return { file, receipt, reused: false };
}

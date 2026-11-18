import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BenchConfigSchema, BenchPathSchema } from "../../types/bench";
import { assertPathWithin, CliErrorObject } from "../cli";

export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
export const loadBenchConfig = (root: string) => BenchConfigSchema.parse(json(path.join(root, "bench/config.json")));
export function contained(root: string, name: string): string {
  BenchPathSchema.parse(name);
  const file = path.resolve(root, name);
  assertPathWithin(root, file);
  let current = path.resolve(root);
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`Symlink refused: ${name}`);
  }
  return file;
}
export function fail(message: string): never {
  throw new CliErrorObject({ code: "VALIDATION", message });
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export function filesIn(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`Symlink refused: ${name}`);
      return entry.isDirectory() ? filesIn(path.join(root, entry.name), name) : entry.isFile() ? [name] : [];
    });
}
export function command(bin: string, args: string[], cwd?: string, input?: string | Buffer): string {
  const result = spawnSync(bin, args, { cwd, input, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${bin} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}
/** Small seeded generator shared by packet anonymisation and bootstrap analysis. */
export function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let out = Math.imul(value ^ (value >>> 15), 1 | value);
    out ^= out + Math.imul(out ^ (out >>> 7), 61 | out);
    return ((out ^ (out >>> 14)) >>> 0) / 4294967296;
  };
}

export async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

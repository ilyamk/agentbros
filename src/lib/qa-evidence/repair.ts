import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { artifactHash } from "./frames";
const RepairRequestSchema = z
  .object({
    before: z.string().min(1),
    after: z.string().min(1),
    description: z.string().min(1).max(2000),
    actor: z.string().min(1).max(160),
    expectedAttempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(3).default(2),
  })
  .strict();
/** Evidence ledger, never an automatic fix or quality approval. Caller must rerender each attempt. */
export function recordRepairEvidence(directory: string, input: z.input<typeof RepairRequestSchema>) {
  const request = RepairRequestSchema.parse(input);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "repair-evidence.json"),
    lock = file + ".lock",
    fd = openSync(lock, "wx", 0o600);
  const read = (source: string) => {
    const value = JSON.parse(readFileSync(source, "utf8"));
    if (
      value.version !== 1 ||
      !/^([a-f0-9]{64})$/.test(value.sourceHash) ||
      ![...(value.extraction?.frames ?? []), ...(value.browser?.frames ?? [])].length
    )
      throw new Error("Repair requires an actual QA evidence report");
    for (const item of [...(value.extraction?.frames ?? []), ...(value.browser?.frames ?? [])]) {
      const frame = realpathSync(item.file);
      if (!frame.startsWith(realpathSync(path.dirname(source)) + path.sep) || artifactHash(frame) !== item.sha256)
        throw new Error("Repair artifact hash/path mismatch");
    }
    return value;
  };
  try {
    const journal = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { version: 1, maxAttempts: request.maxAttempts, attempts: [] };
    if (journal.version !== 1 || !Array.isArray(journal.attempts)) throw new Error("Invalid repair journal");
    if (journal.attempts.length !== request.expectedAttempt) throw new Error("Repair attempt revision conflict");
    if (journal.attempts.length >= journal.maxAttempts)
      throw new Error("Repair attempt cap reached; manual review required");
    const before = read(request.before),
      after = read(request.after);
    journal.attempts.push({
      attempt: journal.attempts.length + 1,
      description: request.description,
      actor: request.actor,
      declaredAt: new Date().toISOString(),
      beforeEvidenceHash: artifactHash(request.before),
      afterEvidenceHash: artifactHash(request.after),
      beforeSourceHash: before.sourceHash,
      afterSourceHash: after.sourceHash,
      beforeArtifacts: [...(before.extraction?.frames ?? []), ...(before.browser?.frames ?? [])].map((f) => ({
        file: f.file,
        sha256: f.sha256,
      })),
      afterArtifacts: [...(after.extraction?.frames ?? []), ...(after.browser?.frames ?? [])].map((f) => ({
        file: f.file,
        sha256: f.sha256,
      })),
      status: "requires-manual-review",
    });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(journal, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return journal;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

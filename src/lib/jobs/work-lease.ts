import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync, writeFileSync, fsyncSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { OperationStore } from "./store";

/** A live local worker exclusively owns submission and publication for this operation. */
export function claimOperationWork(
  store: Pick<OperationStore, "file">,
  operationId: string,
  namespace: "operation" | "higgsfield-upload" = "operation",
): (() => void) | null {
  const directory = path.dirname(store.file);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${namespace}-${createHash("sha256").update(operationId).digest("hex")}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() }));
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        unlinkSync(file);
        throw error;
      }
      return () => {
        closeSync(fd);
        unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let recovery: number;
      try {
        recovery = openSync(`${file}.recovery`, "wx", 0o600);
      } catch {
        return null;
      }
      let recovered = false;
      try {
        let owner: { pid?: number };
        try {
          owner = JSON.parse(readFileSync(file, "utf8"));
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
            recovered = true;
            owner = {};
          } else return null;
        }
        if (!recovered && Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
          try {
            process.kill(owner.pid!, 0);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              unlinkSync(file);
              recovered = true;
            }
          }
        }
      } finally {
        closeSync(recovery);
        unlinkSync(`${file}.recovery`);
      }
      if (!recovered) return null;
    }
  }
  return null;
}

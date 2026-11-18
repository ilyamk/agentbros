import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, CliErrorObject, validateProjectId } from "../../cli";
import { claimOperationWork } from "../../jobs/work-lease";

const publicUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password;
});
export const HiggsfieldUploadCacheSchema = z
  .object({
    version: z.literal(1),
    expiry: z.literal("unknown"),
    entries: z.record(
      z.string().regex(/^[a-f0-9]{64}:(?:image\/(?:jpeg|png|webp|gif)|audio\/wav|video\/mp4)$/),
      z.object({ publicUrl, uploadedAt: z.iso.datetime() }).strict(),
    ),
  })
  .strict();

/** The recorded upload contract documents no public URL expiry; hits are retained indefinitely. */
export class HiggsfieldUploadCache {
  readonly file: string;
  private readonly root: string;
  private readonly project: string;
  constructor(projectId: string, rootDir = process.cwd()) {
    validateProjectId(projectId);
    this.root = path.resolve(rootDir);
    this.project = path.join(this.root, "public/projects", projectId);
    this.file = path.join(this.project, "pipeline/higgsfield-uploads.json");
    this.checkPath();
    if (!existsSync(this.project))
      throw new CliErrorObject({
        code: "PROJECT_NOT_FOUND",
        message: "Higgsfield upload cache requires an existing --project.",
      });
  }
  private checkPath(): void {
    assertPathWithin(this.root, this.project);
    assertPathWithin(path.join(this.root, "public/projects"), this.project);
    assertPathWithin(this.project, this.file);
    for (const file of [path.dirname(this.file), this.file]) {
      try {
        if (lstatSync(file).isSymbolicLink())
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "Higgsfield upload cache cannot use symlinks." });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private read(): z.infer<typeof HiggsfieldUploadCacheSchema> {
    this.checkPath();
    if (!existsSync(this.file)) return { version: 1, expiry: "unknown", entries: {} };
    try {
      return HiggsfieldUploadCacheSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Invalid pipeline/higgsfield-uploads.json; repair the cache before retrying.",
      });
    }
  }
  async reuse(sourceSha256: string, contentType: string, upload: () => Promise<string>): Promise<string> {
    this.checkPath();
    mkdirSync(path.dirname(this.file), { recursive: true });
    const key = `${sourceSha256}:${contentType}`;
    if (!HiggsfieldUploadCacheSchema.shape.entries.keyType.safeParse(key).success)
      throw new CliErrorObject({ code: "VALIDATION", message: "Invalid Higgsfield upload cache key." });
    const release = claimOperationWork(this, "higgsfield-upload-cache", "higgsfield-upload");
    if (!release)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Higgsfield upload cache is busy; retry after the active upload finishes.",
      });
    try {
      const cache = this.read();
      if (cache.entries[key]) return cache.entries[key].publicUrl;
      cache.entries[key] = { publicUrl: await upload(), uploadedAt: new Date().toISOString() };
      const body = JSON.stringify(HiggsfieldUploadCacheSchema.parse(cache));
      this.checkPath();
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
        renameSync(temporary, this.file);
      } finally {
        rmSync(temporary, { force: true });
      }
      return cache.entries[key].publicUrl;
    } finally {
      release();
    }
  }
}

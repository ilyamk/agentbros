import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MediaFetchError } from "./errors";
import { MediaFetchJobSchema, type MediaFetchJob } from "../../types/media-fetch";

export function scopedPath(root: string, value: string): string {
  const resolved = path.resolve(value),
    base = realpathSync(root);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  if (!within(path.resolve(root), resolved))
    throw new MediaFetchError(
      "UNSAFE_PATH",
      "Destination escapes the workspace.",
      "Choose a directory within the workspace.",
    );
  let existing = resolved;
  while (!existsSync(existing)) existing = path.dirname(existing);
  if (!within(base, realpathSync(existing)))
    throw new MediaFetchError("UNSAFE_PATH", "Destination symlink escapes the workspace.");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink())
    throw new MediaFetchError("UNSAFE_PATH", "Symbolic-link state files are forbidden.");
  return resolved;
}
export function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  scopedPath(path.dirname(file), file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, file);
}
export function readJob(directory: string): MediaFetchJob {
  const file = scopedPath(directory, path.join(directory, "job.json"));
  return MediaFetchJobSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
export function saveJob(job: MediaFetchJob): void {
  job.updatedAt = new Date().toISOString();
  job.heartbeat = job.updatedAt;
  atomicJson(path.join(job.directory, "job.json"), MediaFetchJobSchema.parse(job));
}
export function lock(file: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      return () => {
        closeSync(fd);
        unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid: number };
      try {
        owner = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new MediaFetchError("LOCKED", "Unreadable acquisition lock; inspect before recovery.");
      }
      try {
        process.kill(owner.pid, 0);
        throw new MediaFetchError(
          "LOCKED",
          "Another acquisition worker owns this state.",
          "Read status instead of starting another worker.",
          true,
        );
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        unlinkSync(file);
      }
    }
  }
  throw new MediaFetchError("LOCKED", "Acquisition state remains locked.");
}
export function publicReport(job: MediaFetchJob) {
  const completed = job.items.filter((x) => x.state === "completed").length;
  return {
    jobId: job.id,
    status: job.state,
    completed,
    failed: job.items.filter((x) => x.state === "failed" || x.state === "unknown").length,
    total: job.items.length,
    report: path.join(job.directory, "report.json"),
    next:
      job.state === "running"
        ? `media:fetch --status ${job.id} ${job.options.project ? `--project ${job.options.project}` : `--output-dir ${job.options.outputDir}`}`
        : undefined,
    items: job.items.map((item, index) => ({
      index,
      state: item.state,
      provider: item.provider,
      files: item.files.map((f) => ({ path: f.path, assetId: f.assetId, kind: f.kind, preview: f.preview })),
      issue: item.issue,
      duplicateOf: item.duplicateOf,
    })),
  };
}
export function saveReport(job: MediaFetchJob): void {
  atomicJson(path.join(job.directory, "report.json"), publicReport(job));
}

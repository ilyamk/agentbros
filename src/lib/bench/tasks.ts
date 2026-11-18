import { readFileSync } from "node:fs";
import path from "node:path";
import { BenchSuiteSchema, BenchTaskSchema } from "../../types/bench";
import { contained, digest, fail, json } from "./io";

export function loadTask(root: string, id: string, suiteFile = "bench/suite.json") {
  const suite = BenchSuiteSchema.parse(json(path.resolve(root, suiteFile)));
  const entry = suite.tasks.find((task) => task.id === id);
  if (!entry) fail(`Task ${id} is absent from the selected suite`);
  const bytes = readFileSync(contained(root, entry.path));
  if (digest(bytes) !== entry.sha256) fail(`Suite hash mismatch: ${id}`);
  const task = BenchTaskSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (task.id !== id) fail("Suite/task identity mismatch");
  for (const item of task.material) {
    if (!item.path) fail("Remote material must be fetched and pinned locally before an offline benchmark run");
    if (digest(readFileSync(contained(root, item.path))) !== item.sha256) fail(`Material hash mismatch: ${item.path}`);
  }
  if (!task.material.some((item) => item.path === task.answers)) fail("Gate answers must be hash-pinned material");
  for (const criterion of task.criteria)
    if (
      criterion.check.type === "script" &&
      !task.material.some((item) => item.path === (criterion.check as { path: string }).path)
    )
      fail("Check scripts must be hash-pinned material");
  return { suite, task, taskSha256: entry.sha256 };
}

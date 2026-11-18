import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { readWorkflowEvidence } from "../src/lib/workflows/local-evidence";
import { inspectChartQuantitySources } from "../src/lib/chart-quantity-sources";
import { ChapterInspectionInputs } from "../src/lib/longform/inspection-inputs";
import { inspectChapters } from "../src/lib/review-ui/chapters";
import { projectChapterPlan } from "../src/lib/longform/runner";
import { chapterFixture } from "./helpers/review-chapters";
test("directory membership additions and removals invalidate renderer closure", () => {
  const f = chapterFixture();
  try {
    const directory = path.join(f.root, "src");
    fs.mkdirSync(directory);
    const original = path.join(directory, "index.ts");
    fs.writeFileSync(original, "// original");
    const add = new ChapterInspectionInputs();
    add.sourceFiles(directory, f.root);
    fs.writeFileSync(path.join(directory, "new.tsx"), "// added");
    assert.throws(() => add.assertUnchanged(), /directory|membership/);
    const remove = new ChapterInspectionInputs();
    remove.sourceFiles(directory, f.root);
    fs.rmSync(original);
    assert.throws(() => remove.assertUnchanged(), /directory|membership/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
for (const kind of ["output", "cache", "closure", "dependency"] as const)
  test("final response refuses postplanner " + kind + " mutation", () => {
    const f = chapterFixture(),
      cwd = process.cwd(),
      code = path.join(f.root, "code");
    fs.mkdirSync(path.join(code, "src"), { recursive: true });
    fs.writeFileSync(path.join(code, "src/index.ts"), "// diagnostic closure");
    fs.writeFileSync(path.join(code, "package.json"), "{}");
    const image = path.join(f.project, "image.png");
    fs.writeFileSync(image, "source hash fixture");
    const config = JSON.parse(fs.readFileSync(path.join(f.project, "project.json"), "utf8"));
    config.scenes[0].imageUrl = "projects/demo/image.png";
    fs.writeFileSync(path.join(f.project, "project.json"), JSON.stringify(config));
    const doc = f.store.read();
    doc.timeline.tracks[0].clips[0].payload!.scene = config.scenes[0];
    fs.writeFileSync(f.store.file, JSON.stringify(doc));
    const request = {
      ...f.request,
      timelineHash: createHash("sha256").update(JSON.stringify(doc.timeline)).digest("hex"),
    };
    process.chdir(code);
    const originalOpen = fs.openSync;
    let triggered = false,
      cacheReads = 0;
    try {
      const plan = projectChapterPlan("demo", f.manifest, { rootDir: f.root, readonlyInspection: true }),
        job = plan.jobs[0];
      fs.mkdirSync(path.dirname(job.output), { recursive: true });
      fs.writeFileSync(job.output, "immutable hash fixture");
      fs.writeFileSync(
        plan.cacheFile,
        JSON.stringify({
          first: {
            fingerprint: job.fingerprint,
            output: job.output,
            outputHash: createHash("sha256").update("immutable hash fixture").digest("hex"),
          },
        }),
      );
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = originalOpen(...args),
          file = String(args[0]);
        if (file === plan.cacheFile) cacheReads++;
        const atBoundary =
          kind === "cache" ? file === f.manifestFile && cacheReads >= 3 : file === plan.cacheFile && cacheReads === 3;
        if (atBoundary && !triggered) {
          triggered = true;
          if (kind === "output") fs.writeFileSync(job.output, "changed output");
          else if (kind === "cache") fs.writeFileSync(plan.cacheFile, "{}");
          else if (kind === "closure") fs.writeFileSync(path.join(code, "src/new.tsx"), "// late source");
          else fs.writeFileSync(image, "changed dependency");
        }
        return fd;
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      assert.throws(() => inspectChapters(f.project, request, f.root), /changed|membership|directory|candidate/);
      assert.equal(triggered, true, "mutation seam must actually be reached");
    } finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
      process.chdir(cwd);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

test("late quantity bridge is refused without entering workflow/source reads", () => {
  const f = chapterFixture(),
    capture = new ChapterInspectionInputs(),
    artifact = path.join(f.project, "pipeline/evidence/chart-quantity-bindings.json");
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const originalAbsent = capture.absent.bind(capture),
    originalOpen = fs.openSync,
    opened: string[] = [];
  let triggered = false;
  capture.absent = (file, scope) => {
    originalAbsent(file, scope);
    if (file === artifact && !triggered) {
      triggered = true;
      fs.writeFileSync(artifact, '{"late":"unsupported source bridge"}');
    }
  };
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0]));
    return originalOpen(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => inspectChartQuantitySources(f.root, "demo", { timeline: true, readonlyInspection: capture }),
      /unsupported.*chart-quantity-bindings/,
    );
    assert.equal(triggered, true);
    assert.equal(
      opened.some((file) => file === artifact || file.includes("workflow-claims") || file.includes("quantity-source")),
      false,
      "readonly inspector must not consume bridge/workflow/source JSON",
    );
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("repeated real reads and final revalidation share one aggregate byte budget", () => {
  const f = chapterFixture();
  try {
    const file = path.join(f.root, "bounded.bin");
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
    const capture = new ChapterInspectionInputs();
    for (let i = 0; i < 255; i++) capture.hash(file, f.root);
    capture.assertUnchanged();
    assert.throws(() => capture.assertUnchanged(), /aggregate bytes/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("directory mutation during final enumeration is refused", () => {
  const f = chapterFixture(),
    directory = path.join(f.root, "src"),
    originalRead = fs.readdirSync;
  let triggered = false;
  try {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "index.ts"), "// original");
    const capture = new ChapterInspectionInputs();
    capture.sourceFiles(directory, f.root);
    fs.readdirSync = ((...args: unknown[]) => {
      const entries = (originalRead as Function)(...args);
      if (String(args[0]) === directory && !triggered) {
        triggered = true;
        fs.writeFileSync(path.join(directory, "late.tsx"), "// late");
      }
      return entries;
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    assert.throws(() => capture.assertUnchanged(), /membership/);
    assert.equal(triggered, true);
  } finally {
    fs.readdirSync = originalRead;
    syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
for (const mutation of ["add-lock", "add-config", "delete-config"] as const)
  test("final response refuses optional renderer root " + mutation, () => {
    const f = chapterFixture(),
      cwd = process.cwd(),
      code = path.join(f.root, "code"),
      originalOpen = fs.openSync;
    let triggered = false,
      cacheReads = 0;
    try {
      fs.mkdirSync(path.join(code, "src"), { recursive: true });
      fs.writeFileSync(path.join(code, "src/index.ts"), "// diagnostic closure");
      fs.writeFileSync(path.join(code, "package.json"), "{}");
      const target = path.join(code, mutation === "add-lock" ? "pnpm-lock.yaml" : "remotion.config.ts");
      if (mutation === "delete-config") fs.writeFileSync(target, "// original config");
      process.chdir(code);
      const plan = projectChapterPlan("demo", f.manifest, { rootDir: f.root, readonlyInspection: true }),
        job = plan.jobs[0];
      fs.mkdirSync(path.dirname(job.output), { recursive: true });
      fs.writeFileSync(job.output, "immutable hash fixture");
      fs.writeFileSync(
        plan.cacheFile,
        JSON.stringify({
          first: {
            fingerprint: job.fingerprint,
            output: job.output,
            outputHash: createHash("sha256").update("immutable hash fixture").digest("hex"),
          },
        }),
      );
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = originalOpen(...args);
        if (String(args[0]) === plan.cacheFile && ++cacheReads === 3) {
          triggered = true;
          if (mutation === "delete-config") fs.rmSync(target);
          else fs.writeFileSync(target, "// late root closure member");
        }
        return fd;
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      assert.throws(() => inspectChapters(f.project, f.request, f.root), /unsupported|ENOENT|changed/);
      assert.equal(triggered, true, "postplanner mutation must actually occur");
    } finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
      process.chdir(cwd);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
test("omitted optional renderer root broken alias is supplied invalid input", () => {
  const f = chapterFixture(),
    code = path.join(f.root, "code");
  try {
    fs.mkdirSync(path.join(code, "src"), { recursive: true });
    fs.writeFileSync(path.join(code, "src/index.ts"), "// diagnostic");
    fs.writeFileSync(path.join(code, "package.json"), "{}");
    fs.symlinkSync(path.join(code, "missing-lock.yaml"), path.join(code, "pnpm-lock.yaml"));
    assert.throws(
      () => projectChapterPlan("demo", f.manifest, { rootDir: f.root, codeDir: code, readonlyInspection: true }),
      /bounded regular|alias|unsupported/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("bounded reader exposes exact consumed BOM bytes without changing JSON text or SHA", () => {
  const f = chapterFixture();
  try {
    const file = path.join(f.root, "bom.json"),
      data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"unchanged":true}')]);
    fs.writeFileSync(file, data);
    const read = readWorkflowEvidence(file, f.root, data.length);
    assert.equal(read.byteLength, data.length);
    assert.equal(read.text, '{"unchanged":true}');
    assert.deepEqual(JSON.parse(read.text), { unchanged: true });
    assert.equal(read.sha256, createHash("sha256").update(data).digest("hex"));
    assert.equal(read.path, file);
    assert.throws(() => readWorkflowEvidence(file, f.root, data.length - 1), /size invalid/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
test("32 real BOM metadata reads consume exactly the 256MiB aggregate limit", () => {
  const f = chapterFixture();
  try {
    const file = path.join(f.root, "bom-boundary.json"),
      size = 8 * 1024 * 1024,
      data = Buffer.alloc(size, 0x20);
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]).copy(data);
    fs.writeFileSync(file, data);
    const capture = new ChapterInspectionInputs();
    for (let i = 0; i < 32; i++) {
      const read = capture.read(file, f.root, size);
      assert.equal(read.byteLength, size);
      assert.deepEqual(JSON.parse(read.text), {});
    }
    const small = path.join(f.root, "small.json");
    fs.writeFileSync(small, "{}");
    assert.throws(() => capture.read(small, f.root, 8), /aggregate bytes/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
for (const mutation of ["manifest", "journal"] as const)
  test("legacy absent response refuses late " + mutation + " mutation", () => {
    const f = chapterFixture(),
      originalAbsent = ChapterInspectionInputs.prototype.absent;
    let triggered = false;
    try {
      fs.rmSync(f.manifestFile);
      ChapterInspectionInputs.prototype.absent = function (file, scope) {
        originalAbsent.call(this, file, scope);
        if (file === f.manifestFile && !triggered) {
          triggered = true;
          if (mutation === "manifest") fs.writeFileSync(file, JSON.stringify(f.manifest));
          else {
            const doc = JSON.parse(fs.readFileSync(f.store.file, "utf8"));
            doc.revision++;
            fs.writeFileSync(f.store.file, JSON.stringify(doc));
          }
        }
      };
      assert.throws(() => inspectChapters(f.project, f.request, f.root), /unsupported|changed/);
      assert.equal(triggered, true, "early response mutation seam must occur");
    } finally {
      ChapterInspectionInputs.prototype.absent = originalAbsent;
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

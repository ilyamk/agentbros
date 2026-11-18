import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ingestLocalMedia } from "../src/lib/ingest/local-analysis";
import { sourceWordProposal } from "../src/lib/ingest/word-proposal";
import { hashFile } from "../src/lib/assets/registry";
test(
  "actual installed offline native word indexes/cache/proposal retain original/model pins; estimated not forced alignment",
  { skip: process.env.RUN_NATIVE_WORD_TESTS !== "1", timeout: 60000 },
  async () => {
    const primary = process.env.NATIVE_WORD_PRIMARY!,
      workerFile = path.resolve("scripts/workers/local-analysis.py"),
      prior = process.cwd(),
      output = path.resolve("out/qa/offline-word-timing");
    mkdirSync(output, { recursive: true });
    const root = realpathSync(mkdtempSync(path.join(output, "actual-")));
    const denied = spawnSync(
      process.execPath,
      [
        "-e",
        "const n=require('node:net').createServer();n.once('error',e=>process.exit(e.code==='EPERM'?0:1));n.listen(0,()=>process.exit(2));",
      ],
      { encoding: "utf8" },
    );
    assert.equal(denied.status, 0, "OS network deny must be real");
    const config = {
      ...JSON.parse(readFileSync(path.join(primary, "out/qa/offline-inference/runtime/configs/asr.json"), "utf8")),
      workerFile,
      wordTimingMethod: "native-word-segments-v1",
      timeoutMs: 20000,
    };
    const modelBefore = hashFile(config.modelPath),
      engineBefore = hashFile(config.engineExecutable);
    process.chdir(root);
    try {
      mkdirSync("public/projects/demo", { recursive: true });
      writeFileSync("public/projects/demo/project.json", "{}");
      const evidence = [];
      for (const [file, language] of [
        ["english.wav", "en"],
        ["russian.wav", "ru"],
      ]) {
        const source = path.join(primary, "out/qa/offline-inference/audio", file),
          sourceHash = hashFile(source),
          request = { projectId: "demo", sourceFile: source, config: { ...config, language } };
        const result = await ingestLocalMedia(request),
          again = await ingestLocalMedia(request);
        assert.equal(again.workerCacheHit, true);
        assert.equal(again.cacheHit, true);
        assert.deepEqual(again.index, result.index);
        const proposal = sourceWordProposal("demo", result.file);
        assert.ok(proposal.words.length > 1);
        assert.equal(proposal.estimated, true);
        assert.equal(proposal.approved, false);
        assert.deepEqual(sourceWordProposal("demo", result.file), proposal);
        assert.equal(hashFile(source), sourceHash);
        const raw = JSON.parse(readFileSync(path.resolve("public", result.index!.transcript!.path), "utf8"));
        assert.equal(raw.wordTimings.status, "available");
        assert.ok(raw.wordTimings.rawRows.some((r: { text: string }) => !r.text.trim()));
        evidence.push({
          file,
          language,
          indexFile: result.file,
          indexHash: hashFile(result.file),
          workerEvidence: result.workerEvidence,
          sourceHash,
          proposal,
          rawRows: raw.wordTimings.rawRows,
        });
      }
      assert.equal(hashFile(config.modelPath), modelBefore);
      assert.equal(hashFile(config.engineExecutable), engineBefore);
      writeFileSync(
        path.join(root, "evidence.json"),
        JSON.stringify({ network: "OS deny network*", modelBefore, engineBefore, evidence }, null, 2),
      );
    } finally {
      process.chdir(prior);
    }
  },
);

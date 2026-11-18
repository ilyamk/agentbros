import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { AssetRecordSchema } from "../src/types/assets";
import { validateTimeline } from "../src/lib/timeline-ir/compiler";
import { prepareRhythmEvidence } from "../src/lib/audio/rhythm-preparation";
import { readRhythmEvidence, prepareRhythmMarks, inspectRhythmMarks } from "../src/lib/audio/rhythm-evidence";
import { analyzeRhythmPcm } from "../src/lib/audio/rhythm-kernel";
import { validateRhythmClock } from "../src/lib/audio/rhythm-clock";
import { RhythmReadContext, rhythmDigest } from "../src/lib/audio/rhythm-files";
import { resolveRhythmTool, runRhythmTool, runRhythmOwnedProcess } from "../src/lib/audio/rhythm-process";

const MiB = 1024 * 1024;
const installation = {
  ffmpeg: {
    file: "/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffmpeg",
    sha256: "7f6028378534aa10a2dfa07d807ddcc0d18c869bf5c2f64c89efcc18ee88c4ee",
  },
  ffprobe: {
    file: "/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffprobe",
    sha256: "bfe676bfc3a889bebe63af07c71a926a6167f568c7a932a79c2f1fe51ae6d5a1",
  },
  sandbox: {
    file: "/usr/bin/sandbox-exec",
    sha256: "58839ef01b4eef8aac0d2aa8f9d1c074ae45aafe3533965b030672450064acc8",
  },
} as const;
const profiles = [
  { id: "wav-pulse", pattern: "pulse", rate: 16000, channels: 1, extension: "wav", codec: "pcm_s16le" },
  { id: "wav-silence", pattern: "silence", rate: 16000, channels: 1, extension: "wav", codec: "pcm_s16le" },
  { id: "flac-pulse", pattern: "pulse", rate: 44100, channels: 2, extension: "flac", codec: "flac" },
  { id: "flac-silence", pattern: "silence", rate: 44100, channels: 2, extension: "flac", codec: "flac" },
] as const;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const writeNew = (file: string, bytes: Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
};
function installationPins() {
  return Object.fromEntries(
    Object.entries(installation).map(([name, tool]) => {
      const reader = new RhythmReadContext(path.dirname(tool.file));
      const pin = reader.read(path.basename(tool.file), 128 * MiB).pin;
      reader.assertUnchanged();
      assert.equal(pin.sha256, tool.sha256, `Installed ${name} changed; no fallback`);
      assert.ok(fs.lstatSync(tool.file).mode & 0o111);
      return [name, pin];
    }),
  );
}
function inventory(root: string, fingerprint = true) {
  let bytes = 0,
    fileCount = 0;
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (folder: string, depth: number) => {
    assert.ok(depth <= 12, "Diagnostic nesting cap");
    const members = fs.readdirSync(folder);
    assert.ok(members.length <= 128, "Diagnostic membership cap");
    for (const name of members) {
      const file = path.join(folder, name),
        stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(file, depth + 1);
      else {
        assert.ok(stat.isFile() && Number.isSafeInteger(stat.size));
        bytes += stat.size;
        assert.ok(bytes <= 32 * MiB, "Diagnostic disk admission cap");
        assert.ok(++fileCount <= 256, "Diagnostic file cap");
        const reader = new RhythmReadContext(root);
        if (fingerprint) {
          files.push(reader.read(path.relative(root, file), 8 * MiB).pin);
          reader.assertUnchanged();
        }
      }
    }
  };
  walk(root, 0);
  return { bytes, fileCount, files };
}

// No fixture generation, file/tool/version access or media work happens without explicit allocation.
test(
  "genuine bounded shipped rhythm WAV/FLAC preparation and exact reviewed marks",
  {
    skip: process.env.RUN_RHYTHM_EVIDENCE_TESTS !== "1",
    timeout: 120000,
  },
  async () => {
    assert.equal(process.platform, "darwin");
    const artifactBase = process.env.RHYTHM_ARTIFACT_ROOT;
    assert.ok(artifactBase && path.isAbsolute(artifactBase), "Explicit approved artifact root required");
    fs.mkdirSync(artifactBase, { recursive: true });
    const realBase = fs.realpathSync(artifactBase);
    assert.equal(realBase, path.resolve(artifactBase), "Artifact root alias refused");
    const run = fs.mkdtempSync(path.join(realBase, "actual-")),
      root = path.join(run, "project-root"),
      projectId = "rhythm-d",
      project = path.join(root, "public/projects", projectId);
    fs.mkdirSync(path.join(project, "pipeline"), { recursive: true });
    const started = Date.now();
    const beforeTools = installationPins(),
      osFile = fs.realpathSync("/System/Library/CoreServices/SystemVersion.plist"),
      osPin = new RhythmReadContext(path.dirname(osFile)).read(path.basename(osFile), 64 * 1024).pin;
    assert.equal(resolveRhythmTool("ffmpeg"), installation.ffmpeg.file);
    assert.equal(resolveRhythmTool("ffprobe"), installation.ffprobe.file);
    const workspace = path.resolve(fileURLToPath(new URL("../", import.meta.url))),
      sourceFiles = [
        "src/lib/audio/rhythm.ts",
        "src/lib/audio/rhythm-kernel.ts",
        "src/lib/audio/rhythm-overrides.ts",
        "src/lib/audio/rhythm-clock.ts",
        "src/lib/audio/rhythm-files.ts",
        "src/lib/audio/rhythm-marks.ts",
        "src/lib/audio/rhythm-evidence.ts",
        "src/lib/audio/rhythm-process.ts",
        "src/lib/audio/rhythm-publisher.ts",
        "src/lib/audio/rhythm-preparation.ts",
        "src/types/rhythm-evidence.ts",
        "src/types/assets.ts",
        "src/types/timeline.ts",
        "src/lib/timeline-ir/compiler.ts",
        "src/lib/timeline-ir/rational.ts",
        "src/lib/timeline-ir/store.ts",
        "tests/rhythm-evidence-actual.test.ts",
      ];
    const codePins = sourceFiles.map((file) => new RhythmReadContext(workspace).read(file, MiB).pin);
    type ChildReceipt = {
      kind: string;
      argv: string[];
      pid?: number;
      closed: boolean;
      code?: number | null;
      stdoutBytes: number;
      stdoutSha256?: string;
      stderrBytes: number;
      stderrTail: string;
    };
    const children: ChildReceipt[] = [],
      observations: any[] = [],
      negativeErrors: { kind: string; message: string }[] = [];
    const originalSpawn = childProcess.spawn;
    let mediaChildren = 0,
      failure: unknown,
      legacyChildren = 0;
    const deadline = new AbortController(),
      wholeTimer = setTimeout(() => deadline.abort(), 115000);
    try {
      childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
        const argv = Array.isArray(args[1]) ? args[1] : [],
          kind =
            Object.entries(installation).find(([name, tool]) => name !== "sandbox" && argv.includes(tool.file))?.[0] ??
            "owned-supervisor";
        if (kind !== "owned-supervisor") {
          mediaChildren++;
          assert.ok(mediaChildren <= 27, "Planned parent media child cap");
        }
        const child = Reflect.apply(originalSpawn, childProcess, args);
        const receipt: ChildReceipt = {
            kind,
            argv: [String(args[0]), ...argv],
            pid: child.pid,
            closed: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            stderrTail: "",
          },
          digest = createHash("sha256");
        children.push(receipt);
        child.stdout?.on("data", (bytes: Buffer) => {
          receipt.stdoutBytes += bytes.length;
          digest.update(bytes);
        });
        child.stderr?.on("data", (bytes: Buffer) => {
          receipt.stderrBytes += bytes.length;
          receipt.stderrTail = (receipt.stderrTail + bytes.toString("utf8")).slice(-4096);
        });
        child.once("close", (code: number | null) => {
          receipt.closed = true;
          receipt.code = code;
          receipt.stdoutSha256 = digest.digest("hex");
        });
        return child;
      }) as typeof originalSpawn;
      syncBuiltinESMExports();
      const encode = async (args: string[], output: string) => {
        const abort = new AbortController(),
          cancel = () => abort.abort();
        deadline.signal.addEventListener("abort", cancel, { once: true });
        if (deadline.signal.aborted) cancel();
        let growthError: unknown;
        const watch = setInterval(() => {
          try {
            try {
              const stat = fs.lstatSync(output);
              assert.ok(
                stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * MiB,
                "Encoded original size/alias bound",
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            inventory(run, false);
          } catch (error) {
            growthError = error;
            abort.abort();
          }
        }, 20);
        try {
          await runRhythmTool(installation.ffmpeg.file, args, {
            timeoutMs: 5000,
            stallMs: 3000,
            stdoutBytes: 512 * 1024,
            stderrBytes: 64 * 1024,
            signal: abort.signal,
          });
          if (growthError) throw growthError;
          assert.ok(fs.lstatSync(output).size <= 2 * MiB);
        } finally {
          clearInterval(watch);
          deadline.signal.removeEventListener("abort", cancel);
        }
      };
      const generated: {
        profile: (typeof profiles)[number];
        asset: ReturnType<typeof AssetRecordSchema.parse>;
        file: string;
      }[] = [];
      for (const profile of profiles) {
        assert.equal(deadline.signal.aborted, false);
        const frames = profile.rate * 5,
          raw = Buffer.alloc(frames * profile.channels * 4);
        for (let sample = 0; sample < frames; sample++) {
          const t = sample / profile.rate,
            value = profile.pattern === "pulse" && t % 0.5 < 0.04 ? 0.25 * Math.sin(2 * Math.PI * 880 * t) : 0;
          for (let channel = 0; channel < profile.channels; channel++)
            raw.writeFloatLE(channel === 0 ? value : value / 2, (sample * profile.channels + channel) * 4);
        }
        assert.ok(raw.length <= 1764000);
        const rawFile = path.join(run, "raw", profile.id + ".f32"),
          encoded = path.join(run, "encoded", profile.id + "." + profile.extension);
        writeNew(rawFile, raw);
        fs.mkdirSync(path.dirname(encoded), { recursive: true });
        await encode(
          [
            "-v",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "f32le",
            "-ar",
            String(profile.rate),
            "-ac",
            String(profile.channels),
            "-i",
            rawFile,
            "-map",
            "0:a:0",
            "-c:a",
            profile.codec,
            "-n",
            encoded,
          ],
          encoded,
        );
        const reader = new RhythmReadContext(run),
          encodedPin = reader.read(path.relative(run, encoded), 2 * MiB).pin;
        reader.assertUnchanged();
        const original = `projects/${projectId}/assets/imported/${encodedPin.sha256}.${profile.extension}`,
          file = path.join(root, "public", original);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.linkSync(encoded, file);
        fs.unlinkSync(encoded);
        const asset = AssetRecordSchema.parse({
          schemaVersion: 1,
          id: `sha256:${encodedPin.sha256}`,
          hash: encodedPin.sha256,
          revision: 1,
          createdAt: new Date().toISOString(),
          kind: "audio",
          files: { original, bytes: encodedPin.bytes, mime: profile.extension === "wav" ? "audio/wav" : "audio/flac" },
          media: {
            durationSec: 5,
            timebase: `1/${profile.rate}`,
            sampleRate: profile.rate,
            channels: profile.channels,
            codec: profile.codec,
            hasAudio: true,
          },
          provenance: {
            origin: "manual",
            tool: "owned local FFmpeg synthetic diagnostic; not human music/performance",
          },
          rights: {},
          entityLinks: [],
          status: "candidate",
        });
        generated.push({ profile, asset, file });
      }
      const configFile = path.join(project, "project.json"),
        registryFile = path.join(project, "pipeline/asset-registry.json"),
        journalFile = path.join(project, "pipeline/timeline-edit.json");
      writeNew(
        configFile,
        Buffer.from(
          JSON.stringify({
            name: "Synthetic rhythm diagnostic",
            formats: ["landscape"],
            productName: "Diagnostic",
            colors: { accent: "#000000", background: "#ffffff", text: "#000000" },
            scenes: [],
          }),
        ),
      );
      writeNew(
        registryFile,
        Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1, assets: generated.map((g) => g.asset) })),
      );
      const timeline = validateTimeline({
        version: 1,
        projectId,
        timebase: { num: 30000, den: 1001 },
        tracks: generated.map((g) => ({
          id: "music-" + g.profile.id,
          kind: "music",
          clips: [
            {
              id: g.profile.id,
              assetId: g.asset.id,
              start: { num: 75, den: 1 },
              source: {
                start: { num: g.profile.rate / 2, den: 1 },
                end: { num: g.profile.rate * 4, den: 1 },
                timebase: { num: g.profile.rate, den: 1 },
              },
              rate: { num: 3, den: 2 },
              transition: { kind: "cut" },
              captions: [],
            },
          ],
        })),
      });
      writeNew(journalFile, Buffer.from(JSON.stringify({ version: 1, revision: 0, timeline, undo: [], redo: [] })));
      const protectedPins = [configFile, registryFile, journalFile, ...generated.map((g) => g.file)].map((file) => ({
        file,
        sha256: sha(fs.readFileSync(file)),
      }));
      const outputs: Awaited<ReturnType<typeof prepareRhythmEvidence>>[] = [];
      for (const g of generated) {
        const result = await prepareRhythmEvidence(
          root,
          {
            version: 1,
            contract: "source-rhythm-evidence-v1",
            projectId,
            assetId: g.asset.id,
            assetSha256: g.asset.hash,
            profile: "rms-onset-v1-mono16k",
            limits: {
              wholeMs: 15000,
              probeMs: 5000,
              decodeMs: 5000,
              stallMs: 3000,
              sourceBytes: 2 * MiB,
              pcmBytes: 400000,
              metadataBytes: 512 * 1024,
              sharedMetadataBytes: 2 * MiB,
              stderrBytes: 64 * 1024,
              artifactBytes: 8 * MiB,
            },
          },
          { signal: deadline.signal },
        );
        outputs.push(result);
        assert.equal(result.cacheHit, false);
        const evidence = readRhythmEvidence(root, projectId, result.file, result.sha256, result.runtime);
        assert.deepEqual(evidence, result.evidence);
        assert.equal(evidence.clock.sourceSamples, g.profile.rate * 5);
        assert.equal(evidence.clock.analysisSamples, 80000);
        assert.deepEqual(evidence.clock.duration, { num: 5, den: 1 });
        const clockReader = new RhythmReadContext(root),
          clock = clockReader.json(evidence.artifacts.clock.path, 512 * 1024).value;
        assert.deepEqual(validateRhythmClock(clock), evidence.clock);
        const pcm = clockReader.check(evidence.artifacts.pcm, 400000).bytes;
        assert.equal(pcm.length, 320000);
        assert.deepEqual(analyzeRhythmPcm(pcm, 5, g.asset.hash).report, evidence.analysis);
        assert.equal(clockReader.check(evidence.artifacts.originalSnapshot!, 2 * MiB).pin.sha256, g.asset.hash);
        clockReader.assertUnchanged();
        if (g.profile.pattern === "silence") {
          for (let at = 0; at < pcm.length; at += 4) assert.equal(pcm.readFloatLE(at), 0);
          assert.deepEqual(evidence.onsets, []);
          assert.equal(evidence.analysis.tempoBpm, null);
          assert.deepEqual(evidence.analysis.beatCandidatesSec, []);
        }
        const review = {
            kind: "supplied-review",
            reviewedBy: "technical synthetic fixture review; not human listening",
            note: "Exact source geometry diagnostic, not downbeat or audible-mix approval",
            acknowledge: "reviewed-source-marks-not-calibrated-beat-truth",
          },
          request = {
            version: 1,
            contract: "reviewed-rhythm-marks-v1",
            projectId,
            evidence: { path: result.file, sha256: result.sha256 },
            trackId: "music-" + g.profile.id,
            clipId: g.profile.id,
            expectedRevision: 0,
            review,
            marks: [0, 8000, 40000, 64000, 79999].map((sample, i) => ({
              id: "manual-" + i,
              origin: "manual-reviewed-mark",
              sample,
            })),
          };
        const mapped = prepareRhythmMarks(root, projectId, request, result.runtime);
        assert.equal(mapped.rows.length, 5);
        assert.equal(mapped.included, 2);
        assert.equal(mapped.excluded, 3);
        assert.equal(mapped.rows[1].status, "included");
        const middle = mapped.rows[2];
        assert.equal(middle.status, "included");
        if (middle.status === "included") {
          assert.deepEqual(middle.outputFrame, { num: 115075, den: 1001 });
          assert.deepEqual(middle.outputSeconds, { num: 4603, den: 1200 });
        }
        assert.equal(mapped.rows[3].status, "outside-source-trim");
        const mappedFile = `pipeline/rhythm/${g.profile.id}.marks.json`;
        writeNew(path.join(project, mappedFile), Buffer.from(JSON.stringify(mapped)));
        assert.deepEqual(
          inspectRhythmMarks(
            root,
            projectId,
            mappedFile,
            sha(fs.readFileSync(path.join(project, mappedFile))),
            result.runtime,
          ),
          mapped,
        );
        if (g.profile.id === "wav-pulse") {
          const rejected = path.join(run, "rejected-config"),
            copiedProject = path.join(rejected, "public/projects", projectId),
            privateDirectory = path.dirname(evidence.artifacts.clock.path);
          for (const original of [
            configFile,
            registryFile,
            journalFile,
            g.file,
            path.join(project, result.file),
            path.join(project, mappedFile),
          ]) {
            const destination = path.join(rejected, path.relative(root, original));
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL);
          }
          fs.mkdirSync(path.dirname(path.join(rejected, privateDirectory)), { recursive: true });
          fs.cpSync(path.join(root, privateDirectory), path.join(rejected, privateDirectory), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          const copiedMap = path.join(copiedProject, mappedFile),
            savedMap = fs.readFileSync(copiedMap),
            copiedConfig = path.join(copiedProject, "project.json"),
            changed = JSON.parse(fs.readFileSync(copiedConfig, "utf8"));
          changed.tagline = "owned current config changed after mapping";
          fs.writeFileSync(copiedConfig, JSON.stringify(changed));
          const childAdmissions = mediaChildren;
          assert.throws(
            () => inspectRhythmMarks(rejected, projectId, mappedFile, sha(savedMap), result.runtime),
            (error) => {
              const message = String(error);
              assert.match(message, /stale\/reconstruction differs/);
              negativeErrors.push({ kind: "stale-config-old-sidecar", message });
              return true;
            },
          );
          assert.equal(mediaChildren, childAdmissions, "Readback never decodes");
          assert.deepEqual(fs.readFileSync(copiedMap), savedMap);
          for (const pin of protectedPins) assert.equal(sha(fs.readFileSync(pin.file)), pin.sha256);
        }
        let observedRows = 0;
        if (evidence.onsets.length) {
          const observed = prepareRhythmMarks(
            root,
            projectId,
            { ...request, marks: evidence.onsets.map((o) => ({ id: o.id, origin: "evidence-onset", onsetId: o.id })) },
            result.runtime,
          );
          assert.equal(observed.rows.length, evidence.onsets.length);
          observedRows = observed.rows.length;
        }
        const knownStartsSec = g.profile.pattern === "pulse" ? Array.from({ length: 10 }, (_, i) => i * 0.5) : [],
          used = new Set<number>(),
          matched = knownStartsSec.filter((start) => {
            const index = evidence.onsets.findIndex(
              (o, index) => !used.has(index) && Math.abs(o.sample / 16000 - start) <= 0.02,
            );
            if (index < 0) return false;
            used.add(index);
            return true;
          }).length;
        observations.push({
          diagnosticPulseComparison: {
            knownStartsSec,
            windowSec: 0.02,
            matchedEvents: matched,
            missedEvents: knownStartsSec.length - matched,
            unmatchedObservedEvents: evidence.onsets.length - used.size,
            notMusicalGroundTruth: true,
          },
          id: g.profile.id,
          pattern: g.profile.pattern,
          clock: evidence.clock,
          sourceSha256: g.asset.hash,
          evidenceFile: result.file,
          evidenceSha256: result.sha256,
          runtime: result.runtime,
          tempoBpm: evidence.analysis.tempoBpm,
          confidence: evidence.analysis.confidence,
          onsets: evidence.onsets,
          beatCandidatesSec: evidence.analysis.beatCandidatesSec,
          expectedPulsePeriodSec: g.profile.pattern === "pulse" ? 0.5 : null,
          qualityThresholdForced: false,
          manualRows: mapped.rows,
          observedRows,
          humanReviewVerified: false,
          calibratedBeatTruth: false,
        });
      }
      const first = outputs[0],
        selected = generated[0],
        valid = first.evidence;
      for (const kind of ["snapshot", "pcm", "commit", "offset"] as const) {
        const negativeRoot = path.join(run, "rejected-" + kind),
          negativeProject = path.join(negativeRoot, "public/projects", projectId),
          relativePrivate = path.dirname(valid.artifacts.clock.path);
        for (const file of [configFile, registryFile, journalFile, path.join(project, first.file), selected.file]) {
          const relative = path.relative(root, file),
            target = path.join(negativeRoot, relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
        }
        fs.mkdirSync(path.dirname(path.join(negativeRoot, relativePrivate)), { recursive: true });
        fs.cpSync(path.join(root, relativePrivate), path.join(negativeRoot, relativePrivate), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        let expected = first.sha256;
        if (kind === "offset") {
          const file = path.join(negativeRoot, valid.artifacts.clock.path),
            clock = JSON.parse(fs.readFileSync(file, "utf8"));
          clock.frames[0].pts = 1;
          const bytes = Buffer.from(JSON.stringify(clock));
          fs.writeFileSync(file, bytes);
          const altered = structuredClone(valid);
          altered.artifacts.clock = { ...altered.artifacts.clock, bytes: bytes.length, sha256: sha(bytes) };
          const { sha256, ...payload } = altered;
          altered.sha256 = rhythmDigest(payload);
          const output = Buffer.from(JSON.stringify(altered));
          fs.writeFileSync(path.join(negativeProject, first.file), output);
          expected = sha(output);
        } else {
          const pin =
            kind === "snapshot"
              ? valid.artifacts.originalSnapshot!
              : kind === "pcm"
                ? valid.artifacts.pcm
                : valid.artifacts.commit!;
          fs.writeFileSync(path.join(negativeRoot, pin.path), "owned rejected-copy tamper");
        }
        let refused = false;
        try {
          readRhythmEvidence(negativeRoot, projectId, first.file, expected, first.runtime);
        } catch (error) {
          refused = true;
          const message = String(error);
          if (kind === "offset") assert.match(message, /offset\/gap\/overlap/);
          negativeErrors.push({ kind, message });
        }
        assert.equal(refused, true, kind);
      }
      const mappedRequest = {
        version: 1,
        contract: "reviewed-rhythm-marks-v1",
        projectId,
        evidence: { path: first.file, sha256: "0".repeat(64) },
        trackId: "music-" + selected.profile.id,
        clipId: selected.profile.id,
        expectedRevision: 0,
        review: {
          kind: "supplied-review",
          reviewedBy: "technical fixture",
          note: "negative",
          acknowledge: "reviewed-source-marks-not-calibrated-beat-truth",
        },
        marks: [{ id: "x", origin: "manual-reviewed-mark", sample: 8000 }],
      };
      assert.throws(() => prepareRhythmMarks(root, projectId, mappedRequest, first.runtime), /external evidence pin/);
      assert.throws(
        () =>
          prepareRhythmMarks(
            root,
            projectId,
            { ...mappedRequest, evidence: { path: first.file, sha256: first.sha256 }, expectedRevision: 1 },
            first.runtime,
          ),
        /revision/,
      );
      const oldPath = process.env.PATH,
        callsBeforeMissing = mediaChildren;
      process.env.PATH = "/definitely-missing-rhythm-tools";
      try {
        assert.throws(() => resolveRhythmTool("ffmpeg"), /unavailable/);
      } finally {
        process.env.PATH = oldPath;
      }
      assert.equal(mediaChildren, callsBeforeMissing);
      const rejectedRoot = path.join(run, "rejected-container"),
        rejectedProject = path.join(rejectedRoot, "public/projects", projectId),
        bad = Buffer.from("ffconcat version 1.0\nfile /definitely-not-a-media-source\n"),
        badHash = sha(bad),
        badAsset = AssetRecordSchema.parse({
          ...selected.asset,
          id: `sha256:${badHash}`,
          hash: badHash,
          files: {
            ...selected.asset.files,
            original: `projects/${projectId}/assets/imported/${badHash}.wav`,
            bytes: bad.length,
          },
        });
      writeNew(path.join(rejectedProject, "project.json"), fs.readFileSync(configFile));
      writeNew(
        path.join(rejectedProject, "pipeline/asset-registry.json"),
        Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1, assets: [badAsset] })),
      );
      writeNew(path.join(rejectedRoot, "public", badAsset.files.original), bad);
      const beforeInvalid = mediaChildren;
      await assert.rejects(
        prepareRhythmEvidence(
          rejectedRoot,
          { ...first.evidence.request, assetId: badAsset.id, assetSha256: badHash },
          { signal: deadline.signal },
        ),
        (error) => {
          negativeErrors.push({ kind: "fixed-demuxer-invalid-text", message: String(error) });
          return true;
        },
      );
      assert.equal(mediaChildren - beforeInvalid, 3, "Two versions and failed stream probe only");
      const legacyProgram = path.join(run, "legacy-check.mjs"),
        legacyModule = new URL("../src/lib/audio/rhythm.ts", import.meta.url).href;
      writeNew(
        legacyProgram,
        Buffer.from(
          `import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const calls=[];const original=cp.execFileSync;cp.execFileSync=function(file,args,options){assert.ok(file==='ffmpeg'||file==='ffprobe');calls.push({file,args});assert.ok(calls.length<=6);return original.call(cp,file,args,options);};syncBuiltinESMExports();const {analyzeRhythm}=await import(${JSON.stringify(legacyModule)});const pulse=analyzeRhythm(${JSON.stringify(generated[0].file)}),silence=analyzeRhythm(${JSON.stringify(generated[3].file)}),override=analyzeRhythm(${JSON.stringify(generated[3].file)},{beatsSec:[.3,.7],note:'technical fixture override',reviewedBy:'fixture; not human'});assert.deepEqual(override.beatCandidatesSec,[.3,.7]);process.stdout.write(JSON.stringify({pulse,silence,override,calls}));`,
        ),
      );
      const legacy = await runRhythmOwnedProcess(
        installation.sandbox.file,
        ["-p", "(version 1)(allow default)(deny network*)", process.execPath, "--import", "tsx", legacyProgram],
        { timeoutMs: 15000, stallMs: 5000, stdoutBytes: 64 * 1024, stderrBytes: 64 * 1024, signal: deadline.signal },
      );
      const legacyResult = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(legacy.stdout));
      legacyChildren = legacyResult.calls.length;
      assert.equal(legacyChildren, 6);
      assert.deepEqual(legacyResult.pulse, outputs[0].evidence.analysis);
      assert.deepEqual(legacyResult.silence, outputs[3].evidence.analysis);
      writeNew(path.join(run, "legacy-result.json"), legacy.stdout);
      assert.equal(mediaChildren, 27);
      assert.equal(mediaChildren + legacyChildren, 33);
      assert.ok(children.every((c) => c.closed));
      for (const pin of protectedPins) assert.equal(sha(fs.readFileSync(pin.file)), pin.sha256);
      for (const name of fs.readdirSync(path.join(root, ".cache/rhythm-evidence", projectId)))
        assert.ok(!name.startsWith(".staging") && name !== ".preparation-lock");
      assert.deepEqual(installationPins(), beforeTools);
      for (const pin of codePins) assert.equal(new RhythmReadContext(workspace).check(pin, MiB).pin.sha256, pin.sha256);
      inventory(run);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      deadline.abort();
      clearTimeout(wholeTimer);
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      const receipt = {
        version: 1,
        label: "synthetic real-codec diagnostic; not human creative/music acceptance",
        ok: failure === undefined,
        error: failure === undefined ? null : String(failure),
        elapsedMs: Date.now() - started,
        sourcePins: codePins,
        toolPins: beforeTools,
        osPin,
        node: { version: process.versions.node, arch: process.arch, platform: process.platform },
        observations,
        negativeErrors,
        children,
        parentMediaChildren: mediaChildren,
        legacyMediaChildren: legacyChildren,
        maximumMediaChildren: 33,
        providerCalls: 0,
        spend: 0,
        networkAttempts: 0,
        denyNetworkProfileRequested: true,
        successfulSandboxChildren: children.filter(
          (c) => c.argv[0] === installation.sandbox.file && c.closed && c.code === 0,
        ).length,
        networkDenialMeasured: false,
        actualInjectedHost: false,
        ownedStagingCleanupRequired: true,
        immutableEvidenceRetained: true,
      };
      const bytes = Buffer.from(JSON.stringify(receipt, null, 2));
      assert.ok(bytes.length <= MiB, "Receipt/log1MiB bound");
      writeNew(path.join(run, "acceptance.json"), bytes);
      const artifacts = inventory(run);
      writeNew(
        path.join(run, "manifest.json"),
        Buffer.from(JSON.stringify({ receiptSha256: sha(bytes), ...artifacts }, null, 2)),
      );
      console.error(`Retained rhythm diagnostic: ${run}/acceptance.json SHA ${sha(bytes)}`);
    }
  },
);

test("diagnostic inventory counts real files in stat-only and fingerprint modes with exact256 cap", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rhythm-inventory-data-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ["a", "b"]) {
    fs.mkdirSync(path.join(root, folder));
    for (let i = 0; i < 128; i++) writeNew(path.join(root, folder, i + ".json"), Buffer.from("{}"));
  }
  const observed = inventory(root, false);
  assert.equal(observed.fileCount, 256);
  assert.equal(observed.bytes, 512);
  assert.deepEqual(observed.files, []);
  const fingerprinted = inventory(root, true);
  assert.equal(fingerprinted.fileCount, 256);
  assert.equal(fingerprinted.files.length, 256);
  assert.equal(fingerprinted.bytes, 512);
  writeNew(path.join(root, "c", "extra.json"), Buffer.from("{}"));
  assert.throws(() => inventory(root, false), /Diagnostic file cap/);
  assert.throws(() => inventory(root, true), /Diagnostic file cap/);
});

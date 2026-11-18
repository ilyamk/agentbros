import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { assertRegularLocalInput, localInputHash, readLocalJson } from "../src/lib/audio/local-input";
import { mediaProbe } from "../src/lib/audio/analysis";
import { buildAudioMix, mixLocalAudio, scopeMixPlanSources } from "../src/lib/audio/local-mix";
test(
  "local audio rejects FIFO/device/protocol inputs before probing or hashing",
  { skip: process.platform === "win32", timeout: 5000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "audio-regular-"));
    try {
      const fifo = path.join(root, "pipe");
      execFileSync("mkfifo", [fifo]);
      for (const check of [assertRegularLocalInput, localInputHash, readLocalJson, mediaProbe]) {
        const start = Date.now();
        assert.throws(() => check(fifo), /regular file/);
        assert.ok(Date.now() - start < 500);
        assert.throws(() => check("/dev/null"), /regular file/);
        assert.throws(() => check("http://127.0.0.1:1/audio"), /filesystem path/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("local playlist cannot invoke HTTP; ordinary local tone probe/mix still work", () => {
  const root = mkdtempSync(path.join(tmpdir(), "audio-protocol-"));
  try {
    const playlist = path.join(root, "remote.ffconcat");
    writeFileSync(playlist, "ffconcat version 1.0\nfile 'http://127.0.0.1:1/audio.wav'\n");
    assert.throws(() => mediaProbe(playlist), /whitelist|Unsafe file/);
    const hls = path.join(root, "remote.m3u8");
    writeFileSync(
      hls,
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:3,\nhttp://127.0.0.1:1/audio.ts\n#EXT-X-ENDLIST\n",
    );
    assert.throws(() => mediaProbe(hls), /whitelist/);
    const source = path.join(root, "tone.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", source]);
    assert.ok(mediaProbe(source).streams.some((s) => s.codec_type === "audio"));
    const output = path.join(root, "master.wav"),
      plan = { version: 1, durationSec: 3, tracks: [{ source, role: "music" }] };
    assert.match(buildAudioMix(plan).args.join(" "), /protocol_whitelist file,pipe/);
    assert.throws(
      () =>
        mixLocalAudio(plan, output, {
          beforePublish: () => {
            throw new Error("inputs changed");
          },
        }),
      /inputs changed/,
    );
    assert.throws(() => assertRegularLocalInput(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "probe forcibly bounds a TERM-resistant owned child without touching unrelated processes",
  { skip: process.platform === "win32", timeout: 5000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "audio-child-")),
      prior = process.env.PATH;
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
    try {
      const input = path.join(root, "input"),
        pid = path.join(root, "pid");
      writeFileSync(input, "guard-only placeholder");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const code =
        "require('fs').writeFileSync(" +
        JSON.stringify(pid) +
        ",String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);";
      const executable = path.join(root, "ffprobe");
      writeFileSync(executable, "#!/bin/sh\nexec " + quote(process.execPath) + " -e " + quote(code) + "\n");
      chmodSync(executable, 0o755);
      process.env.PATH = root + path.delimiter + prior;
      const start = Date.now();
      assert.throws(() => mediaProbe(input, { timeoutMs: 1000 }), /ETIMEDOUT|SIGKILL|timed out/);
      assert.ok(Date.now() - start < 3000);
      const owned = Number(readFileSync(pid, "utf8"));
      assert.throws(() => process.kill(owned, 0));
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
    } finally {
      unrelated.kill("SIGKILL");
      process.env.PATH = prior;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("a mix plan file keeps every track source inside the workspace before any probe", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "audio-plan-scope-")));
  try {
    const plan = (source: string) => ({ version: 1, durationSec: 3, tracks: [{ source, role: "music" }] });
    const scoped = scopeMixPlanSources(plan("public/music/bg.wav"), root) as { tracks: { source: string }[] };
    assert.equal(scoped.tracks[0]!.source, path.join(root, "public/music/bg.wav"));
    for (const unsafe of [
      "/etc/../etc/passwd",
      "../outside.wav",
      "public/../../outside.wav",
      "./bg.wav",
      "http://127.0.0.1:1/a.wav",
      "concat:a.wav|b.wav",
      "subfile:,start,0,end,0,:/etc/passwd",
      "file:/etc/passwd",
      "a\\..\\b.wav",
    ])
      assert.throws(() => scopeMixPlanSources(plan(unsafe), root), /workspace-relative/, unsafe);
    assert.throws(() => scopeMixPlanSources(plan("/etc/passwd"), root), /escapes/);
    assert.equal(
      (scopeMixPlanSources(plan(path.join(root, "public/a.wav")), root) as { tracks: { source: string }[] }).tracks[0]!
        .source,
      path.join(root, "public/a.wav"),
    );
    // A symlinked directory inside the workspace may not lead out of it.
    execFileSync("ln", ["-s", tmpdir(), path.join(root, "escape")]);
    assert.throws(() => scopeMixPlanSources(plan("escape/x.wav"), root), /escapes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  artefactPath,
  blendBase,
  checkName,
  contractCode,
  encodeRequest,
  liveArguments,
  liveRequest,
  livePaths,
  newToken,
  parseReply,
  readSession,
  replayCommand,
  REPLAY_SCRIPT,
  shellLine,
  writeSecret,
} from "../src/lib/backends/blender-live";
import { probeBlender } from "../src/lib/backends/probe";
import { decodePng } from "../src/lib/sensors/pixels";

const root = process.cwd();
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const workers = path.join(root, "scripts/workers/blender");
const hasPython = !spawnSync("python3", ["--version"]).error;

function temporary(prefix: string) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Runs Python assertions against the bpy-free protocol module, isolated (-I) so nothing from cwd is imported. */
function python(body: string) {
  const code = `import sys, json, os\nsys.path.insert(0, ${JSON.stringify(workers)})\nimport avc_live_protocol as p\n${body}`;
  const result = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop()!);
}

test(
  "protocol: the token is checked in constant time and a request without it is refused",
  { skip: !hasPython && "python3 is not installed" },
  () => {
    const out = python(`
def code(line, token="t" * 64):
    try:
        p.parse_request(line, token); return "ok"
    except p.LiveError as e:
        return e.code
good = json.dumps({"v": 1, "token": "t" * 64, "op": "inspect", "params": {}}).encode()
print(json.dumps({
  "good": code(good),
  "wrong": code(json.dumps({"v": 1, "token": "x" * 64, "op": "inspect"}).encode()),
  "missing": code(json.dumps({"v": 1, "op": "inspect"}).encode()),
  "emptyExpected": code(good, ""),
  "version": code(json.dumps({"v": 2, "token": "t" * 64, "op": "inspect"}).encode()),
  "notJson": code(b"POST / HTTP/1.1"),
  "array": code(b"[1]"),
  "params": code(json.dumps({"v": 1, "token": "t" * 64, "op": "add", "params": "x"}).encode()),
  "op": code(json.dumps({"v": 1, "token": "t" * 64, "op": "../x"}).encode()),
  "compare": [p.check_token("abc", "abc"), p.check_token("abc", "abd"), p.check_token("abc", None)],
}))`);
    assert.deepEqual(out, {
      good: "ok",
      wrong: "AUTH",
      missing: "AUTH",
      emptyExpected: "AUTH",
      version: "INVALID_INPUT",
      notJson: "INVALID_INPUT",
      array: "INVALID_INPUT",
      params: "INVALID_INPUT",
      op: "INVALID_INPUT",
      compare: [true, false, false],
    });
  },
);

test(
  "protocol: request lines are capped and a connection closed early is an error",
  { skip: !hasPython && "python3 is not installed" },
  () => {
    const out = python(`
def reader(chunks):
    data = list(chunks)
    return lambda n: data.pop(0) if data else b""
def code(chunks, limit=16):
    try:
        return p.read_line(reader(chunks), limit).decode()
    except p.LiveError as e:
        return e.code
print(json.dumps([code([b"abc\\n"]), code([b"ab", b"c\\nrest"]), code([b"x" * 40]), code([b"x" * 17 + b"\\n"]), code([b"abc"])]))`);
    assert.deepEqual(out, ["abc", "abc", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT"]);
  },
);

test(
  "protocol: property paths allow attributes and literal subscripts only, never forbidden or private names",
  { skip: !hasPython && "python3 is not installed" },
  () => {
    const out = python(`
def parse(path):
    try:
        return p.parse_property_path(path)
    except p.LiveError as e:
        return e.code
cases = ['location', 'data.lens', 'node_tree.nodes["Principled BSDF"].inputs[0].default_value', 'driver', 'animation_data.action', 'render.filepath',
         '__class__', 'bl_rna', 'a()', 'a+b', 'nodes[__import__]', 'nodes["a"]', 'a..b', 'data.texts', '.'.join(['a'] * 13), '']
print(json.dumps({c: parse(c) for c in cases}))`);
    assert.deepEqual(out.location, [["attr", "location"]]);
    assert.deepEqual(out["data.lens"], [
      ["attr", "data"],
      ["attr", "lens"],
    ]);
    assert.deepEqual(out['node_tree.nodes["Principled BSDF"].inputs[0].default_value'], [
      ["attr", "node_tree"],
      ["attr", "nodes"],
      ["key", "Principled BSDF"],
      ["attr", "inputs"],
      ["key", 0],
      ["attr", "default_value"],
    ]);
    for (const forbidden of ["driver", "animation_data.action", "render.filepath", "bl_rna", "data.texts"])
      assert.equal(out[forbidden], "VALIDATION", forbidden);
    for (const bad of [
      "__class__",
      "a()",
      "a+b",
      "nodes[__import__]",
      'nodes["a"]',
      "a..b",
      "",
      "a.a.a.a.a.a.a.a.a.a.a.a.a",
    ])
      assert.equal(out[bad], "INVALID_INPUT", bad);
  },
);

test(
  "protocol: names are never paths and containment follows symlinks",
  { skip: !hasPython && "python3 is not installed" },
  () => {
    const dir = temporary("live-contain-"),
      outside = temporary("live-outside-");
    try {
      mkdirSync(path.join(dir, "out"));
      symlinkSync(outside, path.join(dir, "out", "escape"));
      const out = python(`
root = ${JSON.stringify(path.join(dir, "out"))}
def name(v):
    try:
        return p.check_name(v)
    except p.LiveError as e:
        return e.code
def inside(v):
    try:
        return p.contained(root, os.path.join(root, v))
    except p.LiveError as e:
        return e.code
print(json.dumps({"names": [name(v) for v in ["look-1", "../x", "/abs", "Upper", "a/b", "", "x" * 65]], "paths": [inside("a.png"), inside("../a.png"), inside("escape/a.png"), inside("/etc/passwd")]}))`);
      assert.deepEqual(out.names, [
        "look-1",
        "INVALID_INPUT",
        "INVALID_INPUT",
        "INVALID_INPUT",
        "INVALID_INPUT",
        "INVALID_INPUT",
        "INVALID_INPUT",
      ]);
      assert.deepEqual(out.paths, [path.join(dir, "out", "a.png"), "VALIDATION", "VALIDATION", "VALIDATION"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

test("session paths, names and artefacts stay inside their roots", () => {
  const dir = temporary("live-paths-");
  try {
    const paths = livePaths(dir, "demo", "main");
    assert.equal(paths.sessionDir, path.join(dir, ".cache/blender-live/demo/main"));
    assert.equal(paths.outDir, path.join(dir, "out/demo/blender-live/main"));
    assert.equal(paths.assetsDir, path.join(dir, "public/projects/demo/assets/blender"));
    assert.equal(livePaths(dir, undefined, "look").outDir, path.join(dir, "out/qa/blender-live/look"));
    for (const bad of ["../x", "a/b", "Main", ""]) assert.throws(() => livePaths(dir, undefined, bad), /--session/);
    assert.throws(() => checkName("../../etc", "name"), /never a path/);
    assert.equal(artefactPath(paths, "shot", ".blend", false), path.join(paths.assetsDir!, "shot.blend"));
    assert.throws(() => artefactPath(paths, "../shot", ".blend", false), /never a path/);
    mkdirSync(paths.assetsDir!, { recursive: true });
    writeFileSync(path.join(paths.assetsDir!, "shot.live.json"), "{}");
    assert.throws(() => artefactPath(paths, "shot", ".live.json", false), /exists/);
    assert.equal(artefactPath(paths, "shot", ".live.json", true), path.join(paths.assetsDir!, "shot.live.json"));
    assert.equal(
      artefactPath(livePaths(dir, undefined, "look"), "shot", ".blend", false),
      path.join(dir, "out/qa/blender-live/look/shot.blend"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the session file is private to its owner, and a readable one is refused", () => {
  const dir = temporary("live-secret-");
  try {
    const paths = livePaths(dir, undefined, "main");
    const token = newToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(newToken(), token);
    writeSecret(paths.sessionFile, JSON.stringify({ token, pid: 1, port: 1 }));
    assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600);
    assert.equal(statSync(paths.sessionDir).mode & 0o777, 0o700);
    assert.equal(readSession(paths)!.token, token);
    chmodSync(paths.sessionFile, 0o644);
    assert.throws(() => readSession(paths), /readable by other users/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Blender starts headless with no user add-ons, no auto-run scripts and Online Access off", () => {
  const args = liveArguments(false, "/w/a.blend");
  assert.deepEqual(args.slice(0, 4), ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode"]);
  assert.ok(args.indexOf("/w/a.blend") > args.indexOf("--disable-autoexec"));
  assert.ok(args[args.indexOf("--python") + 1]!.endsWith("scripts/workers/blender/avc_live.py"));
  assert.equal(liveArguments(true).includes("--background"), false);
  assert.ok(liveArguments(true).includes("--offline-mode"));
  assert.equal(
    args.some((arg) => /token/i.test(arg)),
    false,
    "the token never appears in argv",
  );
  const source =
    readFileSync(path.join(workers, "avc_live.py"), "utf8") +
    readFileSync(path.join(workers, "avc_live_ops.py"), "utf8");
  assert.match(source, /listener\.bind\(\("127\.0\.0\.1", 0\)\)/);
  assert.doesNotMatch(source, /\bexec\(|\beval\(|urllib|requests|http\.client|urlopen|socket\.create_connection/);
});

test("a .blend base must be inside the workspace and is pinned by its hash", () => {
  const dir = temporary("live-base-"),
    outside = temporary("live-base-out-");
  try {
    writeFileSync(path.join(dir, "a.blend"), "BLENDER");
    writeFileSync(path.join(outside, "b.blend"), "BLENDER");
    const base = blendBase(dir, "a.blend");
    assert.equal(base.kind, "blend");
    assert.equal(base.kind === "blend" && base.path, "a.blend");
    assert.match(base.kind === "blend" ? base.sha256 : "", /^[0-9a-f]{64}$/);
    assert.throws(() => blendBase(dir, path.join(outside, "b.blend")), /escapes/);
    assert.throws(() => blendBase(dir, "missing.blend"), /existing \.blend/);
    assert.deepEqual(blendBase(dir), { kind: "empty" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the replay command is blender:run with the replay script and the still settings", () => {
  const command = replayCommand("/w", "/w/public/projects/p/assets/blender/shot.live.json", "/w/out/p/shot-replay", {
    frame: 12,
    width: 640,
    height: 360,
    samples: 16,
    engine: "cycles",
  });
  assert.deepEqual(command, [
    "pnpm",
    "blender:run",
    "--script",
    REPLAY_SCRIPT,
    "--script-args",
    '["public/projects/p/assets/blender/shot.live.json"]',
    "--output",
    "out/p/shot-replay",
    "--frames",
    "12-12",
    "--device",
    "cpu",
    "--engine",
    "cycles",
    "--resolution",
    "640x360",
    "--samples",
    "16",
  ]);
  assert.equal(shellLine(["a b", "it's", "x"]), `'a b' 'it'\\''s' x`);
});

test("client: one line out with the token, one line back; errors keep the contract codes", async () => {
  assert.equal(encodeRequest("tok", "inspect", {}), '{"v":1,"token":"tok","op":"inspect","params":{}}\n');
  assert.deepEqual(parseReply('{"ok":true,"result":{"a":1}}'), { ok: true, result: { a: 1 } });
  assert.equal(contractCode("AUTH"), "VALIDATION");
  assert.equal(contractCode("NOT_FOUND"), "INVALID_INPUT");
  assert.equal(contractCode("ASSET_MISSING"), "ASSET_MISSING");
  assert.equal(contractCode("anything"), "INTERNAL");
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {
      /* the client hangs up on an oversized reply */
    });
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString()) as { token: string; op: string };
      seen.push(data.toString());
      if (request.op === "big") socket.end(`${"x".repeat(17 * 1024 * 1024)}`);
      else if (request.token !== "good")
        socket.end('{"ok":false,"error":{"code":"AUTH","message":"Missing or wrong session token."}}\n');
      else socket.end('{"ok":true,"result":{"pong":true}}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.deepEqual(await liveRequest(port, "good", "ping"), { pong: true });
    assert.ok(seen[0]!.endsWith("\n") && seen[0]!.includes('"token":"good"'));
    await assert.rejects(
      liveRequest(port, "bad", "ping"),
      (error: Error & { code?: string }) => error.code === "VALIDATION" && /token/.test(error.message),
    );
    await assert.rejects(liveRequest(port, "good", "big"), /16 MiB/);
  } finally {
    server.close();
  }
  await assert.rejects(
    liveRequest(port, "good", "ping", {}, 2000),
    (error: Error & { code?: string }) => error.code === "NETWORK",
  );
  await assert.rejects(liveRequest(70000, "good", "ping"), /port/);
});

const blender = probeBlender();
const realBlender = process.env.RUN_BLENDER_TESTS === "1" && blender.available;

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [tsx, "scripts/blender-live.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 300000,
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  return {
    status: result.status,
    envelope: JSON.parse(lines[0]!) as {
      ok: boolean;
      error?: string;
      message?: string;
      outputs: string[];
      metadata: Record<string, any>;
    },
  };
}

function pngSize(file: string): [number, number] {
  const head = readFileSync(file).subarray(0, 24);
  assert.equal(head.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is a PNG`);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

test(
  "real Blender: start, add an object, render a still, refuse a bad token, export a shot and replay through blender:run pixel for pixel",
  { skip: !realBlender && "set RUN_BLENDER_TESTS=1 with Blender installed", timeout: 600000 },
  async () => {
    const session = `test-${process.pid}`;
    const paths = livePaths(root, undefined, session);
    const replayOut = path.join(root, "out/qa", `${session}-recipe-replay`);
    const call = (action: string, params?: object) =>
      cli(["--action", action, "--session", session, ...(params ? ["--params", JSON.stringify(params)] : [])]);
    try {
      const started = call("start");
      assert.equal(started.envelope.ok, true, started.envelope.message ?? "");
      const record = readSession(paths)!;
      assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600);
      assert.equal(started.envelope.metadata.token, undefined, "the token is never printed");
      const listening = spawnSync("lsof", ["-nP", "-a", "-p", String(record.pid), "-iTCP", "-sTCP:LISTEN"], {
        encoding: "utf8",
      });
      if (listening.status === 0) assert.match(listening.stdout, new RegExp(`127\\.0\\.0\\.1:${record.port} `));
      assert.equal(call("status").envelope.metadata.onlineAccess, false);

      for (const [action, params] of [
        ["material", { name: "clay", base_color: "#c8643c", roughness: 0.4 }],
        ["add", { kind: "cube", name: "box", location: [0, 0, 1], material: "clay", rotation_deg: [0, 0, 30] }],
        ["add", { kind: "plane", name: "floor", scale: [5, 5, 1] }],
        ["add", { kind: "camera", name: "cam", location: [5, -6, 4], target: [0, 0, 0.8] }],
        [
          "add",
          {
            kind: "light",
            name: "key",
            light_type: "AREA",
            location: [3, -3, 5],
            target: [0, 0, 1],
            energy: 600,
            size: 2,
          },
        ],
        ["set", { target: { kind: "object", name: "box" }, path: "location", value: [0, 0, 2], frame: 10 }],
        ["set", { target: { kind: "object", name: "box" }, path: "location", value: [0, 0, 1], frame: 1 }],
      ] as const)
        assert.equal(call(action, params).envelope.ok, true, `${action} ${JSON.stringify(params)}`);

      const inspected = call("inspect").envelope.metadata;
      const box = inspected.objects.find((item: { name: string }) => item.name === "box");
      assert.ok(box, "the added object is in the scene");
      assert.equal(box.type, "MESH");
      assert.deepEqual(box.materials, ["clay"]);
      assert.equal(inspected.scene.camera, "cam");
      assert.equal(inspected.journal, 7);
      const journal = JSON.parse(readFileSync(path.join(paths.outDir, "journal.live.json"), "utf8"));
      assert.equal(journal.ops.length, 7, "every change is on disk as it happens");

      // Refusals: a bad token, a forbidden property, a script outside the kit, a path-shaped name.
      await assert.rejects(liveRequest(record.port, "f".repeat(64), "inspect"), /token/);
      const forbidden = call("set", { target: { kind: "scene" }, path: "render.filepath", value: "/tmp/x" });
      assert.equal(forbidden.envelope.ok, false);
      assert.equal(forbidden.envelope.error, "VALIDATION");
      assert.equal(call("run-kit", { script: "studio_kit.py" }).envelope.error, "VALIDATION");
      assert.equal(
        call("run-kit", { script: "../../scripts/workers/blender/avc_live.py" }).envelope.error,
        "VALIDATION",
      );
      assert.equal(call("still", { name: "../escape" }).envelope.error, "INVALID_INPUT");
      assert.equal(call("add", { kind: "cube", name: "box" }).envelope.ok, false, "a duplicate name is refused");
      assert.equal(call("inspect").envelope.metadata.journal, 7, "refused ops leave the journal alone");

      const still = call("still", { name: "look", frame: 5, width: 160, height: 90, samples: 4, engine: "cycles" });
      assert.equal(still.envelope.ok, true, still.envelope.message ?? "");
      const stillPath = still.envelope.outputs[0]!;
      assert.ok(stillPath.startsWith(paths.outDir + path.sep));
      assert.deepEqual(pngSize(stillPath), [160, 90]);

      const saved = call("save", { name: `${session}-snapshot` });
      assert.equal(saved.envelope.ok, true, saved.envelope.message ?? "");
      assert.equal(saved.envelope.outputs[0], path.join(paths.outDir, `${session}-snapshot.blend`));
      assert.ok(statSync(saved.envelope.outputs[0]!).size > 1000);
      assert.equal(
        call("save", { name: `${session}-snapshot` }).envelope.error,
        "FILE_EXISTS",
        "save never overwrites without --overwrite",
      );

      const exported = call("export-recipe", { name: `${session}-recipe` });
      assert.equal(exported.envelope.ok, true, exported.envelope.message ?? "");
      assert.ok(exported.envelope.outputs[1]!.endsWith(".py"));
      assert.match(readFileSync(exported.envelope.outputs[1]!, "utf8"), /avc_recipes.apply/);
      assert.equal((exported.envelope.metadata.command as string[]).includes("--script-args"), false);
      const recipe = JSON.parse(readFileSync(exported.envelope.outputs[0]!, "utf8"));
      assert.equal(recipe.ops.length, 7);
      assert.deepEqual(exported.envelope.metadata.settings, {
        frame: 5,
        width: 160,
        height: 90,
        samples: 4,
        engine: "cycles",
      });
      const [, , ...runArgs] = exported.envelope.metadata.command as string[];
      assert.ok(runArgs.includes(`out/qa/${session}-recipe-replay`));
      const replay = spawnSync(process.execPath, [tsx, "scripts/blender-run.ts", ...runArgs], {
        cwd: root,
        encoding: "utf8",
        timeout: 300000,
      });
      const envelope = JSON.parse(replay.stdout.trim().split("\n").pop()!);
      assert.equal(envelope.ok, true, envelope.message);
      const replayed = path.join(replayOut, "frame-000005.png");
      assert.deepEqual(pngSize(replayed), [160, 90]);
      assert.ok(
        decodePng(readFileSync(replayed), 160, 90).equals(decodePng(readFileSync(stillPath), 160, 90)),
        "the replayed frame matches the live still pixel for pixel",
      );
    } finally {
      const stopped = call("stop");
      assert.equal(stopped.envelope.ok, true);
      const record = existsSync(paths.sessionFile) ? readSession(paths) : undefined;
      if (record)
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      for (const target of [paths.sessionDir, paths.outDir, replayOut])
        rmSync(target, { recursive: true, force: true });
    }
  },
);

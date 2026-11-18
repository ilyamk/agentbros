import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PYTHON_ROOT,
  PYTHON_VERSION,
  pythonArgs,
  pythonEnvironment,
  pythonRequirementsHash,
  pythonToolArgs,
  pythonUv,
  pythonVersion,
} from "../src/lib/python";

test("workers use the pinned interpreter and repository even from another project", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "python-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, ".python-version"), "3.9\n");
  writeFileSync(
    path.join(directory, "pyproject.toml"),
    '[project]\nname="unrelated"\nversion="0.0.0"\nrequires-python=">=3.9"\n',
  );
  const result = spawnSync(
    pythonUv(),
    [
      "--offline",
      ...pythonArgs("stdlib", [
        "-c",
        "import json,sys; print(json.dumps([sys.version.split()[0],sys.prefix,sys.flags.isolated]))",
      ]),
    ],
    {
      cwd: directory,
      env: pythonEnvironment("stdlib"),
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message || "Python launch failed");
  const [version, prefix, isolated] = JSON.parse(result.stdout);
  assert.equal(version, PYTHON_VERSION);
  assert.equal(prefix, path.join(PYTHON_ROOT, ".cache/python/stdlib"));
  assert.equal(isolated, 1);
});

test("profiles have separate environments and refuse inherited sync bypasses", () => {
  const base = {
    UV_PROJECT_ENVIRONMENT: "/wrong",
    UV_NO_SYNC: "1",
    UV_FROZEN: "1",
    UV_ISOLATED: "1",
    VIRTUAL_ENV: "/wrong",
    UV_ENV_FILE: "/wrong",
    PATH: "/path",
  };
  const audio = pythonEnvironment("audio-map", base),
    speech = pythonEnvironment("vad", base);
  assert.notEqual(audio.UV_PROJECT_ENVIRONMENT, speech.UV_PROJECT_ENVIRONMENT);
  assert.equal(audio.PATH, "/path");
  for (const key of ["UV_NO_SYNC", "UV_FROZEN", "UV_ISOLATED", "VIRTUAL_ENV", "UV_ENV_FILE"])
    assert.equal(audio[key], undefined);
  assert.equal(base.UV_NO_SYNC, "1");
  const args = pythonToolArgs("stems", "demucs", ["--help"]);
  assert.ok(args.includes("--locked") && args.includes("--exact") && args.includes("--no-default-groups"));
  assert.deepEqual(args.slice(-2), ["demucs", "--help"]);
  assert.equal(args[args.indexOf("--group") + 1], "stems");
  assert.equal(pythonVersion("offset"), "3.12.16");
  const offset = pythonArgs("offset", ["--version"]);
  assert.equal(offset[offset.indexOf("--python") + 1], pythonVersion("offset"));
  assert.equal(pythonVersion("stems"), PYTHON_VERSION);
});

test("all tracked Python sources compile on the pin and dependencies come from the central lock", () => {
  const files = spawnSync("git", ["ls-files", "*.py"], { cwd: PYTHON_ROOT, encoding: "utf8" });
  assert.equal(files.status, 0);
  const result = spawnSync(
    pythonUv(),
    [
      "--offline",
      ...pythonArgs("stdlib", [
        "-c",
        'import json,pathlib,sys,tomllib; root=pathlib.Path(sys.argv[1]); project=tomllib.loads((root/"pyproject.toml").read_text()); lock=tomllib.loads((root/"uv.lock").read_text()); [compile((root/f).read_bytes(),f,"exec") for f in json.load(sys.stdin)]; print(json.dumps({"groups":list(project["dependency-groups"]),"python":lock["requires-python"],"ruff":project["tool"]["ruff"]["target-version"]}))',
        PYTHON_ROOT,
      ]),
    ],
    {
      input: JSON.stringify(files.stdout.trim().split("\n")),
      env: pythonEnvironment("stdlib"),
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message || "Python launch failed");
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.python, ">=3.12, <3.14");
  assert.equal(metadata.ruff, "py313");
  for (const group of [
    "reference",
    "reference-audio",
    "transnet",
    "audio-map",
    "stems",
    "multicam",
    "offset",
    "asr",
    "vad",
    "diarize",
    "sfx-index",
    "clap",
    "matte",
    "vork",
    "earshot",
    "cmake",
    "yt-dlp",
  ])
    assert.ok(metadata.groups.includes(group), group);
  assert.match(pythonRequirementsHash(), /^[a-f0-9]{64}$/);
  const project = readFileSync(path.join(PYTHON_ROOT, "pyproject.toml"), "utf8");
  assert.match(project, /opencv-python-headless==5\.1\.0\.95/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { excuses, memoryContent } from "../src/lib/leak-scan";
import { serialiseFrontMatter } from "../src/lib/memory";
import {
  decodeEncodedWords,
  neutraliseHeader,
  runGit,
  scanView,
  upstreamProposal,
  type GitRunner,
} from "../src/lib/memory/upstream";
import { MemoryEntrySchema } from "../src/types/memory";

const REPO = path.resolve(import.meta.dirname, "..");
const PRIVATE_EMAIL = "private.person@example.org";
const OBSERVATION = "The critic flagged a flat ending in two promos";
const APPROVAL = "да, давай так и сделаем для всех роликов";
const PROJECT = "acme-launch";
const PROPOSAL = "proposal-20261114-ending-sensor";
const BACKTICKED = String.raw`C:\temp`;

const realMemory = () => {
  const dir = path.join(REPO, "memory");
  return existsSync(dir)
    ? readdirSync(dir)
        .map((name) => `${name}:${statSync(path.join(dir, name)).mtimeMs}`)
        .sort()
    : [];
};

type Fixture = { repo: string; memory: string; commit: (files: Record<string, string>, message: string) => string };

function fixture(t: test.TestContext): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "memory-upstream-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  const memory = path.join(base, "memory");
  mkdirSync(repo);
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", PRIVATE_EMAIL]);
  run(["config", "user.name", "Private Person"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repo, ".gitignore"), "/memory/*\n!/memory/AGENTS.md\n/out/\n");
  writeFileSync(
    path.join(repo, "public-export.json"),
    JSON.stringify({
      deny: [{ glob: "TASK_LOG.md", reason: "private working log" }],
      leakPatterns: [
        { name: "email", regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}\\b" },
      ],
      allowedHits: [],
    }),
  );
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
      run(["add", "--force", "--", file]);
    }
    run(["commit", "-q", "-m", message]);
    return run(["rev-parse", "HEAD"]);
  };
  commit({ "README.md": "# Fixture\n" }, "init");
  return { repo, memory, commit };
}

function writeEntry(memory: string, folder: string, data: Record<string, unknown>, body = "") {
  assert.ok(MemoryEntrySchema.safeParse(data).success, JSON.stringify(MemoryEntrySchema.safeParse(data).error?.issues));
  mkdirSync(path.join(memory, folder), { recursive: true });
  writeFileSync(path.join(memory, folder, `${data.id as string}.md`), serialiseFrontMatter(data, body));
}

function seed(memory: string, proposal: Record<string, unknown>) {
  writeEntry(
    memory,
    "observations",
    {
      version: 1,
      id: "observation-20261114-flat-ending",
      type: "observation",
      summary: OBSERVATION,
      scope: {},
      source: { kind: "agent", agent: "creative-critic", evidence: "out/x/critique.md" },
      occurrences: 2,
      createdAt: "2026-11-14",
    },
    `Seen twice.\n\n- Never leave \`${BACKTICKED}\` paths visible in the final frame of a film\n`,
  );
  writeEntry(memory, "episodes", {
    version: 1,
    id: "episode-20261114-launch",
    type: "episode",
    summary: "Promo delivered after three rounds",
    scope: { project: PROJECT },
    source: { kind: "measured", evidence: "delivery check" },
    createdAt: "2026-11-14",
  });
  writeEntry(memory, "proposals", {
    version: 1,
    id: PROPOSAL,
    type: "proposal",
    summary: "Measure the ending before delivery",
    scope: {},
    source: { kind: "agent", agent: "orchestrator", evidence: "consolidate repeats" },
    createdAt: "2026-11-14",
    proposal: {
      change: "sensor",
      targets: ["scripts/ending.ts", "tests/ending.test.ts"],
      causes: ["observation-20261114-flat-ending"],
      test: "tests/ending.test.ts",
      ...proposal,
    },
  });
}

const applied = (commits: string[], state = "applied") => ({
  state,
  approval: { quote: APPROVAL, at: "2026-11-14" },
  commits,
  appliedAt: "2026-11-14",
});
const TRAILER = "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

function withMemory<T>(memory: string, fn: () => T): T {
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  process.env.AGENTBROS_MEMORY_ROOT = memory;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_MEMORY_ROOT;
    else process.env.AGENTBROS_MEMORY_ROOT = previous;
  }
}

function recorder(): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  return {
    calls,
    git: (args, cwd) => {
      calls.push([...args]);
      return runGit(args, cwd);
    },
  };
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "none";
};

test("an applied proposal becomes neutral patches and a generalised PR.md under the memory root; nothing is pushed", (t) => {
  const before = realMemory();
  const { repo, memory, commit } = fixture(t);
  const sha = commit(
    { "scripts/ending.ts": "export const ending = 1;\n", "tests/ending.test.ts": "// test\n" },
    `feat(sensor): measure the ending${TRAILER}`,
  );
  seed(memory, applied([sha.slice(0, 7)]));
  const { calls, git } = recorder();

  const result = withMemory(memory, () => upstreamProposal({ repo, id: PROPOSAL, git }));
  assert.deepEqual(result.hits, []);
  assert.equal(result.written, true);
  const outDir = path.join(memory, "upstream", PROPOSAL);
  assert.equal(result.outDir, outDir);
  assert.deepEqual(readdirSync(outDir).sort(), ["0001-feat-sensor-measure-the-ending.patch", "PR.md"]);

  const patch = readFileSync(path.join(outDir, "0001-feat-sensor-measure-the-ending.patch"), "utf8");
  assert.match(patch, /^From: Agent Bros\. Pictures contributors <noreply@example\.com>$/m);
  assert.match(patch, /scripts\/ending\.ts/);
  assert.match(
    patch,
    /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m,
    "the date is UTC, without the author's offset",
  );
  assert.ok(
    !patch.includes(PRIVATE_EMAIL) && !patch.includes("Private Person"),
    "the author's identity never reaches a patch",
  );
  const applies = spawnSync(
    "git",
    ["apply", "--check", "-R", path.join(outDir, "0001-feat-sensor-measure-the-ending.patch")],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(applies.status, 0, applies.stderr);

  const pr = readFileSync(path.join(outDir, "PR.md"), "utf8");
  const fromOutput = (skip: string[]) => memoryContent([memory], skip).filter(({ id }) => id === "PR").length;
  assert.ok(fromOutput([]) > 0, "PR.md holds needle-sized lines");
  assert.equal(
    fromOutput(["upstream"]),
    0,
    "export:public skips memory/upstream: its output is tracked text, not an entry",
  );
  assert.match(pr, /^# Add or tighten a sensor: scripts\/ending\.ts and 1 more$/m);
  assert.match(pr, /pnpm exec tsx --test tests\/ending\.test\.ts/);
  assert.match(pr, /Nothing was pushed and no pull request was opened\./);
  for (const secret of [OBSERVATION, APPROVAL, PROPOSAL, "ending-sensor", "flat-ending", PROJECT])
    assert.ok(!pr.includes(secret), secret);

  for (const args of calls)
    for (const banned of ["push", "remote", "fetch", "send-email", "request-pull", "pull"])
      assert.ok(!args.includes(banned), `git ${args.join(" ")}`);
  assert.deepEqual(realMemory(), before, "the real memory/ is untouched");

  assert.equal(
    withMemory(memory, () => codeOf(() => upstreamProposal({ repo, id: PROPOSAL }))),
    "FILE_EXISTS",
    "a second run never overwrites",
  );
});

test("the CLI emits one JSON line, never runs push or gh, and a dry run writes nothing", (t) => {
  const { repo, memory, commit } = fixture(t);
  const sha = commit({ "scripts/ending.ts": "export const ending = 2;\n" }, "feat(sensor): measure the ending");
  seed(memory, applied([sha]));
  const bin = path.join(path.dirname(memory), "bin");
  const log = path.join(path.dirname(memory), "spawned.log");
  mkdirSync(bin);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "git $*" >> "${log}"\nexec "${realGit}" "$@"\n`);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "gh $*" >> "${log}"\nexit 1\n`);
  chmodSync(path.join(bin, "git"), 0o755);
  chmodSync(path.join(bin, "gh"), 0o755);
  const cli = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(REPO, "scripts/memory-upstream.ts"),
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, AGENTBROS_MEMORY_ROOT: memory, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      },
    );
    assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
    return { status: result.status, json: JSON.parse(result.stdout) };
  };

  const dry = cli("--id", PROPOSAL, "--dry-run");
  assert.equal(dry.status, 0);
  assert.equal(dry.json.ok, true);
  assert.deepEqual(dry.json.outputs, []);
  assert.ok(!existsSync(path.join(memory, "upstream")), "a dry run writes nothing");

  const real = cli("--id", PROPOSAL);
  assert.equal(real.status, 0, JSON.stringify(real.json));
  assert.equal(real.json.outputs.length, 2);
  assert.equal(real.json.metadata.pushed, false);

  const spawned = readFileSync(log, "utf8");
  assert.ok(!/^gh /m.test(spawned), "gh never runs");
  assert.ok(!/\bpush\b/.test(spawned), "git push never runs");

  const outside = cli("--id", PROPOSAL, "--out", path.join(repo, "scripts", "upstream-out"));
  assert.equal(
    outside.json.error,
    "INVALID_INPUT",
    "unignored workspace output is refused even when the workspace is in tmp",
  );
});

test("refusals: a proposal not applied, a missing commit, a commit touching memory/, .env or an export-denied file", (t) => {
  const { repo, memory, commit } = fixture(t);
  const sha = commit({ "scripts/ending.ts": "export const ending = 3;\n" }, "feat(sensor): measure the ending");
  seed(memory, { state: "approved", approval: { quote: APPROVAL, at: "2026-11-14" } });
  withMemory(memory, () =>
    assert.equal(
      codeOf(() => upstreamProposal({ repo, id: PROPOSAL })),
      "VALIDATION",
      "approved is not applied",
    ),
  );

  seed(memory, applied(["deadbeef"]));
  withMemory(memory, () =>
    assert.equal(
      codeOf(() => upstreamProposal({ repo, id: PROPOSAL })),
      "VALIDATION",
      "a missing commit",
    ),
  );

  const personal = commit(
    { "memory/lessons/lesson-x.md": "private\n", "scripts/ending.ts": "export const ending = 4;\n" },
    "chore: sneak",
  );
  seed(memory, applied([sha, personal]));
  const refusal = withMemory(memory, () => {
    try {
      upstreamProposal({ repo, id: PROPOSAL });
    } catch (error) {
      return error as { code: string; message: string };
    }
    return undefined;
  });
  assert.equal(refusal?.code, "VALIDATION");
  assert.match(refusal!.message, /touches memory\/ \(memory\/lessons\/lesson-x\.md\)/);

  const env = commit({ "config/.env.local": "KEY=1\n" }, "chore: env");
  seed(memory, applied([env]));
  withMemory(memory, () =>
    assert.equal(
      codeOf(() => upstreamProposal({ repo, id: PROPOSAL })),
      "VALIDATION",
      "an environment file",
    ),
  );

  const log = commit({ "TASK_LOG.md": "# Log\n" }, "docs(log): entry");
  seed(memory, applied([log]));
  const denied = withMemory(memory, () => {
    try {
      upstreamProposal({ repo, id: PROPOSAL });
    } catch (error) {
      return error as { code: string; message: string };
    }
    return undefined;
  });
  assert.equal(denied?.code, "VALIDATION");
  assert.match(denied!.message, /the public export denies: private working log/);

  const binary = commit({ "public/shared/logo.bin": "\u0000\u0001binary\u0000" }, "feat: logo");
  seed(memory, applied([binary]));
  const unreadable = withMemory(memory, () => {
    try {
      upstreamProposal({ repo, id: PROPOSAL });
    } catch (error) {
      return error as { code: string; message: string };
    }
    return undefined;
  });
  assert.equal(unreadable?.code, "VALIDATION");
  assert.match(unreadable!.message, /binary hunk/);

  const rules = commit({ "memory/AGENTS.md": "# Memory rules\n" }, "docs(memory): rules");
  seed(memory, applied([rules]));
  withMemory(memory, () =>
    assert.equal(
      codeOf(() => upstreamProposal({ repo, id: PROPOSAL, dryRun: true })),
      "none",
      "memory/AGENTS.md is tracked harness",
    ),
  );
  assert.ok(!existsSync(path.join(memory, "upstream")));
});

test("private names moved to the local pattern file still block upstream patches", (t) => {
  const { repo, memory, commit } = fixture(t);
  const token = "fixtureclient";
  const sha = commit({ "docs/ending.md": `# Ending\n${token}\n` }, "docs: ending");
  seed(memory, applied([sha]));
  writeFileSync(
    path.join(repo, "leak-patterns.local.json"),
    JSON.stringify({
      leakPatterns: [{ name: "private-names", sha256: [createHash("sha256").update(token).digest("hex")] }],
    }),
  );
  const result = withMemory(memory, () => upstreamProposal({ repo, id: PROPOSAL }));
  assert.equal(result.written, false);
  assert.ok(result.hits.some((hit) => hit.pattern === "private-names"));
  assert.ok(!existsSync(path.join(memory, "upstream")));
});

test("a leak in a commit message or in the diff is refused with its locations and writes nothing", (t) => {
  const { repo, memory, commit } = fixture(t);
  const message = commit(
    { "scripts/ending.ts": "export const ending = 5;\n" },
    `fix: ${OBSERVATION}\n\nSigned-off-by: Private Person <${PRIVATE_EMAIL}>`,
  );
  const diff = commit(
    { "docs/ending.md": `# Ending\n\nAs the user said: ${APPROVAL}\n\nSee ${PROJECT}/final.mp4\n` },
    "docs: ending",
  );
  const rewrapped = commit(
    {
      "docs/notes.md": `# Notes\n\nThe Critic flagged a flat\nending — in two promos!\n\nNever leave ${BACKTICKED} paths visible in the final frame.\n`,
    },
    "docs: notes",
  );
  const encoded = commit({ "scripts/ending.ts": "export const ending = 6;\n" }, `fix: ${APPROVAL}`);
  seed(memory, applied([message, diff, rewrapped, encoded]));

  const result = withMemory(memory, () => upstreamProposal({ repo, id: PROPOSAL }));
  assert.equal(result.written, false);
  assert.ok(!existsSync(path.join(memory, "upstream")), "nothing is written");
  const found = result.hits.map((hit) => `${hit.file.slice(0, 4)} ${hit.pattern}`);
  for (const expected of [
    "0001 memory-entry observation-20261114-flat-ending",
    "0001 author-email",
    "0001 email",
    `0002 memory-entry ${PROPOSAL}`,
    "0002 memory-project",
  ])
    assert.ok(found.includes(expected), `${expected} in ${found.join(", ")}`);
  const notes = result.hits.filter((hit) => hit.file.startsWith("0003")).map((hit) => hit.text);
  assert.ok(
    notes.some((text) => text.includes("The Critic flagged a flat")),
    "a quote rewrapped over two lines, other case and punctuation, is found",
  );
  assert.ok(
    notes.some((text) => text.includes("Never leave")),
    "a memory line with backticks is a needle once they are stripped",
  );
  const subject = result.files.find((file) => file.name.startsWith("0004"))!.content;
  assert.match(subject, /^Subject: \[PATCH\] =\?UTF-8\?q\?fix:/m, "git encodes the subject");
  assert.ok(
    result.hits.some(
      (hit) =>
        hit.file.startsWith("0004") && hit.pattern === `memory-entry ${PROPOSAL}` && hit.text.startsWith("Subject:"),
    ),
    "the decoded subject is scanned",
  );
  assert.ok(result.hits.every((hit) => hit.line > 0));

  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(REPO, "scripts/memory-upstream.ts"),
      "--id",
      PROPOSAL,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_MEMORY_ROOT: memory },
    },
  );
  const envelope = JSON.parse(cli.stdout);
  assert.equal(cli.status, 1);
  assert.equal(envelope.error, "LEAK");
  assert.ok(envelope.details.hits.length >= 5);
});

test("neutraliseHeader replaces a folded From: header and moves Date: to UTC; scanView decodes RFC 2047 words", () => {
  const patch =
    "From abc Mon Sep 17 00:00:00 2001\nFrom: =?UTF-8?q?Long=20Name?=\n <a@b.org>\nDate: Sat, 14 Nov 2026 00:59:56 +0800\nSubject: [PATCH] y\n\nFrom: body line stays\n";
  assert.equal(
    neutraliseHeader(patch),
    "From abc Mon Sep 17 00:00:00 2001\nFrom: Agent Bros. Pictures contributors <noreply@example.com>\nDate: Fri, 13 Nov 2026 16:59:56 +0000\nSubject: [PATCH] y\n\nFrom: body line stays\n",
  );
  assert.equal(decodeEncodedWords("=?UTF-8?q?=D0=B4=D0=B0_ok?= =?UTF-8?b?0LTQsA==?= x"), "да okда x");
  assert.equal(
    scanView("Subject: [PATCH] =?UTF-8?q?a=20b?=\n =?UTF-8?q?c?=\n\nbody"),
    "Subject: [PATCH] a bc\n\n\nbody",
  );
});

test("an allowed hit with `only` excuses its listed literals and nothing else", () => {
  const email = { name: "email", regex: /[\w.+-]+@[\w-]+\.[a-z]{2,}/ };
  assert.equal(excuses({ only: ["noreply@example.com"] }, email, "author noreply@example.com"), true);
  assert.equal(excuses({ only: ["noreply@example.com"] }, email, "noreply@example.com and someone@else.org"), false);
  assert.equal(excuses({}, email, "someone@else.org"), true);
});

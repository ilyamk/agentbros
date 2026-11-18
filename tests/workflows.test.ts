import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { automationModules, privileged } from "../src/lib/contrib/trust-roots";
import { DEFAULT_PROTECTED, matchesPath } from "../src/lib/contrib/categories";

// js-yaml is already installed transitively and pinned in pnpm-lock.yaml; no dependency change.
const require = createRequire(import.meta.url);
const yamlPackage = readdirSync("node_modules/.pnpm").find((name) => /^js-yaml@/.test(name));
assert.ok(yamlPackage, "Install the locked dependencies, including transitive js-yaml");
const yaml = require(path.resolve("node_modules/.pnpm", yamlPackage, "node_modules/js-yaml")) as {
  load: (text: string) => unknown;
};
type Step = { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, unknown> };
type Job = {
  permissions?: Record<string, string>;
  environment?: string | { name: string };
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown[]> };
  env?: Record<string, unknown>;
  "timeout-minutes"?: number;
  if?: string;
  needs?: string | string[];
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  outputs?: Record<string, string>;
};
type Workflow = { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };
export const PLANNED = new Set([
  "contrib:check",
  "contrib:scout",
  "triage:pr",
  "instructions:audit",
  "regen:post-merge",
  "release:plan",
  "release:apply",
  "release:notes",
  "site:build",
  "showcase:media",
  "showcase:readme",
  "bench:verify",
]);
const commands = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
const workflows = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    source: readFileSync(`.github/workflows/${name}`, "utf8"),
    data: yaml.load(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow,
  }));
const warnings: string[] = [];
function check(source: string, workflow: Workflow, name: string) {
  assert.ok(
    workflow.on && !Object.hasOwn(workflow.on, "pull_request_target"),
    `${name}: pull_request_target forbidden`,
  );
  assert.deepEqual(workflow.permissions, {}, `${name}: workflow defaults to no permissions`);
  assert.ok(!JSON.stringify({ ...workflow, jobs: undefined }).includes("secrets."), `${name}: secrets outside a job`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.ok(job.permissions, `${name}/${id}: explicit job permissions required`);
    assert.ok(!Object.values(job.permissions).includes("write-all"));
    assert.ok(
      typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0,
      `${name}/${id}: timeout-minutes required`,
    );
    if (JSON.stringify(job).includes("secrets.")) {
      const environment = typeof job.environment === "string" ? job.environment : job.environment?.name;
      assert.ok(
        environment && ["triage", "release", "automation", "pages", "models"].includes(environment),
        `${name}/${id}: secret outside protected environment`,
      );
    }
    if (privileged(job) && job.steps?.some((step) => step.run?.includes("pnpm install"))) {
      const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      assert.equal(
        checkout?.with?.ref,
        "${{ github.event.repository.default_branch }}",
        `${name}/${id}: write job must install only base code`,
      );
    }
    for (const step of job.steps ?? []) {
      if (step.uses) {
        assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[a-f\d]{40}$/i, `${name}: unpinned action`);
        if (step.uses.endsWith("@" + "0".repeat(40))) warnings.push(`${name}: ${step.uses}`);
        const escaped = step.uses.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(source, new RegExp(escaped + " +# (?:v\\d|TO-PIN )"), `${name}: version comment missing`);
      }
      if (Object.hasOwn(workflow.on, "workflow_run")) {
        if (step.uses?.startsWith("actions/checkout@"))
          assert.equal(
            step.with?.ref,
            "${{ github.event.repository.default_branch }}",
            `${name}: privileged checkout must be the base`,
          );
        assert.ok(
          !JSON.stringify(step).match(/workflow_run\.head_(?:sha|branch)|pull_request\.head/),
          `${name}: fork code reference`,
        );
      }
      if (step.run) {
        if (privileged(job) && step.run.includes("pnpm install")) {
          assert.match(step.run, /--ignore-scripts\b/);
          assert.match(step.run, /--(?:ignore-pnpmfile|config\.ignore-pnpmfile=true)\b/);
        }
        assert.ok(
          !/(?:source|bash|sh|node|tsx|python\w*)\s+out\/(?:untrusted|pr-report)/.test(step.run),
          `${name}: artefacts are data only`,
        );
        assert.ok(
          !/\$\{\{\s*github\.event\.(?:comment\.body|issue\.body|pull_request\.(?:body|title))/.test(step.run),
          `${name}: shell interpolation of untrusted data`,
        );
        assert.ok(!step.run.includes("${{"), `${name}/${id}: pass expressions to run scripts through env`);
        for (const match of step.run.matchAll(/\bpnpm\s+([a-z][\w:-]*)/g))
          assert.ok(
            commands[match[1]!] ||
              PLANNED.has(match[1]!) ||
              ["install", "exec", "audit", "licenses"].includes(match[1]!),
            `${name}: unknown command ${match[1]}`,
          );
      }
    }
  }
}
for (const item of workflows) test(`workflow hygiene: ${item.name}`, () => check(item.source, item.data, item.name));
test("all required workflows exist and pending action pins are reported as warnings", (t) => {
  const names =
    "pr-intake category-gates context-budget pr-comment ai-triage autoclose commands cla post-merge-regen release-pr release pages showcase bench-verify nightly codeql scorecard ci models-refresh".split(
      " ",
    );
  for (const name of names) assert.ok(workflows.some((workflow) => workflow.name === `${name}.yml`));
  t.diagnostic(`Action pin warnings (${warnings.length}):\n${warnings.join("\n")}`);
});
test("checker rejects unpinned actions, excess defaults, missing permissions, head checkout, secret leakage and executable artefacts", () => {
  const source = workflows.find((workflow) => workflow.name === "pr-comment.yml")!;
  for (const mutate of [
    (w: Workflow) => {
      delete w.jobs.comment!.permissions;
    },
    (w: Workflow) => {
      w.permissions = { contents: "write" };
    },
    (w: Workflow) => {
      w.on.pull_request_target = {};
    },
    (w: Workflow) => {
      w.jobs.comment!.steps![0]!.uses = "actions/checkout@v4";
    },
    (w: Workflow) => {
      w.jobs.comment!.steps![0]!.with!.ref = "${{ github.event.workflow_run.head_sha }}";
    },
    (w: Workflow) => {
      w.jobs.comment!.env = { KEY: "${{ secrets.KEY }}" };
    },
    (w: Workflow) => {
      w.jobs.comment!.steps!.push({ run: "node out/untrusted-report/script.js" });
    },
    (w: Workflow) => {
      w.jobs.comment!.steps!.push({ run: "pnpm invented-command" });
    },
  ]) {
    const copy = structuredClone(source.data);
    mutate(copy);
    assert.throws(() => check(source.source, copy, "mutated"));
  }
});
test("CI has four full-suite shards, merge queue triggers and one required ci aggregate", () => {
  const ci = workflows.find((workflow) => workflow.name === "ci.yml")!.data;
  assert.ok(Object.hasOwn(ci.on, "merge_group"));
  assert.deepEqual(ci.jobs.tests?.strategy?.matrix?.shard, [1, 2, 3, 4]);
  assert.ok(ci.jobs.ci);
});
test("Dependabot covers npm and GitHub actions", () => {
  const data = yaml.load(readFileSync(".github/dependabot.yml", "utf8")) as {
    updates: { "package-ecosystem": string }[];
  };
  assert.deepEqual(
    data.updates.map((item) => item["package-ecosystem"]),
    ["npm", "github-actions"],
  );
});

test("privileged automation transitive modules and package-manager trust roots are protected", () => {
  const modules = automationModules(process.cwd());
  assert.ok(modules.includes("src/lib/cli/index.ts"));
  assert.deepEqual(
    modules.filter((file) => !matchesPath(file, DEFAULT_PROTECTED.paths)),
    [],
  );
  for (const file of [
    ".pnpmfile.cjs",
    "pnpmfile.js",
    ".npmrc",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    ".nvmrc",
    ".python-version",
    "pyproject.toml",
    "uv.lock",
    "tsconfig.json",
    "remotion.config.ts",
    "postcss.config.mjs",
    "new.config.js",
  ])
    assert.ok(matchesPath(file, DEFAULT_PROTECTED.paths), file);
});

test("required intake includes an unprivileged blocking dependency audit on a trusted base", () => {
  const job = workflows.find((workflow) => workflow.name === "pr-intake.yml")!.data.jobs["pr-intake"]!;
  assert.equal(privileged(job), false);
  const gate = job.steps!.find((step) => step.run?.startsWith("pnpm deps:check"));
  assert.ok(gate);
  assert.equal((gate as Record<string, unknown>)["continue-on-error"], undefined);
  assert.equal(
    gate.env?.DEPENDENCY_BASE,
    "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
  );
});

test("Pages writes metrics and both needs-board formats before building with full history", () => {
  const steps = workflows.find((workflow) => workflow.name === "pages.yml")!.data.jobs.build!.steps!;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"], 0);
  const metrics = steps.findIndex((step) => step.run === "pnpm metrics --write");
  const scout = steps.findIndex((step) =>
    step.run?.includes("contrib:scout --limit 1000 --markdown out/contrib/needs.md --out-json out/contrib/needs.json"),
  );
  const build = steps.findIndex((step) => step.run?.includes("pnpm site:build"));
  assert.ok(metrics >= 0 && scout > metrics && build > scout);
  const pages = workflows.find((workflow) => workflow.name === "pages.yml")!.data;
  assert.match(steps[scout]!.run!, /--online\b/, "the board drops claimed work and work in open PRs");
  assert.equal(steps[scout]!.env?.GH_TOKEN, "${{ github.token }}");
  assert.deepEqual(pages.jobs.build!.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.ok(
    Array.isArray(pages.on.schedule) && (pages.on.schedule as unknown[]).length === 1,
    "the board and metrics refresh nightly without a push",
  );
});
test("showcase publication processes merged entries without secrets then revalidates before release writes", () => {
  const workflow = workflows.find((workflow) => workflow.name === "showcase.yml")!.data;
  assert.deepEqual((workflow.on.push as { paths: string[] }).paths, ["showcases/*/showcase.json"]);
  const prepare = workflow.jobs.prepare!,
    publish = workflow.jobs.publish!;
  assert.deepEqual(prepare.permissions, { contents: "read" });
  assert.equal(privileged(prepare), false);
  assert.ok(!JSON.stringify(prepare).includes("secrets."));
  assert.equal(
    prepare.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref,
    "${{ github.sha }}",
  );
  assert.ok(prepare.steps?.some((step) => step.run?.includes("showcase:fetch-media --base")));
  assert.equal(publish.environment, "automation");
  assert.deepEqual(publish.permissions, { contents: "read" });
  const source = publish.steps!.map((step) => step.run ?? "").join("\n");
  assert.ok(source.indexOf("showcase:fetch-media --validate") < source.indexOf("gh release upload"));
  assert.match(source, /pnpm --silent showcase:fetch-media --validate \S+ --structural/);
  // ffprobe parses untrusted media only in a job with no secrets and read-only contents.
  const validate = workflow.jobs.validate!;
  assert.deepEqual(validate.permissions, { contents: "read" });
  assert.ok(!JSON.stringify(validate).includes("secrets."));
  assert.ok(validate.steps?.some((step) => /showcase:fetch-media --validate (?!.*--structural)/.test(step.run ?? "")));
  assert.ok(([(publish as { needs?: string | string[] }).needs].flat() as string[]).includes("validate"));
  assert.match(source, /gh release upload .*--clobber/);
  assert.match(source, /pnpm showcase:media/);
  assert.doesNotMatch(source, /ilyamk\/agentbros/, "asset URLs follow the running repository");
});
test("benchmark labels trigger read-only attachment verification and a schema-validated reporting job", () => {
  const workflow = workflows.find((workflow) => workflow.name === "bench-verify.yml")!.data;
  assert.deepEqual(workflow.on.issues, { types: ["labeled"] });
  const verify = workflow.jobs.verify!,
    report = workflow.jobs.report!;
  assert.equal((verify as Record<string, unknown>).if, "github.event.label.name == 'bench:submitted'");
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.equal(privileged(verify), false);
  assert.ok(!JSON.stringify(verify).includes("secrets."));
  assert.ok(verify.steps?.some((step) => step.run?.includes("pnpm bench:fetch-bundle")));
  const signed = verify.steps?.find((step) => step.run?.includes("bench:verify"));
  assert.equal(signed?.env?.SUBMITTER, "${{ github.event.issue.user.login }}");
  assert.match(signed!.run!, /--github-user "\$SUBMITTER" --online/);
  assert.deepEqual(report.permissions, { contents: "read", issues: "write" });
  assert.ok(
    report.steps?.some((step) => step.run === "pnpm github:bench-report --artefact out/untrusted-bench/result.json"),
  );
  assert.ok(!JSON.stringify(report).includes("bench:verify"));
});
test("release workflows mint the release App token, and its bot login is the one the release route trusts", () => {
  const policy = JSON.parse(readFileSync("contrib/release.json", "utf8")) as { botLogins: string[] };
  for (const name of ["release.yml", "release-pr.yml", "post-merge-regen.yml", "showcase.yml", "models-refresh.yml"]) {
    const source = readFileSync(`.github/workflows/${name}`, "utf8");
    assert.doesNotMatch(source, /RELEASE_BOT_TOKEN/, name);
    assert.match(source, /uses: actions\/create-github-app-token@[0-9a-f]{40} /, name);
    for (const [, login] of source.matchAll(/git config user\.name '([^']+)'/g))
      assert.ok(policy.botLogins.includes(login!), `${name}: ${login}`);
  }
  // Both App identities may author bot commits and the release PR (RFC 0002 B10: split keys).
  assert.deepEqual(policy.botLogins, ["agentbros-release[bot]", "agentbros-automation[bot]"]);
});

test("only release.yml requires the release App key; unattended jobs prefer the automation App's key", () => {
  const minted: string[] = [];
  for (const item of workflows) {
    const steps = Object.values(item.data.jobs).flatMap((job) => job.steps ?? []);
    for (const step of steps) {
      if (!/create-github-app-token/.test(step.uses ?? "")) continue;
      const withs = step.with ?? {};
      minted.push(item.name);
      if (item.name === "release.yml") {
        assert.equal(withs["private-key"], "${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
        continue;
      }
      // The fallback lasts only while the release key still sits in `automation`; step 8 deletes it there.
      assert.equal(withs["client-id"], "${{ vars.AUTOMATION_APP_CLIENT_ID || vars.RELEASE_APP_CLIENT_ID }}", item.name);
      assert.equal(
        withs["private-key"],
        "${{ secrets.AUTOMATION_APP_PRIVATE_KEY || secrets.RELEASE_APP_PRIVATE_KEY }}",
        item.name,
      );
    }
  }
  assert.deepEqual([...new Set(minted)].sort(), [
    "models-refresh.yml",
    "post-merge-regen.yml",
    "release-pr.yml",
    "release.yml",
    "showcase.yml",
  ]);
  for (const item of workflows)
    if (item.name !== "release.yml")
      assert.doesNotMatch(item.source, /^\s*private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/m, item.name);
});

test("paid triage has a maintainer dispatch path and dedicated OpenRouter credentials, never pull_request_target", () => {
  const triage = workflows.find((workflow) => workflow.name === "ai-triage.yml")!;
  assert.deepEqual(triage.data.on.workflow_dispatch, {
    inputs: {
      pr: { description: "Pull request number for maintainer-requested triage", required: true, type: "number" },
    },
  });
  assert.match(triage.source, /workflow_run.conclusion == 'success'/);
  for (const name of ["ai-triage.yml", "nightly.yml"]) {
    const item = workflows.find((workflow) => workflow.name === name)!;
    const jobs = Object.values(item.data.jobs);
    assert.ok(
      jobs.some((job) =>
        job.steps?.some((step) => step.env?.TRIAGE_OPENROUTER_API_KEY === "${{ secrets.TRIAGE_OPENROUTER_API_KEY }}"),
      ),
    );
    assert.equal(Object.hasOwn(item.data.on, "pull_request_target"), false);
  }
});
test("only release.yml uses the reviewer-gated release environment; unattended bot jobs use automation with read-only tokens", () => {
  for (const item of workflows)
    for (const [id, job] of Object.entries(item.data.jobs)) {
      const environment = typeof job.environment === "string" ? job.environment : job.environment?.name;
      if (environment === "release") assert.deepEqual([item.name, id], ["release.yml", "release"]);
      if (environment === "automation")
        assert.ok(
          !Object.values(job.permissions ?? {}).includes("write"),
          `${item.name}/${id}: App token writes, not GITHUB_TOKEN`,
        );
    }
  for (const [name, job] of [
    ["release-pr.yml", "release-pr"],
    ["post-merge-regen.yml", "regenerate"],
    ["showcase.yml", "publish"],
    ["models-refresh.yml", "pull-request"],
  ])
    assert.equal(workflows.find((item) => item.name === name)!.data.jobs[job!]!.environment, "automation", name);
});
test("release runs on the push to main and gates the environment on a detected merged bot/release PR", () => {
  const workflow = workflows.find((item) => item.name === "release.yml")!.data;
  assert.deepEqual(Object.keys(workflow.on), ["push", "workflow_dispatch"]);
  assert.deepEqual((workflow.on.push as { branches: string[] }).branches, ["main"]);
  const detect = workflow.jobs.detect!,
    release = workflow.jobs.release!;
  assert.equal(detect.environment, undefined);
  assert.equal(privileged(detect), false);
  assert.match(
    detect.steps!.map((step) => step.run ?? "").join("\n"),
    /commits\/\$SHA\/pulls[\s\S]*bot\/release[\s\S]*release:ready/,
  );
  assert.equal(release.needs, "detect");
  assert.match(release.if!, /needs\.detect\.outputs\.pr/);
  assert.equal(release.permissions?.contents, "read");
  const pages = workflows.find((item) => item.name === "pages.yml")!.data;
  assert.equal(
    Object.hasOwn(pages.on, "release"),
    false,
    "a tag-ref trigger cannot use the main-only pages environment",
  );
});
test("release can be retried by dispatch, runs one at a time and skips a version that is already tagged", () => {
  const workflow = workflows.find((item) => item.name === "release.yml")!.data;
  const input = (workflow.on.workflow_dispatch as { inputs: Record<string, { required: boolean; type: string }> })
    .inputs.version!;
  assert.deepEqual([input.required, input.type], [false, "string"]);
  const detect = workflow.jobs.detect!,
    release = workflow.jobs.release!;
  assert.deepEqual(Object.keys(detect.outputs!).sort(), ["pr", "sha", "version"]);
  const find = detect.steps!.find((step) => step.run?.includes("git/ref/tags"))!;
  assert.equal(find.env?.REQUESTED, "${{ inputs.version }}");
  assert.match(
    find.run!,
    /gh api "repos\/\$GH_REPO\/git\/ref\/tags\/v\$VERSION"[^\n]*\n\s*echo "::notice::[^"]*already exists[^"]*"\n\s*exit 0/,
  );
  assert.ok(
    find.run!.indexOf("git/ref/tags") < find.run!.indexOf("GITHUB_OUTPUT"),
    "a tagged version leaves the outputs empty, so the gated job never starts",
  );
  assert.match(
    find.run!,
    /head=\$\{GH_REPO%%\/\*\}:bot\/release/,
    "a dispatch looks up only same-repository bot/release merges",
  );
  assert.match(find.run!, /compare\/\$SHA\.\.\.\$DEFAULT_BRANCH/, "a dispatched commit must be on main");
  assert.deepEqual(release.concurrency, { group: "release", "cancel-in-progress": false });
  assert.equal(
    (workflow as { concurrency?: unknown }).concurrency,
    undefined,
    "workflow-level concurrency would let ordinary pushes displace a pending release",
  );
  const runs = release.steps!.map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    JSON.stringify(release),
    /github\.sha/,
    "the release uses the detected commit, not the dispatching one",
  );
  assert.match(runs, /git\/ref\/tags\/v\$VERSION[\s\S]*exit 0[\s\S]*gh release create/);
  assert.match(runs, /pnpm metrics --write[\s\S]*gh release create .*"\$ARCHIVE" out\/metrics\/metrics\.json/);
});
test("release-pr edits only an open release PR, never the merged one", () => {
  const source = workflows.find((item) => item.name === "release-pr.yml")!.source;
  assert.match(source, /gh pr list --head bot\/release --base main --state open --json number/);
  assert.doesNotMatch(source, /gh pr (?:view|edit) bot\/release/);
  assert.match(source, /gh pr edit "\$PR"/);
});
test("only versioned releases can become Latest: every other release is created with --latest=false", () => {
  for (const item of workflows)
    for (const [, command] of item.source.matchAll(/gh release create (\S+)[^\n]*/g)) {
      if (/^"v\$VERSION"$/.test(command!)) {
        assert.equal(item.name, "release.yml");
        continue;
      }
      assert.match(
        item.source,
        new RegExp(`gh release create ${command!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --latest=false`),
        `${item.name}: ${command}`,
      );
    }
  assert.match(
    workflows.find((item) => item.name === "showcase.yml")!.source,
    /gh release create showcase-media --latest=false/,
  );
});
test("busy comment and workflow_run triggers filter early and key concurrency per PR source", () => {
  const job = (name: string, id: string) => workflows.find((item) => item.name === name)!.data.jobs[id]!;
  assert.match(job("cla.yml", "signature").if!, /contains\(github\.event\.comment\.body, 'I have read the CLA'\)/);
  assert.equal(job("cla.yml", "signature").concurrency, undefined);
  assert.match(job("commands.yml", "commands").if!, /startsWith\(github\.event\.comment\.body, '\/'\)/);
  assert.match(job("pr-comment.yml", "comment").concurrency!.group, /head_repository\.full_name.*head_branch/);
  for (const [name, id] of [
    ["ai-triage.yml", "triage"],
    ["nightly.yml", "audit"],
  ])
    assert.match(job(name!, id!).if!, /^vars\.TRIAGE_ENABLED == 'true'/, name);
  assert.deepEqual(
    (workflows.find((item) => item.name === "pr-intake.yml")!.data.on.pull_request as { types: string[] }).types,
    ["opened", "synchronize", "reopened", "labeled", "unlabeled"],
  );
  assert.ok(!JSON.stringify(job("ai-triage.yml", "triage")).includes("download-artifact"));
});
test("nightly scans the whole tree for leaks with generic patterns only", () => {
  const leak = workflows.find((item) => item.name === "nightly.yml")!.data.jobs["leak-scan"]!;
  assert.equal(privileged(leak), false);
  const run = leak.steps!.find((step) => step.run?.includes("leak:check"))!.run!;
  assert.match(run, /--mode tree/);
  assert.doesNotMatch(run, /--local/);
});
test("bot commits use the App's noreply identity and direct pushes to main rebase and retry", () => {
  for (const name of ["post-merge-regen.yml", "showcase.yml", "release-pr.yml", "models-refresh.yml"]) {
    const source = readFileSync(`.github/workflows/${name}`, "utf8");
    assert.doesNotMatch(source, /noreply@users\.noreply\.github\.com/, name);
    // The identity is the minting App's slug, so commits follow whichever App key the job holds.
    assert.match(source, /APP_SLUG: \$\{\{ steps\.app-token\.outputs\.app-slug \}\}/, name);
    assert.match(source, /BOT_ID=\$\(gh api "\/users\/\$\{APP_SLUG\}%5Bbot%5D" --jq \.id\)/, name);
    assert.match(source, /git config user\.name "\$BOT"/, name);
    assert.match(source, /git config user\.email "\$\{BOT_ID\}\+\$\{BOT\}@users\.noreply\.github\.com"/, name);
    if (/push origin HEAD:main/.test(source))
      assert.match(source, /for attempt in 1 2 3[\s\S]*git rebase origin\/main[\s\S]*git rebase --abort/, name);
  }
});
test("releases attest their source archive, and Scorecard publishes with only approved steps", () => {
  const release = workflows.find((workflow) => workflow.name === "release.yml")!.data.jobs.release!;
  assert.equal(release.permissions?.["id-token"], "write");
  assert.equal(release.permissions?.attestations, "write");
  const steps = release.steps ?? [];
  const attest = steps.findIndex((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  const publish = steps.findIndex((step) => step.run?.includes("gh release create"));
  assert.ok(attest >= 0 && attest < publish, "attest before publishing");
  assert.match(steps[publish]!.run!, /"\$ARCHIVE"/);
  const scorecard = workflows.find((workflow) => workflow.name === "scorecard.yml")!.data.jobs.analysis!;
  assert.deepEqual(
    Object.keys(scorecard.permissions!)
      .filter((key) => scorecard.permissions![key] === "write")
      .sort(),
    ["id-token", "security-events"],
  );
  assert.ok(
    scorecard.steps?.every((step) => step.uses && !step.run),
    "publish_results allows only action steps",
  );
});

test("model refresh packages and applies the generated slots page inside its exact allow-list", () => {
  const workflow = workflows.find((workflow) => workflow.name === "models-refresh.yml")!;
  const refresh = workflow.data.jobs.refresh!,
    apply = workflow.data.jobs["pull-request"]!;
  const packaging = refresh.steps!.find((step) => step.run?.includes("paths='"))!.run!;
  assert.match(packaging, /paths='[^'\n]*docs\/model-slots\.md/);
  const application = apply.steps!.find((step) => step.run?.includes("git apply"))!.run!;
  assert.ok(application.includes("--include='docs/model-slots.md'"));
  assert.equal(application.includes("--include='docs/verification/"), false);
  assert.match(packaging, /out\/qa\/model-prices\/price-gaps\.md/);
  assert.match(packaging, /cp -- "\$report" out\/models-refresh\/reports\//);
  const expression = application.match(/grep -vE '([^']+)'/)![1]!;
  const allowed = new RegExp(expression);
  for (const file of [
    "src/lib/models/model-slots.json",
    "src/lib/models/fal-catalog/model.json",
    "src/lib/providers/schemas/fal/model.json",
    "docs/model-slots.md",
    "src/lib/models/price-matrix-catalog/fal-text-to-image.json",
  ])
    assert.ok(allowed.test(file), file);
  for (const file of [
    "src/lib/models/runner.ts",
    "docs/extra.md",
    "docs/model-slotsXmd",
    "docs/verification/extra.md",
    "docs/verification/model-refresh.md",
    "docs/verification/price-gaps.md",
    "out/qa/model-refresh/model-refresh.md",
  ])
    assert.ok(!allowed.test(file), file);
});

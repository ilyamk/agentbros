import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPathWithin } from "../cli";
import { commitOf, gitText } from "../context/repository";
import { runGate, type CommandResult, type GateRunner } from "./check";
import { changedFiles, gitBytes } from "./git";
import { contributionCategories } from "./gates";

export type BaseProofOutcome = "proved" | "not-applicable" | "no-test" | "passes-on-base" | "fails-on-head";
export interface BaseProof {
  outcome: BaseProofOutcome;
  base: string;
  head: string;
  tests: string[];
  reason?: string;
  runs: { revision: "base" | "head"; file: string; exitCode: number }[];
}
export const proofBlocks = (proof: BaseProof): boolean => !["proved", "not-applicable"].includes(proof.outcome);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Whole-proof budget; contrib:check gives this gate a matching timeout (gateTimeoutMs). */
export const PROOF_BUDGET_MS = 50 * 60 * 1000;

/** TAP test points by name, without SKIP/TODO directives. A file that fails to load reports one point named after the file. */
export function tapPoints(tap: string): { passed: Set<string>; failed: Set<string> } {
  const passed = new Set<string>(),
    failed = new Set<string>();
  for (const [, status, name, directive] of tap.matchAll(
    /^\s*(not ok|ok) \d+ - (.+?)(\s+#\s*(?:SKIP|TODO)\b.*)?$/gim,
  )) {
    if (directive) continue;
    (status!.toLowerCase() === "ok" ? passed : failed).add(name!.trim());
  }
  return { passed, failed };
}

/** Execute committed tests against isolated revisions; never copy head implementation into the base. */
export async function failsOnBase(
  options: { root: string; base: string; head?: string; force?: boolean },
  runner: GateRunner = runGate,
): Promise<BaseProof> {
  const { root } = options;
  const base = commitOf(root, options.base),
    head = commitOf(root, options.head ?? "HEAD");
  const files = changedFiles(root, base, head);
  const tests = files
    .filter((file) => file.status !== "D" && /^tests\/(?:.*\/)?[^/]+\.test\.ts$/.test(file.path))
    .map((file) => file.path)
    .sort();
  const proof: BaseProof = { outcome: "not-applicable", base, head, tests, runs: [] };
  if (!options.force && !contributionCategories(files).includes("fix"))
    return { ...proof, reason: "The declared category is not fix." };
  if (!tests.length)
    return { ...proof, outcome: "no-test", reason: "A fix requires a changed or added tests/**/*.test.ts file." };
  const directory = mkdtempSync(path.join(tmpdir(), "agentbros-base-proof-"));
  const worktrees: string[] = [];
  try {
    const create = (name: string, commit: string) => {
      const tree = path.join(directory, name);
      gitText(root, ["worktree", "add", "--detach", tree, commit]);
      worktrees.push(tree);
      const modules = path.resolve(root, "node_modules");
      if (!existsSync(modules))
        throw new Error("Failing-on-base proof requires installed node_modules in the current checkout.");
      symlinkSync(modules, path.join(tree, "node_modules"), "dir");
      return tree;
    };
    const baseTree = create("base", base);
    for (const file of files.filter((file) => file.status !== "D" && file.path.startsWith("tests/"))) {
      const target = path.join(baseTree, file.path);
      assertPathWithin(baseTree, target);
      if (file.path.split("/").some((part) => part === ".env" || part.startsWith(".env.")))
        throw new Error("Environment files cannot be copied into a base proof.");
      for (let ancestor = target; ancestor !== baseTree; ancestor = path.dirname(ancestor)) {
        if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error(`Test overlay cannot follow a base symlink: ${file.path}`);
      }
      // Git symlinks must not redirect a test overlay outside the temporary checkout.
      const mode = gitText(root, ["ls-tree", head, "--", file.path]).split(" ")[0];
      if (mode !== "100644" && mode !== "100755") throw new Error(`Test support must be a regular file: ${file.path}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, gitBytes(root, head, file.path));
      chmodSync(target, mode === "100755" ? 0o755 : 0o644);
    }
    const execute = async (tree: string, revision: "base" | "head"): Promise<CommandResult[]> => {
      const results: CommandResult[] = [];
      for (const file of tests) {
        // Two runs per file share the proof budget, so many slow files cannot outlast the gate's own timeout.
        const timeoutMs = Math.min(TEST_TIMEOUT_MS, Math.floor(PROOF_BUDGET_MS / (2 * tests.length)));
        const result = await runner(
          [
            process.execPath,
            "--import",
            "tsx",
            "--test",
            "--import",
            "./tests/helpers/memory-root.ts",
            "--test-reporter=tap",
            file,
          ],
          tree,
          timeoutMs,
        );
        proof.runs.push({ revision, file, exitCode: result.exitCode });
        if (result.interrupted || result.exitCode === 124 || result.exitCode === 130)
          throw new Error(`Base proof ${revision} run interrupted or timed out: ${file}`);
        results.push(result);
      }
      return results;
    };
    const baseResults = await execute(baseTree, "base");
    const headResults = await execute(create("head", head), "head");
    if (headResults.some((result) => result.exitCode !== 0)) return { ...proof, outcome: "fails-on-head" };
    if ([...baseResults, ...headResults].some((result) => !/^# tests [1-9]\d*\s*$/m.test(result.stdout)))
      throw new Error("Test runner did not report executing tests; proof is unverified.");
    const failedOnBase = baseResults.some(
      (result) => result.exitCode !== 0 && /^# fail [1-9]\d*\s*$/m.test(result.stdout),
    );
    if (baseResults.some((result) => result.exitCode !== 0) && !failedOnBase)
      throw new Error("Base test runner failed without reporting a failing test; proof is unverified.");
    // Proof needs a named test that fails on base and passes on head. A file that cannot load on base
    // (for example, it imports a module only the head adds) shows a feature is new, not that a bug was fixed.
    // Limit: a named test that reads a symbol only the head exports still fails on base under tsx; the
    // proof's reason names the tests so a reviewer can judge whether they exercise the reported bug.
    const headPassed = new Set(headResults.flatMap((result) => [...tapPoints(result.stdout).passed]));
    const regressions = baseResults
      .flatMap((result) => [...tapPoints(result.stdout).failed])
      .filter((name) => headPassed.has(name) && !tests.includes(name) && !tests.some((file) => name.endsWith(file)));
    if (failedOnBase && !regressions.length)
      return {
        ...proof,
        outcome: "passes-on-base",
        reason:
          "Base failed only at file level (for example, the test file cannot load on base); a named test must fail on base and pass on head.",
      };
    return {
      ...proof,
      outcome: failedOnBase ? "proved" : "passes-on-base",
      ...(regressions.length ? { reason: `Fails on base, passes on head: ${regressions.slice(0, 5).join("; ")}` } : {}),
    };
  } finally {
    try {
      for (const tree of worktrees.reverse()) gitText(root, ["worktree", "remove", "--force", tree]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

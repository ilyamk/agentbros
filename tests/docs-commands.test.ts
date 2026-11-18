import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** Words after `pnpm` that are not package.json aliases, each with why it may appear. */
const NOT_ALIASES: Record<string, string> = {
  exec: "pnpm built-in: runs a dependency binary",
  install: "pnpm built-in",
  i: "pnpm built-in (install), in vendored Remotion rules",
  add: "pnpm built-in, in dependency notes",
  dlx: "pnpm built-in, in design-reference tool notes",
  tsx: "runs the tsx binary; the script path it names is checked instead",
  doctor: "README names it to say it is pnpm's own command, not this repository's",
  audit: "pnpm built-in: dependency vulnerability audit",
};

/** RFCs describe planned commands before they exist. */
const EXCLUDED = /^docs\/(verification|archive|rfcs)\//;

/** Code fences and inline code only: prose uses "pnpm" as a word ("pnpm shadows it"). */
function codeRegions(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  return [...fences, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!)];
}

function commandMatches(region: string) {
  return region.matchAll(/(?<![\w./-])pnpm[ \t]+(?:--[ \t]+)?([a-z][a-z0-9:_-]*)([^\n]*)/g);
}

test("every pnpm command in tracked Markdown names a package.json alias or an existing script", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  const files = execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !EXCLUDED.test(file) && existsSync(file));
  assert.ok(files.length > 100, "tracked Markdown was found");
  const problems: string[] = [];
  let seen = 0;
  for (const file of files) {
    for (const region of codeRegions(readFileSync(file, "utf8"))) {
      for (const match of commandMatches(region)) {
        const [, word, rest] = match as unknown as [string, string, string];
        seen++;
        if (scripts[word]) continue;
        if (!(word in NOT_ALIASES)) {
          problems.push(`${file}: pnpm ${word} is not in package.json`);
          continue;
        }
        const script =
          (word === "tsx" || word === "exec") &&
          /^\s+(?:tsx\s+)?(?:--\S+\s+)*(scripts\/[\w/.-]+\.ts)\b/.exec(rest)?.[1];
        if (script && !existsSync(script)) problems.push(`${file}: pnpm ${word} names missing ${script}`);
      }
    }
  }
  assert.ok(seen > 200, `pnpm commands were inspected (${seen})`);
  assert.deepEqual(problems, []);
});

test("the allowlist holds no real alias", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  for (const word of Object.keys(NOT_ALIASES)) assert.equal(scripts[word], undefined, word);
});

test("a pnpm flag value cannot consume the command on the following line", () => {
  const source = "npm install --global pnpm@12.21.0 --allow-scripts=pnpm\npnpm install\npnpm preflight";
  assert.deepEqual(
    [...commandMatches(source)].map((match) => match[1]),
    ["install", "preflight"],
  );
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { DEFAULT_CATEGORIES } from "../src/lib/contrib/categories";
import { parsePrBlock } from "../src/lib/contrib/pr-block";
import { parseSignature } from "../scripts/github/gh-cla";

const read = (file: string) => readFileSync(file, "utf8");
const cards = DEFAULT_CATEGORIES.categories.map(({ id }) => `contrib/categories/${id}.md`);
const markdown = [
  "CONTRIBUTING.md",
  "contrib/AGENTS.md",
  ...cards,
  "contrib/pr-template.md",
  ".github/pull_request_template.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "CLA.md",
];
const forms = ["bug", "opportunity", "proposal", "showcase", "benchmark-bundle"];
const formPath = (id: string) => `.github/ISSUE_TEMPLATE/${id}.yml`;
const section = (source: string, name: string) => {
  const match = new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(source);
  assert.ok(match, `Missing ${name} section`);
  assert.ok(match[1]!.trim(), `Empty ${name} section`);
  return match[1]!;
};

test("contributor context stays within its byte budgets and has the required date", () => {
  for (const [file, limit] of [
    ["CONTRIBUTING.md", 6 * 1024],
    ["contrib/AGENTS.md", 8 * 1024],
    ...cards.map((file) => [file, 3 * 1024]),
  ] as [string, number][]) {
    assert.ok(statSync(file).size <= limit, `${file} exceeds ${limit} bytes`);
  }
  assert.match(
    read("contrib/AGENTS.md"),
    /^# Contributing from a fork — Agent Rules\n\nLast updated: \d{4}-\d{2}-\d{2}\n/,
  );
  assert.match(read("CONTRIBUTING.md"), /If you are an agent: read \[contrib\/AGENTS\.md\]/);
});

test("every registered category has exactly one complete card with exactly its gates", () => {
  assert.equal(DEFAULT_CATEGORIES.categories.length, 20);
  assert.deepEqual(readdirSync("contrib/categories").sort(), cards.map((file) => path.basename(file)).sort());
  for (const category of DEFAULT_CATEGORIES.categories) {
    const source = read(`contrib/categories/${category.id}.md`);
    for (const name of ["What is valuable", "Not wanted", "Definition of done", "Evidence required"])
      section(source, name);
    const gates = section(source, "Gates");
    const listed = [...gates.matchAll(/^- `([^`]+)`(?: \(planned; do not claim it ran\))?$/gm)].map(
      (match) => match[1]!,
    );
    assert.deepEqual(listed, [...category.gates, ...(category.plannedGates ?? [])], category.id);
    assert.equal(gates.trim().split(/\r?\n/).length, listed.length, `${category.id}: undeclared gate text`);
    for (const gate of category.plannedGates ?? [])
      assert.ok(gates.includes(`\`${gate}\` (planned; do not claim it ran)`));
  }
});

test("every documented pnpm command exists in package.json or is a pnpm built-in", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const builtins = new Set(["install", "exec", "audit"]);
  const missing = new Set<string>();
  for (const file of [...markdown, ...forms.map(formPath), formPath("config")]) {
    for (const match of read(file).matchAll(/\bpnpm\s+(?:--\s+)?([a-z][a-z0-9:_-]*)/g)) {
      if (!scripts[match[1]!] && !builtins.has(match[1]!)) missing.add(`${file}: pnpm ${match[1]}`);
    }
  }
  assert.deepEqual([...missing], []);
});

function anchors(source: string): Set<string> {
  const seen = new Map<string, number>();
  return new Set(
    [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
      const base = match[1]!
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
        .replace(/\s/g, "-");
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count ? `${base}-${count}` : base;
    }),
  );
}

test("local contributor links and fragments resolve; external links are well-formed", () => {
  let inspected = 0;
  for (const file of markdown) {
    const source = read(file);
    const references = new Map(
      [...source.matchAll(/^\[([^\]]+)\]:\s+(\S+)$/gm)].map((match) => [match[1]!.toLowerCase(), match[2]!]),
    );
    const links = [...source.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
    for (const match of source.matchAll(/\[[^\]\n]+\]\[([^\]\n]+)\]/g)) {
      const target = references.get(match[1]!.toLowerCase());
      assert.ok(target, `${file}: undefined reference ${match[1]}`);
      links.push(target);
    }
    for (const target of [...links, ...references.values()]) {
      inspected++;
      if (/^https?:/.test(target)) {
        const url = new URL(target);
        assert.ok(url.hostname, `${file}: ${target}`);
        if (url.hostname === "github.com" && url.pathname.includes("agentbros"))
          assert.ok(url.pathname.startsWith("/ilyamk/agentbros"), target);
        continue;
      }
      const [relative, fragment] = target.split("#");
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(relative || path.basename(file)));
      assert.ok(existsSync(resolved), `${file}: ${target}`);
      if (fragment)
        assert.ok(anchors(read(resolved)).has(decodeURIComponent(fragment)), `${file}: missing fragment ${target}`);
    }
  }
  assert.ok(inspected > 50, `${inspected} links inspected`);
});

test("both PR templates are identical and filled S/M/L examples parse", () => {
  const template = read("contrib/pr-template.md");
  assert.equal(read(".github/pull_request_template.md"), template);
  for (const size of ["S", "M", "L"] as const) {
    const replacements: Record<string, string> = {
      category: "docs",
      size,
      issue: "123",
      autonomy: "autonomous",
      harness: "codex",
      model: "example-model",
      owner: "example-human",
      slug: "correct-guide",
    };
    let body = template.replace(/<([a-z]+)>/g, (whole: string, field: string) => replacements[field] ?? whole);
    if (size === "S") body = body.replace(/^issue:.*\n/m, "");
    assert.deepEqual(parsePrBlock(body), {
      category: "docs",
      size,
      ...(size === "S" ? {} : { issue: 123 }),
      autonomy: "autonomous",
      harness: "codex",
      model: "example-model",
      owner: "example-human",
      change: ".changes/correct-guide.md",
    });
    for (const name of ["What changed and why", "Evidence", "What was not verified", "Risks"]) section(body, name);
  }
});

type YamlParser = { name: string; parse: (source: string) => unknown };
function yamlParser(): YamlParser | undefined {
  const require = createRequire(import.meta.url);
  const store = "node_modules/.pnpm";
  const candidates = [
    "yaml",
    "js-yaml",
    ...(existsSync(store)
      ? readdirSync(store)
          .sort()
          .filter((name) => /^(?:yaml|js-yaml)@/.test(name))
          .map((name) => path.resolve(store, name, "node_modules", name.startsWith("js-yaml@") ? "js-yaml" : "yaml"))
      : []),
  ];
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = require.resolve(candidate);
    } catch {
      continue;
    }
    const parser = require(resolved) as { parse?: (source: string) => unknown; load?: (source: string) => unknown };
    if (parser.parse) return { name: "yaml", parse: parser.parse };
    if (parser.load) return { name: "js-yaml", parse: parser.load };
  }
  return undefined;
}

const optionSchema = z.union([z.string(), z.object({ label: z.string(), required: z.boolean().optional() })]);
const fieldSchema = z.object({
  type: z.enum(["markdown", "input", "textarea", "dropdown", "checkboxes"]),
  id: z.string().optional(),
  attributes: z.object({
    label: z.string().optional(),
    value: z.string().optional(),
    options: z.array(optionSchema).optional(),
  }),
  validations: z.object({ required: z.boolean() }).optional(),
});
const formSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  title: z.string().min(1),
  body: z.array(fieldSchema).min(1),
});
const requiredIds: Record<string, string[]> = {
  bug: ["version", "reproduction", "expected", "actual"],
  opportunity: ["category", "size", "problem", "done", "related"],
  proposal: ["rfc", "category", "design", "risks", "done"],
  showcase: ["links", "manifest", "provenance", "rights"],
  "benchmark-bundle": ["bundle", "signature", "cells", "evidence"],
};

function validateFormStructure(source: string, required: readonly string[]): void {
  assert.doesNotMatch(source, /\t/);
  for (const key of ["name", "description", "title", "body"]) assert.match(source, new RegExp(`^${key}:`, "m"));
  const blocks = source.split(/^  - type: /m).slice(1);
  const fields = new Map<string, string>();
  for (const block of blocks) {
    if (block.startsWith("markdown\n")) continue;
    const id = /^    id: ([a-z][a-z0-9-]*)$/m.exec(block)?.[1];
    assert.ok(id, "Missing issue-form field id");
    assert.ok(!fields.has(id), `Duplicate issue-form field id: ${id}`);
    assert.match(block, /^      label: .+$/m, `${id}: missing label`);
    fields.set(id, block);
  }
  for (const id of required) {
    const block = fields.get(id);
    assert.ok(block, `Missing required field: ${id}`);
    const validation = block.startsWith("checkboxes\n")
      ? /^          required: true$/m
      : /^    validations:\n      required: true$/m;
    assert.match(block, validation, `${id}: must be required within its own field`);
  }
}

test("structural issue-form validation rejects missing required fields and flags", () => {
  const source = read(formPath("bug"));
  validateFormStructure(source, requiredIds.bug!);
  assert.throws(
    () => validateFormStructure(source.replace("required: true", "required: false"), requiredIds.bug!),
    /version: must be required/,
  );
  assert.throws(
    () => validateFormStructure(source.replace("id: version", "id: renamed"), requiredIds.bug!),
    /Missing required field: version/,
  );
});

test("issue forms are valid YAML with required fields and community contact routes", (t) => {
  assert.deepEqual(readdirSync(".github/ISSUE_TEMPLATE").sort(), [...forms, "config"].map((id) => `${id}.yml`).sort());
  const parser = yamlParser();
  t.diagnostic(
    parser
      ? `Parsed issue forms with installed ${parser.name}; no new dependency`
      : "No installed YAML package; structural regex validation only",
  );
  for (const id of forms) validateFormStructure(read(formPath(id)), requiredIds[id]!);
  assert.match(read(formPath("config")), /^blank_issues_enabled: false\ncontact_links:/);
  assert.match(read(formPath("config")), /https:\/\/github\.com\/ilyamk\/agentbros\/discussions/);
  assert.match(read(formPath("config")), /https:\/\/github\.com\/ilyamk\/agentbros\/blob\/main\/SECURITY\.md/);
  if (!parser) {
    return;
  }
  for (const id of forms) {
    const form = formSchema.parse(parser.parse(read(formPath(id))));
    const fields = form.body.filter((field) => field.type !== "markdown");
    const ids = fields.map((field) => field.id);
    assert.equal(new Set(ids).size, ids.length, `${id}: duplicate field ids`);
    assert.ok(!ids.includes(undefined), `${id}: missing field id`);
    for (const field of form.body) {
      if (field.type === "markdown") {
        assert.ok(field.attributes.value);
        continue;
      }
      assert.ok(field.attributes.label, `${id}/${field.id}: missing label`);
      if (field.type === "dropdown" || field.type === "checkboxes") assert.ok(field.attributes.options?.length);
    }
    for (const name of requiredIds[id]!) {
      const field = fields.find((field) => field.id === name);
      assert.ok(field, `${id}: missing ${name}`);
      if (field.type === "checkboxes")
        assert.ok(field.attributes.options?.every((option) => typeof option === "object" && option.required));
      else assert.equal(field.validations?.required, true, `${id}/${name}: must be required`);
    }
    if (id === "opportunity") {
      assert.deepEqual(
        (parser.parse(read(formPath(id))) as { labels?: unknown }).labels,
        ["needs-triage"],
        "community opportunities wait for maintainer review",
      );
      assert.deepEqual(
        fields.find((field) => field.id === "category")!.attributes.options,
        DEFAULT_CATEGORIES.categories.map((category) => category.id),
      );
      assert.deepEqual(fields.find((field) => field.id === "size")!.attributes.options, ["S", "M", "L"]);
    }
  }
  const config = z
    .object({
      blank_issues_enabled: z.literal(false),
      contact_links: z.array(z.object({ name: z.string(), url: z.url(), about: z.string() })).min(2),
    })
    .parse(parser.parse(read(formPath("config"))));
  assert.ok(config.contact_links.some((link) => link.url === "https://github.com/ilyamk/agentbros/discussions"));
  assert.ok(
    config.contact_links.some((link) => link.url === "https://github.com/ilyamk/agentbros/blob/main/SECURITY.md"),
  );
});

test("the CLA is final, keeps human accountability and the exact comment signature", () => {
  const cla = read("CLA.md");
  assert.doesNotMatch(cla, /\*\*Template\.\*\*|lawyer|corporate agreement/i);
  assert.match(cla, /authorised to accept this agreement on its behalf/);
  const agentClause = section(cla, "Contributions made with automated agents");
  for (const text of [
    "human account owner",
    "on whose instruction an agent submits",
    "Your Contribution",
    "section-5 representations",
    "Agents cannot sign",
  ])
    assert.ok(agentClause.includes(text), text);
  const statement = /```\n([\s\S]+?)\n```/.exec(section(cla, "How to sign"))![1]!;
  const signed = statement
    .replace("COMMIT", "a".repeat(40))
    .replace("FULL NAME", "Alice Example")
    .replace("USERNAME", "alice");
  assert.deepEqual(
    parseSignature(signed, "alice"),
    { claCommit: "a".repeat(40), name: "Alice Example" },
    "the documented statement must satisfy the CLA bot",
  );
  assert.match(read("CODE_OF_CONDUCT.md"), /via GitHub private report to the maintainers/);
  assert.doesNotMatch(read("CODE_OF_CONDUCT.md"), /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
});

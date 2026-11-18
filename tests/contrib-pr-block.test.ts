import test from "node:test";
import assert from "node:assert/strict";
import { parsePrBlock } from "../src/lib/contrib/pr-block";
const source = `<!-- agentbros:pr
category: library # one category
size: S
autonomy: autonomous
harness: codex
model: "model #1"
owner: person
change: .changes/new-block.md
-->\nEvidence follows.`;
test("parses scalar PR block with comments and quoted hashes", () => {
  assert.equal(parsePrBlock(source).category, "library");
  assert.equal(parsePrBlock(source).model, "model #1");
  assert.equal(parsePrBlock(source.replace("size: S", "size: M\nissue: 123")).issue, 123);
});
test("rejects missing, duplicate, misplaced, malformed and unknown fields", () => {
  for (const input of [
    "",
    source + source,
    "Intro\n" + source,
    source.replace("-->", ""),
    source.replace("size: S", "size: XL"),
    source.replace("size: S", "size: M"),
    source.replace("owner: person", "owner: person\nowner: other"),
    source.replace("owner: person", "owner person"),
    source.replace("size: S", "size: S\nextra: true"),
    source.replace(".changes/new-block.md", "../bad.md"),
    source.replace('"model #1"', '"unclosed'),
    source.replace("category: library", "category: [library, fix]"),
    source.replace("harness: codex", "harness: unknown"),
    source.replace("autonomy: autonomous", "autonomy: unknown"),
  ])
    assert.throws(() => parsePrBlock(input), input);
});

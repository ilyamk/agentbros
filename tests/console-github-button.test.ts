/**
 * The console's GitHub button (apps/console/shell/github-button.tsx) asks `GET /api/github` only once the session is
 * ready: the server refuses the route without the session token, and an early 403 was never retried, so the star
 * count never appeared. The console bundles its own TypeScript paths, so this reads the source instead of importing
 * it; apps/console/shell/github-button.test.tsx covers the behaviour in the browser test runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Read inside the test, so a missing file fails it by name instead of the whole file.
const source = (): string => readFileSync("apps/console/shell/github-button.tsx", "utf8");

test("the GitHub button waits for a ready session before asking for the star count", () => {
  const text = source();
  const ready = /const (\w+) = useConsole\(\(state\) => state\.session\.status === "ready"\);/u.exec(text)?.[1];
  assert.ok(ready, 'the button reads session.status === "ready" from the console store');
  const effect = /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/u.exec(text);
  assert.ok(effect, "the button fetches in one effect");
  assert.match(
    effect[1]!,
    new RegExp(`if \\(.*!${ready}\\b.*\\) return;`, "u"),
    "no request before the session is ready",
  );
  assert.ok(
    effect[2]!
      .split(",")
      .map((name) => name.trim())
      .includes(ready),
    "the effect reruns when the session becomes ready",
  );
});

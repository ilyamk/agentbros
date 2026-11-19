/** Chromium on Linux echoes an uncaught exception as console.error; motion:check counts that event once, as a runtime error. */
import test from "node:test";
import assert from "node:assert/strict";
import { dropEchoedExceptions } from "../src/lib/sensors/motion-check";

const thrown = {
  code: "RUNTIME_ERROR",
  frame: 10,
  key: "Error: Deliberate fixture failure at Throws (/bundle.js:161:46)",
};

test("a console echo of the same uncaught exception on the same frame is dropped", () => {
  const echo = {
    code: "CONSOLE_ERROR",
    frame: 10,
    key: "Uncaught Error: Deliberate fixture failure     at Throws (/bundle.js:161:46)",
  };
  assert.deepEqual(dropEchoedExceptions([echo, thrown]), [thrown]);
});

test("other console errors, and echoes on another frame or of another message, stay", () => {
  const own = { code: "CONSOLE_ERROR", frame: 10, key: "Deliberate fixture console error" };
  const otherFrame = { code: "CONSOLE_ERROR", frame: 11, key: "Uncaught Error: Deliberate fixture failure" };
  const otherMessage = { code: "CONSOLE_ERROR", frame: 10, key: "Uncaught Error: Something else" };
  const items = [thrown, own, otherFrame, otherMessage];
  assert.deepEqual(dropEchoedExceptions(items), items);
});

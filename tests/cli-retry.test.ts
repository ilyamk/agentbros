import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CliErrorObject, withRetry } from "../src/lib/cli";

test("long Retry-After waits in bounded timer chunks without an early retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const schedule = t.mock.method(globalThis, "setTimeout");
  const maximum = 2 ** 31 - 1;
  let calls = 0;
  const result = withRetry(
    async () => {
      if (++calls === 1)
        throw new CliErrorObject({ code: "RATE_LIMIT", message: "fixture", retryAfterMs: maximum + 37 });
      return calls;
    },
    { attempts: 2, backoffMs: 0 },
  );
  await setImmediate();
  t.mock.timers.tick(maximum);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(36);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(await result, 2);
  assert.deepEqual(
    schedule.mock.calls.map((call) => call.arguments[1]),
    [maximum, 37],
  );
});

test("invalid provider delays refuse another call", async () => {
  for (const retryAfterMs of [-1, NaN, Infinity]) {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new CliErrorObject({ code: "RATE_LIMIT", message: "fixture", retryAfterMs });
        },
        { attempts: 2, backoffMs: 0 },
      ),
      { code: "INVALID_INPUT" },
    );
    assert.equal(calls, 1);
  }
});

test("exponential overflow refuses another call rather than overflowing a timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const refused = assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new CliErrorObject({ code: "NETWORK", message: "fixture" });
      },
      { attempts: 3, backoffMs: 2, factor: Number.MAX_VALUE },
    ),
    { code: "INVALID_INPUT" },
  );
  await setImmediate();
  t.mock.timers.tick(2);
  await refused;
  assert.equal(calls, 2);
});

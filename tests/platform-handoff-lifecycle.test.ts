import test from "node:test";
import assert from "node:assert/strict";
import {
  AbsolutePhase,
  boundedCleanup,
  captureThenPublish,
  FirstSettlement,
  HarnessFaults,
  measureSfxResidual,
} from "./helpers/platform-handoff-lifecycle";

for (const name of ["bundle", "still", "open"])
  test(`absolute deadline settles pending ${name} and cancels once`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    let starts = 0,
      cancels = 0;
    const faults = new HarnessFaults(),
      phase = new AbsolutePhase(
        1100,
        () => {
          cancels++;
          throw Error("cancel fault");
        },
        faults,
      );
    const result = phase.run(name, () => {
      starts++;
      return new Promise<void>(() => {});
    });
    const rejected = assert.rejects(result, new RegExp(`deadline: ${name}`));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(starts, 1);
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(cancels, 1);
    assert.equal(faults.errors.length, 1);
    assert.throws(() => phase.check(), /deadline/);
    phase.dispose();
  });

test("one absolute deadline shared; expiry blocks downstream work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let starts = 0;
  const phase = new AbsolutePhase(1100, () => {}, new HarnessFaults());
  await phase.run("first", async () => {
    starts++;
  });
  t.mock.timers.tick(75);
  const result = phase.run("second", () => {
    starts++;
    return new Promise<void>(() => {});
  });
  const rejected = assert.rejects(result, /deadline: second/);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(25);
  await rejected;
  await assert.rejects(
    phase.run("receipt", async () => {
      starts++;
    }),
    /deadline/,
  );
  assert.equal(starts, 2);
  phase.dispose();
});

test("late browser closed; rejected late work handled; primary error retained", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const faults = new HarnessFaults(),
    phase = new AbsolutePhase(1100, () => {}, faults);
  let finish!: (value: string) => void,
    closed = 0;
  const result = phase.run(
    "open",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    async (value) => {
      assert.equal(value, "owned");
      closed++;
      throw Error("late close");
    },
  );
  const rejected = assert.rejects(result, /deadline: open/);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(100);
  await rejected;
  finish("owned");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(closed, 1);
  assert.match(faults.errors[0]!, /late close/);
  phase.dispose();
  const other = new AbsolutePhase(1200, () => {}, faults);
  let rejectLate!: (error: Error) => void;
  const pending = other.run(
    "bundle",
    () =>
      new Promise<void>((_, reject) => {
        rejectLate = reject;
      }),
  );
  const failed = assert.rejects(pending, /deadline/);
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(100);
  await failed;
  rejectLate(Error("late rejection"));
  await Promise.resolve();
  other.dispose();
});

test("action rejection settles and disposal removes active deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let cancels = 0;
  const phase = new AbsolutePhase(
    1100,
    () => {
      cancels++;
    },
    new HarnessFaults(),
  );
  await assert.rejects(
    phase.run("render", async () => {
      throw Error("render failure");
    }),
    /render failure/,
  );
  phase.dispose();
  t.mock.timers.tick(100);
  assert.equal(cancels, 0);
});

test("cleanup timeout and throw captured without overriding settlement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const faults = new HarnessFaults();
  const pending = boundedCleanup(() => new Promise<void>(() => {}), 50, faults);
  await Promise.resolve();
  t.mock.timers.tick(50);
  assert.equal(await pending, false);
  assert.equal(
    await boundedCleanup(
      async () => {
        throw Error("inventory");
      },
      50,
      faults,
    ),
    false,
  );
  assert.equal(await boundedCleanup(async () => {}, 50, faults), true);
  assert.equal(faults.errors.length, 2);
});

for (const seam of ["inventory", "signal", "stdout", "timer"])
  test(`first settlement preserves ${seam} primary failure and bounded callback faults`, async () => {
    const faults = new HarnessFaults(),
      settlement = new FirstSettlement<number>();
    let cleanup = 0,
      receipt = 0;
    const failure = assert.rejects(settlement.promise, /primary/);
    settlement.fail(
      Error("primary"),
      () => {
        cleanup++;
        throw Error(seam);
      },
      faults,
    );
    settlement.fail(
      Error("later"),
      () => {
        cleanup++;
      },
      faults,
    );
    settlement.succeed(0);
    try {
      await failure;
    } finally {
      faults.attempt(() => {
        throw Error("final inventory");
      });
      receipt++;
    }
    assert.equal(cleanup, 1);
    assert.equal(receipt, 1);
    assert.equal(faults.errors.length, 2);
    assert.equal(settlement.settled, true);
  });

function fixture() {
  const speech = Buffer.alloc(576000),
    mix = Buffer.alloc(576000);
  for (let i = 0; i < 144000; i++)
    for (let c = 0; c < 2; c++) {
      const voice = Math.round(2000 * Math.sin(i / 31));
      speech.writeInt16LE(voice, i * 4 + c * 2);
      mix.writeInt16LE(voice + (i >= 60800 && i < 65600 ? Math.round(600 * Math.sin(i / 7)) : 0), i * 4 + c * 2);
    }
  return { speech, mix };
}
test("fixed SFX residual accepts exact window and records edge evidence", () => {
  const { speech, mix } = fixture(),
    measured = measureSfxResidual(mix, speech, mix);
  assert.equal(measured.accepted, true);
  assert.equal(measured.projectedGain, 0.2);
  assert.equal(measured.relativeError, 0);
  assert.ok(measured.leading.reference > 0 && measured.trailing.reference > 0);
  assert.equal(measured.startSample, 60800);
});
for (const mode of ["absent", "moved", "gain", "adjacent", "baseline"])
  test(`SFX residual rejects ${mode} instead of aggregate speech success`, () => {
    const { speech, mix } = fixture(),
      actual = Buffer.from(speech);
    for (let i = 0; i < 144000; i++)
      for (let c = 0; c < 2; c++) {
        let tone = 0;
        if (mode === "gain" && i >= 60800 && i < 65600) tone = 1200 * Math.sin(i / 7);
        if ((mode === "moved" || mode === "adjacent") && i >= 68000 && i < 72800) tone = 600 * Math.sin(i / 7);
        if (mode === "baseline") tone = 600 * Math.sin(i / 7);
        actual.writeInt16LE(actual.readInt16LE(i * 4 + c * 2) + Math.round(tone), i * 4 + c * 2);
      }
    assert.equal(measureSfxResidual(actual, speech, mix).accepted, false);
  });
test("SFX residual refuses malformed bounds and zero reference", () => {
  const { speech, mix } = fixture();
  assert.throws(() => measureSfxResidual(Buffer.alloc(4), speech, mix), /bounds/);
  assert.throws(() => measureSfxResidual(mix, speech, speech), /Zero/);
});

test("successful settlement ignores later timer and cleanup; fault capture stays bounded", async () => {
  const faults = new HarnessFaults(),
    settlement = new FirstSettlement<number>();
  let signals = 0;
  settlement.succeed(7);
  settlement.fail(
    Error("late timer"),
    () => {
      signals++;
    },
    faults,
  );
  assert.equal(await settlement.promise, 7);
  assert.equal(signals, 0);
  for (let i = 0; i < 100; i++) faults.record("x".repeat(1024));
  assert.equal(faults.errors.length, 32);
  assert.ok(faults.errors.every((value) => value.length === 512));
});

test("actual shared synchronous capture boundary refuses publication after capture crosses deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let captures = 0,
    publications = 0,
    cancels = 0,
    observed: unknown;
  const phase = new AbsolutePhase(
    1100,
    () => {
      cancels++;
    },
    new HarnessFaults(),
  );
  try {
    captureThenPublish(
      phase,
      () => {
        captures++;
        t.mock.timers.setTime(1101);
        return "identity";
      },
      () => {
        publications++;
        return "receipt";
      },
    );
    assert.fail("Expired consumer must throw");
  } catch (error) {
    observed = error;
    assert.match(String(error), /Render phase deadline/);
  }
  assert.equal(captures, 1);
  assert.equal(publications, 0);
  assert.equal(cancels, 1);
  assert.throws(
    () => phase.check(),
    (error) => error === observed,
  );
  phase.dispose();
});

test("shared capture publication success preserves sync identity and original receipt output", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const phase = new AbsolutePhase(1100, () => {}, new HarnessFaults()),
    identity = { hash: "original" },
    receipt = { file: "original-receipt" };
  const calls: string[] = [];
  const result = captureThenPublish(
    phase,
    () => {
      calls.push("capture");
      t.mock.timers.setTime(1099);
      return identity;
    },
    (captured) => {
      calls.push("publish");
      assert.equal(captured, identity);
      return receipt;
    },
  );
  assert.deepEqual(calls, ["capture", "publish"]);
  assert.equal(result.captured, identity);
  assert.equal(result.publication, receipt);
  phase.dispose();
});

test("shared capture failure never publishes or replaces original error", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const phase = new AbsolutePhase(1100, () => {}, new HarnessFaults()),
    original = Error("capture original");
  let publications = 0;
  assert.throws(
    () =>
      captureThenPublish(
        phase,
        () => {
          throw original;
        },
        () => {
          publications++;
        },
      ),
    (error) => error === original,
  );
  assert.equal(publications, 0);
  phase.dispose();
});

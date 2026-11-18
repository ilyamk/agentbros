// Private acceptance-harness helpers; no production or caller authority.
export function formatHarnessError(error: unknown): string {
  try {
    return String(error).slice(0, 512);
  } catch {
    return "Unprintable harness failure";
  }
}
export function safeHarnessCall<T>(action: () => T, fallback: T, faults: HarnessFaults): { ok: boolean; value: T } {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    faults.record(error);
    return { ok: false, value: fallback };
  }
}
export function publishHarnessReceipt(
  write: () => void,
  primary: { present: boolean; value: unknown },
  faults: HarnessFaults,
  publication: { attempted: boolean; written: boolean },
): void {
  publication.attempted = true;
  let failed = false,
    writeFailure: unknown;
  try {
    write();
    publication.written = true;
  } catch (error) {
    failed = true;
    writeFailure = error;
    faults.record(error);
  }
  if (primary.present) throw primary.value;
  if (failed) throw writeFailure;
}
export class HarnessFaults {
  readonly errors: string[] = [];
  attempt(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.record(error);
    }
  }
  record(error: unknown): void {
    if (this.errors.length < 32) this.errors.push(formatHarnessError(error));
  }
}

export class AbsolutePhase {
  private expired?: Error;
  private disposed = false;
  private active?: string;
  private readonly waiters = new Set<(error: Error) => void>();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly deadline: number,
    private readonly cancel: () => void,
    readonly faults: HarnessFaults,
    private readonly now = Date.now,
  ) {
    this.timer = setTimeout(() => this.expire(), Math.max(0, deadline - now()));
  }
  private expire(): Error {
    if (!this.expired) {
      this.expired = new Error(`Render phase deadline: ${this.active ?? "between operations"}`);
      for (const reject of this.waiters) reject(this.expired);
      this.waiters.clear();
      this.faults.attempt(this.cancel);
    }
    return this.expired;
  }
  remaining(): number {
    this.check();
    return this.deadline - this.now();
  }
  check(): void {
    if (this.disposed) throw new Error("Render phase disposed");
    if (this.expired || this.now() >= this.deadline) throw this.expire();
  }
  async run<T>(name: string, action: () => Promise<T>, late?: (value: T) => Promise<void> | void): Promise<T> {
    this.check();
    this.active = name;
    let settled = false;
    return new Promise<T>((resolve, reject) => {
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          this.waiters.delete(fail);
          reject(error);
        }
      };
      this.waiters.add(fail);
      // Both handlers remain installed after expiry: no unhandled late rejection.
      Promise.resolve()
        .then(() => {
          this.check();
          return action();
        })
        .then(
          (value) => {
            if (settled || this.expired || this.now() >= this.deadline) {
              if (!settled) fail(this.expire());
              if (late)
                Promise.resolve()
                  .then(() => late(value))
                  .catch((error) => this.faults.record(error));
              return;
            }
            settled = true;
            this.waiters.delete(fail);
            resolve(value);
          },
          (error) => {
            if (!settled) {
              settled = true;
              this.waiters.delete(fail);
              reject(error);
            }
          },
        );
    });
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.disposed = true;
  }
}

// Synchronous consumer boundary shared by the actual capture/publisher and CPU checks.
export function captureThenPublish<T, R>(
  phase: AbsolutePhase,
  capture: () => T,
  publish: (captured: T) => R,
): { captured: T; publication: R } {
  phase.check();
  const captured = capture();
  phase.check(); // No asynchronous gap or additional work before the publisher.
  return { captured, publication: publish(captured) };
}

// A bounded cleanup wait; does not claim physical cancellation of the underlying work.
export async function boundedCleanup(
  action: () => Promise<void>,
  milliseconds: number,
  faults: HarnessFaults,
): Promise<boolean> {
  if (milliseconds <= 0) {
    faults.record("Cleanup deadline");
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(action)
        .then(
          () => true,
          (error) => {
            faults.record(error);
            return false;
          },
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          faults.record("Cleanup deadline");
          resolve(false);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class FirstSettlement<T> {
  private done = false;
  readonly promise: Promise<T>;
  private resolve!: (value: T) => void;
  private reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
  succeed(value: T): void {
    if (!this.done) {
      this.done = true;
      this.resolve(value);
    }
  }
  fail(error: unknown, cleanup: () => void, faults: HarnessFaults): void {
    if (this.done) return;
    this.done = true;
    this.reject(error);
    faults.attempt(cleanup);
  }
  get settled(): boolean {
    return this.done;
  }
}

export function measureSfxResidual(actual: Buffer, speech: Buffer, mix: Buffer) {
  const frames = 144000,
    bytes = frames * 4,
    start = 60800,
    end = 65600,
    edge = 1024;
  if (
    speech.length !== bytes ||
    mix.length !== bytes ||
    actual.length < bytes ||
    actual.length > bytes + 8192 ||
    actual.length % 4
  )
    throw new Error("PCM bounds");
  const sample = (buffer: Buffer, frame: number, channel: number) => buffer.readInt16LE(frame * 4 + channel * 2);
  const energy = (from: number, to: number) => {
    let residual = 0,
      reference = 0,
      dot = 0,
      error = 0;
    for (let frame = from; frame < to; frame++)
      for (let channel = 0; channel < 2; channel++) {
        const r = sample(actual, frame, channel) - sample(speech, frame, channel);
        const t = sample(mix, frame, channel) - sample(speech, frame, channel);
        residual += r * r;
        reference += t * t;
        dot += r * t;
        error += (r - t) ** 2;
      }
    return { residual, reference, dot, error, meanResidual: residual / ((to - from) * 2) };
  };
  const central = energy(start + edge, end - edge),
    leading = energy(start, start + edge),
    trailing = energy(end - edge, end);
  const before = energy(start - 4800, start - edge),
    after = energy(end + edge, end + 4800);
  if (central.reference <= 0) throw new Error("Zero SFX reference");
  const projectedGain = (0.2 * central.dot) / central.reference;
  const relativeError = Math.sqrt(central.error / central.reference);
  const baseline = Math.max(before.meanResidual, after.meanResidual);
  const aboveBaseline = central.meanResidual > 3 * baseline;
  const accepted = Math.abs(projectedGain - 0.2) <= 0.06 && relativeError <= 0.35 && aboveBaseline;
  return {
    accepted,
    startSample: start,
    endSample: end,
    expectedGain: 0.2,
    edgeSamples: edge,
    projectedGain,
    relativeError,
    baselineFactor: 3,
    aboveBaseline,
    central,
    leading,
    trailing,
    before,
    after,
  };
}

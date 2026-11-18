import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "../apple/runtime";
import { runtimeStatus } from "../runtime";
import { COMMAND_REGISTRY } from "../cli/commands";
import { validateProjectId } from "../cli";
import { modelCacheOverride } from "../cache-dir";
import { TranscriptSchema } from "../../types/transcript";
import { inspectAsset } from "../assets/inspect";
import { transcriptForSource } from "./workflow-assertions";
import type { WorkflowSource } from "./workflow-source";
import { WorkflowEventSchema, type WorkflowEvent, type WorkflowScenario } from "../../types/workflow-evaluation";
import { contained, digest, fail } from "./io";

const EnvelopeSchema = z
  .object({
    ok: z.boolean(),
    outputs: z.array(z.string()).max(100).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    elapsedMs: z.number().finite().nonnegative(),
    error: z.string().optional(),
    message: z.string().optional(),
    retryAfterMs: z.number().finite().nonnegative().optional(),
  })
  .strict();

export class WorkflowObserver {
  readonly events: WorkflowEvent[] = [];
  readonly actors = new Map<string, string | null>([["root", null]]);
  readonly runId = `run-${randomUUID()}`;
  readonly started = performance.now();
  private commands = 0;
  private retainedBytes = 0;
  private active = new Map<number, () => void>();
  constructor(
    readonly codeRoot: string,
    readonly workspace: string,
    readonly evidence: string,
    readonly scenario: WorkflowScenario,
    readonly source?: WorkflowSource,
    readonly signal?: AbortSignal,
  ) {
    const work = realpathSync(workspace),
      out = path.resolve(evidence);
    if (out === work || out.startsWith(work + path.sep)) fail("Observer evidence must be outside the agent workspace");
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(evidence, "blobs"), { recursive: true, mode: 0o700 });
  }
  pin(file: string) {
    const name = path.relative(this.workspace, path.resolve(this.workspace, file)).split(path.sep).join("/");
    const bytes = boundedFile(contained(this.workspace, name), this.scenario.limits.fileBytes);
    const sha256 = digest(bytes),
      blob = path.join(this.evidence, "blobs", sha256);
    if (!existsSync(blob)) {
      if (this.retainedBytes + bytes.length > this.scenario.limits.fileBytes * 4)
        fail("Workflow evidence byte limit exceeded");
      writeFileSync(blob, bytes, { flag: "wx", mode: 0o600 });
      this.retainedBytes += bytes.length;
    }
    return { path: name, sha256, bytes: bytes.length };
  }
  read(file: string): Buffer {
    const pin = this.pin(file),
      bytes = boundedFile(contained(this.workspace, file), this.scenario.limits.fileBytes);
    if (digest(bytes) !== pin.sha256) fail("Input changed between pin and read");
    return bytes;
  }
  record(event: Omit<WorkflowEvent, "version" | "runId" | "id" | "parent" | "node">): WorkflowEvent {
    if (!this.actors.has(event.actor)) fail("Unobserved actor identity");
    if (this.events.length >= 1000) fail("Workflow observation limit exceeded");
    const runtime = runtimeStatus();
    const value = WorkflowEventSchema.parse({
      ...event,
      version: 2,
      runId: this.runId,
      id: `event-${this.events.length + 1}`,
      parent: this.actors.get(event.actor),
      node: { version: runtime.actual, executable: process.execPath },
    });
    writeFileSync(path.join(this.evidence, value.id + ".json"), JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    this.events.push(value);
    return value;
  }
  get remainingMs(): number {
    return this.scenario.limits.wallTimeSec * 1000 - (performance.now() - this.started);
  }
  private ensureActive(): void {
    if (this.signal?.aborted || this.remainingMs <= 0) fail("Evaluation cancelled or deadline reached");
  }
  async operation<T>(
    command: string,
    inputs: string[],
    outputs: string[],
    fn: () => T | Promise<T>,
    options: { actor?: string; kind?: WorkflowEvent["kind"]; authority?: WorkflowEvent["authority"] } = {},
  ) {
    this.ensureActive();
    this.source?.verify();
    const actor = options.actor ?? "root",
      start = performance.now(),
      startedAt = new Date().toISOString(),
      pins = inputs.map((file) => this.pin(file));
    try {
      const value = await fn();
      this.ensureActive();
      this.source?.verify();
      for (const pin of pins)
        if (this.pin(pin.path).sha256 !== pin.sha256) fail("Input changed during the consuming operation");
      const event = this.record({
        actor,
        kind: options.kind ?? "consumption",
        authority: options.authority ?? "trusted-executor",
        command,
        argv: [],
        startedAt,
        elapsedMs: performance.now() - start,
        exitCode: 0,
        inputs: pins,
        outputs: outputs.map((file) => this.pin(file)),
        passed: true,
        detail: "Trusted operation completed; inputs unchanged.",
      });
      return { value, event };
    } catch (error) {
      this.record({
        actor,
        kind: options.kind ?? "validation",
        authority: options.authority ?? "trusted-executor",
        command,
        argv: [],
        startedAt,
        elapsedMs: performance.now() - start,
        exitCode: 1,
        inputs: pins,
        outputs: outputs.flatMap((file) => {
          try {
            return [this.pin(file)];
          } catch {
            return [];
          }
        }),
        passed: false,
        detail: error instanceof Error ? error.message.slice(0, 4000) : "Operation failed",
      });
      throw error;
    }
  }
  async execute(
    alias: string,
    argv: string[],
    options: { actor?: string; inputs?: string[]; authority?: WorkflowEvent["authority"]; timeoutMs?: number } = {},
  ) {
    const count = this.events.length;
    try {
      return await this.executeCommand(alias, argv, options);
    } catch (error) {
      if (this.events.length === count && this.actors.has(options.actor ?? "root"))
        this.record({
          actor: options.actor ?? "root",
          kind: "command",
          authority: "trusted-executor",
          command: alias,
          argv,
          startedAt: new Date().toISOString(),
          elapsedMs: 0,
          exitCode: 1,
          inputs: [],
          outputs: [],
          passed: false,
          detail: error instanceof Error ? error.message.slice(0, 4000) : "Command precondition failed",
        });
      throw error;
    }
  }
  private async executeCommand(
    alias: string,
    argv: string[],
    options: { actor?: string; inputs?: string[]; authority?: WorkflowEvent["authority"]; timeoutMs?: number },
  ) {
    this.ensureActive();
    this.source?.verify();
    const actor = options.actor ?? "root",
      startedAt = new Date().toISOString(),
      start = performance.now();
    if (!this.actors.has(actor)) fail("Unobserved actor identity");
    const shorts: Record<string, string> = {
      h: "help",
      ...(["transcribe", "speech:local"].includes(alias)
        ? { i: "input", o: "output", f: "force", l: "language", ...(alias === "transcribe" ? { m: "model" } : {}) }
        : {}),
    };
    const view = argv
      .map((v) => {
        if (v.startsWith("-") && !v.startsWith("--") && v.length > 1) {
          const option = v.split("=")[0]!,
            name = shorts[option.slice(1)];
          if (!name || option.length !== 2) fail("Unsupported short option in the scoped command adapter");
          return "--" + name + v.slice(option.length);
        }
        return v;
      })
      .flatMap((v) =>
        v.startsWith("--") && v.includes("=") ? [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)] : [v],
      );
    const entry = COMMAND_REGISTRY.find((e) => e.alias === alias);
    const help = view.length === 1 && view[0] === "--help";
    const executedArgv = help ? ["--help"] : argv;
    const fromRaw = alias === "transcribe" && view.includes("--from-raw") && !view.includes("--provider");
    const adapters = [
      "campaign:production",
      "campaign:next",
      "commands",
      "local:capabilities",
      "next",
      "film:next",
      "film:brief",
      "footage:next",
      "pipeline:check",
      "playbook",
      "film:init",
      "transcribe",
      "speech:local",
      "shorts:prepare",
      "asset:import",
      "voiceover:local",
      "text:translate",
      "text:analyse",
      "text:assist",
      "image:describe",
      "media:vision",
      "audio:events",
      "campaign",
      "reframe:track",
      "timeline:edit",
      "video:workflow",
      "captions:export",
      "film:render",
      "delivery",
    ];
    const refuse = (message: string): never => {
      this.record({
        actor,
        kind: "command",
        authority: "trusted-executor",
        command: alias,
        argv,
        startedAt,
        elapsedMs: 0,
        exitCode: null,
        inputs: [],
        outputs: [],
        passed: false,
        detail: message,
      });
      return fail(message);
    };
    if (
      !help &&
      ["campaign", "campaign:production", "delivery"].includes(alias) &&
      view.filter((v) => v === "--action").length > 1
    )
      refuse("Duplicate authority-sensitive action flags are refused");
    const flagValue = (flag: string) => view[view.indexOf(flag) + 1];
    if (!help && alias === "campaign" && !["localize-plan", "localize-create"].includes(flagValue("--action") ?? ""))
      refuse("Only localisation drafts are authorised");
    if (!help && alias === "delivery" && !["snapshot", "check"].includes(flagValue("--action") ?? ""))
      refuse("Only snapshot/check are authorised");
    if (!help && alias === "timeline:edit" && view.includes("--command"))
      refuse("Use a pinned command-file in workflow evaluation");
    const discovery = ["commands", "local:capabilities"].includes(alias);
    const allowed =
      entry?.script &&
      (help ||
        (adapters.includes(alias) &&
          (this.scenario.commands.includes(alias) || discovery || fromRaw) &&
          (entry.paid === "none" || fromRaw)));
    const forbidden = [
      "--force",
      "--allow-download",
      "--write-doc",
      "--ceiling-usd",
      "--approved-by",
      "--proxy",
      "--set",
      "--note",
      "--by",
      ...(alias === "local:capabilities" ? [] : ["--task"]),
    ];
    if (alias === "campaign:production" && !help) {
      const action = view[view.indexOf("--action") + 1];
      if (!["plan", "init", "status"].includes(action))
        fail("Campaign evaluation permits no approvals, execution or decision recording");
    }
    if (!allowed || view.some((v) => forbidden.includes(v))) {
      this.record({
        actor,
        kind: "command",
        authority: "trusted-executor",
        command: alias,
        argv,
        startedAt,
        elapsedMs: 0,
        exitCode: null,
        inputs: [],
        outputs: [],
        passed: false,
        detail: "Command or side effect exceeds the scenario authority.",
      });
      fail("Command or side effect exceeds the scenario authority");
    }
    // The executor must not grant a sandboxed caller wider filesystem authority.
    const pathFlags = [
      "--input",
      "--output",
      "--output-dir",
      "--vad-output",
      "--transcript",
      "--from-raw",
      "--metadata",
      "--request",
      "--source",
      "--keyterms-file",
      "--local-evidence",
      "--manifest",
      "--detections",
      "--save-detections",
      "--command-output",
      "--command-file",
      "--timeline",
      "--recording-edit",
      "--shots",
      "--map",
      "--follow",
      "--sync",
      "--snapshot",
      "--entry",
      "--public-dir",
      "--audio",
      "--decision",
      "--props",
      "--receipt",
      "--measure",
      "--targets",
      "--audio-map",
      "--cue-sheet",
      "--scope-root",
    ];
    for (let i = 0; i < view.length; i++) {
      const flag = view[i]!;
      if (pathFlags.includes(flag) && !(flag === "--timeline" && alias !== "reframe:track")) {
        const value = view[++i];
        if (!value || value.startsWith("--")) fail("Missing scoped path argument");
        const name = path.relative(this.workspace, path.resolve(this.workspace, value)).split(path.sep).join("/");
        contained(this.workspace, name);
      } else if (flag === "--project") {
        const value = view[++i];
        if (!value) fail("Missing project ID");
        validateProjectId(value);
        contained(this.workspace, `public/projects/${value}`);
      } else if (flag === "--cameras") {
        const value = view[++i];
        if (!value) fail("Missing scoped material path");
        for (const file of value.split(","))
          contained(
            this.workspace,
            path.relative(this.workspace, path.resolve(this.workspace, file)).split(path.sep).join("/"),
          );
      } else if (flag === "--product") {
        let count = 0;
        while (view[i + 1] && !view[i + 1]!.startsWith("--")) {
          const file = view[++i]!;
          count++;
          contained(
            this.workspace,
            path.relative(this.workspace, path.resolve(this.workspace, file)).split(path.sep).join("/"),
          );
        }
        if (!count) fail("Missing scoped product material");
      }
    }
    if (existsSync(path.join(this.workspace, ".env"))) fail("An evaluator workspace must not contain .env");
    if (++this.commands > this.scenario.limits.commands) fail("Workflow command limit exceeded");
    const manifest = JSON.parse(boundedFile(path.join(this.codeRoot, "package.json")).toString()) as {
      scripts: Record<string, string>;
    };
    const script = manifest.scripts[alias]?.split(" ");
    if (!script || script[0] !== "tsx" || script[1] !== entry.script || script.some((s) => /[;&|`$<>]/u.test(s)))
      fail("Observed command needs a literal tsx registry entry");
    const inputNames = help ? [] : [...(options.inputs ?? [])];
    for (let i = 0; i < view.length; i++)
      if (
        [
          "--input",
          "--transcript",
          "--from-raw",
          "--metadata",
          "--request",
          "--local-evidence",
          "--manifest",
          "--detections",
          "--command-file",
          "--snapshot",
        ].includes(view[i]!)
      ) {
        if (!view[i + 1]) fail("Missing input path");
        inputNames.push(view[++i]!);
      }
    const inputs = [...new Set(inputNames)].map((f) => this.pin(f));
    const originals = this.events.find((event) => event.command === "fixture:material")?.outputs ?? [];
    for (const pin of inputs) {
      const original = originals.find((p) => p.path === pin.path);
      if (original && original.sha256 !== pin.sha256) fail("Task original changed before execution: " + pin.path);
    }
    if (fromRaw) {
      const rawIndex = view.indexOf("--from-raw"),
        raw = this.pin(view[rawIndex + 1]!);
      const frozen = this.scenario.material.find((m) => m.path.endsWith("/scribe.json"));
      if (!frozen || raw.sha256 !== frozen.sha256) fail("Frozen transcript material changed before execution");
    }
    if (alias === "shorts:prepare" && !help) {
      const input = inputs[0];
      if (!input) fail("A transcript input is required");
      const raw = JSON.parse(this.read(input.path).toString());
      const transcript = TranscriptSchema.parse(raw);
      const producer = this.events.some(
        (e) =>
          e.passed &&
          ["speech:local", "transcribe"].includes(e.command) &&
          e.outputs.some((p) => p.path === input.path && p.sha256 === input.sha256),
      );
      if (!producer) fail("Consumer input has no observed transcript producer");
      const source = this.pin(transcript.source.file),
        duration = inspectAsset(path.join(this.workspace, source.path)).media.durationSec;
      if (!duration) fail("Source media duration is unavailable");
      transcriptForSource(raw, source.sha256, duration);
      if (transcript.source.durationSec === null || Math.abs(transcript.source.durationSec - duration) > 0.05)
        fail("Transcript duration differs from actual source");
    }
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SYSTEMROOT: process.env.SYSTEMROOT,
      CI: "1",
      AGENTBROS_NO_SPEND: "1",
      AGENTBROS_WORKFLOW_BROWSER: process.env.AGENTBROS_WORKFLOW_BROWSER,
      AGENTBROS_LOCAL_DOWNLOADS: "never",
      AGENTBROS_INTERACTION_MODE: "autonomous",
      AGENTBROS_MEMORY_ROOT: path.join(this.workspace, ".cache/workflow-memory"),
    };
    // Reuse installed native workers read-only; no new resources are authorised.
    const modelCache = modelCacheOverride();
    if (modelCache) env.AGENTBROS_MODEL_CACHE = modelCache;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(this.codeRoot, "node_modules/tsx/dist/cli.mjs"),
          path.join(this.codeRoot, entry.script!),
          ...script.slice(2),
          ...executedArgv,
          ...(alias === "video:workflow" && !help ? ["--scope-root", this.workspace] : []),
        ],
        { cwd: this.workspace, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "",
        bytes = 0,
        reason = "";
      const stdoutDecoder = new StringDecoder("utf8"),
        stderrDecoder = new StringDecoder("utf8");
      const stop = () => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already finished. */
        }
      };
      if (child.pid) this.active.set(child.pid, stop);
      const remaining = this.scenario.limits.wallTimeSec * 1000 - (performance.now() - this.started);
      const abort = () => {
        reason = "Evaluation cancelled";
        stop();
      };
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
      const timer = setTimeout(
        () => {
          reason = "Command timeout";
          stop();
        },
        Math.max(1, Math.min(options.timeoutMs ?? 120000, remaining)),
      );
      const read = (stream: "stdout" | "stderr", chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 262144) {
          reason = "Command output limit";
          stop();
        } else if (stream === "stdout") stdout += stdoutDecoder.write(chunk);
        else stderr += stderrDecoder.write(chunk);
      };
      child.stdout.on("data", (b: Buffer) => read("stdout", b));
      child.stderr.on("data", (b: Buffer) => read("stderr", b));
      child.on("error", (error) => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
        if (child.pid) this.active.delete(child.pid);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
        stop();
        if (child.pid) this.active.delete(child.pid);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({ code, stdout, stderr: reason || stderr });
      });
    });
    this.source?.verify();
    let envelope: { ok?: boolean; outputs?: string[]; metadata?: Record<string, unknown>; message?: string } = {};
    try {
      if (result.stdout.trim().split("\n").length !== 1) fail("CLI must emit one JSON line");
      envelope = EnvelopeSchema.parse(JSON.parse(result.stdout.trim()));
    } catch {
      /* Invalid envelopes are recorded as failed execution. */
    }
    let outputs: WorkflowEvent["outputs"] = [],
      detail = envelope.message ?? "Public CLI envelope and exit status checked.";
    let passed = result.code === 0 && envelope.ok === true;
    try {
      outputs = (envelope.outputs ?? []).map((f) => this.pin(f));
      for (const pin of inputs) if (this.pin(pin.path).sha256 !== pin.sha256) fail("Command changed a declared input");
    } catch (error) {
      passed = false;
      detail = error instanceof Error ? error.message : "Invalid outputs";
    }
    const event = this.record({
      actor,
      kind: [
        "commands",
        "local:capabilities",
        "next",
        "film:next",
        "film:brief",
        "footage:next",
        "pipeline:check",
      ].includes(alias)
        ? "discovery"
        : "command",
      authority: options.authority ?? "trusted-executor",
      command: alias,
      argv: executedArgv,
      startedAt,
      elapsedMs: performance.now() - start,
      exitCode: result.code,
      inputs,
      outputs,
      passed,
      detail: detail.slice(0, 4000),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return { envelope, event };
  }
  stop(): void {
    for (const cancel of this.active.values()) cancel();
  }
  get activeProcesses(): number {
    return this.active.size;
  }
}

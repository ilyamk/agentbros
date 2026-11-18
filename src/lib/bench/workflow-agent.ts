import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { boundedFile } from "../apple/runtime";
import type { WorkflowReport } from "../../types/workflow-evaluation";
import { harnessArgs, runHarness } from "./run";
import { transcriptCounts } from "./measure";
import { contained, fail } from "./io";
import type { WorkflowObserver } from "./workflow-observer";

const RequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      alias: z.string().min(1).max(100),
      argv: z.array(z.string().max(12000)).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("delegate"), task: z.string().min(1).max(12000) }).strict(),
]);
const SignedRequestSchema = z
  .object({ body: z.string().min(1).max(32768), signature: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export interface WorkflowAgentOptions {
  harness: "codex" | "claude-code";
  model: string;
  allowAgent: boolean;
  expectedHarnessVersion?: string;
  signal?: AbortSignal;
}

/** File IPC works inside the existing workspace-write sandbox without enabling network access. */
function clientSource(inbox: string, replies: string, timeoutMs: number): string {
  return `#!${process.execPath}
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const inbox=${JSON.stringify(inbox)},replies=${JSON.stringify(replies)},id=crypto.randomUUID();
const args=process.argv.slice(2),delegate=path.basename(process.argv[1])==='workflow-delegate';
if(!delegate&&(args.length===0||args[0]==='--help'||args[0]==='-h'))args.unshift('commands');
const request=delegate?{kind:'delegate',task:args.join(' ')}:{kind:'command',alias:args.shift()||'commands',argv:args};
const deadline=Date.now()+${timeoutMs};
(async()=>{const context=process.env.AGENTBROS_WORKFLOW_CONTEXT;if(!context)throw new Error('Observed actor environment is missing');const body=JSON.stringify(request),signature=crypto.createHmac('sha256',context).update(id+'.json\\n'+body).digest('hex'),temporary=path.join(path.dirname(inbox),id+'.request.tmp');let created=false;try{fs.writeFileSync(temporary,JSON.stringify({body,signature}),{flag:'wx',mode:0o600});created=true;fs.linkSync(temporary,path.join(inbox,id+'.json'));}finally{if(created){try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}}while(Date.now()<deadline){try{const file=path.join(replies,id+'.json');const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>524288)throw new Error('Invalid observer reply');const result=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(result)+'\\n');process.exitCode=result.ok?0:1;return;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,30));}throw new Error('Observer reply timed out');})().catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:'VALIDATION',message:e.message})+'\\n');process.exitCode=1;});
`;
}
export async function workflowAgent(observer: WorkflowObserver, options: WorkflowAgentOptions) {
  if (!options.allowAgent || !options.model.trim())
    fail("Real-agent execution requires --allow-agent and an exact --model; harness usage may be billed.");
  const override = process.env[`BENCH_HARNESS_BIN_${options.harness.replaceAll("-", "_").toUpperCase()}`];
  const bin = override ?? (options.harness === "codex" ? "codex" : "claude");
  if (options.signal?.aborted || observer.remainingMs <= 0) fail("Evaluation cancelled or deadline reached");
  const version = spawnSync(bin, ["--version"], {
    cwd: observer.codeRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SYSTEMROOT: process.env.SYSTEMROOT,
    },
    timeout: Math.max(1, Math.min(5000, observer.remainingMs)),
    maxBuffer: 8192,
    encoding: "utf8",
    shell: false,
  });
  if (version.error || version.status !== 0 || !version.stdout.trim())
    fail("Harness version probe failed within its bounded setup allowance");
  if (options.expectedHarnessVersion && version.stdout.trim() !== options.expectedHarnessVersion)
    fail("Installed harness version differs from the registered profile");
  const harness: NonNullable<WorkflowReport["harness"]> = {
    name: options.harness,
    model: options.model,
    version: version.stdout.trim(),
    fixture: !!override,
  };
  const tasks = new Set<Promise<void>>(),
    childTraces = new Map<string, Awaited<ReturnType<typeof runHarness>>>();
  let cancelled = false,
    leaves = 0,
    commandQueue = Promise.resolve(),
    sharedExceeded = false,
    observationError: string | undefined;
  const observedUsage = new Map<string, { input: number; output: number }>();
  const controller = new AbortController();
  const abort = () => {
    cancelled = true;
    controller.abort();
    observer.stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const folders = new Map<string, { inbox: string; replies: string; bin: string }>();
  const contexts = new Map<string, string>();
  const ipcPath = (file: string) =>
    contained(observer.workspace, path.relative(observer.workspace, file).split(path.sep).join("/"));
  const redact = (text: string) =>
    [...contexts.values()].reduce((value, context) => value.split(context).join("[redacted actor context]"), text);
  const seen = new Set<string>();
  const setup = (actor: string) => {
    contexts.set(actor, randomBytes(32).toString("hex"));
    const directory = path.join(observer.workspace, ".cache/workflow-bridge", actor),
      inbox = path.join(directory, "inbox"),
      replies = path.join(directory, "replies"),
      binDir = path.join(observer.evidence, "clients", actor);
    for (const dir of [inbox, replies]) {
      mkdirSync(ipcPath(dir), { recursive: true, mode: 0o700 });
      ipcPath(dir);
    }
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    for (const name of ["pnpm", "workflow-delegate"])
      writeFileSync(
        path.join(binDir, name),
        clientSource(inbox, replies, observer.scenario.limits.wallTimeSec * 1000),
        { flag: "wx", mode: 0o700 },
      );
    const value = { inbox, replies, bin: binDir };
    folders.set(actor, value);
    return value;
  };
  const invoke = async (actor: string, task: string) => {
    const folder = setup(actor),
      remaining = Math.max(
        1,
        Math.floor(observer.scenario.limits.wallTimeSec - (performance.now() - observer.started) / 1000),
      );
    const limits = {
      wallTimeSec: remaining,
      tokens: observer.scenario.limits.tokens,
      maxFileBytes: observer.scenario.limits.fileBytes,
      maxBundleBytes: observer.scenario.limits.fileBytes * 4,
      maxTranscriptBytes: observer.scenario.limits.transcriptBytes,
    };
    const observedTask = `Evaluation command boundary: ${path.join(folder.bin, "pnpm")}. Run public aliases through this executable. A login shell may reset PATH; then use its absolute path or a non-login shell. The equivalent delegation executable is ${path.join(folder.bin, "workflow-delegate")}. This instrumentation changes no production command semantics.\n\n${task}`;
    const result = await runHarness(
      bin,
      harnessArgs(options.harness, options.model),
      observer.workspace,
      observedTask,
      limits,
      options.harness,
      false,
      {
        PATH: `${folder.bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENTBROS_WORKFLOW_CONTEXT: contexts.get(actor),
        AGENTBROS_LOCAL_DOWNLOADS: "never",
        AGENTBROS_INTERACTION_MODE: "autonomous",
        ...(override ? { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined } : {}),
      },
      controller.signal,
      (usage) => {
        observedUsage.set(actor, usage);
        if (
          [...observedUsage.values()].reduce((sum, u) => sum + u.input + u.output, 0) > observer.scenario.limits.tokens
        ) {
          sharedExceeded = true;
          abort();
        }
      },
    );
    result.transcript = redact(result.transcript);
    result.stderr = redact(result.stderr);
    childTraces.set(actor, result);
    writeFileSync(path.join(observer.evidence, `${actor}-transcript.jsonl`), result.transcript, {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(path.join(observer.evidence, `${actor}-stderr.txt`), result.stderr, { flag: "wx", mode: 0o600 });
    return result;
  };
  const reply = (folder: { replies: string }, id: string, value: unknown) => {
    const temporary = ipcPath(path.join(path.dirname(folder.replies), id + ".reply.tmp"));
    let created = false;
    try {
      writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
      created = true;
      linkSync(ipcPath(temporary), ipcPath(path.join(folder.replies, id)));
    } finally {
      if (created) unlinkSync(ipcPath(temporary));
    }
  };
  const handle = async (actor: string, file: string, folder: { inbox: string; replies: string }) => {
    try {
      const signed = SignedRequestSchema.parse(
        JSON.parse(boundedFile(ipcPath(path.join(folder.inbox, file)), 262144).toString()),
      );
      const expected = createHmac("sha256", contexts.get(actor)!)
        .update(file + "\n" + signed.body)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signed.signature, "hex"))) {
        observationError = "An unauthenticated actor request was refused";
        abort();
        fail(observationError);
      }
      const request = RequestSchema.parse(JSON.parse(signed.body));
      if (request.kind === "delegate") {
        if (actor !== "root" || ++leaves > observer.scenario.limits.leaves) {
          observer.record({
            actor,
            kind: "blocker",
            authority: "trusted-executor",
            command: "workflow-delegate",
            argv: [],
            startedAt: new Date().toISOString(),
            elapsedMs: 0,
            exitCode: null,
            inputs: [],
            outputs: [],
            passed: false,
            detail: "Leaf depth or delegation allowance exceeded.",
          });
          fail("Leaf agents cannot delegate; the scenario bounds root delegation.");
        }
        const child = `leaf-${leaves}`;
        observer.actors.set(child, actor);
        observer.record({
          actor,
          kind: "delegation",
          authority: "trusted-executor",
          command: "workflow-delegate",
          argv: [],
          startedAt: new Date().toISOString(),
          elapsedMs: 0,
          exitCode: 0,
          inputs: [],
          outputs: [],
          passed: true,
          detail: `Started observed child ${child}; its own transcript is required.`,
        });
        const result = await invoke(
          child,
          `You are a leaf agent. Do not delegate or grant approvals. Use the public commands through pnpm; the test observer executes trusted implementations. Preserve source hashes and IDs. No paid APIs or downloads.\n\n${request.task}`,
        );
        reply(folder, file, {
          ok: result.status === "completed",
          metadata: {
            actor: child,
            status: result.status,
            outputs: observer.events.filter((e) => e.actor === child).flatMap((e) => e.outputs),
            observedRun: observer.runId,
          },
        });
      } else {
        commandQueue = commandQueue.then(async () => {
          if (cancelled) fail("Evaluation cancelled");
          const result = await observer.execute(request.alias, request.argv, { actor });
          reply(folder, file, {
            ...result.envelope,
            ok: result.event.passed,
            metadata: { ...result.envelope.metadata, observedEvent: result.event.id, observedRun: observer.runId },
          });
        });
        await commandQueue;
        // A failed request must not poison the queue for bounded recovery.
      }
    } catch (error) {
      commandQueue = commandQueue.catch(() => undefined);
      try {
        reply(folder, file, {
          ok: false,
          error: "VALIDATION",
          message: error instanceof Error ? error.message : "Observer request failed",
        });
      } catch {
        /* A conflicting reply never replaces evidence. */
      }
    }
  };
  const poll = () => {
    if (cancelled) return;
    try {
      for (const [actor, folder] of folders)
        for (const file of readdirSync(ipcPath(folder.inbox))
          .filter((name) => !seen.has(actor + "/" + name))
          .slice(0, 64)) {
          const key = actor + "/" + file;
          if (seen.has(key)) continue;
          seen.add(key);
          if (
            !/^[a-f0-9-]{36}\.json$/u.test(file) ||
            seen.size > observer.scenario.limits.commands + observer.scenario.limits.leaves + 10
          ) {
            abort();
            continue;
          }
          const task = handle(actor, file, folder);
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        }
    } catch (error) {
      observationError = error instanceof Error ? error.message : "Observer channel failed";
      abort();
    }
  };
  const timer = setInterval(poll, 25);
  try {
    const prompt = [
      observer.scenario.task,
      'The task contract fixes outputs and authority, not a command sequence. Discover commands with pnpm commands --query "task words"; inspect pnpm <alias> --help when needed. Choose any equivalent permitted route. pnpm is observed by an external executor using the trusted checkout; unknown commands return a structured refusal. Ordinary file preparation is allowed in this workspace.',
      "Material: material/scribe.json, material/voice.json, material/translation.json, material/notes.txt; input.wav is a synthetic tone, not ASR ground truth. Reconstruct the frozen transcript with transcribe --from-raw rather than recognising the tone. Project workflow-e2e already exists for asset imports.",
      `Task command families: ${observer.scenario.commands.join(", ")}. Passive discovery, registered command help and frozen-raw offline transcription for auxiliary verification are also available. No model downloads, settings changes, approvals or media-provider expenditure. Do not access .env or credentials, commit or send messages.`,
      observer.scenario.requiresLeaf
        ? 'Use workflow-delegate "<narrow task and input/output paths>" for one actual leaf. Wait for its result, validate the artefact and pass it to a consumer. The leaf must not delegate.'
        : "Complete this task directly; delegation is not authorised in this scenario.",
      `Limits: ${JSON.stringify(observer.scenario.limits)}. Stop with a specific blocker when resources are absent. Report what you verified and what remains uncertain.`,
    ].join("\n\n");
    writeFileSync(path.join(observer.evidence, "prompt.txt"), prompt, { flag: "wx", mode: 0o600 });
    const result = await invoke("root", prompt);
    abort();
    await Promise.all([...tasks]);
    const counts = [...childTraces.values()].map((r) => transcriptCounts(r.transcript, options.harness));
    const tokens = counts.every((c) => c.tokens !== null)
      ? counts.reduce((sum, c) => ({ input: sum.input + c.tokens!.input, output: sum.output + c.tokens!.output }), {
          input: 0,
          output: 0,
        })
      : null;
    const observedChildren = [...childTraces]
      .filter(
        ([actor, r]) =>
          actor !== "root" &&
          r.status === "completed" &&
          transcriptCounts(r.transcript, options.harness).toolCalls > 0 &&
          observer.events.some((e) => e.actor === actor && e.passed && e.kind === "command"),
      )
      .map(([actor]) => actor);
    const childTrace = observedChildren.length > 0;
    const observedTokens = observedUsage.size
      ? [...observedUsage.values()].reduce(
          (sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output }),
          { input: 0, output: 0 },
        )
      : null;
    return {
      harness,
      result,
      tokens,
      observedTokens,
      childTrace,
      observedChildren,
      observationError,
      tracesComplete: counts.every((c) => c.transcriptState === "complete"),
      tokenLimitExceeded:
        sharedExceeded || (!!tokens && tokens.input + tokens.output > observer.scenario.limits.tokens),
    };
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    abort();
    await Promise.allSettled([...tasks]);
  }
}

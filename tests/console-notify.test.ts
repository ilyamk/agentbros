/**
 * RFC 0004 WP14 (D23, A12): console notifications with a stub OS sender. Off by default and under AGENTBROS_NOTIFY=off;
 * enabling starts from the present state; dedupe by decision, card, job and event key across restarts (persisted
 * cursor); per-kind toggles; cooldown; rate limit with one overflow notice; one notice per pause; redaction (only
 * fixed templates and safe identifiers reach the sender); the deep link; the focused-tab and browser channels; routes.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ConsoleEvent, Decision } from "../src/types/console";
import { Notifier, deepLink, type NotifierOptions } from "../src/lib/console/notify";
import { eventNotice, SAFE_TOKEN } from "../src/lib/console/notify-rules";
import {
  OSASCRIPT_SCRIPT,
  osascriptArgs,
  osascriptSender,
  terminalNotifierArgs,
  terminalNotifierSender,
  type NotificationSender,
  type OsNotification,
} from "../src/lib/console/notify-sender";
import { notifyDisabledByEnv, notifyStateFile, readNotifyState } from "../src/lib/console/notify-state";
import { ulid } from "../src/lib/console/ulid";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const SECRET = "sk-" + "live-notify-secret-0123456789abcdef";
const WORDS = "please make the logo bigger, my phone is 555-0100";
const ORIGIN = "http://127.0.0.1:4317";

const roots: string[] = [];
after(() => roots.forEach(removeRoot));

function fixture() {
  const root = makeRoot();
  roots.push(root);
  return root;
}

let clock = Date.parse("2026-11-17T10:00:00.000Z");
let counter = 0;
beforeEach(() => {
  clock += 3_600_000;
});

function event(partial: Partial<ConsoleEvent> & Pick<ConsoleEvent, "kind">): ConsoleEvent {
  counter += 1;
  return {
    v: 1,
    id: ulid(clock + counter),
    at: new Date(clock).toISOString(),
    project: PROJECT,
    ...partial,
  } as ConsoleEvent;
}

const cliEnd = (partial: Partial<ConsoleEvent> = {}) =>
  event({ kind: "cli.end", runId: `run-${counter}`, alias: "film:next", ok: false, elapsedMs: 5, ...partial });

function append(root: string, ...events: ConsoleEvent[]) {
  const file = path.join(root, "public/projects", PROJECT, "pipeline/events.jsonl");
  appendFileSync(file, events.map((item) => `${JSON.stringify(item)}\n`).join(""));
}

function decision(id: string, extra: Partial<Decision> = {}): Decision {
  return {
    v: 1,
    id,
    project: PROJECT,
    kind: "approve-gate",
    step: "script",
    title: `Approve the script ${SECRET}`,
    summary: WORDS,
    status: "pending",
    createdAt: new Date(clock).toISOString(),
    ...extra,
  } as unknown as Decision;
}

function stubSender(name: NotificationSender["name"] = "osascript") {
  const sent: OsNotification[] = [];
  const sender: NotificationSender = {
    name,
    clickThrough: name === "terminal-notifier",
    send: async (notification) => {
      sent.push(notification);
    },
  };
  return { sent, sender };
}

function notifier(
  root: string,
  extra: Omit<Partial<NotifierOptions>, "waiting"> & { waiting?: () => Decision[] } = {},
) {
  const { sent, sender } = stubSender();
  const waiting = extra.waiting ?? (() => []);
  const instance = new Notifier({
    rootDir: root,
    origin: ORIGIN,
    sender,
    env: {},
    now: () => clock,
    pollMs: 0,
    ...extra,
    waiting: async () => waiting(),
  });
  return { instance, sent };
}

describe("console notifications: switches", () => {
  test("off by default: nothing is sent and no state is written", async () => {
    const root = fixture();
    append(root, cliEnd({ step: "build", error: "VALIDATION" }));
    const { instance, sent } = notifier(root, { waiting: () => [decision("d-1")] });
    assert.equal(instance.status().settings.enabled, false);
    assert.deepEqual(await instance.scan(), []);
    assert.equal(sent.length, 0);
    assert.equal(readNotifyState(root).settings.enabled, false);
  });

  test("AGENTBROS_NOTIFY=off holds every notification off, whatever the settings", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root, { env: { AGENTBROS_NOTIFY: "off" } });
    await instance.update({ enabled: true });
    append(root, cliEnd({ step: "build", error: "VALIDATION" }));
    assert.equal(instance.status().disabledBy, "env");
    assert.deepEqual(await instance.scan(), []);
    assert.equal(sent.length, 0);
  });

  test("AGENTBROS_NOTIFY is read like the other console switches (trimmed, any case, off/0/false/no)", () => {
    const root = fixture();
    for (const value of ["off", " OFF ", "Off", "0", "false", "FALSE", "no"])
      assert.equal(notifier(root, { env: { AGENTBROS_NOTIFY: value } }).instance.status().disabledBy, "env", value);
    for (const value of ["", "on", "1", "true"])
      assert.equal(notifier(root, { env: { AGENTBROS_NOTIFY: value } }).instance.status().disabledBy, undefined, value);
    assert.equal(notifyDisabledByEnv({ AGENTBROS_NOTIFY: "\tfalse\n" }), true);
  });

  test("tests run with AGENTBROS_NOTIFY=off (memory-root helper)", () => {
    assert.equal(process.env.AGENTBROS_NOTIFY, "off");
  });

  test("enabling starts from the present state: earlier events and waiting decisions are not sent", async () => {
    const root = fixture();
    append(root, cliEnd({ step: "build", error: "VALIDATION" }));
    let waiting = [decision("d-old")];
    const { instance, sent } = notifier(root, { waiting: () => waiting });
    await instance.update({ enabled: true, prompted: true });
    assert.deepEqual(await instance.scan(), []);
    append(root, cliEnd({ step: "build", error: "VALIDATION" }));
    waiting = [decision("d-old"), decision("d-new", { step: "look" })];
    const out = await instance.scan();
    assert.deepEqual(out.map((item) => item.notice.kind).sort(), ["decision", "failure"]);
    assert.equal(sent.length, 2);
    assert.deepEqual(await instance.scan(), [], "a second scan sends nothing new");
    const written = statSync(notifyStateFile(root)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.scan();
    assert.equal(statSync(notifyStateFile(root)).mtimeMs, written, "an idle scan writes nothing");
  });
});

describe("console notifications: dedupe and cursor", () => {
  test("a restart neither repeats sent notices nor loses new ones (persisted cursor and keys)", async () => {
    const root = fixture();
    const waiting = [decision("d-1")];
    const first = notifier(root, { waiting: () => waiting });
    await first.instance.update({ enabled: true });
    append(root, cliEnd({ step: "build", error: "VALIDATION" }));
    waiting.push(decision("d-2", { step: "look" }));
    assert.equal((await first.instance.scan()).length, 2);
    first.instance.close();
    const state = readNotifyState(root);
    assert.ok(state.cursors[PROJECT]!.offset > 0);
    assert.ok(state.seen.includes("decision:d-2"));

    append(root, event({ kind: "job.state", data: { jobId: "job-7", state: "published" } }));
    const second = notifier(root, { waiting: () => waiting });
    const out = await second.instance.scan();
    assert.deepEqual(
      out.map((item) => item.notice.key),
      [`job:${PROJECT}:job-7`],
    );
    assert.equal(second.sent.length, 1);
  });

  test("one notice per paid job, whichever end state comes first", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    append(
      root,
      event({ kind: "job.state", data: { jobId: "job-1", state: "running" } }),
      event({ kind: "job.state", data: { jobId: "job-1", state: "validated" } }),
      event({ kind: "job.state", data: { jobId: "job-1", state: "published" } }),
    );
    await instance.scan();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.title, "Agent Bros.: a paid job finished");
  });

  test("an agent card is keyed by its card id, so a rewritten card file does not notify again", async () => {
    const root = fixture();
    let waiting: Decision[] = [];
    const { instance, sent } = notifier(root, { waiting: () => waiting });
    await instance.update({ enabled: true });
    waiting = [decision("card-a", { kind: "card-answer", cardId: "c1", step: "card" })];
    await instance.scan();
    waiting = [decision("card-b", { kind: "card-answer", cardId: "c1", step: "card" })];
    await instance.scan();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.title, "Agent Bros.: an agent card is waiting");
  });

  test("a gate re-keyed by a file change within the cooldown is not notified twice", async () => {
    const root = fixture();
    let waiting: Decision[] = [];
    const { instance, sent } = notifier(root, { waiting: () => waiting });
    await instance.update({ enabled: true });
    waiting = [decision("d-a")];
    await instance.scan();
    waiting = [decision("d-b")];
    await instance.scan();
    assert.equal(sent.length, 1);
    assert.ok(!readNotifyState(root).seen.includes("decision:d-b"), "held, not dropped");
    clock += 11 * 60_000;
    await instance.scan();
    assert.equal(sent.length, 2, "the still-waiting re-asked gate is notified once the cooldown ends");
    await instance.scan();
    assert.equal(sent.length, 2, "and only once");
  });

  test("a gate answered during the cooldown is never notified", async () => {
    const root = fixture();
    let waiting: Decision[] = [decision("d-a")];
    const { instance, sent } = notifier(root, { waiting: () => waiting });
    await instance.update({ enabled: true });
    waiting = [decision("d-b")];
    await instance.scan();
    waiting = [decision("d-c")];
    await instance.scan();
    assert.equal(sent.length, 1);
    waiting = [];
    clock += 11 * 60_000;
    await instance.scan();
    assert.equal(sent.length, 1);
  });

  test("a journal event held by a cooldown is folded into the earlier notice, not sent later", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    append(root, event({ kind: "agent.notification", data: { type: "permission-prompt" } }));
    await instance.scan();
    append(root, event({ kind: "agent.notification", data: { type: "permission-prompt" } }));
    await instance.scan();
    clock += 11 * 60_000;
    await instance.scan();
    assert.equal(sent.length, 1);
  });

  test("a kind switched off is skipped and not sent later when switched back on", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true, kinds: { render: false } });
    append(root, cliEnd({ alias: "render", ok: true, error: undefined }));
    await instance.scan();
    assert.equal(sent.length, 0);
    await instance.update({ kinds: { render: true } });
    await instance.scan();
    assert.equal(sent.length, 0);
    append(root, cliEnd({ alias: "film:render", ok: true, error: undefined }));
    await instance.scan();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.title, "Agent Bros.: render finished");
  });
});

describe("console notifications: rules", () => {
  test("failures: at a leased step or a user-needed code; never the user's own console action", () => {
    assert.equal(eventNotice(cliEnd({ error: "VALIDATION" })), undefined, "no step: the agent handles it");
    assert.equal(eventNotice(cliEnd({ step: "build", error: "X", channel: "console" })), undefined);
    assert.equal(eventNotice(cliEnd({ step: "build", error: "X", actor: "user" })), undefined);
    assert.equal(eventNotice(cliEnd({ error: "BUDGET_EXCEEDED" }))?.kind, "failure");
    for (const error of ["RATE_LIMIT", "NETWORK", "TIMEOUT", "ASSET_MISSING"])
      assert.equal(eventNotice(cliEnd({ step: "build", error })), undefined, `${error}: the agent retries`);
    assert.equal(
      eventNotice(cliEnd({ step: "build", error: "RENDER_FAILED" }))?.body,
      `${PROJECT} · build · film:next · RENDER_FAILED`,
    );
  });

  test("agent prompts and stop failures notify; tool failures, turn ends, links and interrupts do not", () => {
    const of = (type: string) => eventNotice(event({ kind: "agent.notification", data: { type, text: SECRET } }));
    assert.equal(of("permission-prompt")?.title, "Agent Bros.: the agent waits for permission");
    assert.equal(of("idle-prompt")?.title, "Agent Bros.: the agent waits for your input");
    assert.equal(of("stop-failure")?.title, "Agent Bros.: the agent stopped on an error");
    for (const type of ["tool-failure", "turn-end", "agent-link", "interrupt"]) assert.equal(of(type), undefined, type);
  });

  test("a delivery check that passed is a render notice; other successes are silent", () => {
    assert.equal(
      eventNotice(cliEnd({ alias: "delivery", ok: true, error: undefined, argv: ["--action", "check"] }))?.title,
      "Agent Bros.: delivery check passed",
    );
    assert.equal(
      eventNotice(cliEnd({ alias: "delivery", ok: true, error: undefined, argv: ["--action", "snapshot"] })),
      undefined,
    );
    assert.equal(eventNotice(cliEnd({ alias: "film:next", ok: true, error: undefined })), undefined);
  });

  test("a repeated idle prompt is held by the cooldown", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    append(root, event({ kind: "agent.notification", data: { type: "idle-prompt" } }));
    await instance.scan();
    append(root, event({ kind: "agent.notification", data: { type: "idle-prompt" } }));
    await instance.scan();
    assert.equal(sent.length, 1);
  });

  test("PAUSED refusals: one notice per pause, a new pause calls again", async () => {
    const root = fixture();
    const control = path.join(root, "public/projects", PROJECT, "pipeline/session/control.json");
    mkdirSync(path.dirname(control), { recursive: true });
    const pause = (at: string) =>
      writeFileSync(
        control,
        JSON.stringify({ v: 1, state: "paused", by: "user", channel: "console", at, history: [] }),
      );
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    pause("2026-11-17T12:00:00.000Z");
    append(root, cliEnd({ step: "build", error: "PAUSED" }), cliEnd({ step: "build", error: "PAUSED" }));
    await instance.scan();
    append(root, cliEnd({ step: "build", error: "PAUSED", alias: "render" }));
    await instance.scan();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.title, "Agent Bros.: the project is paused");
    pause("2026-11-17T13:00:00.000Z");
    append(root, cliEnd({ step: "build", error: "PAUSED" }));
    await instance.scan();
    assert.equal(sent.length, 2);
  });
});

describe("console notifications: rate limit", () => {
  test("a burst sends what the bucket allows and one overflow notice; held items come out later as one", async () => {
    const root = fixture();
    let waiting: Decision[] = [];
    const { instance, sent } = notifier(root, {
      waiting: () => waiting,
      rate: { capacity: 2, refillMs: 30_000 },
      cooldownMs: 0,
    });
    await instance.update({ enabled: true });
    waiting = ["a", "b", "c", "d", "e"].map((id) => decision(`d-${id}`, { step: id }));
    await instance.scan();
    assert.deepEqual(
      sent.map((item) => item.title),
      ["Agent Bros.: a decision is waiting", "Agent Bros.: 4 more items need you"],
    );
    // The bucket is empty: a new item waits, counted.
    append(root, cliEnd({ step: "build", error: "X" }));
    await instance.scan();
    assert.equal(sent.length, 2);
    clock += 30_000;
    await instance.scan();
    assert.equal(sent.length, 3);
    assert.equal(sent[2]!.title, "Agent Bros.: 1 more item needs you");
    assert.equal(sent[2]!.url, `${ORIGIN}/#/`);
  });
});

describe("console notifications: content and delivery", () => {
  test("only fixed templates and safe identifiers reach the sender: no secrets, words or messages", async () => {
    const root = fixture();
    let waiting: Decision[] = [];
    const { instance, sent } = notifier(root, { waiting: () => waiting });
    await instance.update({ enabled: true });
    append(
      root,
      cliEnd({ step: "build", error: "VALIDATION", message: `${SECRET} ${WORDS}`, argv: ["--key", SECRET] }),
      cliEnd({ step: `x ${SECRET}`.slice(0, 64), error: "BUDGET_EXCEEDED", message: WORDS }),
      event({ kind: "agent.notification", data: { type: "permission-prompt", text: `Run rm -rf? ${SECRET}` } }),
      event({ kind: "agent.notification", data: { type: "stop-failure", text: WORDS } }),
    );
    waiting = [decision("d-1"), decision("card-1", { kind: "card-answer", cardId: "c9", title: WORDS })];
    await instance.scan();
    assert.equal(sent.length, 4, "the rate limit folds the fifth into one overflow notice");
    const everything = JSON.stringify(sent.flatMap((item) => [...osascriptArgs(item), ...terminalNotifierArgs(item)]));
    assert.ok(!everything.includes(SECRET));
    assert.ok(!everything.includes("logo"));
    assert.ok(!everything.includes("rm -rf"));
    for (const item of sent) {
      assert.ok(item.title.length <= 64);
      if (item.group.startsWith("agentbros:overflow:")) assert.equal(item.body, "Open the console");
      else for (const part of item.body.split(" · ")) assert.match(part, SAFE_TOKEN, item.body);
    }
  });

  test("osascript gets the text as arguments, never inside the script", () => {
    const n: OsNotification = { title: 'Hi" & (do shell script "id") & "', body: "b\nody", url: "u", group: "g" };
    const args = osascriptArgs(n);
    const scripts = args.filter((_, index) => args[index - 1] === "-e");
    assert.deepEqual(scripts, [...OSASCRIPT_SCRIPT]);
    assert.deepEqual(args.slice(-2), ['Hi" & (do shell script "id") & "', "b ody"]);
  });

  test("terminal-notifier opens the deep link at the decision, without the session token", async () => {
    const root = fixture();
    const calls: { file: string; args: readonly string[] }[] = [];
    const run = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
    };
    let waiting: Decision[] = [];
    const instance = new Notifier({
      rootDir: root,
      origin: ORIGIN,
      sender: terminalNotifierSender("/opt/homebrew/bin/terminal-notifier", run),
      env: {},
      now: () => clock,
      pollMs: 0,
      waiting: async () => waiting,
    });
    await instance.update({ enabled: true });
    waiting = [decision("01JDECISION.script-1")];
    await instance.scan();
    assert.equal(calls.length, 1);
    const args = calls[0]!.args;
    const url = args[args.indexOf("-open") + 1];
    assert.equal(url, `${ORIGIN}/#/projects/${PROJECT}/decision/01JDECISION.script-1`);
    assert.equal(url, deepLink(ORIGIN, `/projects/${PROJECT}/decision/01JDECISION.script-1`));
    assert.ok(!args.join(" ").includes("token"));
    assert.equal(args[args.indexOf("-group") + 1], "agentbros:decision:01JDECISION.script-1");
  });

  test("the osascript sender runs /usr/bin/osascript; a failing sender never stops the scan", async () => {
    const calls: string[] = [];
    await osascriptSender(async (file) => {
      calls.push(file);
    }).send({ title: "t", body: "b", url: "u", group: "g" });
    assert.deepEqual(calls, ["/usr/bin/osascript"]);
    const root = fixture();
    const logs: string[] = [];
    const instance = new Notifier({
      rootDir: root,
      origin: ORIGIN,
      sender: { name: "osascript", clickThrough: false, send: () => Promise.reject(new Error("boom")) },
      env: {},
      now: () => clock,
      pollMs: 0,
      log: (line) => logs.push(line),
    });
    await instance.update({ enabled: true });
    append(root, cliEnd({ step: "build", error: "X" }));
    assert.equal((await instance.scan()).length, 1);
    assert.match(logs.join("\n"), /osascript failed: boom/);
  });
});

describe("console notifications: tabs", () => {
  test("a focused tab shows the notice itself: nothing goes to the OS (A12)", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    const first = instance.presence({ tab: "tab-aaaaaaaa", focused: true, browser: "default" });
    assert.deepEqual(first.notices, [], "no backlog on the first report");
    append(root, cliEnd({ step: "build", error: "X" }));
    await instance.scan();
    assert.equal(sent.length, 0);
    const polled = instance.presence({ tab: "tab-aaaaaaaa", focused: true, browser: "default", since: first.seq });
    assert.equal(polled.notices.length, 1);
    assert.equal(polled.notices[0]!.channel, "page");
    assert.equal(polled.notices[0]!.notice.route, `/projects/${PROJECT}`);
  });

  test("an open tab with browser permission takes the notice; a silent tab expires back to the OS", async () => {
    const root = fixture();
    const { instance, sent } = notifier(root);
    await instance.update({ enabled: true });
    instance.presence({ tab: "tab-bbbbbbbb", focused: false, browser: "granted" });
    append(root, cliEnd({ step: "build", error: "X", alias: "a1" }));
    const browser = await instance.scan();
    assert.equal(browser[0]!.channel, "browser");
    assert.equal(sent.length, 0);
    clock += 80_000;
    append(root, cliEnd({ step: "build", error: "X", alias: "a2" }));
    const os = await instance.scan();
    assert.equal(os[0]!.channel, "os");
    assert.equal(sent.length, 1);
    instance.presence({ tab: "tab-bbbbbbbb", focused: true, browser: "granted" });
    instance.presence({ tab: "tab-bbbbbbbb", focused: true, browser: "granted", gone: true });
    assert.equal(instance.channel(), "os");
  });
});

describe("console notifications: server routes", () => {
  test("GET /api/notify, POST settings and presence; 501 without a notifier", async () => {
    const root = fixture();
    const { sender } = stubSender();
    const server = await startTestServer(root, { notify: { sender, env: {}, pollMs: 0 } });
    const plain = await startTestServer(root);
    try {
      const auth = { "x-console-token": server.token };
      assert.ok([401, 403].includes((await raw(server.port, { path: "/api/notify" })).status));
      const status = await raw(server.port, { path: "/api/notify", headers: auth });
      assert.equal(status.status, 200);
      assert.deepEqual(status.json().sender, { name: "osascript", clickThrough: false });
      assert.equal(status.json().settings.enabled, false);
      const noCsrf = await raw(server.port, {
        method: "POST",
        path: "/api/notify/settings",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.ok(noCsrf.status === 401 || noCsrf.status === 403);
      const changed = await raw(server.port, {
        method: "POST",
        path: "/api/notify/settings",
        headers: postHeaders(server),
        body: JSON.stringify({ enabled: true, prompted: true, kinds: { job: false } }),
      });
      assert.equal(changed.status, 200, changed.text);
      assert.equal(changed.json().settings.enabled, true);
      assert.equal(changed.json().settings.kinds.job, false);
      assert.equal(readNotifyState(root).settings.kinds.job, false);
      const unknown = await raw(server.port, {
        method: "POST",
        path: "/api/notify/settings",
        headers: postHeaders(server),
        body: JSON.stringify({ volume: 11 }),
      });
      assert.equal(unknown.status, 400);
      const presence = await raw(server.port, {
        method: "POST",
        path: "/api/notify/presence",
        headers: postHeaders(server),
        body: JSON.stringify({ tab: "tab-cccccccc", focused: true, browser: "unsupported" }),
      });
      assert.equal(presence.status, 200, presence.text);
      assert.deepEqual(presence.json(), { ok: true, seq: 0, notices: [] });
      assert.equal(server.notifier?.channel(), "page");
      const missing = await raw(plain.port, { path: "/api/notify", headers: { "x-console-token": plain.token } });
      assert.equal(missing.status, 501);
      assert.equal(missing.json().error, "NOT_IMPLEMENTED");
      // A failed write answers 500 with our own words: no absolute path reaches the page.
      rmSync(notifyStateFile(root), { force: true });
      mkdirSync(notifyStateFile(root), { recursive: true });
      const failed = await raw(server.port, {
        method: "POST",
        path: "/api/notify/settings",
        headers: postHeaders(server),
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(failed.status, 500);
      assert.equal(failed.json().error, "INTERNAL");
      assert.ok(!failed.text.includes(root), failed.text);
      assert.ok(!/\/(Users|home|private|tmp|var)\//.test(failed.text), failed.text);
      const bad = await raw(server.port, {
        method: "POST",
        path: "/api/notify/presence",
        headers: postHeaders(server),
        body: "{not json",
      });
      assert.equal(bad.status, 400);
      assert.ok(!bad.text.includes(root));
    } finally {
      await server.close();
      await plain.close();
    }
    assert.ok(notifyStateFile(root).endsWith(path.join("out", "console", "notify.json")));
  });
});

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { CREDENTIALS_HEADER, CredentialListSchema } from "../src/types/console-credentials";
import { openConsoleBrowser } from "../src/lib/console/browser";
import { issuePairingCode } from "../src/lib/console/pairing";
import { loadOrCreateCredentialSessionToken } from "../src/lib/console/credential-session";
import { readSessionToken } from "../src/lib/console/session";
import { knownSecrets } from "../src/lib/console/snapshot";
import { CREDENTIALS_FILE } from "../src/lib/setup/credential-store";
import { ENV_KEYS } from "../src/lib/setup/keys";
import { makeRoot, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const API = "/api/credentials";
const FAL = "FAL_KEY";
const OLD = "fake-fal-legacy-123";
const NEXT = "fake-fal-console-456";

test("API keys require an independent capability, validate atomic changes, and are applied by new CLI processes", async (t) => {
  for (const name of [FAL, "HIGGSFIELD_API_KEY", "OPENVERSE_CLIENT_ID", "OPENVERSE_CLIENT_SECRET"]) {
    const inherited = process.env[name];
    delete process.env[name];
    if (inherited !== undefined)
      t.after(() => {
        process.env[name] = inherited;
      });
  }
  const root = makeRoot();
  const legacy = `# A user comment\nexport ${FAL}="${OLD}"\nUNRELATED_SETTING="one # two\nthree"\n`;
  const envFile = path.join(root, ".env");
  const managedFile = path.join(root, CREDENTIALS_FILE);
  writeFileSync(envFile, legacy, { mode: 0o600 });
  const logs: string[] = [];
  const server = await startTestServer(root, { log: (line) => logs.push(line) });
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });

  assert.equal(readSessionToken(root), server.token);
  const capability = loadOrCreateCredentialSessionToken(root);
  assert.notEqual(capability, server.token);
  assert.equal(loadOrCreateCredentialSessionToken(root), capability);
  assert.equal(readSessionToken(root), server.token, "existing sessions survive the migration");

  const read = (headers: Record<string, string> = { "x-console-token": server.token }, requestPath = API) =>
    raw(server.port, { path: requestPath, headers });
  const post = (
    value: object | string,
    requestPath = API,
    headers: Record<string, string> = postHeaders(server, { [CREDENTIALS_HEADER]: capability }),
  ) =>
    raw(server.port, {
      method: "POST",
      path: requestPath,
      headers,
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  const save = (revision: string | null, changes: Record<string, string | null>) => post({ revision, changes });
  const reveal = (revision: string | null, name = FAL) => post({ revision, name }, API + "/reveal");

  assert.equal((await read({})).status, 403);
  const ordinary = await read();
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers["cache-control"], "no-store");
  assert.equal(CredentialListSchema.parse(ordinary.json()).editable, false);
  assert.equal(ordinary.text.includes(OLD), false);
  const ownerList = await read(headersForTest(server.token, capability));
  const initial = CredentialListSchema.parse(ownerList.json());
  assert.equal(initial.editable, true);
  assert.equal(initial.revision, null);
  assert.deepEqual(
    initial.keys.map((key) => key.name),
    ENV_KEYS.map((key) => key.name),
  );
  assert.ok(initial.keys.every((key) => new URL(key.signup).protocol === "https:"));
  assert.equal(ownerList.text.includes(OLD), false);

  const pair = await post({ code: issuePairingCode(root) }, "/api/session/pair", {
    Origin: server.origin,
    "Content-Type": "application/json",
  });
  assert.equal(pair.status, 200);
  assert.deepEqual(pair.json(), { ok: true, token: server.token });
  const cookie = pair.headers["set-cookie"]![0]!.split(";")[0]!;
  assert.equal((await raw(server.port, { path: API, headers: { Cookie: cookie } })).status, 403);
  assert.equal((await post({ revision: null, name: FAL }, API + "/reveal", postHeaders(server))).status, 403);
  assert.equal((await post({ revision: null, changes: { [FAL]: NEXT } }, API, postHeaders(server))).status, 403);
  assert.equal(
    (
      await post(
        { revision: null, name: FAL },
        API + "/reveal",
        postHeaders(server, { [CREDENTIALS_HEADER]: server.token }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        { revision: null, name: FAL },
        API + "/reveal",
        postHeaders(server, {
          [CREDENTIALS_HEADER]: capability,
          Origin: "https://example.org",
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post({ revision: null, name: FAL }, API + "/reveal", {
        ...headersForTest(server.token, capability),
        "Content-Type": "application/json",
      })
    ).status,
    403,
  );

  const revealed = await reveal(null);
  assert.equal(revealed.headers["cache-control"], "no-store");
  assert.deepEqual(revealed.json(), { ok: true, value: OLD });
  assert.equal((await reveal(null, "PATH")).status, 400);
  assert.equal((await read(headersForTest(server.token, capability), API + "?reveal=1")).status, 400);

  const malformed = await post(`not JSON ${NEXT}`);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.text.includes(NEXT), false);
  const invalidChanges: Record<string, string | null>[] = [
    { NODE_OPTIONS: NEXT },
    { [FAL]: NEXT + "\nNODE_OPTIONS=" },
    { [FAL]: "a".repeat(2049) },
    {},
  ];
  for (const changes of invalidChanges) {
    const invalid = await save(null, changes);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.text.includes(NEXT), false);
  }
  assert.equal((await save(null, { HIGGSFIELD_API_KEY: NEXT })).json().error, "HIGGSFIELD_CREDENTIAL");
  assert.equal((await save(null, { OPENVERSE_CLIENT_SECRET: NEXT })).json().error, "OPENVERSE_CREDENTIALS");
  assert.equal(existsSync(managedFile), false);

  const concurrent = await Promise.all([
    save(null, { [FAL]: NEXT, OPENVERSE_CLIENT_ID: "example-client", OPENVERSE_CLIENT_SECRET: "example-secret" }),
    save(null, { [FAL]: NEXT, OPENVERSE_CLIENT_ID: "example-client", OPENVERSE_CLIENT_SECRET: "example-secret" }),
  ]);
  assert.deepEqual(concurrent.map((reply) => reply.status).sort(), [200, 409]);
  for (const reply of concurrent) assert.equal(reply.text.includes(NEXT), false);
  const updated = CredentialListSchema.parse(concurrent.find((reply) => reply.status === 200)!.json());
  assert.ok(updated.revision);
  if (process.platform !== "win32") assert.equal(statSync(managedFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(envFile, "utf8"), legacy);
  assert.equal((await reveal(null)).status, 409);
  assert.deepEqual((await reveal(updated.revision)).json(), { ok: true, value: NEXT });
  for (const secret of [capability, server.token, NEXT, OLD]) assert.ok(knownSecrets(root).includes(secret));

  const exec = promisify(execFile);
  const checkout = path.resolve(import.meta.dirname, "..");
  const cli = async (source: string, dotenvFlag = "0") => {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(checkout, "node_modules/tsx/dist/loader.mjs")).href,
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, AGENTBROS_NO_DOTENV: dotenvFlag, AGENTBROS_EVENTS: "off", [FAL]: OLD },
      },
    );
    assert.equal((stdout + stderr).includes(NEXT), false);
    assert.equal((stdout + stderr).includes(OLD), false);
    return JSON.parse(stdout).metadata;
  };
  const probe = `import { runScript } from ${JSON.stringify(pathToFileURL(path.join(checkout, "src/lib/cli/index.ts")).href)};
    runScript(async () => ({metadata: {
      current: process.env.FAL_KEY === ${JSON.stringify(NEXT)} ? "new" : process.env.FAL_KEY ? "inherited" : "unset",
      companion: Boolean(process.env.OPENVERSE_CLIENT_ID && process.env.OPENVERSE_CLIENT_SECRET),
    }}));`;
  assert.deepEqual(await cli(probe), { current: "new", companion: true });
  assert.deepEqual(await cli(probe, "1"), { current: "inherited", companion: false });

  assert.equal((await save(updated.revision, { OPENVERSE_CLIENT_ID: null })).status, 400);
  const removed = CredentialListSchema.parse(
    (
      await save(updated.revision, {
        [FAL]: null,
        OPENVERSE_CLIENT_ID: null,
        OPENVERSE_CLIENT_SECRET: null,
      })
    ).json(),
  );
  assert.deepEqual((await reveal(removed.revision)).json(), { ok: true, value: null });
  assert.deepEqual(await cli(probe), { current: "unset", companion: false });
  assert.equal(readFileSync(envFile, "utf8"), legacy);
  for (const value of [OLD, NEXT, capability]) assert.equal(logs.join("\n").includes(value), false);
});

const headersForTest = (token: string, capability?: string): Record<string, string> => ({
  "x-console-token": token,
  ...(capability ? { [CREDENTIALS_HEADER]: capability } : {}),
});

test("the credential store rejects unsafe file types, permissions, and unknown stored variables", async (t) => {
  const root = makeRoot();
  const server = await startTestServer(root);
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });
  const file = path.join(root, CREDENTIALS_FILE);
  const target = path.join(root, "unrelated-file");
  const content = JSON.stringify({
    version: 1,
    revision: "a1b2c3d4-abcd-4321-aabc-000000000000",
    values: { [FAL]: NEXT },
  });
  writeFileSync(target, content, { mode: 0o600 });
  const request = () => raw(server.port, { path: API, headers: headersForTest(server.token) });
  const rejected = async () => {
    const response = await request();
    assert.ok(response.status >= 400);
    assert.equal(response.text.includes(NEXT), false);
  };
  if (process.platform !== "win32") {
    symlinkSync(target, file);
    await rejected();
    unlinkSync(file);
    linkSync(target, file);
    await rejected();
    unlinkSync(file);
    writeFileSync(file, content, { mode: 0o644 });
    chmodSync(file, 0o644);
    await rejected();
    chmodSync(file, 0o600);
  }
  writeFileSync(file, content.replace(FAL, "NODE_OPTIONS"), { mode: 0o600 });
  await rejected();
  writeFileSync(file, content);
  assert.equal((await request()).status, 200);
  assert.equal(readFileSync(target, "utf8"), content);
});

test("the key editor launches through the OS without granting its capability to the requesting tab", async (t) => {
  const root = makeRoot();
  const launched: URL[] = [];
  const server = await startTestServer(root, {
    openBrowser: async (url) => {
      launched.push(new URL(url));
    },
  });
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });

  const endpoint = `${API}/open`;
  const session = await raw(server.port, {
    path: "/api/session/pair",
    method: "POST",
    headers: { Origin: server.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issuePairingCode(root) }),
  });
  assert.equal(session.status, 200);
  const { token } = session.json();
  const headers = postHeaders(server, { "x-console-token": token });
  const open = (headers: Record<string, string>, body = "{}", requestPath = endpoint) =>
    raw(server.port, { path: requestPath, method: "POST", headers, body });

  assert.equal((await open({ Origin: server.origin, "Content-Type": "application/json" })).status, 403);
  assert.equal((await open({ ...headers, Origin: "https://example.org" })).status, 403);
  assert.equal((await open({ ...headers, Host: "example.org" })).status, 403);
  assert.equal((await open(headers, JSON.stringify({ url: "https://example.org" }))).status, 400);
  assert.equal((await open(headers, "{}", `${endpoint}?url=https://example.org`)).status, 400);
  assert.equal((await raw(server.port, { path: endpoint, headers })).status, 404);
  assert.equal(launched.length, 0);

  const replies = await Promise.all([open(headers), open(headers)]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 429]);
  const success = replies.find((reply) => reply.status === 200)!;
  assert.deepEqual(success.json(), { ok: true });
  assert.equal(success.headers.location, undefined);
  assert.equal(success.headers["set-cookie"], undefined);
  assert.equal(launched.length, 1);
  const url = launched[0]!;
  assert.equal(url.origin, server.origin);
  assert.equal(url.pathname, "/");
  assert.ok(url.searchParams.get("credential-launch"));
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get("token"), token);
  assert.equal(fragment.get("view"), "api-keys");
  const capability = fragment.get("credentials");
  assert.match(capability ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(capability, token);
  assert.equal(success.text.includes(capability!), false);
  assert.equal(url.search.includes(capability!), false);

  const list = (headers: Record<string, string>) => raw(server.port, { path: API, headers });
  assert.equal((await list(headers)).json().editable, false);
  assert.equal((await list({ ...headers, [CREDENTIALS_HEADER]: capability! })).json().editable, true);
});

test("the key editor sanitises launcher errors and allows a retry", async (t) => {
  const root = makeRoot();
  let launches = 0;
  const server = await startTestServer(root, {
    openBrowser: async (url) => {
      if (++launches === 1) throw new Error(url);
    },
  });
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });
  const open = () =>
    raw(server.port, { method: "POST", path: `${API}/open`, headers: postHeaders(server), body: "{}" });
  const failure = await open();
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.json(), {
    ok: false,
    error: "BROWSER_UNAVAILABLE",
    message: "Could not open the default browser.",
  });
  assert.equal((await open()).status, 200);
});

test("the browser launcher handles nonzero exit after spawning and uses a restricted child environment", async () => {
  const fakeUrl = "http://127.0.0.1:4317/#example";
  const launch = (status: number) =>
    openConsoleBrowser(fakeUrl, (_command, args, options) => {
      assert.equal(args.at(-1), fakeUrl);
      assert.equal(options.shell, false);
      for (const name of [FAL, "NODE_OPTIONS", "BROWSER", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"])
        assert.equal(Object.hasOwn(options.env ?? {}, name), false);
      return spawn(process.execPath, ["-e", `process.exit(${status})`], { stdio: "ignore" });
    });
  await launch(0);
  await assert.rejects(launch(3), { message: "Could not open the default browser." });
});

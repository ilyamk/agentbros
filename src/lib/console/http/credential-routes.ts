import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  CREDENTIALS_HEADER,
  CredentialRevealSchema,
  CredentialSaveSchema,
  type CredentialList,
} from "../../../types/console-credentials";
import { readJsonBody } from "../../local-server/body";
import { badRequest, forbidden, HttpError, sendJson } from "../../local-server/errors";
import { headerValue, tokensEqual } from "../../local-server/security";
import {
  CREDENTIALS_FILE,
  isCredentialName,
  readManagedCredentials,
  settingsEnvironment,
} from "../../setup/credential-store";
import { ENV_KEYS, keyStatuses } from "../../setup/keys";
import { writeFileAtomic } from "../control";
import { withFileLock } from "../file-lock";
import { readCredentialSessionToken } from "../session";

async function body<T extends z.ZodType>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  try {
    return schema.parse(await readJsonBody(req));
  } catch {
    throw badRequest("Invalid credentials request.", "VALIDATION");
  }
}

const EmptyRequest = z.strictObject({});

type ManagedCredentials = ReturnType<typeof readManagedCredentials>;

function effectiveEnvironment(legacy: NodeJS.ProcessEnv, { values }: ManagedCredentials): NodeJS.ProcessEnv {
  return {
    ...legacy,
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value ?? undefined])),
  };
}

function list(legacy: NodeJS.ProcessEnv, managed: ManagedCredentials, editable: boolean): CredentialList {
  return {
    ok: true,
    editable,
    revision: managed.revision,
    keys: keyStatuses(effectiveEnvironment(legacy, managed)).map(({ name, service, signup, state }) => ({
      name,
      service,
      signup: signup.split(" ")[0]!,
      state,
    })),
  };
}

function assertRevision(expected: string | null, current: ManagedCredentials): void {
  if (expected !== current.revision)
    throw new HttpError(409, "CONFLICT", "API keys changed in another tab. Cancel to load the current settings.");
}

export async function handleCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  root: string,
  openEditor: () => Promise<void>,
): Promise<boolean> {
  if (segments[0] !== "api" || segments[1] !== "credentials") return false;
  if (query.size) throw badRequest("Credentials requests take no query.");
  const method = req.method;
  if (method === "POST" && segments.length === 3 && segments[2] === "open") {
    await body(req, EmptyRequest);
    await openEditor();
    sendJson(res, 200, { ok: true });
    return true;
  }
  const reveal = method === "POST" && segments.length === 3 && segments[2] === "reveal";
  const save = method === "POST" && segments.length === 2;
  const read = (method === "GET" || method === "HEAD") && segments.length === 2;
  if (!read && !save && !reveal) return false;
  const owner = readCredentialSessionToken(root);
  const editable = owner !== undefined && tokensEqual(headerValue(req, CREDENTIALS_HEADER), owner);
  if (!read && !editable) throw forbidden("Open the console in your own browser to manage API keys.");
  if (read) {
    sendJson(res, 200, list(settingsEnvironment(root, process.env), readManagedCredentials(root), editable));
  } else if (reveal) {
    const request = await body(req, CredentialRevealSchema);
    if (!isCredentialName(request.name)) throw badRequest("Unknown credential.", "VALIDATION");
    const managed = readManagedCredentials(root);
    assertRevision(request.revision, managed);
    const value = effectiveEnvironment(settingsEnvironment(root, process.env), managed)[request.name] || null;
    sendJson(res, 200, { ok: true, value });
  } else {
    const request = await body(req, CredentialSaveSchema);
    const names = Object.keys(request.changes);
    if (names.some((name) => !isCredentialName(name))) throw badRequest("Unknown credential.", "VALIDATION");
    const file = path.join(root, CREDENTIALS_FILE);
    const response = withFileLock(
      file + ".lock",
      () => {
        const current = readManagedCredentials(root);
        assertRevision(request.revision, current);
        const legacy = settingsEnvironment(root, process.env);
        const next = { revision: randomUUID(), values: { ...current.values, ...request.changes } };
        const statuses = keyStatuses(effectiveEnvironment(legacy, next));
        const affected = new Set(
          names.flatMap((name) => [name, ...(ENV_KEYS.find((key) => key.name === name)?.pairedWith ?? [])]),
        );
        if (statuses.some((key) => affected.has(key.name) && key.state === "malformed"))
          throw badRequest("Higgsfield requires an ID and secret separated by a colon.", "HIGGSFIELD_CREDENTIAL");
        if (statuses.some((key) => affected.has(key.name) && key.state === "incomplete"))
          throw badRequest("Openverse requires both the client ID and client secret.", "OPENVERSE_CREDENTIALS");
        writeFileAtomic(file, JSON.stringify({ version: 1, ...next }) + "\n", 0o600);
        return list(legacy, next, true);
      },
      { waitMs: 500, staleMs: 10_000, what: "API credentials" },
    );
    sendJson(res, 200, response);
  }
  return true;
}

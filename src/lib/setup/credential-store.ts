import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import {
  CredentialNameSchema,
  CredentialsRevisionSchema,
  CredentialValueSchema,
} from "../../types/console-credentials";
import { ENV_KEYS } from "./keys";

export const CREDENTIALS_FILE = ".env.console.json";
const FILE_LIMIT = 64 * 1024;
const managedSchema = z.strictObject({
  version: z.literal(1),
  revision: CredentialsRevisionSchema.unwrap(),
  values: z.record(CredentialNameSchema, CredentialValueSchema.nullable()),
});

export function isCredentialName(name: string): boolean {
  return ENV_KEYS.some((key) => key.name === name);
}

function readCredentialFile(file: string, maxBytes: number, privateFile: boolean): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (privateFile ? constants.O_NOFOLLOW : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const privateMode =
      stat.nlink <= 1 &&
      (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()));
    if (!stat.isFile() || stat.size > maxBytes || (privateFile && !privateMode)) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new Error();
    return bytes.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

export function readManagedCredentials(root: string): {
  revision: string | null;
  values: Record<string, string | null>;
} {
  try {
    const text = readCredentialFile(path.join(root, CREDENTIALS_FILE), FILE_LIMIT, true);
    if (text === undefined) return { revision: null, values: {} };
    const data = managedSchema.parse(JSON.parse(text));
    if (Object.keys(data.values).some((key) => !isCredentialName(key))) throw new Error();
    return data;
  } catch {
    throw new Error("The Studio Console credentials file is invalid or has unsafe permissions.");
  }
}

export function credentialFilesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true"].includes((env.AGENTBROS_NO_DOTENV ?? "").toLowerCase());
}

/** Called by each CLI after it loads its ordinary environment. A saved null suppresses a legacy key. */
export function applyManagedCredentials(env: NodeJS.ProcessEnv, root = process.cwd()): NodeJS.ProcessEnv {
  if (credentialFilesDisabled(env)) return env;
  const { values } = readManagedCredentials(root);
  for (const [name, value] of Object.entries(values)) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Settings read just registry values. This never loads unrelated .env entries into the server's environment. */
export function settingsEnvironment(root: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let fileEnv: NodeJS.ProcessEnv = {};
  try {
    fileEnv = parseEnv(readCredentialFile(path.join(root, ".env"), 1024 * 1024, false) ?? "");
  } catch {
    throw new Error("Could not read the existing .env file.");
  }
  return Object.fromEntries(ENV_KEYS.map(({ name }) => [name, base[name] ?? fileEnv[name]]));
}

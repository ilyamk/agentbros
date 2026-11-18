import { randomUUID } from "node:crypto";
import { newToken } from "../local-server/security";
import { writeFileAtomic } from "./control";
import { withFileLock } from "./file-lock";
import { loadOrCreateSessionToken, readCredentialSessionToken, sessionPath } from "./session";

/** An independent capability that is issued only to the browser opened through the OS. */
export function loadOrCreateCredentialSessionToken(rootDir: string): string {
  const file = sessionPath(rootDir);
  return withFileLock(
    file + ".lock",
    () => {
      const token = loadOrCreateSessionToken(rootDir);
      const existing = readCredentialSessionToken(rootDir);
      if (existing) return existing;
      const credentialsToken = newToken();
      writeFileAtomic(file, JSON.stringify({ v: 1, token, credentialsToken }) + "\n", 0o600);
      return credentialsToken;
    },
    { waitMs: 1000, staleMs: 10_000, what: "console session" },
  );
}

/** A separate navigation also works when the browser reuses an existing console tab. */
export function credentialBrowserUrl(rootDir: string, session: string, editor = false): string {
  const url = new URL(session);
  url.searchParams.set("credential-launch", randomUUID());
  url.hash += `&credentials=${loadOrCreateCredentialSessionToken(rootDir)}${editor ? "&view=api-keys" : ""}`;
  return url.href;
}

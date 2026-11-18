/** Copyright, licence and version shown in the sidebar footer and the Settings "About and licence" card. */
import { version } from "../../../package.json";
import { GITHUB_URL } from "../../../src/lib/console/github-schema";

export const APP_VERSION: string = version;
export const COPYRIGHT_YEAR = "2026";
export const AUTHOR = { name: "ILIA_AGI", url: "https://x.com/ILIA_AGI" } as const;
export const LICENCE_ID = "BUSL-1.1";

const REPOSITORY = GITHUB_URL;

/** A file of the repository on GitHub. */
export function repositoryFile(path: string): string {
  return `${REPOSITORY}/blob/main/${path}`;
}

export const LICENCE_URL = repositoryFile("LICENSE");

/** The licence documents listed in Settings, keyed by their label in `d.about.documents`. */
export const LICENCE_DOCUMENTS = [
  ["licence", "LICENSE"],
  ["notice", "NOTICE.md"],
  ["commercial", "COMMERCIAL-LICENSE.md"],
  ["trademarks", "TRADEMARKS.md"],
  ["credits", "CREDITS.md"],
  ["dependencies", "DEPENDENCY_LICENCES.md"],
] as const;

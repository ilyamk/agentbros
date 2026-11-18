/**
 * URL shapes of the console server (RFC 0004 §9.1), free of `node:*` imports so the UI bundle may copy or import them.
 *
 * - Media: `/media/<project>/<path>` serves `public/projects/<project>/<path>`; `/media/<project>/@out/<path>` serves
 *   `out/<project>/<path>` (a {@link MediaRefLike} with `root: "out"`).
 * - Thumbnails: the same tail under `/thumb/`, with `?t=<seconds>&w=<pixels>`.
 * - The session URL is `http://127.0.0.1:<port>/#token=<hex>`, plus `&project=<id>` when a project is named and
 *   `&view=timeline|history` to open that project page (the canvas otherwise).
 */
export const OUT_PREFIX = "@out";

export interface MediaRefLike {
  root?: "project" | "out";
  path: string;
}

const encodePath = (relative: string) => relative.split("/").map(encodeURIComponent).join("/");

const tail = (project: string, ref: MediaRefLike) =>
  `${encodeURIComponent(project)}/${ref.root === "out" ? `${OUT_PREFIX}/` : ""}${encodePath(ref.path)}`;

export const mediaUrl = (project: string, ref: MediaRefLike) => `/media/${tail(project, ref)}`;

export function thumbUrl(project: string, ref: MediaRefLike, options: { t?: number; w?: number } = {}) {
  const query = new URLSearchParams();
  if (options.t !== undefined) query.set("t", String(options.t));
  if (options.w !== undefined) query.set("w", String(options.w));
  const search = query.toString();
  return `/thumb/${tail(project, ref)}${search ? `?${search}` : ""}`;
}

/** Project pages a session URL may open besides the canvas (`&view=`); the console accepts only these. */
export const SESSION_VIEWS = ["timeline", "history"] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];

/** The URL a person opens: the token travels in the fragment, which never reaches the server or its logs. */
export function sessionUrl(origin: string, token: string, project?: string, view?: SessionView) {
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return `${base}#token=${token}${project ? `&project=${encodeURIComponent(project)}${view ? `&view=${view}` : ""}` : ""}`;
}

/**
 * What `pnpm console` prints (D15): the token URL only to a terminal or with `--print-token`; otherwise a one-use
 * pairing URL (`pairUrl`, pairing.ts) when one could be issued, else the bare page URL (`<base>#/projects/<id>`).
 */
export function printableConsoleUrl(
  started: { url: string; baseUrl: string },
  options: { project?: string; printToken?: boolean; isTTY?: boolean; pairUrl?: () => string },
): { url: string; tokenInUrl: boolean } {
  const tokenInUrl = options.printToken === true || options.isTTY === true;
  if (tokenInUrl) return { url: started.url, tokenInUrl };
  try {
    if (options.pairUrl) return { url: options.pairUrl(), tokenInUrl };
  } catch {
    // no pairing code: the bare URL
  }
  const project = options.project ? `#/projects/${encodeURIComponent(options.project)}` : "";
  return { url: `${started.baseUrl}${project}`, tokenInUrl };
}

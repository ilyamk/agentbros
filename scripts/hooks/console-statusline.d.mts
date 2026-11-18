/** Types of console-statusline.mjs (plain Node, run by Claude Code's statusLine; RFC 0004 D1, WP15). */
export interface StatusCounts {
  waiting: number;
  paused: number;
  source: "server" | "files";
}
export declare const BUDGET_MS: number;
export declare const SERVER_TIMEOUT_MS: number;
export declare function budgetMs(env?: Record<string, string | undefined>): number;
export declare function liveConsole(root: string): { port: number; token: string } | undefined;
export declare function fromServer(
  live: { port: number; token: string },
  timeoutMs?: number,
): Promise<StatusCounts | undefined>;
export declare function fromFiles(root: string, deadline: number, now?: Date): StatusCounts;
export declare function statusLine(
  root: string | undefined,
  options?: { started?: number; server?: { port: number; token: string } | null; budget?: number },
): Promise<string>;

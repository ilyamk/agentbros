import { entry, eventData, integer, prNumbers, upsertComment, type Comment, type GitHub } from "./api";
import { claAuthors, claExempt, signatures, type Pull, type Signature } from "./gh-pr-facts";

/** The exact statement CLA.md ("How to sign") asks signers to post; cla.yml filters comments on its prefix. */
export const CLA_STATEMENT = "I have read the CLA and I agree to it.";
export const SIGNATURE_ATTEMPT = /^I have read the (?:CLA|Individual Contributor Licence Agreement)\b/i;
export class ClaRefusal extends Error {}
/** Short form: the CLA.md statement, bound at recording time to the current CLA.md. Long form: names a commit whose CLA.md must match the current one. */
export function parseSignature(body: string, login: string): { name: string; claCommit?: string } | undefined {
  if (body.trim().replace(/\.$/, "").toLowerCase() === CLA_STATEMENT.replace(/\.$/, "").toLowerCase())
    return { name: login };
  const match =
    /^I have read the Individual Contributor Licence Agreement in CLA\.md at commit ([a-f\d]{40}) and I agree to it\r?\nfor this and all my future Contributions to (?:Agent Bros\. Pictures|AgentBros)\.\r?\nName: ([^\r\n]{2,200})\r?\nGitHub or Git username: @?([\w-]+)\s*$/i.exec(
      body.trim(),
    );
  if (!match || match[3]!.toLowerCase() !== login.toLowerCase() || /[<>]/.test(match[2]!)) return undefined;
  return { claCommit: match[1]!.toLowerCase(), name: match[2]!.trim() };
}
export async function recordSignature(api: GitHub, comment: Comment): Promise<boolean> {
  if (comment.user.type === "Bot") return false;
  const signature = parseSignature(comment.body, comment.user.login);
  if (!signature) {
    if (SIGNATURE_ATTEMPT.test(comment.body.trim()))
      throw new ClaRefusal(`Not recorded: post exactly \`${CLA_STATEMENT}\` as its own comment from your own account.`);
    return false;
  }
  const repository = await api.call<{ default_branch: string }>("");
  const ref = await api.call<{ object: { sha: string } }>(
    `/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
  );
  // Bind acceptance to the CLA text, not to a moving branch head: any commit carrying the current CLA.md blob is the same agreement.
  const current = await api.content("CLA.md", ref.object.sha);
  if (!current) throw new ClaRefusal("Not recorded: the default branch has no CLA.md.");
  if (!signature.claCommit && !current.text.includes(CLA_STATEMENT))
    throw new ClaRefusal(
      "Not recorded: CLA.md no longer contains this signing statement; follow its current instructions.",
    );
  if (signature.claCommit && (await api.content("CLA.md", signature.claCommit))?.sha !== current.sha)
    throw new ClaRefusal(
      `Not recorded: CLA.md changed after the named commit. Post \`${CLA_STATEMENT}\` to accept the current text.`,
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const registry = await signatures(api);
    if (registry.signatures.some((item) => item.login.toLowerCase() === comment.user.login.toLowerCase())) return true;
    const added: Signature = {
      login: comment.user.login,
      name: signature.name,
      claCommit: signature.claCommit ?? ref.object.sha.toLowerCase(),
      claBlob: current.sha,
      commentId: comment.id,
      signedAt: comment.created_at,
    };
    try {
      await api.call("/contents/signatures.json", "PUT", {
        message: `Record CLA acceptance for ${comment.user.login}`,
        branch: "cla-signatures",
        ...(registry.sha ? { sha: registry.sha } : {}),
        content: Buffer.from(
          JSON.stringify({ version: 1, signatures: [...registry.signatures, added] }, null, 2) + "\n",
        ).toString("base64"),
      });
      return true;
    } catch (error) {
      if (
        !(error instanceof Error && "details" in error && (error.details as { status?: number })?.status === 409) ||
        attempt === 2
      )
        throw error;
    }
  }
  return false;
}
export async function verifyCla(api: GitHub, number: number) {
  const pr = await api.call<Pull>(`/pulls/${number}`);
  const contributors = await claAuthors(api, pr);
  const registry = await signatures(api);
  const missing = contributors.authors.filter(
    (login) =>
      !claExempt(api, login) && !registry.signatures.some((signature) => signature.login.toLowerCase() === login),
  );
  const ok = !missing.length && !contributors.unresolved.length;
  await upsertComment(
    api,
    number,
    "<!-- agentbros:cla -->",
    ok
      ? "CLA signed by the PR author and all identified co-authors."
      : `CLA pending. Missing signatures: ${missing.join(", ") || "none"}. Unresolved commit/co-author identities: ${contributors.unresolved.length}. Each human signs once by posting exactly \`${CLA_STATEMENT}\` as a comment on this PR.`,
  );
  return { ok, missing, unresolvedCount: contributors.unresolved.length };
}
export async function rerunIntake(api: GitHub, number: number): Promise<void> {
  const pr = await api.call<Pull>(`/pulls/${number}`);
  for (const workflow of ["pr-intake.yml", "cla.yml"]) {
    const runs = await api.call<{
      workflow_runs: {
        id: number;
        head_sha: string;
        event: string;
        status: string;
        conclusion: string;
        pull_requests: { number: number }[];
      }[];
    }>(`/actions/workflows/${workflow}/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`);
    for (const run of runs.workflow_runs
      .filter((run) => run.head_sha === pr.head.sha && run.event === "pull_request")
      .sort((a, b) => b.id - a.id)) {
      if (
        !run.pull_requests.some((item) => item.number === pr.number) &&
        (run.pull_requests.length || !(await prNumbers(api, { run: run.id })).includes(pr.number))
      )
        continue;
      if (run.status === "completed" && run.conclusion !== "success")
        await api.call(`/actions/runs/${run.id}/rerun`, "POST");
      break;
    }
  }
}
entry(import.meta.url, async (api, args) => {
  const event = eventData(args) as {
    action?: string;
    issue?: { number: number; pull_request?: unknown };
    comment?: { id: number };
    sender?: { login: string };
  };
  if (event.action !== "created" || !event.comment || !event.issue?.pull_request) return { ignored: true };
  const comment = await api.call<Comment>(`/issues/comments/${integer(event.comment.id)}`);
  if (comment.user.login !== event.sender?.login) throw new Error("Comment actor mismatch");
  let recorded: boolean;
  try {
    recorded = await recordSignature(api, comment);
  } catch (error) {
    if (!(error instanceof ClaRefusal)) throw error;
    // A refused signature is answered on the PR rather than failing silently in the workflow log.
    await upsertComment(
      api,
      integer(event.issue.number),
      "<!-- agentbros:cla-refusal -->",
      `@${comment.user.login}: ${error.message}`,
    );
    return { recorded: false, refused: error.message };
  }
  const result = await verifyCla(api, integer(event.issue.number));
  if (recorded && result.ok) await rerunIntake(api, integer(event.issue.number));
  return { recorded, ...result };
});

import agentCoauthorsJson from "../../../contrib/agent-coauthors.json";
import { AgentCoauthorsFileSchema, type AgentCoauthorsFile } from "../../types/contrib";

/** Agents cannot sign (CLA, "Contributions made with automated agents"): their co-author trailers are the submitting human's Contribution. */
export const AGENT_COAUTHORS: AgentCoauthorsFile = AgentCoauthorsFileSchema.parse(agentCoauthorsJson);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether a co-author email is a listed agent identity: an exact email, or a listed login's users.noreply address (any numeric id prefix); case-insensitive. */
export function agentCoauthorMatcher(file: AgentCoauthorsFile = AGENT_COAUTHORS): (email: string) => boolean {
  const emails = new Set(file.agents.flatMap((agent) => agent.emails));
  const logins = file.agents.flatMap((agent) => agent.githubLogins ?? []);
  const noreply = logins.length
    ? new RegExp(`^(?:\\d+\\+)?(?:${logins.map(escape).join("|")})@users\\.noreply\\.github\\.com$`, "i")
    : undefined;
  return (email) => {
    const value = email.trim().toLowerCase();
    return emails.has(value) || Boolean(noreply?.test(value));
  };
}
export const isAgentCoauthor = agentCoauthorMatcher();

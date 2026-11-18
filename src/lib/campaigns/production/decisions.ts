import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CampaignDecisionSchema,
  type CampaignProductionPlan,
  type CampaignTask,
} from "../../../types/campaign-production";
import {
  atomicJson,
  digest,
  immutableJson,
  jsonFile,
  productionDirectory,
  scopedFile,
  refuse,
  verifyPin,
} from "./files";

export function decisionFile(root: string, plan: CampaignProductionPlan, task: CampaignTask) {
  return scopedFile(
    root,
    path.join(productionDirectory(root, plan.request.id), "decisions", plan.planHash, `${task.id}.json`),
  );
}
export function currentDecision(root: string, plan: CampaignProductionPlan, task: CampaignTask) {
  const file = decisionFile(root, plan, task);
  if (!existsSync(file)) return null;
  const decision = CampaignDecisionSchema.parse(jsonFile(file));
  if (
    decision.planHash !== plan.planHash ||
    decision.taskId !== task.id ||
    decision.agent !== (task.payload.agentTask as { agent: string }).agent
  )
    refuse("Agent decision identity differs");
  return { file, decision, hash: digest(decision) };
}
export function decisionAttempts(root: string, plan: CampaignProductionPlan, task: CampaignTask, inputHash: string) {
  const current = currentDecision(root, plan, task),
    history = scopedFile(root, path.join(path.dirname(decisionFile(root, plan, task)), "history", task.id));
  const values = existsSync(history)
    ? readdirSync(history)
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) => CampaignDecisionSchema.parse(jsonFile(scopedFile(root, path.join(history, file)))))
    : [];
  if (current) values.push(current.decision);
  return [
    ...new Map(values.filter((value) => value.inputHash === inputHash).map((value) => [digest(value), value])).values(),
  ];
}
export function saveDecision(
  root: string,
  plan: CampaignProductionPlan,
  task: CampaignTask,
  raw: unknown,
  inputHash: string,
) {
  const decision = CampaignDecisionSchema.parse(raw),
    current = currentDecision(root, plan, task);
  if (current?.hash === digest(decision)) return current;
  if ((current && decision.supersedes !== current.hash) || (!current && decision.supersedes))
    refuse("Decision replacement needs the exact superseded decision hash");
  const pendingFile = scopedFile(
    root,
    path.join(path.dirname(decisionFile(root, plan, task)), "history", task.id, `${digest(decision)}.json`),
  );
  const pending =
    existsSync(pendingFile) &&
    digest(CampaignDecisionSchema.parse(jsonFile(scopedFile(root, pendingFile)))) === digest(decision);
  const attempts = decisionAttempts(root, plan, task, inputHash);
  if (!pending && attempts.length >= (plan.request.policy?.maxAgentAttempts ?? 3))
    refuse("Agent attempt limit reached; provide new inputs or revise the plan");
  const signature = (value: typeof decision) => digest({ ...value, supersedes: undefined });
  if (!pending && attempts.some((value) => signature(value) === signature(decision)))
    refuse("Agent made no progress; identical decisions cannot consume another attempt");
  [...decision.evidence, ...decision.outputs, ...(decision.issues ?? []).flatMap((issue) => issue.evidence)].forEach(
    (pin) => verifyPin(root, pin),
  );
  const file = decisionFile(root, plan, task),
    history = scopedFile(root, path.join(path.dirname(file), "history", task.id));
  if (current) immutableJson(path.join(history, `${current.hash}.json`), current.decision);
  immutableJson(path.join(history, `${digest(decision)}.json`), decision);
  atomicJson(file, decision);
  return { file, decision, hash: digest(decision) };
}

export function repairRounds(root: string, plan: CampaignProductionPlan, memberId: string) {
  const directory = scopedFile(root, path.join(productionDirectory(root, plan.request.id), "repairs", plan.planHash));
  return existsSync(directory)
    ? readdirSync(directory).filter(
        (file) => file.startsWith(`${memberId}-`) && /^[a-f0-9]{64}\.json$/.test(file.slice(memberId.length + 1)),
      ).length
    : 0;
}

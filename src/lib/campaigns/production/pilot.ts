import type { CampaignProductionPlan } from "../../../types/campaign-production";
import { packageApproved } from "./review";

export function pilotTaskIds(root: string, plan: CampaignProductionPlan) {
  const members = plan.request.policy?.pilotMemberIds;
  if (!members || packageApproved(root, plan, "pilot-outputs")) return undefined;
  const ids = new Set(
    plan.tasks
      .filter((task) => task.memberId && members.includes(task.memberId) && task.kind !== "delivery")
      .map((task) => task.id),
  );
  const add = (id: string) => {
    for (const dependency of plan.tasks.find((task) => task.id === id)!.dependsOn)
      if (!ids.has(dependency)) {
        ids.add(dependency);
        add(dependency);
      }
  };
  [...ids].forEach(add);
  return ids;
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { revisePolicy, type PolicyChange } from "../src/lib/autonomy/policy";
import { BudgetError, OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT } from "./helpers/ceiling-grant";

const restrictions: { name: string; change: PolicyChange; code: BudgetError["code"] }[] = [
  { name: "provider revocation", change: { budget: { allowedProviders: [] } }, code: "AUTHORITY_REQUIRED" },
  { name: "lowered ceiling", change: { budget: { ceilingUsd: 1, maxJobUsd: 1 } }, code: "BUDGET_EXCEEDED" },
  { name: "lowered per-job limit", change: { budget: { maxJobUsd: 1 } }, code: "BUDGET_EXCEEDED" },
  {
    name: "user-bound quote revocation",
    change: { budget: { allowUserBoundQuotes: false } },
    code: "AUTHORITY_REQUIRED",
  },
];

for (const route of ["admission", "transition", "ambiguous retry", "submitting retry"] as const) {
  for (const restriction of restrictions) {
    test(`${route} respects ${restriction.name} after reservation`, (t) => {
      const directory = mkdtempSync(path.join(tmpdir(), "submission-policy-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      revisePolicy(
        directory,
        "fixture",
        {
          autonomy: "autonomous",
          budget: { ceilingUsd: 10, maxJobUsd: 5, allowedProviders: ["fixture"], allowUserBoundQuotes: true },
        },
        "Spend up to ten dollars with the fixture provider, including bounded quotes.",
      );
      const store = new OperationStore("fixture", { directory: path.join(directory, "pipeline") });
      store.configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
      store.reserveOperation({
        operationId: "reserved",
        provider: "fixture",
        endpoint: "fixture/image",
        inputHash: "fixture",
        assetId: "fixture",
        quote: {
          currency: "USD",
          lowUsd: 2,
          expectedUsd: 2,
          highUsd: 2,
          bounded: true,
          confidence: "user-bound",
          source: "fixture quote",
          asOf: "2026-11-18",
        },
      });
      if (route === "ambiguous retry" || route === "submitting retry") {
        store.transitionJob("reserved", "submitting");
        if (route === "ambiguous retry") store.transitionJob("reserved", "unknown", { error: "Lost response" });
      }
      revisePolicy(directory, "fixture", restriction.change, undefined);
      const before = store.snapshot();
      assert.throws(
        () =>
          route === "transition" || route === "submitting retry"
            ? store.transitionJob("reserved", "submitting")
            : store.admitSubmission("reserved"),
        (error: unknown) => error instanceof BudgetError && error.code === restriction.code,
      );
      assert.deepEqual(store.snapshot(), before, "a refusal must preserve the reservation and attempt count");
      if (route === "ambiguous retry") {
        assert.equal(
          store.transitionJob("reserved", "running", { providerRequestId: "existing-request" }).state,
          "running",
        );
      }
    });
  }
}

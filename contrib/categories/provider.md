# Providers and pricing

## What is valuable

Add a capability required by an existing route through `src/lib/providers/`, `src/lib/apis/` and `src/lib/models/endpoints.json`. Check `src/lib/pricing.ts` and [model routing](../../docs/production-model-routing.md) for an existing fit.

## Not wanted

Unpriced endpoints, guessed sibling prices, direct provider calls outside durable jobs, real credentials in tests or live paid verification.

## Definition of done

Provide dated price evidence, reserve through budget admission before submission, and retain operation ownership through ambiguous retries. Mock submit, poll, resume and failure; follow [library rules](../../src/lib/AGENTS.md).

## Evidence required

Mock lifecycle tests, dated price source and budget-admission/operation-ownership proof; distinguish mocked from live acceptance.

## Gates

- `pnpm typecheck`

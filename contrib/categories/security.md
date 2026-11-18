# Security fixes

## What is valuable

Report vulnerabilities in code, the MCP boundary, provider/budget/job handling or instruction automation through [private reporting](../../SECURITY.md). Include prompt-injection and instruction supply-chain exploits in scope.

## Not wanted

Public disclosure before coordination, public exploit credentials, unapproved exploitation of third-party services or paid verification.

## Definition of done

Agree disclosure and patch scope privately with the maintainer before opening a PR. Add an offline regression test, obtain protected-path approval and avoid exposing the exploit before the coordinated release.

## Evidence required

Private advisory first; share reproduction, impact, affected revision and targeted verification privately. Put only maintainer-approved disclosure details in public evidence.

## Gates

- `pnpm typecheck`
- `pnpm lint`

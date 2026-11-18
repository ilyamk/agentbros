# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/ilyamk/agentbros/security/advisories/new) to send a report to the maintainers. Do not open a public issue, PR or Discussion containing an uncoordinated vulnerability. If private reporting is unavailable, e-mail the maintainer at hello@iliamax.com with the subject "agentbros security"; do not put exploit details in Discussions or any other public place.

Include the affected commit/version, impact, prerequisites, a minimal reproduction and a proposed fix if available. Redact credentials, private media and personal data. Use local fixtures; do not test against other people's accounts or spend money to demonstrate the issue.

## Scope

Report code execution, credential disclosure, path traversal, provider/budget/job ownership failures, MCP permission escapes and unsafe GitHub workflow trust boundaries. Include prompt-injection attacks against triage or agents, malicious instruction/skill updates, instruction supply-chain attacks, and ways to turn untrusted artefacts into privileged execution or paid calls.

Use [SUPPORT.md](SUPPORT.md) for non-security failures. Treat the current default branch as the patch target; identify older affected tags without assuming a backport commitment. Agree disclosure timing and any public patch with the maintainers in the private report. Keep details private until that coordination is complete.

## Verify what you install

- [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/ilyamk/agentbros) rates the repository's supply-chain practices weekly and on every push to `main` (`.github/workflows/scorecard.yml`).
- [CodeQL](https://github.com/ilyamk/agentbros/actions/workflows/codeql.yml) analyses every pull request and `main`; findings appear under the repository's code-scanning alerts.
- Every release carries a source archive with a signed build-provenance attestation, made by `.github/workflows/release.yml` from the merged base revision. Check one before installing from it:

  ```bash
  gh release download v1.2.3 --repo ilyamk/agentbros --pattern 'agentbros-*.tar.gz'
  gh attestation verify agentbros-1.2.3.tar.gz --repo ilyamk/agentbros
  ```

  A passing check proves the archive was built by this repository's release workflow; it does not prove the code is free of defects.
- Workflows pin every action to a full commit and default to no token permissions; `tests/workflows.test.ts` enforces this.

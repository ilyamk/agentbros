# Change entries

Each pull request adds one `.changes/<slug>.md` file for release notes.
Run `pnpm change:add --category fix --bump patch --summary "Describe the fix" --author your-handle --harness codex`.
The command refuses an existing filename. Supply `--slug` to choose another.

Front matter declares `category`, `bump` (`patch`, `minor` or `major`),
`breaking`, `pr` (initially 0), `authors: [handle]`, and optional `harness`.
Add a non-empty `deps:` justification when introducing dependencies.
The body is the release-note summary. Front matter supports scalar values,
inline lists and `#` comments; nested YAML is unsupported.

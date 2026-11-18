# Spine template

Copy to `pipeline/spine.md` when a project starts its first render loop. The spine is the project's memory, so the next attempt starts from what failed instead of repeating it. Read it before each attempt and add to it after.

Write what happened, not what should happen. Keep it short: one line per attempt. If the same failure appears twice, change the rule or sensor, not only the video, and record that here.

```markdown
# Spine: PROJECT_ID

## Goal and stop rule

- **Goal:** the conditions a loop can check, for example "motion:check counters at zero".
- **Stop:** at most N rounds, or two rounds with no progress. Taste goes to the critic and the user.

## Attempts

| # | Date | Changed | Render sha (first 12) | Result |
|---|------|---------|-----------------------|--------|
| 1 | YYYY-MM-DD | what changed, in a few words | abc123def456 | what the checks and frames showed |

## Failures

- **Attempt 1, frame 240:** what was wrong, as seen. Cause, if known; otherwise "cause unknown".

## Rules from failures

- **Rule:** what to do from now on. **From:** attempt 1. **Lives in:** this project, or the skill, sensor or rule file it moved to.
```

A rule that holds beyond this project goes to the file that owns it. A lesson about taste goes to the user's memory (`pnpm memory --add --type lesson`), and only once the user confirms it; `design-reference/creative-lessons.md` takes it only as an approved, generalised proposal.

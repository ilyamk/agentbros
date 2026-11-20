---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
A Dependabot npm bump can carry its regenerated DEPENDENCY_LICENCES.json and .md and still take the Dependabot intake route; before, the inventory CI requires pushed the PR out of that route, so no npm bump could pass both. lucide-react and lucide-static now arrive in one Dependabot PR

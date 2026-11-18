# Third-party skills

Vendored skills recorded in `skills-lock.json`. These folders are not part of the Licensed Work under the Business Source License 1.1 (BUSL-1.1) of Agent Bros. Pictures and are not covered by its commercial licence: each keeps its upstream licence ([NOTICE.md](../../NOTICE.md)). A `computedHash` in `skills-lock.json` is the hash of the upstream install, not of the local edits noted below.

| Skill | Upstream repository | Licence | In the public export |
|---|---|---|---|
| `copywriter` | github.com/sunnypatneedi/claude-starter-kit | CC-BY-SA-4.0 (verified), modified | yes, with `copywriter/LICENSE.md` |
| `ugc-content-creator` | github.com/sunnypatneedi/claude-starter-kit | CC-BY-SA-4.0 (verified), modified | yes, with `ugc-content-creator/LICENSE.md` |
| `remotion-best-practices` | github.com/remotion-dev/skills | none granted (verified) | no: install from upstream |

The seven ElevenLabs API references (`elevenlabs/skills`, MIT) are no longer skills: on 2026-11-16 they moved to [docs/reference/elevenlabs](../../docs/reference/elevenlabs/README.md), which keeps their licences, upstream files, install hashes and local changes. Production speech, music, sound and dubbing go through the repository commands and the budget layer ([audio integrations](../../docs/audio-integrations.md)).

## Licence evidence (checked 2026-11-15)

**Claude starter kit.** Both skills come from `skills/business/{copywriter,ugc-content-creator}/SKILL.md` at commit `b80150280e09b8ac35d9a6e3f79c3d49f491f5ce`, the only commit touching them. The root `LICENSE` (blob `d304c8c`, unchanged from that commit to HEAD) is CC BY-SA 4.0, and `package.json` declares `"license": "CC-BY-SA-4.0"`. It allows sharing and adapting "for any purpose, even commercially", on condition of attribution in the form "Based on Claude Starter Kit by Sunny Patneedi and Contributors (https://github.com/sunnypatneedi/claude-starter-kit) Licensed under CC-BY-SA-4.0", a note of changes, a link to the licence and ShareAlike for adaptations. Each folder's `LICENSE.md` carries that notice and its dated changes. Users and commercial licensees of Agent Bros. Pictures receive these two folders under CC BY-SA 4.0, not under the BUSL-1.1 or the commercial terms.

**Remotion skills.** The vendored `SKILL.md` matches `skills/remotion/SKILL.md` at commit `e9d8ecd5685a0ab1291444f5ad0288a64d053155` (2026-02-20) byte for byte. Neither that commit, `1fc074b7` nor HEAD `7e541aa4` has a licence file; GitHub reports no licence, and `package.json` is `private` with no licence field. It names its source as `remotion-dev/remotion/packages/skills`, which has no licence file either, so the monorepo's root Remotion License applies. That licence grants use for creating videos and forbids copying or modifying Remotion code "for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivate of Remotion"; it grants no right to redistribute. The licence of this repository grants no rights in Remotion (NOTICE.md), so nothing here permits shipping Remotion-authored files. The skill is therefore not included in the public repository; install it from upstream.

To install it from upstream, as its README gives:

```bash
npx skills add remotion-dev/skills
# or
gh skill install remotion-dev/skills
```

Upstream is now a router (`remotion-best-practices`) with sibling skills (`remotion-markup`, `remotion-captions` and others), so a fresh install does not match the older `rules/` copy the maintainers studied.

Removed on 2026-11-11 as irrelevant to video production: `agents`, `setup-api-key` (elevenlabs/skills), `sales-playbook`, `performance-marketing` (sunnypatneedi/claude-starter-kit).

# The replica route

The `replica` type of the [production chain](../production-chain.md): read at rights and the replica steps.

Type `replica` is an exact copy of one given film, only when the user asks to copy it ("in the style of" is any other type with a reference). It runs four steps no other type sees (they are not listed, counted or shown elsewhere) and switches off the creative front, the look, the beat sheet, the animatic, `measure` and the critic. It never joins another type as a hybrid. The [reference replica](../../.agents/skills/reference-replica/SKILL.md) skill is the method.

```
intake             brief-collector    brief                                   [user]
rights             the user           owned, licensed or study-only           [user: film:rights --status --answer]
replica-reference  reference-analyst  ref:add with the rights, --crop auto; every measured and judged layer; targets
replica-spec       reference-analyst  one row per corrected shot, the swaps;  [ref:replica-check passed, then user]
                                      replica-shots.json
music, audio-map   sound-director     the user's track: another owner's music and voice are replaced   [user, by ear]
material           asset-planner      the spec's swaps: the user's real UI, logos, licensed media      [user]
build, sound       motion-engineer,   library blocks at the spec's numbers; the mix on the spec's cues
                   sound-director
replica-compare    script             film:render, ref:compare --tolerance replica --project           [no failed measure; fixer, 5 rounds]
human              the user           verdict                                 [user]
```

Nothing is measured before `pipeline/replica-rights.json` holds the user's words; the reference's `source.json` and the spec's `rights` must repeat them. `replica-spec` passes only when `ref:replica-check`'s result is of this exact spec (`specSha256`), and `replica-compare` only when `ref:compare`'s replica result is of the current render (`renderSha256`) and `summary.withinTolerance` has no `failed`. Findings go to the fixer in severity order; after five rounds the residuals go to the user. Within tolerance is measured close, not approved. A `study-only` answer never becomes production-ready: `film:next` says "Study only, not for publication" at the human step and after it, and the [delivery check](../delivery.md) blocks it.

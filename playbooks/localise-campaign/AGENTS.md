# Campaign localisation

Last updated: 2026-11-16

## Start

Prepare language variants of accepted campaign members. Use [campaign production](../../docs/campaign-production.md) to author the request.

```bash
pnpm campaign:production --project <id> --action plan --request <file>
pnpm campaign:production --project <id> --action init --request <file>
pnpm next --project <id>
```

## What good looks like

Speech and text communicate the intended offer naturally, captions fit the target language, and visual composition remains recognisable without inheriting stale performance timing.

## Method

1. Identify the accepted source variants and pin the source project. List languages, voices, mandatory wording and the reviewer for each language.
2. Supply translations for every scene and label. Use the existing localisation adapter, dubbing or recording workflow according to the source material.
3. Measure replacement speech before finalising scene lengths. Supply matching MP3 files and ordered word alignments; resolve cue anchors from the new performance.
4. Review replacement presenter footage when native embedded speech changes. Rebuild captions and dependent events instead of stretching source timestamps.
5. Obtain language-specific child review and the exact final campaign package. Human listening and linguistic judgement remain explicit evidence.

## Tools

The captions-and-localization skill and the `dubbing` command ([audio integrations](../../docs/audio-integrations.md)) are the existing production tools. campaign:brief passes language-specific evidence to specialists; the queue reuses only language-independent assets.

Validate a long target-language line first. Require matching speech, alignment, terminology and cached glyph coverage before widening the batch; linguistic changes keep the language review gate.

## Anti-patterns

Do not certify a translation from a synthetic tone, preserve obsolete lip movement or assume a short source line guarantees readable translated captions.

## References

[Guide](../../docs/campaign-production.md).

## Done when

All requested languages have current speech, alignment, captions and human review records, with strict delivery acceptance or named remaining blockers.

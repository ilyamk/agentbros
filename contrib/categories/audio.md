# Audio analysis and mixing

## What is valuable

Improve measured dialogue, mix or sync behaviour in `src/lib/audio/` or `src/lib/audio-map/`; keep shared SFX changes to manifests. Use `pnpm audio:analyze --help` and [audio QA](../../docs/local-audio-qa.md) for measurements.

## Not wanted

Claims that something sounds better without human review, an LLM sound verdict, binary SFX commits or arbitrary gain changes without evidence.

## Definition of done

Preserve dialogue intent and deterministic timing; test the measured defect using local synthetic media. Follow [audio rules](../../src/lib/audio/AGENTS.md) and preserve provenance.

## Evidence required

Before/after loudness, peak, drift or other relevant measurements with units and fixture identity; label any human listening evidence separately.

## Gates

- `pnpm typecheck`

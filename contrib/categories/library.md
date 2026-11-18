# Motion library

## What is valuable

Fill a playbook or reference-gap need in `src/motion/library/`; inspect `pnpm library:list` and [the library guide](../../docs/motion-library.md) first. Improve an existing block when its mechanics already fit.

## Not wanted

Re-skins without a new use, blocks no playbook needs, third-party film frames, autonomous animation clocks or unseeded randomness.

## Definition of done

Register the block and props, produce a preview with `pnpm library:preview`, verify frame determinism and novelty, and name its use in a playbook. Preserve `inspiredBy` and source credits.

## Evidence required

Preview artefacts, determinism and `pnpm contrib:novelty --base BASE` evidence against the nearest existing blocks, plus the consuming playbook. For an overlap, add `novelty:` to the change entry naming each existing id and what is new. Record any source and licence.

## Gates

- `pnpm library:catalogue`
- `pnpm lint`
- `pnpm contrib:novelty`

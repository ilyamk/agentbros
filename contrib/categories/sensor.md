# Sensors and validators

## What is valuable

Catch a demonstrated film failure through `src/lib/sensors/`, `src/lib/qa-evidence/` or `src/lib/film/measure.ts`; relate it to `design-reference/slop-catalogue.md`. Use `pnpm ref:degrade --help` to prepare controlled degradation evidence.

## Not wanted

Uncalibrated blocking thresholds, arbitrary score changes, synthetic examples with no film failure or visual judgements presented as sound review.

## Definition of done

Prove degraded references rank below their originals; record sample count and date beside the threshold, or keep it warn-only. Test false positives as well as the failure.

## Evidence required

Degraded-reference ranking, threshold calibration note and fixtures reproducing the observed failure.

## Gates

- `pnpm lint`

# Agent Bros Bench v1

Protocol and commands: [benchmark guide](../docs/benchmark.md).

- `suite.json`: nine public **scaffold** no-spend production tasks, pinned by SHA-256: four production scaffolds (`footage-edit`, `shorts-from-long`, `explainer`, `motion-design`) and five campaign tasks (`campaign-ad-experiments`, `campaign-catalogue-videos`, `campaign-reference-family`, `campaign-localise-campaign`, `campaign-content-series`).
- `instructions/suite.json`: ten small agentic instruction tasks, each with a trusted automatic `check.mjs`.
- `config.json`: three runs minimum, bounded execution, two judge vendors. Funding, models and calibration thresholds remain deliberately undecided. Judging refuses until the maintainer fixes them.
- `answers/`: fixed simulated decisions, supplied verbatim in the harness prompt. They never impersonate human production approval.
- `allowed_signers`: currently authorises nobody (comments only); the maintainer must authorise submitters' registered keys before CI can accept a submission.

**Status (2026-11-17):** no campaign has run. `bench/results/` does not exist yet, both judge slots in `config.json` are unset placeholders and the calibration thresholds are `null`, so the creative (picture-judging) layer has never run and there are no published ratings.

The footage scaffolds use a generated moving test pattern and tone plus an existing synthetic dialogue timing fixture. They do not establish performance on natural recorded speech. Template and motion tasks reuse repository test fixtures as structure, replacing their content. No media binaries are tracked.

Keep v1 task files immutable once a campaign has been registered. A changed task requires new versioned paths and a new suite version; retain old suite manifests for verification. Hidden split manifests stay outside git and are selected explicitly with `--suite`.

The v1 explainer pins the historical `tests/fixtures/legacy/demo/project.json` bytes (SHA-256 `7320b9ed4748e2fdf5869eabf5ddccbfeb720c8cbad41e128edf20f632a459fa`). Its legacy product name is benchmark material, independent of current application branding. Keep this fixture and its compatibility baseline frozen; task, suite and registered campaign pins are unchanged.

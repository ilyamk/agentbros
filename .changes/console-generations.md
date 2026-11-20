---
category: fix
bump: minor
breaking: false
pr: 46
authors: [ilyamk]
harness: claude-code
---

Studio console: a project-level Media tab and paid model generations as content. The Media tab groups every media file of the project in albums by lineage (sources, preparation, generations, builds, not registered), read from the asset registry, job store, model preparations and renders, with each item's player, the file it was made from and an A/B compare; files under footage/ and assets/ that nothing lists appear marked not registered, and copies of a registered file appear as aliases. Its Generations album shows every job of the job store newest first (endpoint, state, the provider's error as written, reserved and settled money, quote, elapsed time, prompt, references) and plays the result once the job is published; the canvas panel shows the running jobs and the newest result with a link there. The Preparation album holds the latest model preparation (prompt, references, board samples, approval in the user's words, rights). The top bar and home card show reserved money beside spent, so a reservation never reads as $0. History folds consecutive identical successful runs (an agent re-running generate:model to resume a queued job) into one row with a count; the journal is unchanged. A project:new template that only holds generations no longer presents the template render as its current step or offers Remotion Studio. Contract: optional view.generations, view.gallery and ProjectSummary.reservedUsd.

The large video view works like an editing table: no rounded frame or dark band, a timeline with a seconds ruler that shows the exact frame and its time to the millisecond under the pointer and seeks to it, a millisecond readout, J/K/L, frame and second stepping, and C to mark the frame. On the frame the user clicks a point (an arrow) or drags an area (a box) and writes words for each; Send to the agent posts a new `frame-note` decision on any route, and `pnpm frame:note` writes the exact frame from the file with the marks drawn on it as `pipeline/frame-notes/<id>.png` plus a JSON note, whose paths `console:wait` returns as `note` and `still`. Contract: decision kind `frame-note`, `FrameComment.marks`, `DecisionRequest.overlay`, `FrameNote`.

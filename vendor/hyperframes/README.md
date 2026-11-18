# Pinned Hyperframes FrameAdapter reference

Unmodified upstream source from HeyGen's Hyperframes repository, revision `9e9b613ccf867f98838617f7424967e056e63de2`, distributed under the accompanying Apache-2.0 LICENSE. Exact upstream paths and SHA256 checksums are recorded in `provenance.json` and verified by tests. The copied scope is only the small GSAP FrameAdapter and its TypeScript interface; it is not the full runtime, player or GSAP library.

The adapter is used for an explicit trusted external HTML asset capture bridge. It is never imported by a Remotion composition. Actual GSAP is an independently licensed, explicitly supplied local runtime; this directory does not distribute or install it. See `docs/html-capture.md` and the Hyperframes native verification record for supported lifecycle, actual browser verification and open full-engine scope.

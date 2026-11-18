/**
 * The preload Remotion Studio runs under (`node --require scripts/studio/loopback.cjs <remotion-cli.js> studio ...`):
 * binds every server of the process to loopback and refuses requests from other sites (loopback-core.cjs).
 */
"use strict";

require("./loopback-core.cjs").install();

/**
 * Shared deadline for child processes that tests spawn (a CLI, a tsx probe, a fake worker). Loaded machines and full
 * parallel runs start tsx slowly, so a few seconds flakes; the default is 30 s and `AGENTBROS_TEST_SPAWN_TIMEOUT_MS` overrides it.
 * Tests that assert a timeout fires keep their own small deadline.
 */
const configured = Number(process.env.AGENTBROS_TEST_SPAWN_TIMEOUT_MS);
export const SPAWN_TIMEOUT_MS = Number.isFinite(configured) && configured > 0 ? configured : 30_000;

// Tracked-data regression gates price against the repository's own price files. Import this FIRST
// (before any src module): the model registry derives API-fallback pricing at module load.
import path from "node:path";

const models = path.resolve(import.meta.dirname, "../../src/lib/models");
process.env.AGENTBROS_FAL_PRICES = path.join(models, "fal-prices.json");
process.env.AGENTBROS_FAL_HISTORICAL_PRICES = path.join(models, "fal-historical-prices.json");
process.env.AGENTBROS_FAL_UNIT_SEMANTICS = path.join(models, "fal-unit-semantics.json");

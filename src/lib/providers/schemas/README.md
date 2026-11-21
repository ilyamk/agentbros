# fal operation schemas

`fal-operations.json` contains 98 public OpenAPI snapshots retrieved on 2026-10-11 via read-only GET; the seven Seedance 2.5 snapshots were refreshed on 2026-11-21 (4k, `output_format`, `task: auto`, 14-day drafts):

`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<URL-encoded exact endpoint>`

Each entry stores normalised routing metadata, source/date, SHA-256 of the original complete response, exact input/output references and component schemas. Descriptions capture constraints not encoded as JSON Schema keywords.

## Validation

`buildFalOperation()` accepts the legacy form (`family`/`variant`/`operation`) or the endpoint form (`{ endpoint, input }`). An endpoint resolves to its snapshot here first; any other endpoint resolves through the catalogue index (`src/lib/models/fal-catalog/`) to the hash-pinned cache `.cache/fal-schemas/<sha256>.json`. A missing cache file fails with `SCHEMA_NOT_CACHED` and names the `fal:sync --schemas <endpoint>` command; realtime or schema-less entries are `UNSUPPORTED_OPERATION`. Catalogue plans carry `family: "catalog"`, `operation: <category>`, the entry's tier, output kinds, retirement and replacement; a gone endpoint is planned but not executable.

The order is: strict schema validation, guard plugins (`providers/fal-guards/`, phase then registration order: reference URLs, family guards, generic warnings), validation again, then media limits.

`providers/json-schema-validate.ts` enforces `$ref`, `type`, `nullable`, `required`, `properties`, `additionalProperties` (strict mode rejects undeclared fields), `minProperties`/`maxProperties`, `anyOf`/`oneOf`/`allOf`, `discriminator` with `mapping` (falls back to plain alternatives for an unmapped tag), `enum`, `const`, `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`, `minLength`/`maxLength`, `pattern`, `format` (`uri`, `date-time`, `date`; others ignored), `items`, `prefixItems`, `minItems`/`maxItems` and `uniqueItems`. File limits in `x-fal` or directly on a field (`min/max_file_size`, `min/max_width`, `min/max_height`, `min/max_duration`, `min/max_fps`, `min/max_pixels`, `min/max_area`, `min/max_aspect_ratio`) are checked only when the request context holds media metadata for that exact URL. Documentation and UI keys are ignored on purpose: `title`, `description`, `examples`, `example`, `default`, `x-fal-order-properties`, `_fal_ui_field`, `field`, `limit_description`, `ui`, `deprecated`, `readOnly`, `writeOnly`. `unsupportedKeywords()` lists anything else in a schema; `tests/fal-validator-keywords.test.ts` requires it to be empty for every recorded fixture. `exampleFromSchema()` builds a minimal valid input from required fields.

98 endpoints: GPT Image 2.5 (4), Nano Banana 2.1 (2), Seedance 2.5 (7), Kling V3 (12), Kling O3 (15), voice companion (1), FLUX inference/LoRA/stream/realtime/training/gallery (57). Queue and training have local operation adapters. Stream/realtime schemas can be inspected/planned; execution uses the dedicated `generate:stream` and `generate:realtime` transports and their separate recovery contracts. Schema-less catalogue realtime entries remain non-executable. None has live verification.

The snapshots are API documentation, not paid generation results. `tests/fixtures/provider-contracts/fal-valid.json` holds synthetic inputs; manual edge tests exercise constraints absent from schema. To refresh, retrieve the same source URL for each exact endpoint, reconcile fields and constraints, update the original response hash/date, and run provider-contract tests. Do not mark a refreshed schema live-tested.

Documented semantic sources: [GPT Flare](https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/api), [Nano edit](https://fal.ai/models/google/nano-banana-2.1/edit/api), [Kling V3 i2v](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api), [Kling O3 4K](https://fal.ai/models/fal-ai/kling-video/o3/4k/text-to-video/api), [Seedance references](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api).

> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# SOUL V2 — Text to image API

> Text to image with SOUL V2: request parameters, examples and response handling.

[← SOUL V2](https://docs.higgsfield.ai/docs/models/soul-2.md)

**Endpoint:** `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard`

**Endpoint ID:** `higgsfield-ai/soul/v2/standard`

[▶
Open API PlaygroundSOUL V2 · Text to image
↗](https://console.higgsfield.ai/models/higgsfield-ai%2Fsoul%2Fv2%2Fstandard/playground)

## Usage notes

* batch\_size is 1 or 4 only. A custom\_reference\_id must belong to the calling account and have completed training.
* aspect\_ratio defaults to 1:1 and enhance\_prompt defaults to false. seed defaults to a random integer from 1 to 1000000; explicit null is invalid.
* style\_id defaults to 3db34ab5-3439-4317-9e03-08dc30852e69. style\_strength is accepted by the request schema but currently has no effect on generation.
* Short prompts using the general style can be enhanced automatically even when enhance\_prompt=false.
* When using custom\_reference\_id, set custom\_reference\_strength to a value greater than 0 and no greater than 1. The schema accepts 0, but the current runtime fails to process it for a character reference.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "resolution": "720p",
  "aspect_ratio": "1:1",
  "enhance_prompt": true,
  "batch_size": 1
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'resolution': '720p',
     'aspect_ratio': '1:1',
     'enhance_prompt': True,
     'batch_size': 1}
)
result = higgsfield_client.subscribe(
    "higgsfield-ai/soul/v2/standard",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("higgsfield-ai/soul/v2/standard", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "resolution": "720p",
      "aspect_ratio": "1:1",
      "enhance_prompt": true,
      "batch_size": 1
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.images?.[0]?.url);
}
```

## Input schema

**prompt** `string` *required*

Text instructions for the generation or edit.

**aspect\_ratio** `string` (default: 1:1)

Output width-to-height ratio.
Allowed values: `"9:16"`, `"16:9"`, `"4:3"`, `"3:4"`, `"1:1"`, `"2:3"`, `"3:2"`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"720p"`, `"1080p"`.

**enhance\_prompt** `boolean` (default: false)

Enable prompt enhancement for this workflow.

**custom\_reference\_id** `string | null`

Identifier of a completed character reference owned by your account.
Format: `uuid`.
Omit this field to use the server default; `null` is accepted only when included in the field type.

**custom\_reference\_strength** `number` (default: 1.0)

Strength of the character reference. With custom\_reference\_id, use a value greater than 0; the current runtime cannot process 0 even though the schema accepts it.
Minimum: `0`.
Maximum: `1`.

**style\_id** `string` (default: 3db34ab5-3439-4317-9e03-08dc30852e69)

Identifier of a style supported by this model.
Format: `uuid`.

**style\_strength** `number` (default: 1.0)

Accepted by the request schema, but currently has no effect on generation.
Minimum: `0`.
Maximum: `1`.

**seed** `integer`

Seed used to control generation randomness.
Minimum: `1`.
Maximum: `1000000`.

**batch\_size** `integer` (default: 1)

Number of output images.
Allowed values: `1`, `4`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "properties": {
>     "prompt": {
>       "title": "Prompt",
>       "type": "string"
>     },
>     "aspect_ratio": {
>       "default": "1:1",
>       "enum": [
>         "9:16",
>         "16:9",
>         "4:3",
>         "3:4",
>         "1:1",
>         "2:3",
>         "3:2"
>       ],
>       "title": "Aspect Ratio",
>       "type": "string"
>     },
>     "resolution": {
>       "default": "720p",
>       "enum": [
>         "720p",
>         "1080p"
>       ],
>       "title": "Resolution",
>       "type": "string"
>     },
>     "enhance_prompt": {
>       "default": false,
>       "title": "Enhance Prompt",
>       "type": "boolean"
>     },
>     "custom_reference_id": {
>       "anyOf": [
>         {
>           "format": "uuid",
>           "type": "string"
>         },
>         {
>           "type": "null"
>         }
>       ],
>       "default": null,
>       "title": "Custom Reference Id"
>     },
>     "custom_reference_strength": {
>       "default": 1.0,
>       "maximum": 1,
>       "minimum": 0,
>       "title": "Custom Reference Strength",
>       "type": "number"
>     },
>     "style_id": {
>       "default": "3db34ab5-3439-4317-9e03-08dc30852e69",
>       "format": "uuid",
>       "title": "Style Id",
>       "type": "string"
>     },
>     "style_strength": {
>       "default": 1.0,
>       "maximum": 1,
>       "minimum": 0,
>       "title": "Style Strength",
>       "type": "number"
>     },
>     "seed": {
>       "maximum": 1000000,
>       "minimum": 1,
>       "title": "Seed",
>       "type": "integer"
>     },
>     "batch_size": {
>       "default": 1,
>       "enum": [
>         1,
>         4
>       ],
>       "title": "Batch Size",
>       "type": "integer"
>     }
>   },
>   "required": [
>     "prompt"
>   ],
>   "title": "SoulV2ParamsSchema",
>   "type": "object"
> }
> ```

## List SOUL styles

`GET https://api.higgsfield.ai/v1/text2image/soul-styles/v2`

Use this authenticated endpoint to retrieve available `style_id` values.

```bash theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request GET \
  --url https://api.higgsfield.ai/v1/text2image/soul-styles/v2 \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}"
```

```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
[
  {
    "id": "<style-uuid>",
    "name": "Editorial",
    "description": "A polished editorial image style.",
    "preview_url": "https://cdn.example.com/soul-style-preview.jpg"
  }
]
```

## Response

Submission returns a request handle. Poll `status_url` until `status` is `completed`, or use [webhooks](https://docs.higgsfield.ai/docs/how-to/webhooks.md).

```json Accepted theme={"theme":{"light":"github-light","dark":"github-dark"}}
{
  "status": "queued",
  "request_id": "REQUEST_ID",
  "status_url": "https://api.higgsfield.ai/requests/REQUEST_ID/status",
  "cancel_url": "https://api.higgsfield.ai/requests/REQUEST_ID/cancel"
}
```

A completed response includes the following output fields:

```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
{
  "status": "completed",
  "request_id": "REQUEST_ID",
  "images": [
    {
      "url": "https://example.com/output.png"
    }
  ]
}
```

See [idempotent requests](https://docs.higgsfield.ai/docs/concepts/idempotency.md), [polling](https://docs.higgsfield.ai/docs/concepts/polling.md), [request errors](https://docs.higgsfield.ai/docs/concepts/errors.md) and [authentication](https://docs.higgsfield.ai/docs/authentication.md) for shared request handling.


## Related topics

- [SOUL V2 API](https://docs.higgsfield.ai/docs/models/soul-2.md)
- [SOUL — Text to image API](https://docs.higgsfield.ai/docs/models/soul-standard/generate.md)
- [SOUL Cinema — Text to image API](https://docs.higgsfield.ai/docs/models/soul-cinema/generate.md)
- [Qwen Image 3 — Text to image API](https://docs.higgsfield.ai/docs/models/qwen-image-3/text-to-image.md)
- [Recraft V4.1 — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1/text-to-image.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
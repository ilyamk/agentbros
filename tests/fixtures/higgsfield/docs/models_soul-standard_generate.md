> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# SOUL — Text to image API

> Text to image with SOUL: request parameters, examples and response handling.

[← SOUL](https://docs.higgsfield.ai/docs/models/soul-standard.md)

**Endpoint:** `POST https://api.higgsfield.ai/higgsfield-ai/soul/standard`

**Endpoint ID:** `higgsfield-ai/soul/standard`

[▶
Open API PlaygroundSOUL · Text to image
↗](https://console.higgsfield.ai/models/higgsfield-ai%2Fsoul%2Fstandard/playground)

## Usage notes

* batch\_size is 1 or 4 only. A custom\_reference\_id must belong to the calling account and have completed training.
* aspect\_ratio defaults to 4:3; enhance\_prompt defaults to false; style\_id defaults to 464ea177-8d40-4940-8d9d-b438bab269c7.
* Optional image\_reference\_url guides prompt enhancement; it is distinct from custom\_reference\_id for a trained character.
* seed may be omitted or null; generation selects a random seed when it is absent.
* Short prompts using the general style can be enhanced automatically even when enhance\_prompt=false.
* custom\_reference\_strength=0 uses the selected style's default character strength; it does not disable the character reference.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/higgsfield-ai/soul/standard \
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
    "higgsfield-ai/soul/standard",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("higgsfield-ai/soul/standard", {
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

**aspect\_ratio** `string` (default: 4:3)

Output width-to-height ratio.
Allowed values: `"9:16"`, `"16:9"`, `"4:3"`, `"3:4"`, `"1:1"`, `"2:3"`, `"3:2"`.

**enhance\_prompt** `boolean` (default: false)

Enable prompt enhancement for this workflow.

**style\_id** `string` (default: 464ea177-8d40-4940-8d9d-b438bab269c7)

Identifier of a style supported by this model.
Format: `uuid`.

**style\_strength** `number` (default: 1.0)

Strength of the selected style.
Minimum: `0`.
Maximum: `1`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"720p"`, `"1080p"`.

**seed** `integer | null`

Seed used to control generation randomness.
Minimum: `1`.
Maximum: `1000000`.
Omit this field to use the server default; `null` is accepted only when included in the field type.

**custom\_reference\_id** `string | null`

Identifier of a completed character reference owned by your account.
Format: `uuid`.
Omit this field to use the server default; `null` is accepted only when included in the field type.

**custom\_reference\_strength** `number` (default: 1.0)

Strength of the character reference. A value of 0 uses the selected style's default character strength.
Minimum: `0`.
Maximum: `1`.

**image\_reference\_url** `string | null`

Minimum characters: `1`.
Maximum characters: `2083`.
Format: `uri`.
Omit this field to use the server default; `null` is accepted only when included in the field type.

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
>       "default": "4:3",
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
>     "enhance_prompt": {
>       "default": false,
>       "title": "Enhance Prompt",
>       "type": "boolean"
>     },
>     "style_id": {
>       "default": "464ea177-8d40-4940-8d9d-b438bab269c7",
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
>     "resolution": {
>       "default": "720p",
>       "enum": [
>         "720p",
>         "1080p"
>       ],
>       "title": "Resolution",
>       "type": "string"
>     },
>     "seed": {
>       "anyOf": [
>         {
>           "maximum": 1000000,
>           "minimum": 1,
>           "type": "integer"
>         },
>         {
>           "type": "null"
>         }
>       ],
>       "default": null,
>       "title": "Seed"
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
>     "image_reference_url": {
>       "anyOf": [
>         {
>           "format": "uri",
>           "maxLength": 2083,
>           "minLength": 1,
>           "type": "string"
>         },
>         {
>           "type": "null"
>         }
>       ],
>       "default": null,
>       "title": "Image Reference Url"
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
>   "title": "SoulParamsSchema",
>   "type": "object"
> }
> ```

## List SOUL styles

`GET https://api.higgsfield.ai/v1/text2image/soul-styles`

Use this authenticated endpoint to retrieve valid `style_id` values.

```bash theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request GET \
  --url https://api.higgsfield.ai/v1/text2image/soul-styles \
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

- [SOUL V2 — Text to image API](https://docs.higgsfield.ai/docs/models/soul-2/generate.md)
- [SOUL Cinema — Text to image API](https://docs.higgsfield.ai/docs/models/soul-cinema/generate.md)
- [Qwen Image 3 — Text to image API](https://docs.higgsfield.ai/docs/models/qwen-image-3/text-to-image.md)
- [Recraft V4.1 — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1/text-to-image.md)
- [Recraft V4.1 Pro — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1-pro/generate.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
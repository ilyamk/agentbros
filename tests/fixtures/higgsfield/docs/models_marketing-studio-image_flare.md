> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Marketing Studio Image — 2.5 Flare API

> 2.5 Flare with Marketing Studio Image: request parameters, examples and response handling.

[← Marketing Studio Image](https://docs.higgsfield.ai/docs/models/marketing-studio-image.md)

**Endpoint:** `POST https://api.higgsfield.ai/marketing-studio/image/flare`

**Endpoint ID:** `marketing-studio/image/flare`

[▶
Open API PlaygroundMarketing Studio Image · 2.5 Flare
↗](https://console.higgsfield.ai/models/marketing-studio%2Fimage%2Fflare/playground)

## Usage notes

* Omit image\_urls for text-to-image; provide up to 16 URLs for editing when enhance\_prompt=false.
* enhance\_prompt=true requires an existing preset\_id and 1–2 image URLs: product first, optional person/model reference second. Discover presets with GET /marketing-studio/image/presets.
* Reference images must be valid JPEG, PNG, or WebP. Oversized supported images are normalized before rendering.
* With enhancement enabled, aspect\_ratio=auto uses the preset ratio. With enhancement disabled, current production mappings use square output for auto.
* The 1k/2k/4k values are resolution tiers; exact pixel dimensions depend on the aspect ratio.
* quality accepts low, medium, high, xhigh, max and remains selectable with enhancement enabled.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/marketing-studio/image/flare \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "resolution": "2k",
  "aspect_ratio": "1:1",
  "quality": "high",
  "enhance_prompt": false
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'resolution': '2k',
     'aspect_ratio': '1:1',
     'quality': 'high',
     'enhance_prompt': False}
)
result = higgsfield_client.subscribe(
    "marketing-studio/image/flare",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("marketing-studio/image/flare", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "resolution": "2k",
      "aspect_ratio": "1:1",
      "quality": "high",
      "enhance_prompt": false
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.images?.[0]?.url);
}
```

## Input schema

**prompt** `string` *required*

Write your prompt here
Minimum characters: `1`.
Maximum characters: `5000`.

**quality** `string` (default: high)

Allowed values: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`.

**preset\_id** `string`

Identifier of a Marketing Studio image preset.
Format: `uuid`.

**image\_urls** `array`

Ordered public image reference URLs.
Minimum items: `0`.
Maximum items: `16`.
Each item: string. Format: `uri`.

**moderation** `string` (default: auto)

Allowed values: `"auto"`, `"low"`.

**resolution** `string` (default: 2k)

Output resolution tier.
Allowed values: `"1k"`, `"2k"`, `"4k"`.

**aspect\_ratio** `string` (default: auto)

Output width-to-height ratio.
Allowed values: `"auto"`, `"1:1"`, `"3:2"`, `"2:3"`, `"4:3"`, `"3:4"`, `"16:9"`, `"9:16"`, `"21:9"`.

**enhance\_prompt** `boolean` (default: false)

Enable prompt enhancement for this workflow.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "allOf": [
>     {
>       "if": {
>         "required": [
>           "enhance_prompt"
>         ],
>         "properties": {
>           "enhance_prompt": {
>             "const": true
>           }
>         }
>       },
>       "then": {
>         "required": [
>           "preset_id",
>           "image_urls"
>         ],
>         "properties": {
>           "image_urls": {
>             "maxItems": 2,
>             "minItems": 1
>           }
>         }
>       }
>     }
>   ],
>   "title": "Marketing Studio Image 2.5 Flare",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "maxLength": 5000,
>       "minLength": 1,
>       "description": "Write your prompt here"
>     },
>     "quality": {
>       "enum": [
>         "low",
>         "medium",
>         "high",
>         "xhigh",
>         "max"
>       ],
>       "type": "string",
>       "title": "Quality",
>       "default": "high"
>     },
>     "preset_id": {
>       "type": "string",
>       "title": "Preset ID",
>       "format": "uuid"
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "title": "Image URLs",
>       "maxItems": 16,
>       "minItems": 0
>     },
>     "moderation": {
>       "enum": [
>         "auto",
>         "low"
>       ],
>       "type": "string",
>       "default": "auto"
>     },
>     "resolution": {
>       "enum": [
>         "1k",
>         "2k",
>         "4k"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "2k"
>     },
>     "aspect_ratio": {
>       "enum": [
>         "auto",
>         "1:1",
>         "3:2",
>         "2:3",
>         "4:3",
>         "3:4",
>         "16:9",
>         "9:16",
>         "21:9"
>       ],
>       "type": "string",
>       "title": "Aspect Ratio",
>       "default": "auto"
>     },
>     "enhance_prompt": {
>       "type": "boolean",
>       "title": "Enhance prompt",
>       "default": false
>     }
>   },
>   "additionalProperties": false
> }
> ```

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

- [Marketing Studio Image API](https://docs.higgsfield.ai/docs/models/marketing-studio-image.md)
- [Marketing Studio Image — 2.5 Sunburst API](https://docs.higgsfield.ai/docs/models/marketing-studio-image/sunburst.md)
- [Marketing Studio Image — 2.0 Alpha API](https://docs.higgsfield.ai/docs/models/marketing-studio-image/generate-and-edit.md)
- [Ads Studio API](https://docs.higgsfield.ai/docs/models/ads-studio.md)
- [Image Generation API](https://docs.higgsfield.ai/docs/models/image-generation.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
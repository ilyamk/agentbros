> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Grok Image 2.0 — Generate and edit API

> Generate and edit with Grok Image 2.0: request parameters, examples and response handling.

[← Grok Image 2.0](https://docs.higgsfield.ai/docs/models/grok-image-2.md)

**Endpoint:** `POST https://api.higgsfield.ai/xai/grok-imagine-image-2.0`

**Endpoint ID:** `xai/grok-imagine-image-2.0`

[▶
Open API PlaygroundGrok Image 2.0 · Generate and edit
↗](https://console.higgsfield.ai/models/xai%2Fgrok-imagine-image-2.0/playground)

## Usage notes

* Supports both text-to-image and editing: omit image\_urls for generation, or supply up to 10 references for editing.
* quality accepts low or medium only; resolution accepts 1k or 2k. aspect\_ratio defaults to auto.
* Reference images may be resized during preprocessing before submission. The request produces one image; no batch count is declared.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/xai/grok-imagine-image-2.0 \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "resolution": "1k",
  "aspect_ratio": "1:1",
  "quality": "medium"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'resolution': '1k',
     'aspect_ratio': '1:1',
     'quality': 'medium'}
)
result = higgsfield_client.subscribe(
    "xai/grok-imagine-image-2.0",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("xai/grok-imagine-image-2.0", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "resolution": "1k",
      "aspect_ratio": "1:1",
      "quality": "medium"
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

**quality** `string` (default: medium)

Allowed values: `"low"`, `"medium"`.

**image\_urls** `array`

Ordered public image reference URLs.
Minimum items: `0`.
Maximum items: `10`.
Each item: string. Format: `uri`.

**resolution** `string` (default: 1k)

Output resolution tier.
Allowed values: `"1k"`, `"2k"`.

**aspect\_ratio** `string` (default: auto)

Output width-to-height ratio.
Allowed values: `"auto"`, `"1:1"`, `"1:2"`, `"2:1"`, `"3:2"`, `"2:3"`, `"4:3"`, `"3:4"`, `"16:9"`, `"9:16"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Grok Imagine 2.0 Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "description": "Write your prompt here"
>     },
>     "quality": {
>       "enum": [
>         "low",
>         "medium"
>       ],
>       "type": "string",
>       "title": "Quality",
>       "default": "medium"
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "title": "Image",
>         "format": "uri"
>       },
>       "title": "Input Images",
>       "maxItems": 10,
>       "minItems": 0
>     },
>     "resolution": {
>       "enum": [
>         "1k",
>         "2k"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "1k"
>     },
>     "aspect_ratio": {
>       "enum": [
>         "auto",
>         "1:1",
>         "1:2",
>         "2:1",
>         "3:2",
>         "2:3",
>         "4:3",
>         "3:4",
>         "16:9",
>         "9:16"
>       ],
>       "type": "string",
>       "default": "auto"
>     }
>   }
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

- [Grok Image 2.0 API](https://docs.higgsfield.ai/docs/models/grok-image-2.md)
- [Image Generation API](https://docs.higgsfield.ai/docs/models/image-generation.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)
- [Qwen Image 3 API](https://docs.higgsfield.ai/docs/models/qwen-image-3.md)
- [Seedance 2.0 API](https://docs.higgsfield.ai/docs/models/seedance-2.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
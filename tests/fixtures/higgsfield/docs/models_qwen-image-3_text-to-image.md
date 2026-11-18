> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Qwen Image 3 — Text to image API

> Text to image with Qwen Image 3: request parameters, examples and response handling.

[← Qwen Image 3](https://docs.higgsfield.ai/docs/models/qwen-image-3.md)

**Endpoint:** `POST https://api.higgsfield.ai/alibaba/qwen-image-3/text-to-image`

**Endpoint ID:** `alibaba/qwen-image-3/text-to-image`

[▶
Open API PlaygroundQwen Image 3 · Text to image
↗](https://console.higgsfield.ai/models/alibaba%2Fqwen-image-3%2Ftext-to-image/playground)

## Usage notes

* prompt must contain non-whitespace text. The schema imposes no character maximum; its 4,500-token guidance is advisory.
* enable\_thinking defaults to true and requires prompt\_extend=true. Set both to false to disable enhancement.
* prompt\_extend\_mode supports direct or agent. No reference images are accepted by this endpoint.
* resolution is a tier; 2k square maps to 1536 by 1536 pixels, not 2048 by 2048.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/alibaba/qwen-image-3/text-to-image \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "resolution": "1k",
  "aspect_ratio": "1:1"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'resolution': '1k',
     'aspect_ratio': '1:1'}
)
result = higgsfield_client.subscribe(
    "alibaba/qwen-image-3/text-to-image",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("alibaba/qwen-image-3/text-to-image", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "resolution": "1k",
      "aspect_ratio": "1:1"
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.images?.[0]?.url);
}
```

## Input schema

**seed** `integer`

Optional random seed for similar, reproducible results.
Minimum: `0`.
Maximum: `2147483647`.

**prompt** `string` *required*

Positive prompt or editing instruction in Chinese or English. Alibaba recommends at most 4,500 tokens.
Minimum characters: `1`.

**resolution** `string` (default: 1k)

Output resolution tier. Both tiers produce PNG images.
Allowed values: `"1k"`, `"2k"`.

**aspect\_ratio** `string` (default: 1:1)

Output aspect ratio. Exact provider-recommended dimensions are selected automatically.
Allowed values: `"1:1"`, `"2:3"`, `"3:2"`, `"3:4"`, `"4:3"`, `"7:9"`, `"9:7"`, `"9:16"`, `"16:9"`, `"21:9"`.

**prompt\_extend** `boolean` (default: true)

Improve the prompt before generation. Required when thinking mode is enabled.

**enable\_thinking** `boolean` (default: true)

Use model reasoning to improve image quality. Requires prompt enhancement.

**negative\_prompt** `string`

Content, styles, or artifacts to avoid in the output.

**prompt\_extend\_mode** `string` (default: direct)

Direct enhancement is available for every request; agent enhancement is text-to-image only.
Allowed values: `"direct"`, `"agent"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "allOf": [
>     {
>       "if": {
>         "required": [
>           "enable_thinking"
>         ],
>         "properties": {
>           "enable_thinking": {
>             "const": true
>           }
>         }
>       },
>       "then": {
>         "required": [
>           "prompt_extend"
>         ],
>         "properties": {
>           "prompt_extend": {
>             "const": true
>           }
>         }
>       }
>     }
>   ],
>   "title": "Qwen Image 3 Text to Image",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "seed": {
>       "type": "integer",
>       "maximum": 2147483647,
>       "minimum": 0,
>       "description": "Optional random seed for similar, reproducible results."
>     },
>     "prompt": {
>       "type": "string",
>       "minLength": 1,
>       "description": "Positive prompt or editing instruction in Chinese or English. Alibaba recommends at most 4,500 tokens."
>     },
>     "resolution": {
>       "enum": [
>         "1k",
>         "2k"
>       ],
>       "type": "string",
>       "default": "1k",
>       "description": "Output resolution tier. Both tiers produce PNG images."
>     },
>     "aspect_ratio": {
>       "enum": [
>         "1:1",
>         "2:3",
>         "3:2",
>         "3:4",
>         "4:3",
>         "7:9",
>         "9:7",
>         "9:16",
>         "16:9",
>         "21:9"
>       ],
>       "type": "string",
>       "default": "1:1",
>       "description": "Output aspect ratio. Exact provider-recommended dimensions are selected automatically."
>     },
>     "prompt_extend": {
>       "type": "boolean",
>       "default": true,
>       "description": "Improve the prompt before generation. Required when thinking mode is enabled."
>     },
>     "enable_thinking": {
>       "type": "boolean",
>       "default": true,
>       "description": "Use model reasoning to improve image quality. Requires prompt enhancement."
>     },
>     "negative_prompt": {
>       "type": "string",
>       "description": "Content, styles, or artifacts to avoid in the output."
>     },
>     "prompt_extend_mode": {
>       "enum": [
>         "direct",
>         "agent"
>       ],
>       "type": "string",
>       "default": "direct",
>       "description": "Direct enhancement is available for every request; agent enhancement is text-to-image only."
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

- [Qwen Image 3 API](https://docs.higgsfield.ai/docs/models/qwen-image-3.md)
- [Qwen Image 3 — Edit images API](https://docs.higgsfield.ai/docs/models/qwen-image-3/edit.md)
- [Image Generation API](https://docs.higgsfield.ai/docs/models/image-generation.md)
- [SOUL — Text to image API](https://docs.higgsfield.ai/docs/models/soul-standard/generate.md)
- [SOUL V2 — Text to image API](https://docs.higgsfield.ai/docs/models/soul-2/generate.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Ideogram 4.0 — Generate API

> Generate with Ideogram 4.0: request parameters, examples and response handling.

[← Ideogram 4.0](https://docs.higgsfield.ai/docs/models/ideogram-4.md)

**Endpoint:** `POST https://api.higgsfield.ai/ideogram/v4.0`

**Endpoint ID:** `ideogram/v4.0`

[▶
Open API PlaygroundIdeogram 4.0 · Generate
↗](https://console.higgsfield.ai/models/ideogram%2Fv4.0/playground)

## Usage notes

* Omit image\_url for text-to-image; provide image\_url for remix/editing.
* image\_weight controls preservation of the input image and applies to editing requests only; values are integers from 1 to 100.
* The square 1:1 aspect ratio is applied by default, including when an input image is supplied.
* rendering\_speed values are case-sensitive: TURBO, DEFAULT, QUALITY. prompt must contain 2–2048 characters.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/ideogram/v4.0 \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "aspect_ratio": "1:1",
  "rendering_speed": "DEFAULT"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'aspect_ratio': '1:1',
     'rendering_speed': 'DEFAULT'}
)
result = higgsfield_client.subscribe(
    "ideogram/v4.0",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("ideogram/v4.0", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "aspect_ratio": "1:1",
      "rendering_speed": "DEFAULT"
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
Minimum characters: `2`.
Maximum characters: `2048`.

**image\_url** `string`

Public URL of the input image.
Format: `uri`.

**aspect\_ratio** `string` (default: 1:1)

Output width-to-height ratio.
Allowed values: `"1:1"`, `"1:2"`, `"2:1"`, `"2:3"`, `"3:2"`, `"4:5"`, `"5:4"`, `"9:16"`, `"16:9"`, `"5:8"`, `"8:5"`, `"3:4"`, `"4:3"`, `"9:22"`, `"22:9"`, `"9:23"`, `"23:9"`, `"3:8"`, `"8:3"`, `"5:12"`, `"12:5"`, `"1:3"`, `"3:1"`.

**image\_weight** `integer`

How strongly the output should preserve the input image.
Minimum: `1`.
Maximum: `100`.

**rendering\_speed** `string` (default: DEFAULT)

Allowed values: `"TURBO"`, `"DEFAULT"`, `"QUALITY"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Ideogram 4.0 Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "maxLength": 2048,
>       "minLength": 2,
>       "description": "Write your prompt here"
>     },
>     "image_url": {
>       "type": "string",
>       "title": "Input image",
>       "format": "uri"
>     },
>     "aspect_ratio": {
>       "enum": [
>         "1:1",
>         "1:2",
>         "2:1",
>         "2:3",
>         "3:2",
>         "4:5",
>         "5:4",
>         "9:16",
>         "16:9",
>         "5:8",
>         "8:5",
>         "3:4",
>         "4:3",
>         "9:22",
>         "22:9",
>         "9:23",
>         "23:9",
>         "3:8",
>         "8:3",
>         "5:12",
>         "12:5",
>         "1:3",
>         "3:1"
>       ],
>       "type": "string",
>       "title": "Aspect ratio",
>       "default": "1:1"
>     },
>     "image_weight": {
>       "type": "integer",
>       "title": "Image weight",
>       "maximum": 100,
>       "minimum": 1,
>       "description": "How strongly the output should preserve the input image."
>     },
>     "rendering_speed": {
>       "enum": [
>         "TURBO",
>         "DEFAULT",
>         "QUALITY"
>       ],
>       "type": "string",
>       "title": "Rendering speed",
>       "default": "DEFAULT"
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

- [Ideogram 4.0 API](https://docs.higgsfield.ai/docs/models/ideogram-4.md)
- [Cinema Studio 4.0 — Generate API](https://docs.higgsfield.ai/docs/models/cinema-studio-4/generate.md)
- [Image Generation API](https://docs.higgsfield.ai/docs/models/image-generation.md)
- [Cinema Studio 4.0 API](https://docs.higgsfield.ai/docs/models/cinema-studio-4.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
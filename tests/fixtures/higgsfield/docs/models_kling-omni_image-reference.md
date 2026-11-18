> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling Omni — Image reference API

> Image reference with Kling Omni: request parameters, examples and response handling.

[← Kling Omni](https://docs.higgsfield.ai/docs/models/kling-omni.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/omni/image-reference`

**Endpoint ID:** `kling-video/omni/image-reference`

[▶
Open API PlaygroundKling Omni · Image reference
↗](https://console.higgsfield.ai/models/kling-video%2Fomni%2Fimage-reference/playground)

## Usage notes

* Supply image\_urls for visual references. Reference images are optional in the schema.
* Keep the top-level prompt within 2,500 characters; longer prompts are truncated.
* elements contains Kling element IDs as decimal strings. Each ID must belong to the account making the request; arbitrary provider IDs are rejected.
* The example.com media URLs are placeholders. Replace them with public HTTPS URLs to your own media before submitting.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/omni/image-reference \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A slow cinematic camera move around the subject in warm evening light.",
  "image_urls": [
    "https://example.com/reference-image.jpg"
  ]
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A slow cinematic camera move around the subject in warm evening '
               'light.',
     'image_urls': ['https://example.com/reference-image.jpg']}
)
result = higgsfield_client.subscribe(
    "kling-video/omni/image-reference",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/omni/image-reference", {
  input:
    {
      "prompt": "A slow cinematic camera move around the subject in warm evening light.",
      "image_urls": [
        "https://example.com/reference-image.jpg"
      ]
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.video?.url);
}
```

## Input schema

**mode** `string` (default: pro)

Allowed values: `"std"`, `"pro"`.

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `3`.
Maximum: `10`.

**elements** `array`

Each item: string.

**image\_urls** `array`

Ordered public image reference URLs.
Each item: string. Format: `uri`.

**aspect\_ratio** `string` (default: 16:9)

Output width-to-height ratio.
Allowed values: `"16:9"`, `"9:16"`, `"1:1"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Kling Omni Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "mode": {
>       "enum": [
>         "std",
>         "pro"
>       ],
>       "type": "string",
>       "default": "pro"
>     },
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "type": "integer",
>       "title": "Duration",
>       "default": 5,
>       "maximum": 10,
>       "minimum": 3
>     },
>     "elements": {
>       "type": "array",
>       "items": {
>         "type": "string"
>       }
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "title": "Image URL",
>         "format": "uri"
>       }
>     },
>     "aspect_ratio": {
>       "enum": [
>         "16:9",
>         "9:16",
>         "1:1"
>       ],
>       "type": "string",
>       "default": "16:9"
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
  "video": {
    "url": "https://example.com/output.mp4"
  }
}
```

See [idempotent requests](https://docs.higgsfield.ai/docs/concepts/idempotency.md), [polling](https://docs.higgsfield.ai/docs/concepts/polling.md), [request errors](https://docs.higgsfield.ai/docs/concepts/errors.md) and [authentication](https://docs.higgsfield.ai/docs/authentication.md) for shared request handling.


## Related topics

- [Kling Omni API](https://docs.higgsfield.ai/docs/models/kling-omni.md)
- [Kling Omni — Video reference API](https://docs.higgsfield.ai/docs/models/kling-omni/video-reference.md)
- [Kling O3 — Image reference API](https://docs.higgsfield.ai/docs/models/kling-o3/image-reference.md)
- [Kling Omni — Video edit API](https://docs.higgsfield.ai/docs/models/kling-omni/video-edit.md)
- [Kling Omni — First last frame API](https://docs.higgsfield.ai/docs/models/kling-omni/first-last-frame.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
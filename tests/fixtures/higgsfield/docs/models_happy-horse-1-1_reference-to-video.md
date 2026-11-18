> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# HappyHorse 1.1 — Reference to video API

> Reference to video with HappyHorse 1.1: request parameters, examples and response handling.

[← HappyHorse 1.1](https://docs.higgsfield.ai/docs/models/happy-horse-1-1.md)

**Endpoint:** `POST https://api.higgsfield.ai/alibaba/happy-horse/v1.1/reference-to-video`

**Endpoint ID:** `alibaba/happy-horse/v1.1/reference-to-video`

[▶
Open API PlaygroundHappyHorse 1.1 · Reference to video
↗](https://console.higgsfield.ai/models/alibaba%2Fhappy-horse%2Fv1.1%2Freference-to-video/playground)

## Usage notes

* Provide 1–9 reference images. This limit is enforced at submission even though the stored JSON Schema does not set minItems or maxItems. Reference videos are unsupported.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/alibaba/happy-horse/v1.1/reference-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "image_urls": [
    "https://example.com/input.jpg"
  ],
  "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement."
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'image_urls': ['https://example.com/input.jpg'],
     'prompt': 'A cinematic wide shot of ocean waves at sunset, with gentle camera '
               'movement.'}
)
result = higgsfield_client.subscribe(
    "alibaba/happy-horse/v1.1/reference-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("alibaba/happy-horse/v1.1/reference-to-video", {
  input:
    {
      "image_urls": [
        "https://example.com/input.jpg"
      ],
      "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement."
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.video?.url);
}
```

## Input schema

**seed** `integer`

Seed used to control generation randomness.
Minimum: `1`.
Maximum: `2147483646`.

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `2`.
Maximum: `15`.

**image\_urls** `array` *required*

Ordered public image reference URLs.
Each item: string. Format: `uri`.

**resolution** `string` (default: 1080p)

Output resolution tier.
Allowed values: `"720p"`, `"1080p"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Happy horse",
>   "required": [
>     "image_urls",
>     "prompt"
>   ],
>   "properties": {
>     "seed": {
>       "type": "integer",
>       "maximum": 2147483646,
>       "minimum": 1
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
>       "maximum": 15,
>       "minimum": 2
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "title": "Image URL",
>         "format": "uri"
>       }
>     },
>     "resolution": {
>       "enum": [
>         "720p",
>         "1080p"
>       ],
>       "type": "string",
>       "default": "1080p"
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

- [HappyHorse 1.1 API](https://docs.higgsfield.ai/docs/models/happy-horse-1-1.md)
- [HappyHorse 1.1 — Image to video API](https://docs.higgsfield.ai/docs/models/happy-horse-1-1/image-to-video.md)
- [HappyHorse 1.1 — Text to video API](https://docs.higgsfield.ai/docs/models/happy-horse-1-1/text-to-video.md)
- [Happy Horse 1.0 — Reference to video API](https://docs.higgsfield.ai/docs/models/happy-horse-1/reference-to-video.md)
- [Happy Horse 1.0 — Image to video API](https://docs.higgsfield.ai/docs/models/happy-horse-1/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Wan 2.6 — Reference to video API

> Reference to video with Wan 2.6: request parameters, examples and response handling.

[← Wan 2.6](https://docs.higgsfield.ai/docs/models/wan-2-6.md)

**Endpoint:** `POST https://api.higgsfield.ai/wan/v2.6/reference-to-video`

**Endpoint ID:** `wan/v2.6/reference-to-video`

[▶
Open API PlaygroundWan 2.6 · Reference to video
↗](https://console.higgsfield.ai/models/wan%2Fv2.6%2Freference-to-video/playground)

## Usage notes

* Supply 1–3 reference videos. This endpoint supports only 5 or 10 seconds, unlike the text and image endpoints that also support 15 seconds.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/wan/v2.6/reference-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
  "video_urls": [
    "https://example.com/input.mp4"
  ]
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A cinematic wide shot of ocean waves at sunset, with gentle camera '
               'movement.',
     'video_urls': ['https://example.com/input.mp4']}
)
result = higgsfield_client.subscribe(
    "wan/v2.6/reference-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("wan/v2.6/reference-to-video", {
  input:
    {
      "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
      "video_urls": [
        "https://example.com/input.mp4"
      ]
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.video?.url);
}
```

## Input schema

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Allowed values: `5`, `10`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"720p"`, `"1080p"`.

**video\_urls** `array` *required*

Ordered public video reference URLs.
Minimum items: `1`.
Maximum items: `3`.
Each item: string. Format: `uri`.

**aspect\_ratio** `string` (default: 16:9)

Output width-to-height ratio.
Allowed values: `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Wan 2.6 Playground",
>   "required": [
>     "prompt",
>     "video_urls"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "enum": [
>         5,
>         10
>       ],
>       "type": "integer",
>       "title": "Duration",
>       "default": 5
>     },
>     "resolution": {
>       "enum": [
>         "720p",
>         "1080p"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "720p"
>     },
>     "video_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "title": "Video URL",
>         "format": "uri"
>       },
>       "maxItems": 3,
>       "minItems": 1
>     },
>     "aspect_ratio": {
>       "enum": [
>         "16:9",
>         "9:16",
>         "1:1",
>         "4:3",
>         "3:4"
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

- [Wan 2.6 API](https://docs.higgsfield.ai/docs/models/wan-2-6.md)
- [Wan 2.6 — Image to video API](https://docs.higgsfield.ai/docs/models/wan-2-6/image-to-video.md)
- [Wan 2.6 — Text to video API](https://docs.higgsfield.ai/docs/models/wan-2-6/text-to-video.md)
- [Wan 2.7 — Text to video API](https://docs.higgsfield.ai/docs/models/wan-2-7/text-to-video.md)
- [Wan 2.7 — Image to video API](https://docs.higgsfield.ai/docs/models/wan-2-7/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
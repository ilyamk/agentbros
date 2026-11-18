> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# MiniMax H3 — Reference to video API

> Reference to video with MiniMax H3: request parameters, examples and response handling.

[← MiniMax H3](https://docs.higgsfield.ai/docs/models/minimax-h3.md)

**Endpoint:** `POST https://api.higgsfield.ai/minimax/h3/reference-to-video`

**Endpoint ID:** `minimax/h3/reference-to-video`

[▶
Open API PlaygroundMiniMax H3 · Reference to video
↗](https://console.higgsfield.ai/models/minimax%2Fh3%2Freference-to-video/playground)

## Usage notes

* Resolution is fixed to the case-sensitive schema value "2K". The prompt must contain non-whitespace text; the current provider serializer uses only its first 7,000 characters.
* Provide at least one image or video reference. Audio references require an image or video reference and cannot be used alone.
* Reference media may be cropped, resized, transcoded and trimmed. Video duration and audio duration are each normalized to fit within the provider's 15-second total budget.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/minimax/h3/reference-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
  "image_urls": [
    "https://example.com/input.jpg"
  ]
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A cinematic wide shot of ocean waves at sunset, with gentle camera '
               'movement.',
     'image_urls': ['https://example.com/input.jpg']}
)
result = higgsfield_client.subscribe(
    "minimax/h3/reference-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("minimax/h3/reference-to-video", {
  input:
    {
      "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
      "image_urls": [
        "https://example.com/input.jpg"
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
Minimum characters: `1`.

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `5`.
Maximum: `15`.

**audio\_urls** `array`

Ordered public audio reference URLs.
Minimum items: `0`.
Maximum items: `3`.
Each item: string. Format: `uri`.

**image\_urls** `array`

Ordered public image reference URLs.
Minimum items: `1`.
Maximum items: `9`.
Each item: string. Format: `uri`.

**resolution** `string` (default: 2K)

Output resolution tier.
Allowed values: `"2K"`.

**video\_urls** `array`

Ordered public video reference URLs.
Minimum items: `1`.
Maximum items: `3`.
Each item: string. Format: `uri`.

**aspect\_ratio** `string` (default: auto)

Output width-to-height ratio.
Allowed values: `"auto"`, `"adaptive"`, `"21:9"`, `"16:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"`.

**aigc\_watermark** `boolean` (default: false)

See the complete JSON schema below.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "if": {
>     "required": [
>       "image_urls"
>     ]
>   },
>   "else": {
>     "required": [
>       "video_urls"
>     ]
>   },
>   "type": "object",
>   "title": "MiniMax H3 Reference to Video Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "minLength": 1,
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "type": "integer",
>       "title": "Duration",
>       "default": 5,
>       "maximum": 15,
>       "minimum": 5
>     },
>     "audio_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "title": "Reference audio URLs",
>       "maxItems": 3,
>       "minItems": 0
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "title": "Reference image URLs",
>       "maxItems": 9,
>       "minItems": 1
>     },
>     "resolution": {
>       "enum": [
>         "2K"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "2K"
>     },
>     "video_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "title": "Reference video URLs",
>       "maxItems": 3,
>       "minItems": 1
>     },
>     "aspect_ratio": {
>       "enum": [
>         "auto",
>         "adaptive",
>         "21:9",
>         "16:9",
>         "4:3",
>         "1:1",
>         "3:4",
>         "9:16"
>       ],
>       "type": "string",
>       "title": "Aspect ratio",
>       "default": "auto"
>     },
>     "aigc_watermark": {
>       "type": "boolean",
>       "title": "AIGC watermark",
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
  "video": {
    "url": "https://example.com/output.mp4"
  }
}
```

See [idempotent requests](https://docs.higgsfield.ai/docs/concepts/idempotency.md), [polling](https://docs.higgsfield.ai/docs/concepts/polling.md), [request errors](https://docs.higgsfield.ai/docs/concepts/errors.md) and [authentication](https://docs.higgsfield.ai/docs/authentication.md) for shared request handling.


## Related topics

- [MiniMax H3 API](https://docs.higgsfield.ai/docs/models/minimax-h3.md)
- [MiniMax H3 — Image to video API](https://docs.higgsfield.ai/docs/models/minimax-h3/image-to-video.md)
- [MiniMax H3 — Text to video API](https://docs.higgsfield.ai/docs/models/minimax-h3/text-to-video.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)
- [Model API Reference](https://docs.higgsfield.ai/docs/models.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
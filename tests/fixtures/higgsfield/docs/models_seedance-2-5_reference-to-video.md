> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Seedance 2.5 — Reference to video API

> Reference to video with Seedance 2.5: request parameters, examples and response handling.

[← Seedance 2.5](https://docs.higgsfield.ai/docs/models/seedance-2-5.md)

**Endpoint:** `POST https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video`

**Endpoint ID:** `bytedance/seedance-2.5/reference-to-video`

[▶
Open API PlaygroundSeedance 2.5 · Reference to video
↗](https://console.higgsfield.ai/models/bytedance%2Fseedance-2.5%2Freference-to-video/playground)

## Usage notes

* Use publicly accessible media URLs; asset:// references are rejected for these endpoints.
* Provide at least one nonempty reference array: image\_urls, video\_urls or audio\_urls. Audio-only references are supported by this schema and preprocessing path.
* Reference media are limited to 30 images, 10 videos and 10 audio files, with at most 50 items total. Video duration and audio duration are normalized separately to at most 30 seconds total per media type.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "image_urls": [
    "https://example.com/input.jpg"
  ]
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'image_urls': ['https://example.com/input.jpg']}
)
result = higgsfield_client.subscribe(
    "bytedance/seedance-2.5/reference-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("bytedance/seedance-2.5/reference-to-video", {
  input:
    {
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

**prompt** `string`

Write your prompt here
Minimum characters: `1`.

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `4`.
Maximum: `30`.

**audio\_urls** `array`

Ordered public audio reference URLs.
Minimum items: `1`.
Maximum items: `10`.
Each item: string. Format: `uri`.

**image\_urls** `array`

Ordered public image reference URLs.
Minimum items: `1`.
Maximum items: `30`.
Each item: string. Format: `uri`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"480p"`, `"720p"`, `"1080p"`.

**video\_urls** `array`

Ordered public video reference URLs.
Minimum items: `1`.
Maximum items: `10`.
Each item: string. Format: `uri`.

**aspect\_ratio** `string` (default: 16:9)

Output width-to-height ratio.
Allowed values: `"16:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"`, `"21:9"`.

**bitrate\_mode** `string` (default: high)

Allowed values: `"standard"`, `"high"`.

**generate\_audio** `boolean` (default: true)

Generate audio with the video.

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
>     "if": {
>       "required": [
>         "video_urls"
>       ]
>     },
>     "else": {
>       "required": [
>         "audio_urls"
>       ]
>     }
>   },
>   "type": "object",
>   "required": [],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "minLength": 1,
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "type": "integer",
>       "default": 5,
>       "maximum": 30,
>       "minimum": 4
>     },
>     "audio_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "maxItems": 10,
>       "minItems": 1
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "maxItems": 30,
>       "minItems": 1
>     },
>     "resolution": {
>       "enum": [
>         "480p",
>         "720p",
>         "1080p"
>       ],
>       "type": "string",
>       "default": "720p"
>     },
>     "video_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri"
>       },
>       "maxItems": 10,
>       "minItems": 1
>     },
>     "aspect_ratio": {
>       "enum": [
>         "16:9",
>         "4:3",
>         "1:1",
>         "3:4",
>         "9:16",
>         "21:9"
>       ],
>       "type": "string",
>       "default": "16:9"
>     },
>     "bitrate_mode": {
>       "enum": [
>         "standard",
>         "high"
>       ],
>       "type": "string",
>       "default": "high"
>     },
>     "generate_audio": {
>       "type": "boolean",
>       "default": true
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

- [Seedance 2.5 API](https://docs.higgsfield.ai/docs/models/seedance-2-5.md)
- [Seedance 2.5 — Text to video API](https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video.md)
- [Seedance 2.5 — Video extend API](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-extend.md)
- [Seedance 2.5 — Video edit API](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-edit.md)
- [Seedance 2.5 — Image to video API](https://docs.higgsfield.ai/docs/models/seedance-2-5/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
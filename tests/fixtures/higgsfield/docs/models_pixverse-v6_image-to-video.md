> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# PixVerse V6 — Image to video API

> Image to video with PixVerse V6: request parameters, examples and response handling.

[← PixVerse V6](https://docs.higgsfield.ai/docs/models/pixverse-v6.md)

**Endpoint:** `POST https://api.higgsfield.ai/pixverse/v6/image-to-video`

**Endpoint ID:** `pixverse/v6/image-to-video`

[▶
Open API PlaygroundPixVerse V6 · Image to video
↗](https://console.higgsfield.ai/models/pixverse%2Fv6%2Fimage-to-video/playground)

## Usage notes

* duration is a number from 1 to 15, so the schema allows fractional values. If negative\_prompt is supplied, it must contain 1–2,048 characters.
* Use image\_url for the first frame and optional end\_image\_url for the last frame. This endpoint has no aspect\_ratio parameter; framing comes from the input image.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/pixverse/v6/image-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
  "image_url": "https://example.com/input.jpg"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A cinematic wide shot of ocean waves at sunset, with gentle camera '
               'movement.',
     'image_url': 'https://example.com/input.jpg'}
)
result = higgsfield_client.subscribe(
    "pixverse/v6/image-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("pixverse/v6/image-to-video", {
  input:
    {
      "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement.",
      "image_url": "https://example.com/input.jpg"
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
Minimum: `0`.
Maximum: `2147483647`.

**prompt** `string` *required*

Write your prompt here
Minimum characters: `1`.
Maximum characters: `5000`.

**duration** `number` (default: 5)

Requested output duration in seconds.
Minimum: `1`.
Maximum: `15`.

**image\_url** `string` *required*

Public URL of the input image.
Format: `uri`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"360p"`, `"540p"`, `"720p"`, `"1080p"`.

**end\_image\_url** `string`

Format: `uri`.

**generate\_audio** `boolean` (default: true)

Generate audio with the video.

**negative\_prompt** `string`

Content or visual features to avoid.
Minimum characters: `1`.
Maximum characters: `2048`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "PixVerse V6 Image to Video Playground",
>   "required": [
>     "prompt",
>     "image_url"
>   ],
>   "properties": {
>     "seed": {
>       "type": "integer",
>       "title": "Seed",
>       "maximum": 2147483647,
>       "minimum": 0
>     },
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "maxLength": 5000,
>       "minLength": 1,
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "type": "number",
>       "title": "Duration",
>       "default": 5,
>       "maximum": 15,
>       "minimum": 1
>     },
>     "image_url": {
>       "type": "string",
>       "title": "First frame",
>       "format": "uri"
>     },
>     "resolution": {
>       "enum": [
>         "360p",
>         "540p",
>         "720p",
>         "1080p"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "720p"
>     },
>     "end_image_url": {
>       "type": "string",
>       "title": "Last frame",
>       "format": "uri"
>     },
>     "generate_audio": {
>       "type": "boolean",
>       "title": "Generate audio",
>       "default": true
>     },
>     "negative_prompt": {
>       "type": "string",
>       "title": "Negative prompt",
>       "maxLength": 2048,
>       "minLength": 1
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

- [PixVerse V6 API](https://docs.higgsfield.ai/docs/models/pixverse-v6.md)
- [PixVerse V6 — Text to video API](https://docs.higgsfield.ai/docs/models/pixverse-v6/text-to-video.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)
- [Model API Reference](https://docs.higgsfield.ai/docs/models.md)
- [Seedance 2.5 — Image to video API](https://docs.higgsfield.ai/docs/models/seedance-2-5/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
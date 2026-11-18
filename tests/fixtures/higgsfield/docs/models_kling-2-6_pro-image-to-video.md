> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling 2.6 — Pro image to video API

> Pro image to video with Kling 2.6: request parameters, examples and response handling.

[← Kling 2.6](https://docs.higgsfield.ai/docs/models/kling-2-6.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/v2.6/pro/image-to-video`

**Endpoint ID:** `kling-video/v2.6/pro/image-to-video`

[▶
Open API PlaygroundKling 2.6 · Pro image to video
↗](https://console.higgsfield.ai/models/kling-video%2Fv2.6%2Fpro%2Fimage-to-video/playground)

## Usage notes

* duration accepts 5 or 10 seconds; 5 is the default.
* Native audio uses sound: on or off and defaults to on.
* The example.com media URLs are placeholders. Replace them with public HTTPS URLs to your own media before submitting.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/v2.6/pro/image-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A slow cinematic tracking shot along a sunlit coastal road.",
  "image_url": "https://example.com/first-frame.jpg"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A slow cinematic tracking shot along a sunlit coastal road.',
     'image_url': 'https://example.com/first-frame.jpg'}
)
result = higgsfield_client.subscribe(
    "kling-video/v2.6/pro/image-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/v2.6/pro/image-to-video", {
  input:
    {
      "prompt": "A slow cinematic tracking shot along a sunlit coastal road.",
      "image_url": "https://example.com/first-frame.jpg"
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.video?.url);
}
```

## Input schema

**sound** `string` (default: on)

Enable sound for the output video.
Allowed values: `"on"`, `"off"`.

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Allowed values: `5`, `10`.

**cfg\_scale** `number` (default: 0.5)

Minimum: `0`.
Maximum: `1`.
Multiple of: `0.01`.

**image\_url** `string` *required*

Public URL of the input image.
Format: `uri`.

**aspect\_ratio** `string`

Output width-to-height ratio.
Allowed values: `"16:9"`, `"9:16"`, `"1:1"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Kling 2.6 Playground",
>   "required": [
>     "prompt",
>     "image_url"
>   ],
>   "properties": {
>     "sound": {
>       "enum": [
>         "on",
>         "off"
>       ],
>       "type": "string",
>       "title": "Generate sound",
>       "default": "on"
>     },
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
>     "cfg_scale": {
>       "type": "number",
>       "title": "CFG Scale",
>       "default": 0.5,
>       "maximum": 1,
>       "minimum": 0,
>       "multipleOf": 0.01
>     },
>     "image_url": {
>       "type": "string",
>       "title": "Image URL",
>       "format": "uri"
>     },
>     "aspect_ratio": {
>       "enum": [
>         "16:9",
>         "9:16",
>         "1:1"
>       ],
>       "type": "string",
>       "title": "Aspect ratio"
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

- [Kling 2.6 Motion Control — Pro API](https://docs.higgsfield.ai/docs/models/kling-2-6-motion-control/pro.md)
- [Kling 2.6 — Pro text to video API](https://docs.higgsfield.ai/docs/models/kling-2-6/pro-text-to-video.md)
- [Kling 3.0 — Pro · Image to video API](https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video.md)
- [Kling 2.5 Turbo — Pro image to video API](https://docs.higgsfield.ai/docs/models/kling-2-5-turbo/pro-image-to-video.md)
- [Wan 2.6 — Image to video API](https://docs.higgsfield.ai/docs/models/wan-2-6/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
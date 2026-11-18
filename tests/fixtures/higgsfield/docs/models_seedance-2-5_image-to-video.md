> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Seedance 2.5 — Image to video API

> Image to video with Seedance 2.5: request parameters, examples and response handling.

[← Seedance 2.5](https://docs.higgsfield.ai/docs/models/seedance-2-5.md)

**Endpoint:** `POST https://api.higgsfield.ai/bytedance/seedance-2.5/image-to-video`

**Endpoint ID:** `bytedance/seedance-2.5/image-to-video`

[▶
Open API PlaygroundSeedance 2.5 · Image to video
↗](https://console.higgsfield.ai/models/bytedance%2Fseedance-2.5%2Fimage-to-video/playground)

## Usage notes

* Use publicly accessible media URLs; asset:// references are rejected for these endpoints.
* The prompt is optional. Output framing follows image\_url; end\_image\_url is the optional last frame.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/bytedance/seedance-2.5/image-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "image_url": "https://example.com/input.jpg"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'image_url': 'https://example.com/input.jpg'}
)
result = higgsfield_client.subscribe(
    "bytedance/seedance-2.5/image-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("bytedance/seedance-2.5/image-to-video", {
  input:
    {
      "image_url": "https://example.com/input.jpg"
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

**image\_url** `string` *required*

Public URL of the input image.
Format: `uri`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"480p"`, `"720p"`, `"1080p"`.

**bitrate\_mode** `string` (default: high)

Allowed values: `"standard"`, `"high"`.

**end\_image\_url** `string`

Format: `uri`.

**generate\_audio** `boolean` (default: true)

Generate audio with the video.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "required": [
>     "image_url"
>   ],
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
>     "image_url": {
>       "type": "string",
>       "format": "uri"
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
>     "bitrate_mode": {
>       "enum": [
>         "standard",
>         "high"
>       ],
>       "type": "string",
>       "default": "high"
>     },
>     "end_image_url": {
>       "type": "string",
>       "format": "uri"
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
- [Seedance 2.5 — Reference to video API](https://docs.higgsfield.ai/docs/models/seedance-2-5/reference-to-video.md)
- [Seedance 2.5 — Text to video API](https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video.md)
- [Seedance 2.5 — Video edit API](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-edit.md)
- [Seedance 2.5 — Video extend API](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-extend.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
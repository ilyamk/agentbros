> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Wan 2.6 — Image to video API

> Image to video with Wan 2.6: request parameters, examples and response handling.

[← Wan 2.6](https://docs.higgsfield.ai/docs/models/wan-2-6.md)

**Endpoint:** `POST https://api.higgsfield.ai/wan/v2.6/image-to-video`

**Endpoint ID:** `wan/v2.6/image-to-video`

[▶
Open API PlaygroundWan 2.6 · Image to video
↗](https://console.higgsfield.ai/models/wan%2Fv2.6%2Fimage-to-video/playground)

## Usage notes

* Setting multi\_shots=true also enables prompt\_extend, even if prompt\_extend was false.
* Input images may be resized to fit a 1,440-pixel maximum dimension before generation. A last-frame input is unsupported.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/wan/v2.6/image-to-video \
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
    "wan/v2.6/image-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("wan/v2.6/image-to-video", {
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
Minimum: `-1`.
Maximum: `10000000`.

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Allowed values: `5`, `10`, `15`.

**audio\_url** `string`

Public URL of the audio reference.
Format: `uri`.

**image\_url** `string` *required*

Public URL of the input image.
Format: `uri`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"480p"`, `"720p"`, `"1080p"`.

**multi\_shots** `boolean` (default: false)

See the complete JSON schema below.

**prompt\_extend** `boolean` (default: false)

Enable prompt expansion.

**negative\_prompt** `string`

Content or visual features to avoid.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Wan 2.6 Playground",
>   "required": [
>     "prompt",
>     "image_url"
>   ],
>   "properties": {
>     "seed": {
>       "type": "integer",
>       "maximum": 10000000,
>       "minimum": -1
>     },
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "description": "Write your prompt here"
>     },
>     "duration": {
>       "enum": [
>         5,
>         10,
>         15
>       ],
>       "type": "integer",
>       "title": "Duration",
>       "default": 5
>     },
>     "audio_url": {
>       "type": "string",
>       "title": "Audio URL",
>       "format": "uri"
>     },
>     "image_url": {
>       "type": "string",
>       "title": "Image URL",
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
>     "multi_shots": {
>       "type": "boolean",
>       "default": false
>     },
>     "prompt_extend": {
>       "type": "boolean",
>       "default": false
>     },
>     "negative_prompt": {
>       "type": "string",
>       "title": "Negative prompt",
>       "default": ""
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
- [Wan 2.6 — Reference to video API](https://docs.higgsfield.ai/docs/models/wan-2-6/reference-to-video.md)
- [Wan 2.7 — Image to video API](https://docs.higgsfield.ai/docs/models/wan-2-7/image-to-video.md)
- [Wan 2.6 — Text to video API](https://docs.higgsfield.ai/docs/models/wan-2-6/text-to-video.md)
- [Wan 3.0 — Image to video API](https://docs.higgsfield.ai/docs/models/wan-3/image-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
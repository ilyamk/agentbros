> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Genjutsu — Motion transfer API

> Motion transfer with Genjutsu: request parameters, examples and response handling.

[← Genjutsu](https://docs.higgsfield.ai/docs/models/genjutsu.md)

**Endpoint:** `POST https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0`

**Endpoint ID:** `higgsfield/genjutsu/motion-transfer/v1.0`

[▶
Open API PlaygroundGenjutsu · Motion transfer
↗](https://console.higgsfield.ai/models/higgsfield%2Fgenjutsu%2Fmotion-transfer%2Fv1.0/playground)

## Usage notes

* Use higgsfield/genjutsu/motion-transfer/v1.0 for new integrations. The legacy endpoint higgsfiled/genjutsu/motion-transfer/v1.0 remains callable for existing clients but is hidden from model discovery.
* The source video must be at least 4 seconds. Videos longer than 30 seconds are trimmed to 30 seconds; output duration follows the prepared source video.
* Provide 1–8 image references. The prompt is optional and defaults to an empty string.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0 \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "video_url": "https://example.com/input.mp4",
  "image_urls": [
    "https://example.com/input.jpg"
  ]
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'video_url': 'https://example.com/input.mp4',
     'image_urls': ['https://example.com/input.jpg']}
)
result = higgsfield_client.subscribe(
    "higgsfield/genjutsu/motion-transfer/v1.0",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("higgsfield/genjutsu/motion-transfer/v1.0", {
  input:
    {
      "video_url": "https://example.com/input.mp4",
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

Text instructions for the generation or edit.
Maximum characters: `10000`.

**video\_url** `string` *required*

Public URL of the source video.
Minimum characters: `1`.
Maximum characters: `2083`.
Format: `uri`.

**image\_urls** `array` *required*

Ordered public image reference URLs.
Minimum items: `1`.
Maximum items: `8`.
Each item: string. Minimum characters: `1`. Maximum characters: `2083`. Format: `uri`.

**resolution** `string` (default: 720p)

Output resolution tier.
Allowed values: `"720p"`, `"480p"`, `"1080p"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "MotionTransferParams",
>   "required": [
>     "video_url",
>     "image_urls"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "default": "",
>       "maxLength": 10000
>     },
>     "video_url": {
>       "type": "string",
>       "title": "Video Url",
>       "format": "uri",
>       "maxLength": 2083,
>       "minLength": 1
>     },
>     "image_urls": {
>       "type": "array",
>       "items": {
>         "type": "string",
>         "format": "uri",
>         "maxLength": 2083,
>         "minLength": 1
>       },
>       "title": "Image Urls",
>       "maxItems": 8,
>       "minItems": 1
>     },
>     "resolution": {
>       "enum": [
>         "720p",
>         "480p",
>         "1080p"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "720p"
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

- [Genjutsu API](https://docs.higgsfield.ai/docs/models/genjutsu.md)
- [Higgsfield API](https://docs.higgsfield.ai/docs/index.md)
- [Genjutsu — Restyle API](https://docs.higgsfield.ai/docs/models/genjutsu/restyle.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)
- [Genjutsu — Object swap API](https://docs.higgsfield.ai/docs/models/genjutsu/object-swap.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
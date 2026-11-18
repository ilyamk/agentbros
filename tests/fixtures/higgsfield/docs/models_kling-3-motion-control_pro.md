> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling 3.0 Motion Control — Pro API

> Pro with Kling 3.0 Motion Control: request parameters, examples and response handling.

[← Kling 3.0 Motion Control](https://docs.higgsfield.ai/docs/models/kling-3-motion-control.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/v3/motion-control/pro`

**Endpoint ID:** `kling-video/v3/motion-control/pro`

[▶
Open API PlaygroundKling 3.0 Motion Control · Pro
↗](https://console.higgsfield.ai/models/kling-video%2Fv3%2Fmotion-control%2Fpro/playground)

## Usage notes

* Use a motion-reference video from 3 to 30 seconds long. The output duration follows the source video; do not send a separate duration field.
* Use a character image up to 10 MB with each dimension between 300 and 65,536 pixels. Images outside the 0.4–2.5 width-to-height range are adjusted before generation.
* Videos larger than 100 MB are compressed before generation.
* Set character\_orientation to image or video. keep\_original\_sound uses the strings yes and no, with yes as the default.
* The example.com media URLs are placeholders. Replace them with public HTTPS URLs to your own media before submitting.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/v3/motion-control/pro \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "image_url": "https://example.com/character.jpg",
  "video_url": "https://example.com/motion-reference.mp4"
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'image_url': 'https://example.com/character.jpg',
     'video_url': 'https://example.com/motion-reference.mp4'}
)
result = higgsfield_client.subscribe(
    "kling-video/v3/motion-control/pro",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/v3/motion-control/pro", {
  input:
    {
      "image_url": "https://example.com/character.jpg",
      "video_url": "https://example.com/motion-reference.mp4"
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

**image\_url** `string` *required*

Public URL of the input image.
Format: `uri`.

**video\_url** `string` *required*

Public URL of the source video.
Format: `uri`.

**keep\_original\_sound** `string` (default: yes)

Allowed values: `"yes"`, `"no"`.

**character\_orientation** `string` (default: video)

Generate the orientation of the characters in the video, which can be selected to match the image or the video
Allowed values: `"image"`, `"video"`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Kling V3 Motion Control Playground",
>   "required": [
>     "image_url",
>     "video_url"
>   ],
>   "properties": {
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "default": "",
>       "description": "Write your prompt here"
>     },
>     "image_url": {
>       "type": "string",
>       "title": "Image URL",
>       "format": "uri"
>     },
>     "video_url": {
>       "type": "string",
>       "title": "Video URL",
>       "format": "uri"
>     },
>     "keep_original_sound": {
>       "enum": [
>         "yes",
>         "no"
>       ],
>       "type": "string",
>       "title": "Keep original sound",
>       "default": "yes"
>     },
>     "character_orientation": {
>       "enum": [
>         "image",
>         "video"
>       ],
>       "type": "string",
>       "title": "Character orientation",
>       "default": "video",
>       "description": "Generate the orientation of the characters in the video, which can be selected to match the image or the video"
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

- [Kling 3.0 Motion Control API](https://docs.higgsfield.ai/docs/models/kling-3-motion-control.md)
- [Kling 2.6 Motion Control — Pro API](https://docs.higgsfield.ai/docs/models/kling-2-6-motion-control/pro.md)
- [Kling 3.0 Motion Control — Standard API](https://docs.higgsfield.ai/docs/models/kling-3-motion-control/std.md)
- [Kling 2.6 Motion Control API](https://docs.higgsfield.ai/docs/models/kling-2-6-motion-control.md)
- [Kling 2.6 Motion Control — Standard API](https://docs.higgsfield.ai/docs/models/kling-2-6-motion-control/std.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
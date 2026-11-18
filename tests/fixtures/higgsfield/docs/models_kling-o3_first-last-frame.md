> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling O3 — First last frame API

> First last frame with Kling O3: request parameters, examples and response handling.

[← Kling O3](https://docs.higgsfield.ai/docs/models/kling-o3.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/o3/first-last-frame`

**Endpoint ID:** `kling-video/o3/first-last-frame`

[▶
Open API PlaygroundKling O3 · First last frame
↗](https://console.higgsfield.ai/models/kling-video%2Fo3%2Ffirst-last-frame/playground)

## Usage notes

* first\_frame\_url supplies the starting frame; last\_frame\_url is optional. These names differ from the image\_url and last\_image\_url fields on Kling 3.0 image-to-video.
* For a single shot, set multi\_shots to false and provide prompt. For multiple shots, set multi\_shots to true and provide 1–6 multi\_prompt objects, each containing prompt and a positive integer duration.
* Always include a non-empty top-level prompt, including when using multi\_prompt.
* Each shot prompt is limited to 512 characters. Custom-shot durations are summed for generation and billing; the top-level duration does not override that sum.
* Native audio uses sound: on or off and defaults to off.
* Keep the top-level prompt within 2,500 characters; longer prompts are truncated.
* The example.com media URLs are placeholders. Replace them with public HTTPS URLs to your own media before submitting.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/o3/first-last-frame \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A slow cinematic camera move around the subject in warm evening light.",
  "first_frame_url": "https://example.com/first-frame.jpg",
  "multi_shots": false
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A slow cinematic camera move around the subject in warm evening '
               'light.',
     'first_frame_url': 'https://example.com/first-frame.jpg',
     'multi_shots': False}
)
result = higgsfield_client.subscribe(
    "kling-video/o3/first-last-frame",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/o3/first-last-frame", {
  input:
    {
      "prompt": "A slow cinematic camera move around the subject in warm evening light.",
      "first_frame_url": "https://example.com/first-frame.jpg",
      "multi_shots": false
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.video?.url);
}
```

## Input schema

**mode** `string` (default: pro)

Allowed values: `"std"`, `"pro"`, `"4k"`.

**sound** `string` (default: off)

Enable sound for the output video.
Allowed values: `"on"`, `"off"`.

**prompt** `string`

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `3`.
Maximum: `15`.

**multi\_shots** `boolean` (default: false)

See the complete JSON schema below.

**aspect\_ratio** `string`

Output width-to-height ratio.
Allowed values: `"16:9"`, `"9:16"`, `"1:1"`.

**multi\_prompt** `array`

Minimum items: `1`.
Maximum items: `6`.

**Nested fields**

**multi\_prompt\[].prompt** `string`

Text instructions for the generation or edit.
Maximum characters: `512`.

**multi\_prompt\[].duration** `integer`

Requested output duration in seconds.
Minimum: `1`.
Maximum: `15`.

**last\_frame\_url** `string`

Format: `uri`.

**first\_frame\_url** `string` *required*

Format: `uri`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "if": {
>     "properties": {
>       "multi_shots": {
>         "const": true
>       }
>     }
>   },
>   "else": {
>     "required": [
>       "prompt",
>       "first_frame_url"
>     ]
>   },
>   "then": {
>     "required": [
>       "multi_prompt",
>       "first_frame_url"
>     ]
>   },
>   "type": "object",
>   "title": "Kling O3 Playground",
>   "properties": {
>     "mode": {
>       "enum": [
>         "std",
>         "pro",
>         "4k"
>       ],
>       "type": "string",
>       "default": "pro"
>     },
>     "sound": {
>       "enum": [
>         "on",
>         "off"
>       ],
>       "type": "string",
>       "default": "off"
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
>       "minimum": 3
>     },
>     "multi_shots": {
>       "type": "boolean",
>       "default": false
>     },
>     "aspect_ratio": {
>       "enum": [
>         "16:9",
>         "9:16",
>         "1:1"
>       ],
>       "type": "string"
>     },
>     "multi_prompt": {
>       "type": "array",
>       "items": {
>         "type": "object",
>         "properties": {
>           "prompt": {
>             "type": "string",
>             "maxLength": 512
>           },
>           "duration": {
>             "type": "integer",
>             "maximum": 15,
>             "minimum": 1
>           }
>         }
>       },
>       "maxItems": 6,
>       "minItems": 1
>     },
>     "last_frame_url": {
>       "type": "string",
>       "title": "Last frame URL",
>       "format": "uri"
>     },
>     "first_frame_url": {
>       "type": "string",
>       "title": "First frame URL",
>       "format": "uri"
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

- [Kling Omni — First last frame API](https://docs.higgsfield.ai/docs/models/kling-omni/first-last-frame.md)
- [Kling O3 API](https://docs.higgsfield.ai/docs/models/kling-o3.md)
- [Kling O3 — Image reference API](https://docs.higgsfield.ai/docs/models/kling-o3/image-reference.md)
- [Kling Omni API](https://docs.higgsfield.ai/docs/models/kling-omni.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling 3.0 — Pro · Text to video API

> Pro · Text to video with Kling 3.0: request parameters, examples and response handling.

[← Kling 3.0](https://docs.higgsfield.ai/docs/models/kling-3.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/v3.0/pro/text-to-video`

**Endpoint ID:** `kling-video/v3.0/pro/text-to-video`

[▶
Open API PlaygroundKling 3.0 · Pro · Text to video
↗](https://console.higgsfield.ai/models/kling-video%2Fv3.0%2Fpro%2Ftext-to-video/playground)

## Usage notes

* Always include a non-empty top-level prompt, including when using multi\_prompt. Keep it within 2,500 characters; longer prompts are truncated.
* For custom shots, set multi\_shots to true and provide 1–6 multi\_prompt objects. Each object needs prompt (at most 512 characters) and duration (a positive integer from 1 to 15 seconds).
* Custom-shot durations are summed for generation and billing; the top-level duration does not override that sum. With multi\_shots enabled and no custom shots, the top-level duration is retained.
* Native audio uses sound: on or off and defaults to on.
* elements contains Kling element IDs as decimal strings. Each ID must belong to the account making the request; arbitrary provider IDs are rejected.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/v3.0/pro/text-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A slow cinematic tracking shot along a sunlit coastal road."
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A slow cinematic tracking shot along a sunlit coastal road.'}
)
result = higgsfield_client.subscribe(
    "kling-video/v3.0/pro/text-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/v3.0/pro/text-to-video", {
  input:
    {
      "prompt": "A slow cinematic tracking shot along a sunlit coastal road."
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

**prompt** `string`

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Minimum: `3`.
Maximum: `15`.

**elements** `array`

Each item: string.

**cfg\_scale** `number` (default: 0.5)

Minimum: `0`.
Maximum: `1`.
Multiple of: `0.01`.

**multi\_shots** `boolean` (default: false)

See the complete JSON schema below.

**aspect\_ratio** `string` (default: 16:9)

Output width-to-height ratio.
Allowed values: `"16:9"`, `"9:16"`, `"1:1"`.

**multi\_prompt** `array`

Minimum items: `0`.
Maximum items: `6`.

**Nested fields**

**multi\_prompt\[].prompt** `string`

Text instructions for the generation or edit.
Maximum characters: `512`.

**multi\_prompt\[].duration** `integer`

Requested output duration in seconds.
Minimum: `1`.
Maximum: `15`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Kling 3.0 Playground",
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
>       "type": "integer",
>       "title": "Duration",
>       "default": 5,
>       "maximum": 15,
>       "minimum": 3
>     },
>     "elements": {
>       "type": "array",
>       "items": {
>         "type": "string"
>       }
>     },
>     "cfg_scale": {
>       "type": "number",
>       "title": "CFG Scale",
>       "default": 0.5,
>       "maximum": 1,
>       "minimum": 0,
>       "multipleOf": 0.01
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
>       "type": "string",
>       "title": "Aspect ratio",
>       "default": "16:9"
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
>       "minItems": 0
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

- [Kling 2.6 — Pro text to video API](https://docs.higgsfield.ai/docs/models/kling-2-6/pro-text-to-video.md)
- [Kling 3.0 — 4K · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/4k-text-to-video.md)
- [Kling 3.0 — Pro · Image to video API](https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video.md)
- [Kling 3.0 — Standard · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video.md)
- [Kling 3.0 — Turbo · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/turbo-text-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
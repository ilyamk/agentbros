> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Kling 2.5 Turbo — Pro text to video API

> Pro text to video with Kling 2.5 Turbo: request parameters, examples and response handling.

[← Kling 2.5 Turbo](https://docs.higgsfield.ai/docs/models/kling-2-5-turbo.md)

**Endpoint:** `POST https://api.higgsfield.ai/kling-video/v2.5-turbo/pro/text-to-video`

**Endpoint ID:** `kling-video/v2.5-turbo/pro/text-to-video`

[▶
Open API PlaygroundKling 2.5 Turbo · Pro text to video
↗](https://console.higgsfield.ai/models/kling-video%2Fv2.5-turbo%2Fpro%2Ftext-to-video/playground)

## Usage notes

* duration accepts 5 or 10 seconds; 5 is the default.
* This endpoint does not expose a sound or aspect\_ratio field.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/kling-video/v2.5-turbo/pro/text-to-video \
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
    "kling-video/v2.5-turbo/pro/text-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("kling-video/v2.5-turbo/pro/text-to-video", {
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

**prompt** `string` *required*

Write your prompt here

**duration** `integer` (default: 5)

Requested output duration in seconds.
Allowed values: `5`, `10`.

**cfg\_scale** `number` (default: 0.5)

Minimum: `0`.
Maximum: `1`.
Multiple of: `0.01`.

**negative\_prompt** `string`

Content or visual features to avoid.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Kling 2.5 Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
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
>     "negative_prompt": {
>       "type": "string",
>       "title": "Negative Prompt",
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

- [Kling 2.5 Turbo API](https://docs.higgsfield.ai/docs/models/kling-2-5-turbo.md)
- [Kling 2.5 Turbo — Pro image to video API](https://docs.higgsfield.ai/docs/models/kling-2-5-turbo/pro-image-to-video.md)
- [Kling 2.6 — Pro text to video API](https://docs.higgsfield.ai/docs/models/kling-2-6/pro-text-to-video.md)
- [Kling 3.0 — Pro · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/pro-text-to-video.md)
- [Kling 3.0 — Turbo · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/turbo-text-to-video.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
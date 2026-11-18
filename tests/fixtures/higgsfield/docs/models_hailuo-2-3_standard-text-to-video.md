> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Hailuo 2.3 — Standard text to video API

> Standard text to video with Hailuo 2.3: request parameters, examples and response handling.

[← Hailuo 2.3](https://docs.higgsfield.ai/docs/models/hailuo-2-3.md)

**Endpoint:** `POST https://api.higgsfield.ai/minimax/hailuo-2.3/standard/text-to-video`

**Endpoint ID:** `minimax/hailuo-2.3/standard/text-to-video`

[▶
Open API PlaygroundHailuo 2.3 · Standard text to video
↗](https://console.higgsfield.ai/models/minimax%2Fhailuo-2.3%2Fstandard%2Ftext-to-video/playground)

## Usage notes

* This Standard endpoint uses a fixed 768P output resolution; resolution is not a configurable field in the production schema.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/minimax/hailuo-2.3/standard/text-to-video \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement."
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A cinematic wide shot of ocean waves at sunset, with gentle camera '
               'movement.'}
)
result = higgsfield_client.subscribe(
    "minimax/hailuo-2.3/standard/text-to-video",
    arguments=arguments,
)
print(result["video"]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("minimax/hailuo-2.3/standard/text-to-video", {
  input:
    {
      "prompt": "A cinematic wide shot of ocean waves at sunset, with gentle camera movement."
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

**duration** `integer` (default: 6)

Requested output duration in seconds.
Allowed values: `6`, `10`.

**prompt\_optimizer** `boolean` (default: true)

See the complete JSON schema below.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Minimax Hailuo 2.3 Playground",
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
>         6,
>         10
>       ],
>       "type": "integer",
>       "title": "Duration",
>       "default": 6
>     },
>     "prompt_optimizer": {
>       "type": "boolean",
>       "title": "Prompt optimizer",
>       "default": true
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

- [Hailuo 2.3 — Standard image to video API](https://docs.higgsfield.ai/docs/models/hailuo-2-3/standard-image-to-video.md)
- [Kling 3.0 — Standard · Text to video API](https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video.md)
- [Hailuo 2.3 API](https://docs.higgsfield.ai/docs/models/hailuo-2-3.md)
- [Video Generation API](https://docs.higgsfield.ai/docs/models/video-generation.md)
- [Kling 3.0 API](https://docs.higgsfield.ai/docs/models/kling-3.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Recraft V4.1 Pro — Text to image API

> Text to image with Recraft V4.1 Pro: request parameters, examples and response handling.

[← Recraft V4.1 Pro](https://docs.higgsfield.ai/docs/models/recraft-v4-1-pro.md)

**Endpoint:** `POST https://api.higgsfield.ai/recraft/v4.1/pro/text-to-image`

**Endpoint ID:** `recraft/v4.1/pro/text-to-image`

[▶
Open API PlaygroundRecraft V4.1 Pro · Text to image
↗](https://console.higgsfield.ai/models/recraft%2Fv4.1%2Fpro%2Ftext-to-image/playground)

## Usage notes

* This variant accepts only resolution=2k; use the separate standard/Pro endpoint for the other resolution tier.
* colors is an array of objects shaped as \{"rgb": \[R, G, B]}; background\_color is one such object. Every RGB value is an integer 0–255, with exactly three entries.
* output\_format is jpg, png, or webp; default is jpg. No reference-image input is declared.
* prompt must contain 1–10000 characters. Fourteen aspect-ratio values are listed in the schema, including 6:10, 14:10, and 10:14.

## Quick start

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/recraft/v4.1/pro/text-to-image \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data '{
  "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
  "resolution": "2k",
  "aspect_ratio": "1:1",
  "output_format": "png",
  "colors": [
    {
      "rgb": [
        40,
        90,
        150
      ]
    }
  ],
  "background_color": {
    "rgb": [
      245,
      242,
      235
    ]
  }
}'
```

```python Python theme={"theme":{"light":"github-light","dark":"github-dark"}}
import higgsfield_client

arguments = (
    {'prompt': 'A ceramic vase on a wooden table beside a sunlit window, soft '
               'natural shadows, editorial photograph.',
     'resolution': '2k',
     'aspect_ratio': '1:1',
     'output_format': 'png',
     'colors': [{'rgb': [40, 90, 150]}],
     'background_color': {'rgb': [245, 242, 235]}}
)
result = higgsfield_client.subscribe(
    "recraft/v4.1/pro/text-to-image",
    arguments=arguments,
)
print(result["images"][0]["url"])
```

```typescript TypeScript theme={"theme":{"light":"github-light","dark":"github-dark"}}
import { config, higgsfield } from "@higgsfield/client/v2";

config({ credentials: process.env.HF_CREDENTIALS });

const result = await higgsfield.subscribe("recraft/v4.1/pro/text-to-image", {
  input:
    {
      "prompt": "A ceramic vase on a wooden table beside a sunlit window, soft natural shadows, editorial photograph.",
      "resolution": "2k",
      "aspect_ratio": "1:1",
      "output_format": "png",
      "colors": [
        {
          "rgb": [
            40,
            90,
            150
          ]
        }
      ],
      "background_color": {
        "rgb": [
          245,
          242,
          235
        ]
      }
    },
  withPolling: true,
});

if (result.status === "completed") {
  console.log(result.images?.[0]?.url);
}
```

## Input schema

**colors** `array`

Preferred RGB palette for the generated image.

**Nested fields**

**colors\[].rgb** `array` *required*

Minimum items: `3`.
Maximum items: `3`.
Each item: integer. Minimum: `0`. Maximum: `255`.

**prompt** `string` *required*

Write your prompt here
Minimum characters: `1`.
Maximum characters: `10000`.

**resolution** `string` (default: 2k)

Output resolution tier.
Allowed values: `"2k"`.

**aspect\_ratio** `string` (default: 1:1)

Output width-to-height ratio.
Allowed values: `"1:1"`, `"2:1"`, `"1:2"`, `"3:2"`, `"2:3"`, `"4:3"`, `"3:4"`, `"5:4"`, `"4:5"`, `"6:10"`, `"14:10"`, `"10:14"`, `"16:9"`, `"9:16"`.

**output\_format** `string` (default: jpg)

Output file format.
Allowed values: `"jpg"`, `"png"`, `"webp"`.

**background\_color** `object`

Preferred RGB background color.

**Nested fields**

**background\_color.rgb** `array` *required*

Minimum items: `3`.
Maximum items: `3`.
Each item: integer. Minimum: `0`. Maximum: `255`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "type": "object",
>   "title": "Recraft V4.1 Pro Playground",
>   "required": [
>     "prompt"
>   ],
>   "properties": {
>     "colors": {
>       "type": "array",
>       "items": {
>         "type": "object",
>         "required": [
>           "rgb"
>         ],
>         "properties": {
>           "rgb": {
>             "type": "array",
>             "items": {
>               "type": "integer",
>               "maximum": 255,
>               "minimum": 0
>             },
>             "maxItems": 3,
>             "minItems": 3
>           }
>         }
>       },
>       "title": "Colors"
>     },
>     "prompt": {
>       "type": "string",
>       "title": "Prompt",
>       "maxLength": 10000,
>       "minLength": 1,
>       "description": "Write your prompt here"
>     },
>     "resolution": {
>       "enum": [
>         "2k"
>       ],
>       "type": "string",
>       "title": "Resolution",
>       "default": "2k"
>     },
>     "aspect_ratio": {
>       "enum": [
>         "1:1",
>         "2:1",
>         "1:2",
>         "3:2",
>         "2:3",
>         "4:3",
>         "3:4",
>         "5:4",
>         "4:5",
>         "6:10",
>         "14:10",
>         "10:14",
>         "16:9",
>         "9:16"
>       ],
>       "type": "string",
>       "title": "Aspect ratio",
>       "default": "1:1"
>     },
>     "output_format": {
>       "enum": [
>         "jpg",
>         "png",
>         "webp"
>       ],
>       "type": "string",
>       "title": "Output format",
>       "default": "jpg"
>     },
>     "background_color": {
>       "type": "object",
>       "title": "Background color",
>       "required": [
>         "rgb"
>       ],
>       "properties": {
>         "rgb": {
>           "type": "array",
>           "items": {
>             "type": "integer",
>             "maximum": 255,
>             "minimum": 0
>           },
>           "maxItems": 3,
>           "minItems": 3
>         }
>       }
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
  "images": [
    {
      "url": "https://example.com/output.png"
    }
  ]
}
```

See [idempotent requests](https://docs.higgsfield.ai/docs/concepts/idempotency.md), [polling](https://docs.higgsfield.ai/docs/concepts/polling.md), [request errors](https://docs.higgsfield.ai/docs/concepts/errors.md) and [authentication](https://docs.higgsfield.ai/docs/authentication.md) for shared request handling.


## Related topics

- [Recraft V4.1 Utility Pro — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1-utility-pro/text-to-image.md)
- [Recraft V4.1 Pro API](https://docs.higgsfield.ai/docs/models/recraft-v4-1-pro.md)
- [Recraft V4.1 Utility Pro API](https://docs.higgsfield.ai/docs/models/recraft-v4-1-utility-pro.md)
- [Recraft V4.1 — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1/text-to-image.md)
- [Recraft V4.1 Utility — Text to image API](https://docs.higgsfield.ai/docs/models/recraft-v4-1-utility/text-to-image.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.higgsfield.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Soul ID — Create character API

> Create character with Soul ID: request parameters, examples and response handling.

[← Soul ID](https://docs.higgsfield.ai/docs/models/soul-id.md)

**Endpoint:** `POST https://api.higgsfield.ai/v1/custom-references`

**Catalog ID:** `soul-id`

## Usage notes

* Soul ID trains a reusable character reference. This is not an image-generation endpoint; do not POST to /soul-id.
* Use POST /v1/custom-references with application/json. name has a maximum length of 100; input\_images must contain 1–100 \{"type":"image\_url","image\_url":"..."} objects.
* model\_version accepts v1, v2, cinema; its default is v1. Choose the matching generation family.
* The creation response returns id and status. Poll GET /v1/custom-references/\{id}; statuses are not\_ready, queued, in\_progress, completed, and failed.
* After completion, pass the returned id as custom\_reference\_id to the matching Soul generation endpoint. References are scoped to the account that created them.
* When the account already has the maximum number of references in training, creation returns 429 Too Many Requests with a Retry-After header. Retry after that delay; nothing is charged for the rejected request.

## Quick start

Replace the example media URLs with publicly accessible URLs for your own files before submitting.

```bash cURL theme={"theme":{"light":"github-light","dark":"github-dark"}}
curl --request POST \
  --url https://api.higgsfield.ai/v1/custom-references \
  --header "Authorization: Key ${HF_API_KEY_ID}:${HF_API_KEY_SECRET}" \
  --header "Content-Type: application/json" \
  --data '{
  "name": "My character",
  "model_version": "v2",
  "input_images": [
    {
      "type": "image_url",
      "image_url": "https://example.com/portrait-front.jpg"
    },
    {
      "type": "image_url",
      "image_url": "https://example.com/portrait-side.jpg"
    },
    {
      "type": "image_url",
      "image_url": "https://example.com/portrait-outdoors.jpg"
    }
  ]
}'
```

## Input schema

**name** `string` *required*

Name of the character reference.
Maximum characters: `100`.

**model\_version** `string` (default: v1)

SOUL family that will use this character reference.
Allowed values: `"v1"`, `"v2"`, `"cinema"`.

**input\_images** `array` *required*

Training images supplied as public URL objects.
Minimum items: `1`.
Maximum items: `100`.

**Nested fields**

**input\_images\[].type** `string` *required*

Must be `"image_url"`.

**input\_images\[].image\_url** `string` *required*

Public URL of the input image.
Minimum characters: `1`.
Maximum characters: `2083`.
Format: `uri`.

> [accordion] Complete JSON schema
>
> ```json theme={"theme":{"light":"github-light","dark":"github-dark"}}
> {
>   "$defs": {
>     "ImageUrlInputImageSchema": {
>       "properties": {
>         "type": {
>           "const": "image_url",
>           "title": "Type",
>           "type": "string"
>         },
>         "image_url": {
>           "format": "uri",
>           "maxLength": 2083,
>           "minLength": 1,
>           "title": "Image Url",
>           "type": "string"
>         }
>       },
>       "required": [
>         "type",
>         "image_url"
>       ],
>       "title": "ImageUrlInputImageSchema",
>       "type": "object"
>     },
>     "SoulModelVersion": {
>       "enum": [
>         "v1",
>         "v2",
>         "cinema"
>       ],
>       "title": "SoulModelVersion",
>       "type": "string"
>     }
>   },
>   "properties": {
>     "name": {
>       "maxLength": 100,
>       "title": "Name",
>       "type": "string"
>     },
>     "model_version": {
>       "$ref": "#/$defs/SoulModelVersion",
>       "default": "v1"
>     },
>     "input_images": {
>       "items": {
>         "$ref": "#/$defs/ImageUrlInputImageSchema"
>       },
>       "maxItems": 100,
>       "minItems": 1,
>       "title": "Input Images",
>       "type": "array"
>     }
>   },
>   "required": [
>     "name",
>     "input_images"
>   ],
>   "title": "CreateCustomReferenceSchema",
>   "type": "object"
> }
> ```

## Response

The response is a character reference with `id`, `name`, `model_version`, `status`, `thumbnail_url`, `created_at`, `in_progress_at` and `fail_reason`.

Poll `GET https://api.higgsfield.ai/v1/custom-references/{id}` with the same API credentials. Training states are `not_ready`, `queued`, `in_progress`, `completed` and `failed`.

After `completed`, pass the reference `id` as `custom_reference_id` to the matching SOUL generation workflow. The reference must belong to your account. Training does not return `request_id` or generated `images`.


## Related topics

- [Soul ID API](https://docs.higgsfield.ai/docs/models/soul-id.md)
- [SOUL — Text to image API](https://docs.higgsfield.ai/docs/models/soul-standard/generate.md)
- [SOUL Cinema — Text to image API](https://docs.higgsfield.ai/docs/models/soul-cinema/generate.md)
- [SOUL V2 — Text to image API](https://docs.higgsfield.ai/docs/models/soul-2/generate.md)
- [Image Generation API](https://docs.higgsfield.ai/docs/models/image-generation.md)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.
# Catalogue videos

Last updated: 2026-11-16

## Start

Produce one accountable video draft per selected product row. Use [campaign production](../../docs/campaign-production.md) to author the request.

```bash
pnpm campaign:production --project <id> --action plan --request <file>
pnpm campaign:production --project <id> --action init --request <file>
pnpm next --project <id>
```

## What good looks like

Every SKU resolves to its own facts and original material. A failed row is visible and does not silently inherit the previous product’s image, price or disclosure.

## Method

1. Map CSV, TSV or JSON columns explicitly. Require stable product IDs and reject duplicate or incomplete rows before creating projects. Use {{memberId}}/{{projectId}} for internal names and {{productId}} for the original SKU.
2. Check product names, prices, units, affiliate disclosures and source media independently. Missing evidence becomes an intake question.
3. Bind the chosen row set to a reusable format. Allocate pre-creation shared materials to the campaign owner and import verified consumer copies.
4. Run the queue and inspect failures by SKU. Repair the affected member rather than restarting unrelated completed products.
5. Use batch review filters to compare product/factor combinations, then collect output approvals and per-child delivery reports.

## Tools

Catalogue parsing, source-bound product-ad workflows and the asset registry supply the production inputs. Local processing and renderer receipts establish technical correspondence; specialists assess the selling story.

Pilot the longest title, incomplete row and unusual image before processing the catalogue. Strict assurance binds each original SKU to its source field and authored text; repair only the affected goods.

## Anti-patterns

Never fabricate a benefit to fill a blank cell, use one generic product plate for different goods or hide rejected rows in a successful batch count.

## References

[Guide](../../docs/campaign-production.md).

## Done when

Every selected row has an exact output or an explicit blocker, and no product or billing owner is counted twice.

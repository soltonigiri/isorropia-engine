# Contributing

Use Node.js 24 or newer and install the locked dependencies with `npm ci`.

## Code changes

Keep the public CLI to `pair`, `catalog`, and `validate`. Preserve deterministic JSON and the fixed disclaimer. Run the smallest relevant test first, then `npm run check` for implementation or curated-data changes. Changes to artifact generation also require `npm run artifacts`; package-surface changes require `npm pack --dry-run`.

## Pair review

Pairing corrections should name both SCPs, the mode, the relevant article revisions, and the source passages that support acceptance or rejection. A `cycle` needs mutual constraint or balance, not a loop that only repeats or worsens failure. Review multiple modes when a correction changes the qualitative database.

## Data and attribution

Do not add fetched article text. Put generated candidates under `data/candidates/`; promotion requires human review of semantic claims, interactions, attribution, revision IDs, schema validity, and resulting rankings. Attribution corrections should cite the official page-level metadata and distinguish verified authorship from unresolved historical entries.

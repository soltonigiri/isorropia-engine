# Isorropía Engine

An explainable anomaly-pairing engine for containment cycles, catastrophic interactions, and suspiciously good double features.

Give it one SCP. It returns up to five supported, non-canonical pairing hypotheses with deterministic scores, confidence, rules, and source evidence.

<!-- ●●|●●●●●|●●|● -->

## Requirements

- Node.js 24 or newer

## Setup

```bash
npm install
npm run build
node dist/cli.js pair scp-3984 --mode cycle
```

After package installation, the executable name is `isorropia`:

```bash
isorropia pair scp-3984 --mode cycle
isorropia pair scp-008 --mode breach --json
isorropia pair scp-4010 --mode double-feature
```

The normal command uses only the curated local dataset. It does not call an LLM or an external service.
Interactive terminals use a width-aware rich layout; pipes and narrow terminals keep the compact plain-text format.

### Modes

- `cycle`: effects that may constrain or balance each other
- `breach`: effects that may amplify or propagate a containment failure
- `double-feature`: articles with related effects, themes, triggers, or source links

Every result is labeled `Containment hypothesis — not canonical.`

### SCP-914 settings

`--setting rough|coarse|1:1|fine|very-fine` filters results by minimum confidence. It never changes scoring. The default is `1:1`; use `rough` to inspect metadata-only signals that are excluded from normal recommendations.

## Data

The dataset contains 100 structurally validated SCP EN profiles. Article-grounded semantic claims and reviewed pair interactions are stored separately from metadata-derived fallback signals. Confidence measures source support, while score measures the strength and discovery value of the pairing.

```text
data/
├── profiles/          # curated profiles used by the CLI
├── candidates/        # unaccepted refresh proposals
├── curation.json      # fixed 100-page selection and maintained effect mappings
├── edges.jsonl        # explicit links among selected articles
├── semantics.json     # article-grounded effects, dependencies, and reading traits
├── interactions.json  # accepted hypotheses and reviewed negative pairs
├── golden-pairs.json # positive and negative acceptance examples
├── manifest.json     # source revisions and attribution
├── rules.json        # deterministic scoring rules
└── tag-effects.json  # official-tag to effect mapping
```

Refresh checks access the SCP Data API directly:

```bash
npm run refresh -- --check
npm run refresh
```

Changed pages are written under `data/candidates/`. Curated files under `data/profiles/` are not overwritten.

The primary API supplies the initial creator field. To apply author overrides and co-author entries from the SCP Wiki's official Attribution Metadata without making it part of the refresh dependency chain, run `npm run attribution -- --apply`. An unavailable auxiliary response leaves the existing attribution unchanged.

## Validation and artifacts

```bash
npm run check
npm run artifacts
```

`npm run artifacts` validates the dataset before generating:

- `release/isorropia-data.json.gz`
- `release/isorropia.sqlite`

Both artifacts include a precomputed ranking index. Runtime clients only look up a page and mode, filter by confidence, and apply the requested limit; qualitative analysis is never performed at runtime.

## License

The code is MIT licensed. SCP-derived profiles, quotations, and metadata are distributed under CC BY-SA 3.0 with per-page attribution in `data/manifest.json`. This is an unofficial project and is not endorsed by the SCP Wiki.

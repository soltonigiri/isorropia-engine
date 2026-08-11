# Isorropía Engine

An explainable anomaly-pairing engine for containment cycles, catastrophic interactions, and suspiciously good double features.

Give it one SCP. It returns five non-canonical pairing hypotheses with deterministic scores, confidence, rules, and source evidence.

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

### Modes

- `cycle`: effects that may constrain or balance each other
- `breach`: effects that may amplify or propagate a containment failure
- `double-feature`: articles with related effects, themes, triggers, or source links

Every result is labeled `Containment hypothesis — not canonical.`

### SCP-914 settings

`--setting rough|coarse|1:1|fine|very-fine` filters results by minimum confidence. It never changes scoring.

## Data

The MVP contains 100 curated and structurally validated SCP EN profiles. Each effect points to an SCP Data API revision and either a source locator or an official metadata tag. Profiles and rules are ordinary JSON so proposed changes remain reviewable.

```text
data/
├── profiles/          # curated profiles used by the CLI
├── candidates/        # unaccepted refresh proposals
├── curation.json      # fixed 100-page selection and focus tags
├── edges.jsonl        # explicit links among selected articles
├── golden-pairs.json # acceptance examples
├── manifest.json     # source revisions and attribution
├── rules.json        # deterministic scoring rules
└── tag-effects.json  # official-tag to effect mapping
```

Refresh checks access the SCP Data API directly:

```bash
npm run refresh -- --check
npm run refresh
```

Changed pages are written under `data/candidates/`. Curated files under `data/profiles/` are not overwritten. A data-refresh pull request remains a draft until a reviewer verifies the evidence and promotes the accepted candidate into `data/profiles/`.

The primary API supplies the initial creator field. To apply author overrides and co-author entries from the SCP Wiki's official Attribution Metadata without making it part of the refresh dependency chain, run `npm run attribution -- --apply`. An unavailable auxiliary response leaves the existing attribution unchanged.

## Validation and artifacts

```bash
npm run check
npm run artifacts
```

`npm run artifacts` validates the dataset before generating:

- `release/isorropia-data.json.gz`
- `release/isorropia.sqlite`

## License

The code is MIT licensed. SCP-derived profiles, quotations, and metadata are distributed under CC BY-SA 3.0 with per-page attribution in `data/manifest.json`. This is an unofficial project and is not endorsed by the SCP Wiki.

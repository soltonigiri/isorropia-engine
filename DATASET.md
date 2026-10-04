# Dataset

The bundled dataset contains 100 curated SCP EN profiles. Each profile is compiled from reviewed semantic claims with article revision, section, and source locator. Full article text is not distributed.

## Selection and review

The initial catalog is fixed. Expansion candidates must satisfy `data/selection-policy.json`, have resolvable attribution, and produce at least one support A-C reviewed interaction before promotion. Candidate files are never promoted automatically.

Semantic profiles use the versioned ontology and analysis policy in `data/semantic-ontology.json` and `data/analysis-policy.json`. They record source coverage, analyzed chunks, and the extraction-policy digest. A policy change schedules the affected profile for regeneration instead of silently reusing stale analysis.

An interaction is either accepted or rejected for one mode. `cycle` requires mutual counteraction, constraint, or balance; a self-reinforcing failure or repeated reset is not sufficient. Support grades mean:

- A: the relationship is directly supported
- B: a tight inference connects both articles
- C: a conditional interpretation with an explicit assumption or limitation

Candidate retrieval is mode-specific and uses semantic claims and reading structure rather than catalog tags. Every stored interaction records semantic, candidate-policy, and review-policy digests. Accepted interactions also require a mode-specific proof and a separate verification pass. The proof determines the maximum support grade; model-supplied numeric scores are not stored.

## Score and confidence

`data/scoring-policy.json` is the source of scoring thresholds, rubric points, confidence values, fallback caps, and tie order. The rule version also includes the executable scoring and ranking contract. Reviewed scores combine mode fit, coherence, specificity, and discovery value. Confidence describes evidential support and is not the same as score.

The default setting excludes unreviewed fallback matches. `rough` exposes them as weaker signals with an evidence grade. Identical input, database version, and rule version produce byte-identical JSON.

## Artifacts and attribution

`npm run artifacts` creates compressed JSON and SQLite from the same validated source. Artifact metadata records the schema, tool, database, rule, analysis-policy digests, ranking setting, confidence threshold, and source revision when available.

Every profile has a CC BY-SA 3.0 attribution entry. `verified` means the stored author list is resolved; `unresolved` is retained for existing historical entries and is reported explicitly. The dataset inherits the limitations of article selection, available source text, and human qualitative review.

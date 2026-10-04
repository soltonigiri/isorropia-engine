import { createHash } from 'node:crypto';
import {
  CANDIDATE_CONTRACT_VERSION,
  MODE_REVIEW_CONTRACT_VERSIONS,
  QUALITATIVE_CONTRACT,
  SOURCE_CONTRACT_VERSION,
} from './contracts.js';
import type {
  AnalysisPolicy,
  Mode,
  SemanticProfile,
  SemanticOntology,
} from './types.js';

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

export function interactionSemanticDigest(semantic: SemanticProfile): string {
  return stableDigest({
    page_id: semantic.page_id,
    source_revision: semantic.source_revision,
    schema_version: semantic.schema_version,
    claims: semantic.claims,
    reading: semantic.reading,
    coverage: semantic.coverage,
  });
}

export function analysisPolicyDigests(options: {
  policy: AnalysisPolicy;
  ontology: SemanticOntology;
}): {
  source: string;
  semantic: string;
  candidate: string;
  review: string;
  review_modes: Record<Mode, string>;
} {
  const legacyReview = stableDigest({
    review: options.policy.review,
    review_contract: QUALITATIVE_CONTRACT.review,
  });
  const reviewModes: Record<Mode, string> = {
    cycle: stableDigest({
      review: options.policy.review,
      review_contract: QUALITATIVE_CONTRACT.review,
      mode: 'cycle',
      mode_version: MODE_REVIEW_CONTRACT_VERSIONS.cycle,
    }),
    breach: stableDigest({
      review: options.policy.review,
      review_contract: QUALITATIVE_CONTRACT.review,
      mode: 'breach',
      mode_version: MODE_REVIEW_CONTRACT_VERSIONS.breach,
    }),
    'double-feature': legacyReview,
  };
  return {
    source: stableDigest({
      contract_version: SOURCE_CONTRACT_VERSION,
      policy: options.policy.source,
    }),
    semantic: stableDigest({
      source_contract_version: SOURCE_CONTRACT_VERSION,
      source_policy: options.policy.source,
      ontology: options.ontology,
      extraction_contract: QUALITATIVE_CONTRACT.extraction,
    }),
    candidate: stableDigest({
      contract_version: CANDIDATE_CONTRACT_VERSION,
      policy: options.policy.candidates,
    }),
    review: stableDigest(reviewModes),
    review_modes: reviewModes,
  };
}

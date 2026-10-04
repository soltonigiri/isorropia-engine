import { createHash } from 'node:crypto';
import type { Mode } from './types.js';

export const SOURCE_CONTRACT_VERSION = 6;
export const SEMANTIC_CONTRACT_VERSION = 5;
export const CANDIDATE_CONTRACT_VERSION = 4;
export const REVIEW_CONTRACT_VERSION = 4;
export const SCORING_CONTRACT_VERSION = 2;
export const RANKING_CONTRACT_VERSION = 2;

export const EXTRACTION_MODEL = 'gpt-5.6-terra';
export const JUDGEMENT_MODEL = 'gpt-5.6-sol';
export const VERIFICATION_MODEL = 'gpt-5.6-sol';

export const QUALITATIVE_CONTRACT = {
  extraction: {
    version: SEMANTIC_CONTRACT_VERSION,
    model: EXTRACTION_MODEL,
  },
  review: {
    version: REVIEW_CONTRACT_VERSION,
    proposer_model: JUDGEMENT_MODEL,
    verifier_model: VERIFICATION_MODEL,
  },
} as const;

export const MODE_REVIEW_CONTRACT_VERSIONS: Record<Mode, number> = {
  cycle: 5,
  breach: 2,
  'double-feature': 1,
};

export function qualitativeReviewContractDigest(mode: Mode): string {
  if (mode === 'double-feature') return digest(QUALITATIVE_CONTRACT.review);
  return digest({
    ...QUALITATIVE_CONTRACT.review,
    mode,
    mode_version: MODE_REVIEW_CONTRACT_VERSIONS[mode],
  });
}

export function qualitativeContractDigests(): { extraction: string; review: string } {
  return {
    extraction: digest(QUALITATIVE_CONTRACT.extraction),
    review: digest(QUALITATIVE_CONTRACT.review),
  };
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

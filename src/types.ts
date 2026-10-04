export const MODES = ['cycle', 'breach', 'double-feature'] as const;

export type Mode = (typeof MODES)[number];

export type Evidence = {
  revision: number;
  section: string;
  locator: string;
};

export type Effect = {
  domain: string;
  operation: string;
  target: string;
  trigger: string;
  persistence: string;
  constraints: string[];
  evidence: Evidence;
};

export type Profile = {
  page_id: string;
  scp_number: number;
  wikidot_page_id: string;
  title: string;
  url: string;
  authors: string[];
  language: 'en';
  source_revision: number;
  series?: string;
  tags: string[];
  themes: string[];
  effects: Effect[];
  known_not?: string[];
  curated: true;
};

export type SemanticClaimKind = 'effect' | 'dependency' | 'narrative';

export type SemanticClaim = {
  id: string;
  kind: SemanticClaimKind;
  domain: string;
  operation: string;
  subject?: string;
  target?: string;
  vector?: string;
  trigger?: string;
  scope?: string;
  persistence?: string;
  outcomes: string[];
  preconditions: string[];
  limitations: string[];
  evidence: Evidence[];
  role: string;
  operation_class: string;
  domain_class: string;
  affected_state: string;
  direction: string;
  raw_operation?: string;
  raw_domain?: string;
  chunk_ids: string[];
};

export type ReadingProfile = {
  themes: string[];
  forms: string[];
  structures: string[];
  tones: string[];
  motifs: string[];
  moves?: ReadingMove[];
};

export type ReadingMoveKind = 'premise' | 'escalation' | 'reversal' | 'reframing' | 'ending';

export type ReadingMove = {
  kind: ReadingMoveKind;
  description: string;
  evidence: Evidence[];
  chunk_ids: string[];
};

export type SourceCoverage = {
  status: 'complete' | 'partial';
  source_digest: string;
  analyzed_chunk_ids: string[];
  unresolved_features: string[];
};

type SemanticProfileContent = {
  page_id: string;
  source_revision: number;
  claims: SemanticClaim[];
  reading?: ReadingProfile;
};

export type ExtractedSemanticProfile = SemanticProfileContent & {
  /** Private model-runner receipt. Removed before a profile is persisted. */
  extraction_chunk_id?: string;
};

export type SemanticProfile = SemanticProfileContent & {
  reviewed_modes: Mode[];
  schema_version: 2;
  coverage: SourceCoverage;
  semantic_policy_digest: string;
};

export type ProofLink = {
  from_page: string;
  from_claim: string;
  to_page: string;
  to_claim: string;
  relation: string;
};

export type CycleProof = {
  mode: 'cycle';
  pattern: 'mutual-counteraction' | 'shared-state-balance';
  links: ProofLink[];
  shared_state?: string;
  directions?: [string, string];
  bridge_assumptions: string[];
};

export type BreachProof = {
  mode: 'breach';
  relation:
    | 'activates'
    | 'disables-safeguard'
    | 'propagates'
    | 'increases-reach'
    | 'increases-severity'
    | 'increases-duration'
    | 'removes-required-resource';
  direction: [string, string];
  links: ProofLink[];
  bridge_assumptions: string[];
};

export type DoubleFeatureProof = {
  mode: 'double-feature';
  relation: 'contrast' | 'inversion' | 'progression' | 'reframing';
  anchors: Array<{ page_id: string; claim_refs: string[] }>;
  reading_order: [string, string] | 'order-neutral';
  ordering_gain: string;
  replacement_test: string;
  bridge_assumptions: string[];
};

export type ModeProof = CycleProof | BreachProof | DoubleFeatureProof;

export type InteractionRubric = {
  mode_fit: 'core' | 'strong' | 'partial';
  coherence: 'complete' | 'conditional' | 'thematic';
  specificity: 'article-specific' | 'domain-specific' | 'generic';
  discovery_value: 'high' | 'medium' | 'low';
};

type InteractionBase = {
  id: string;
  pages: [string, string];
  mode: Mode;
  source_revisions: Record<string, number>;
  semantic_digests: Record<string, string>;
  candidate_policy_digest: string;
  review_policy_digest: string;
};

export type AcceptedInteraction = InteractionBase & {
  verdict: 'accepted';
  mechanism: string;
  claim_refs: Record<string, string[]>;
  causal_chain: string[];
  explanation: string;
  assumption?: string;
  limitation?: string;
  rubric: InteractionRubric;
  support: 'A' | 'B' | 'C';
  proof: ModeProof;
};

export type RejectedInteraction = InteractionBase & {
  verdict: 'rejected';
  reason: string;
};

export type PairInteraction = AcceptedInteraction | RejectedInteraction;

export type Edge = {
  from: string;
  to: string;
  type: 'explicit_link' | 'shared_entity' | 'same_series';
  evidence: Evidence;
};

export type RuleMatcher =
  | {
      type: 'operation_pair';
      left: string[];
      right: string[];
    }
  | { type: 'same_domain' }
  | { type: 'different_operation_same_domain' }
  | { type: 'shared_tag'; minimum: number }
  | { type: 'shared_theme'; minimum: number }
  | { type: 'same_trigger' }
  | { type: 'same_persistence' }
  | { type: 'same_series' }
  | { type: 'explicit_link' };

export type Rule = {
  id: string;
  mode: Mode;
  weight: number;
  description: string;
  matcher: RuleMatcher;
};

export type AttributionEntry = {
  page_id: string;
  title: string;
  url: string;
  authors: string[];
  revision: number;
  license: 'CC BY-SA 3.0';
  status: 'verified' | 'unresolved';
};

export type DatasetManifest = {
  database_version: string;
  generated_at: string;
  source: string;
  profile_count: number;
  attributions: AttributionEntry[];
};

export type SelectionPolicy = {
  version: number;
  weekly_analysis_limit: number;
  eligibility: {
    domain: 'scp-wiki.wikidot.com';
    required_tag: 'scp';
    minimum_rating: number;
    minimum_age_days: number;
    require_content_file: true;
    require_attribution: true;
  };
  weights: {
    rating_percentile: number;
    tag_novelty: number;
    reference_adjacency: number;
    series_underrepresentation: number;
  };
};

export type GoldenCase = {
  id: string;
  mode: Mode;
  left: string;
  right?: string;
  expectation?: 'include' | 'exclude' | 'empty';
  minimum_score?: number;
  maximum_rank?: number;
  required_rule?: string;
};

export type ScoringPolicy = {
  version: number;
  setting_thresholds: {
    rough: number;
    coarse: number;
    '1:1': number;
    fine: number;
    'very-fine': number;
  };
  rubric_points: {
    mode_fit: Record<InteractionRubric['mode_fit'], number>;
    coherence: Record<InteractionRubric['coherence'], number>;
    specificity: Record<InteractionRubric['specificity'], number>;
    discovery_value: Record<InteractionRubric['discovery_value'], number>;
  };
  support_confidence: Record<'A' | 'B' | 'C', number>;
  fallback: {
    article_both: { score_cap: number; confidence: number };
    article_one: { score_cap: number; confidence: number };
    metadata_only: { score_cap: number; confidence: number };
  };
  tie_break: ['score-desc', 'confidence-desc', 'page-id-asc'];
};

export type SemanticOntology = {
  version: number;
  claim_roles: string[];
  directions: string[];
  reading_moves: ReadingMoveKind[];
  domains: Record<string, string[]>;
  operations: Record<string, string[]>;
  affected_states: Record<string, string[]>;
};

export type AnalysisPolicy = {
  version: number;
  source: {
    maximum_depth: number;
    maximum_segments: number;
    maximum_characters: number;
  };
  candidates: {
    per_mode_limit: number;
    mode_weights: Record<Mode, Record<string, number>>;
  };
  review: {
    batch_size: number;
    maximum_b_bridges: number;
    maximum_c_bridges: number;
  };
};

export type Dataset = {
  profiles: Profile[];
  rules: Rule[];
  edges: Edge[];
  semantics: SemanticProfile[];
  interactions: PairInteraction[];
  selectionPolicy: SelectionPolicy;
  scoringPolicy: ScoringPolicy;
  semanticOntology: SemanticOntology;
  analysisPolicy: AnalysisPolicy;
  manifest: DatasetManifest;
  golden: GoldenCase[];
};

export type MatchedRule = {
  id: string;
  weight: number;
  explanation: string;
};

export type PairResult = {
  page_id: string;
  title: string;
  url: string;
  score: number;
  confidence: number;
  rules: MatchedRule[];
  evidence: {
    query: Evidence;
    candidate: Evidence;
  };
  causal_chain?: string[];
  assumption?: string;
  limitation?: string;
  basis:
    | {
        kind: 'reviewed-interaction';
        support_grade: AcceptedInteraction['support'];
        score_components: {
          mode_fit: number;
          coherence: number;
          specificity: number;
          discovery_value: number;
        };
      }
    | {
        kind: 'rule-fallback';
        evidence_grade: 'article-both' | 'article-one' | 'metadata-only';
      };
};

export type PairResponse = {
  query: {
    page_id: string;
    title: string;
    url: string;
  };
  mode: Mode;
  database_version: string;
  rule_version: string;
  results: PairResult[];
  known_not?: string[];
  disclaimer: typeof DISCLAIMER;
};

export type PairInspectionStatus =
  | 'accepted'
  | 'rejected'
  | 'weak-signal'
  | 'unreviewed';

export type PairInspectionResponse = {
  query: PairResponse['query'];
  candidate: PairResponse['query'];
  mode: Mode;
  status: PairInspectionStatus;
  database_version: string;
  rule_version: string;
  result?: PairResult;
  reason?: string;
  disclaimer: typeof DISCLAIMER;
};

export const DISCLAIMER = 'Containment hypothesis — not canonical.' as const;

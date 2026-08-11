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
};

export type DatasetManifest = {
  database_version: string;
  generated_at: string;
  source: string;
  profile_count: number;
  attributions: AttributionEntry[];
};

export type GoldenCase = {
  id: string;
  mode: Mode;
  left: string;
  right: string;
  minimum_score: number;
  required_rule?: string;
};

export type Dataset = {
  profiles: Profile[];
  rules: Rule[];
  edges: Edge[];
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

export const DISCLAIMER = 'Containment hypothesis — not canonical.' as const;

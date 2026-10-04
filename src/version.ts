import { createHash } from 'node:crypto';
import type {
  Edge,
  PairInteraction,
  Profile,
  SemanticProfile,
  SemanticOntology,
  AnalysisPolicy,
} from './types.js';

export type DatabaseVersionInput = {
  profiles: Profile[];
  edges: Edge[];
  semantics: SemanticProfile[];
  interactions: PairInteraction[];
  semanticOntology: SemanticOntology;
  analysisPolicy: AnalysisPolicy;
};

export function calculateDatabaseVersion(input: DatabaseVersionInput): string {
  const versionInput = JSON.stringify({
    profiles: input.profiles.map(({ authors: _authors, ...profile }) => profile),
    edges: input.edges,
    semantics: input.semantics,
    interactions: input.interactions,
    semantic_ontology: input.semanticOntology,
    analysis_policy: input.analysisPolicy,
  });
  return createHash('sha256').update(versionInput).digest('hex').slice(0, 12);
}

import { createHash } from 'node:crypto';
import type {
  Edge,
  PairInteraction,
  Profile,
  SemanticProfile,
} from './types.js';

export function calculateDatabaseVersion(
  profiles: Profile[],
  edges: Edge[],
  semantics: SemanticProfile[] = [],
  interactions: PairInteraction[] = [],
): string {
  const versionInput = JSON.stringify({
    profiles: profiles.map(({ authors: _authors, ...profile }) => profile),
    edges,
    semantics,
    interactions,
  });
  return createHash('sha256').update(versionInput).digest('hex').slice(0, 12);
}

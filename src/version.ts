import { createHash } from 'node:crypto';
import type { Edge, Profile } from './types.js';

export function calculateDatabaseVersion(
  profiles: Profile[],
  edges: Edge[],
): string {
  const versionInput = JSON.stringify({
    profiles: profiles.map(({ authors: _authors, ...profile }) => profile),
    edges,
  });
  return createHash('sha256').update(versionInput).digest('hex').slice(0, 12);
}

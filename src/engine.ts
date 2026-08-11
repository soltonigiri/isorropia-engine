import { createHash } from 'node:crypto';
import { scorePair } from './scoring.js';
import {
  DISCLAIMER,
  type Dataset,
  type Mode,
  type PairResponse,
  type PairResult,
  type Profile,
} from './types.js';

export const SETTING_THRESHOLDS = {
  rough: 0,
  coarse: 0.25,
  '1:1': 0.5,
  fine: 0.7,
  'very-fine': 0.85,
} as const;

export type Setting = keyof typeof SETTING_THRESHOLDS;

export class IsorropiaEngine {
  private readonly profileMap: Map<string, Profile>;
  readonly ruleVersion: string;

  constructor(private readonly dataset: Dataset) {
    this.profileMap = new Map(
      dataset.profiles.map((profile) => [profile.page_id, profile]),
    );
    this.ruleVersion = createHash('sha256')
      .update(JSON.stringify(dataset.rules))
      .digest('hex')
      .slice(0, 12);
  }

  pair(params: {
    pageId: string;
    mode: Mode;
    limit?: number;
    setting?: Setting;
  }): PairResponse {
    const pageId = normalizePageId(params.pageId);
    const query = this.profileMap.get(pageId);
    if (!query) throw new Error(`Unknown SCP profile: ${pageId}`);

    const threshold = params.setting
      ? SETTING_THRESHOLDS[params.setting]
      : 0;
    const limit = params.limit ?? 5;
    const results = this.dataset.profiles
      .filter((candidate) => candidate.page_id !== query.page_id)
      .map((candidate) =>
        scorePair({
          query,
          candidate,
          mode: params.mode,
          rules: this.dataset.rules,
          edges: this.dataset.edges,
        }),
      )
      .filter((result) => result.confidence >= threshold)
      .sort(compareResults)
      .slice(0, limit);

    return {
      query: {
        page_id: query.page_id,
        title: query.title,
        url: query.url,
      },
      mode: params.mode,
      database_version: this.dataset.manifest.database_version,
      rule_version: this.ruleVersion,
      results,
      ...(query.known_not ? { known_not: query.known_not } : {}),
      disclaimer: DISCLAIMER,
    };
  }

  coreCycle(): {
    database_version: string;
    cycle: string[];
    minimum_edge_score: number;
    average_edge_score: number;
    disclaimer: typeof DISCLAIMER;
  } {
    if (this.dataset.profiles.length !== 100) {
      throw new Error('CENTRAL CONTAINMENT requires exactly 100 curated profiles');
    }

    const profiles = [...this.dataset.profiles].sort((left, right) =>
      left.page_id.localeCompare(right.page_id),
    );
    let selected:
      | { cycle: string[]; minimum: number; average: number }
      | undefined;
    // A two-node cycle containing the globally strongest edge always equals or
    // outranks every longer cycle under the specified minimum/average ordering.
    for (let i = 0; i < profiles.length; i += 1) {
      for (let j = i + 1; j < profiles.length; j += 1) {
        const left = profiles[i]!;
        const right = profiles[j]!;
        const result = scorePair({
          query: left,
          candidate: right,
          mode: 'cycle',
          rules: this.dataset.rules,
          edges: this.dataset.edges,
        });
        if (result.score <= 0) continue;
        const candidate = {
          cycle: [left.page_id, right.page_id],
          minimum: result.score,
          average: result.score,
        };
        if (!selected || compareCycles(candidate, selected) < 0) {
          selected = candidate;
        }
      }
    }

    if (!selected) throw new Error('No positive containment cycle found');
    return {
      database_version: this.dataset.manifest.database_version,
      cycle: selected.cycle,
      minimum_edge_score: selected.minimum,
      average_edge_score: Math.round(selected.average * 100) / 100,
      disclaimer: DISCLAIMER,
    };
  }
}

export function normalizePageId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const match = /^(?:scp-)?(\d+)$/.exec(trimmed);
  if (!match) return trimmed;
  return `scp-${match[1]!.padStart(3, '0')}`;
}

function compareResults(left: PairResult, right: PairResult): number {
  return (
    right.score - left.score ||
    right.confidence - left.confidence ||
    left.page_id.localeCompare(right.page_id)
  );
}

function compareCycles(
  left: { cycle: string[]; minimum: number; average: number },
  right: { cycle: string[]; minimum: number; average: number },
): number {
  return (
    right.minimum - left.minimum ||
    right.average - left.average ||
    left.cycle.join('|').localeCompare(right.cycle.join('|'))
  );
}

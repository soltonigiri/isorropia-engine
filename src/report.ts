import { IsorropiaEngine } from './engine.js';
import { MODES, type Dataset, type Mode } from './types.js';

export type CoverageReport = {
  database_version: string;
  profiles: number;
  semantics: number;
  source_coverage: { complete: number; partial: number };
  accepted_with_proof: number;
  interactions_with_provenance: number;
  interactions: Record<Mode, { accepted: number; rejected: number }>;
  support: Record<'A' | 'B' | 'C', number>;
  zero_default_results: Record<Mode, number>;
  accepted_pair_concentration: Array<{ page_id: string; accepted: number }>;
  series: Record<string, number>;
  domains: Record<string, number>;
  unresolved_attribution: string[];
};

export function buildCoverageReport(dataset: Dataset): CoverageReport {
  const engine = new IsorropiaEngine(dataset);
  const interactions = Object.fromEntries(MODES.map((mode) => [mode, {
    accepted: dataset.interactions.filter((item) => item.mode === mode && item.verdict === 'accepted').length,
    rejected: dataset.interactions.filter((item) => item.mode === mode && item.verdict === 'rejected').length,
  }])) as CoverageReport['interactions'];
  const support = { A: 0, B: 0, C: 0 };
  const acceptedByPage = new Map<string, number>();
  for (const interaction of dataset.interactions) {
    if (interaction.verdict !== 'accepted') continue;
    support[interaction.support] += 1;
    for (const pageId of interaction.pages) {
      acceptedByPage.set(pageId, (acceptedByPage.get(pageId) ?? 0) + 1);
    }
  }
  const zeroDefaultResults = Object.fromEntries(MODES.map((mode) => [
    mode,
    dataset.profiles.filter((profile) =>
      engine.pair({ pageId: profile.page_id, mode }).results.length === 0).length,
  ])) as Record<Mode, number>;
  return {
    database_version: dataset.manifest.database_version,
    profiles: dataset.profiles.length,
    semantics: dataset.semantics.length,
    source_coverage: {
      complete: dataset.semantics.filter((semantic) => semantic.coverage.status === 'complete').length,
      partial: dataset.semantics.filter((semantic) => semantic.coverage.status === 'partial').length,
    },
    accepted_with_proof: dataset.interactions.filter((interaction) =>
      interaction.verdict === 'accepted').length,
    interactions_with_provenance: dataset.interactions.length,
    interactions,
    support,
    zero_default_results: zeroDefaultResults,
    accepted_pair_concentration: [...acceptedByPage.entries()]
      .map(([page_id, accepted]) => ({ page_id, accepted }))
      .sort((left, right) => right.accepted - left.accepted || left.page_id.localeCompare(right.page_id))
      .slice(0, 10),
    series: counts(dataset.profiles.map((profile) => profile.series ?? 'unassigned')),
    domains: counts(dataset.profiles.flatMap((profile) =>
      [...new Set(profile.effects.map((effect) => effect.domain))])),
    unresolved_attribution: dataset.manifest.attributions
      .filter((entry) => entry.status === 'unresolved')
      .map((entry) => entry.page_id)
      .sort(),
  };
}

export function formatCoverageReport(report: CoverageReport): string {
  const lines = [
    '# Dataset coverage',
    '',
    `Database: \`${report.database_version}\``,
    '',
    `Profiles: ${report.profiles}  `,
    `Semantics: ${report.semantics}`,
    `Source coverage: complete ${report.source_coverage.complete}, partial ${report.source_coverage.partial}`,
    `Accepted proofs: ${report.accepted_with_proof}; interaction provenance: ${report.interactions_with_provenance}`,
    '',
    '| Mode | Accepted | Rejected | Zero default results |',
    '|---|---:|---:|---:|',
    ...MODES.map((mode) =>
      `| ${mode} | ${report.interactions[mode].accepted} | ${report.interactions[mode].rejected} | ${report.zero_default_results[mode]} |`),
    '',
    `Support: A ${report.support.A}, B ${report.support.B}, C ${report.support.C}`,
    '',
    `Unresolved attribution: ${report.unresolved_attribution.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

function counts(values: string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((map, value) =>
    map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

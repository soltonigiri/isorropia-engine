import type { PairResponse } from './types.js';

export function formatPairResponse(
  response: PairResponse,
  options: { judgement?: boolean } = {},
): string {
  const lines: string[] = [];
  const decorativeTitle =
    response.query.page_id === 'scp-2521'
      ? '●●|●●●●●|●●|●'
      : response.query.title;

  lines.push(`Isorropía Engine // ${response.mode.toUpperCase()}`);
  lines.push(`${decorativeTitle} (${response.query.page_id})`);
  if (options.judgement) {
    const accepted = response.results.some((result) => result.confidence >= 0.5);
    lines.push(
      accepted
        ? 'JUDGEMENT: ACCEPTED / SCP-001-K CANDIDATE'
        : 'JUDGEMENT: DEFERRED',
    );
  }
  if (response.known_not) {
    lines.push(`known_not: ${response.known_not.join('; ')}`);
  }
  lines.push('');

  response.results.forEach((result, index) => {
    lines.push(
      `${index + 1}. ${result.title} (${result.page_id})  score=${result.score} confidence=${result.confidence.toFixed(2)}`,
    );
    if (result.rules.length === 0) {
      lines.push('   rule: no strong interaction rule matched');
    } else {
      for (const rule of result.rules) {
        lines.push(`   rule: ${rule.id} — ${rule.explanation}`);
      }
    }
    lines.push(
      `   evidence: ${response.query.page_id} ${formatEvidence(result.evidence.query)}`,
    );
    lines.push(
      `   evidence: ${result.page_id} ${formatEvidence(result.evidence.candidate)}`,
    );
  });

  lines.push('');
  lines.push(response.disclaimer);
  return lines.join('\n');
}

function formatEvidence(evidence: {
  revision: number;
  section: string;
  locator: string;
}): string {
  return `rev.${evidence.revision} ${evidence.section} [${evidence.locator}]`;
}

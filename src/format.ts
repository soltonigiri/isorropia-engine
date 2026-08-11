import type { Mode, PairResponse } from './types.js';

export type FormatOptions = {
  judgement?: boolean;
  rich?: boolean;
  color?: boolean;
  width?: number;
};

const DEFAULT_WIDTH = 78;
const MIN_RICH_WIDTH = 60;
const MAX_RICH_WIDTH = 100;
const CONFIDENCE_SEGMENTS = 20;

const MODE_STYLE: Record<
  Mode,
  { heading: string; symbol: string; ansi: number }
> = {
  cycle: { heading: 'CYCLE ANALYSIS', symbol: '⇄', ansi: 36 },
  breach: { heading: 'BREACH ANALYSIS', symbol: '⇈', ansi: 31 },
  'double-feature': {
    heading: 'DOUBLE-FEATURE ANALYSIS',
    symbol: '✦',
    ansi: 35,
  },
};

export function formatPairResponse(
  response: PairResponse,
  options: FormatOptions = {},
): string {
  const requestedWidth = options.width ?? DEFAULT_WIDTH;
  if (options.rich === false || requestedWidth < MIN_RICH_WIDTH) {
    return formatPlainPairResponse(response, options);
  }
  return formatRichPairResponse(response, {
    ...options,
    width: Math.min(MAX_RICH_WIDTH, requestedWidth),
  });
}

function formatRichPairResponse(
  response: PairResponse,
  options: FormatOptions & { width: number },
): string {
  const lines: string[] = [];
  const style = MODE_STYLE[response.mode];
  const width = options.width;
  const innerWidth = width - 2;
  const color = options.color === true;
  const border = paint(`╭${'━'.repeat(innerWidth)}╮`, style.ansi, color);
  const bottomBorder = paint(`╰${'━'.repeat(innerWidth)}╯`, style.ansi, color);
  const separator = paint(` ${'━'.repeat(width - 2)}`, style.ansi, color);
  const target =
    response.query.page_id === 'scp-2521'
      ? `●●|●●●●●|●●|● · ${response.query.page_id}`
      : response.query.page_id.toUpperCase();

  lines.push(border);
  lines.push(
    boxLine(
      spread('  ISORROPÍA ENGINE', '', innerWidth),
      innerWidth,
      color,
    ),
  );
  lines.push(
    boxLine(
      spread(`  ${style.heading}`, `TARGET ${target}  `, innerWidth),
      innerWidth,
      color,
      style.ansi,
    ),
  );
  if (options.judgement) {
    const accepted = response.results.some((result) => result.confidence >= 0.5);
    lines.push(
      boxLine(
        `  ${
          accepted
            ? 'JUDGEMENT: ACCEPTED / SCP-001-K CANDIDATE'
            : 'JUDGEMENT: DEFERRED'
        }`,
        innerWidth,
        color,
      ),
    );
  }
  if (response.known_not) {
    lines.push(
      boxLine(
        `  KNOWN NOT  ${response.known_not.join('; ')}`,
        innerWidth,
        color,
      ),
    );
  }
  lines.push(bottomBorder, '');

  response.results.forEach((result, index) => {
    const rank = String(index + 1).padStart(2, '0');
    const title = displayTitle(result.title, result.page_id);
    const score = `SCORE ${String(result.score).padStart(3, ' ')}`;
    lines.push(
      paint(
        spread(` ${rank}  ${title}`, score, width),
        1,
        color,
      ),
    );

    const bar = confidenceBar(result.confidence);
    lines.push(
      `     CONFIDENCE  ${paint(bar, style.ansi, color)}  ${result.confidence.toFixed(2)}`,
    );

    const strongestRule = [...result.rules].sort(
      (left, right) => right.weight - left.weight || left.id.localeCompare(right.id),
    )[0];
    appendWrapped(
      lines,
      `     ${style.symbol}  `,
      '        ',
      strongestRule?.explanation ?? 'No strong interaction rule matched.',
      width,
    );
    if (result.causal_chain) {
      appendWrapped(
        lines,
        '     CHAIN       ',
        '                 ',
        result.causal_chain.join(' → '),
        width,
      );
    }
    if (result.assumption) {
      appendWrapped(
        lines,
        '     CONDITION   ',
        '                 ',
        result.assumption,
        width,
      );
    }
    if (result.limitation) {
      appendWrapped(
        lines,
        '     LIMIT       ',
        '                 ',
        result.limitation,
        width,
      );
    }
    appendWrapped(
      lines,
      '     RULES       ',
      '                 ',
      result.rules.length > 0
        ? result.rules.map((rule) => rule.id).join(' · ')
        : 'none',
      width,
    );
    appendWrapped(
      lines,
      '     QUERY       ',
      '                 ',
      richEvidence(result.evidence.query),
      width,
    );
    appendWrapped(
      lines,
      '     MATCH       ',
      '                 ',
      richEvidence(result.evidence.candidate),
      width,
    );

    if (index < response.results.length - 1) {
      lines.push('', separator, '');
    }
  });

  lines.push('', paint(response.disclaimer, 2, color));
  return lines.join('\n');
}

function formatPlainPairResponse(
  response: PairResponse,
  options: FormatOptions,
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
    if (result.causal_chain) {
      lines.push(`   chain: ${result.causal_chain.join(' -> ')}`);
    }
    if (result.assumption) lines.push(`   condition: ${result.assumption}`);
    if (result.limitation) lines.push(`   limit: ${result.limitation}`);
    lines.push(
      `   evidence: ${response.query.page_id} ${formatEvidence(result.evidence.query)}`,
    );
    lines.push(
      `   evidence: ${result.page_id} ${formatEvidence(result.evidence.candidate)}`,
    );
  });

  lines.push('', response.disclaimer);
  return lines.join('\n');
}

function confidenceBar(confidence: number): string {
  const filled = Math.max(
    0,
    Math.min(CONFIDENCE_SEGMENTS, Math.round(confidence * CONFIDENCE_SEGMENTS)),
  );
  return `${'█'.repeat(filled)}${'░'.repeat(CONFIDENCE_SEGMENTS - filled)}`;
}

function displayTitle(title: string, pageId: string): string {
  return title.trim().toLowerCase() === pageId
    ? pageId.toUpperCase()
    : `${pageId.toUpperCase()} — ${title}`;
}

function richEvidence(evidence: {
  revision: number;
  section: string;
  locator: string;
}): string {
  return `rev.${evidence.revision} · ${evidence.section} › ${evidence.locator}`;
}

function formatEvidence(evidence: {
  revision: number;
  section: string;
  locator: string;
}): string {
  return `rev.${evidence.revision} ${evidence.section} [${evidence.locator}]`;
}

function boxLine(
  content: string,
  width: number,
  color: boolean,
  accent?: number,
): string {
  const line = `┃${pad(truncate(content, width), width)}┃`;
  return accent ? paint(line, accent, color) : line;
}

function spread(left: string, right: string, width: number): string {
  if (!right) return pad(truncate(left, width), width);
  const leftWidth = Math.max(1, width - right.length - 1);
  const fittedLeft = truncate(left, leftWidth);
  return `${fittedLeft}${' '.repeat(width - fittedLeft.length - right.length)}${right}`;
}

function appendWrapped(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  value: string,
  width: number,
): void {
  const firstWidth = Math.max(1, width - firstPrefix.length);
  const continuationWidth = Math.max(1, width - continuationPrefix.length);
  const wrapped = wrap(value, firstWidth, continuationWidth);
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`);
  for (const part of wrapped.slice(1)) {
    lines.push(`${continuationPrefix}${part}`);
  }
}

function wrap(value: string, firstWidth: number, continuationWidth: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  let limit = firstWidth;

  for (const word of words) {
    if (!current && word.length > limit) {
      lines.push(word.slice(0, limit));
      let remainder = word.slice(limit);
      limit = continuationWidth;
      while (remainder.length > limit) {
        lines.push(remainder.slice(0, limit));
        remainder = remainder.slice(limit);
      }
      current = remainder;
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    limit = continuationWidth;
  }
  if (current) lines.push(current);
  return lines;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…'.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - value.length))}`;
}

function paint(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

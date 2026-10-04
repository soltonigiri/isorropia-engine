#!/usr/bin/env node
import { createRequire } from 'node:module';
import { loadDataset } from './data.js';
import {
  IsorropiaEngine,
  SETTING_NAMES,
  normalizePageId,
  type Setting,
} from './engine.js';
import { formatPairInspection, formatPairResponse } from './format.js';
import { canonicalOntologyClass, normalizeToken } from './profile-compiler.js';
import { validateDataset } from './validate.js';
import {
  DISCLAIMER,
  MODES,
  type Mode,
} from './types.js';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(rootHelp());
    return;
  }
  if (command === 'pair' && isHelpRequest(args)) {
    process.stdout.write(pairHelp());
    return;
  }
  if (command === 'catalog' && isHelpRequest(args)) {
    process.stdout.write(catalogHelp());
    return;
  }

  const dataset = await loadDataset();
  const engine = new IsorropiaEngine(dataset);
  if (command === '--version' || command === '-V') {
    process.stdout.write(
      `isorropia-engine ${packageJson.version}\ndatabase ${dataset.manifest.database_version}\nrules ${engine.ruleVersion}\n`,
    );
    return;
  }

  if (command === 'catalog') {
    const options = parseOptions(args);
    assertOptions(options, ['json', 'mode', 'query']);
    const mode = options.mode === undefined ? undefined : parseMode(options.mode);
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
    const semantics = new Map(dataset.semantics.map((semantic) => [semantic.page_id, semantic]));
    const catalog = [...dataset.profiles]
      .sort((left, right) => left.scp_number - right.scp_number || left.page_id.localeCompare(right.page_id))
      .map((profile) => {
        const counts = Object.fromEntries(MODES.map((currentMode) => [
          currentMode,
          engine.pair({ pageId: profile.page_id, mode: currentMode, limit: 99 }).results.length,
        ])) as Record<Mode, number>;
        const semantic = semantics.get(profile.page_id);
        const domains = [...new Set(profile.effects.map((effect) => effect.domain))].sort();
        const searchValues = [
          profile.page_id,
          profile.title,
          ...profile.tags,
          ...profile.themes,
          ...domains,
          ...(semantic?.claims.flatMap((claim) => [
            canonicalOntologyClass(
              claim.domain_class,
              dataset.semanticOntology.domains,
            ).canonical,
            canonicalOntologyClass(
              claim.operation_class,
              dataset.semanticOntology.operations,
            ).canonical,
          ]) ?? []),
          ...(semantic?.reading ? [
            semantic.reading.themes,
            semantic.reading.forms,
            semantic.reading.structures,
            semantic.reading.tones,
            semantic.reading.motifs,
          ].flat().map(normalizeToken) : []),
        ].join('\n').toLowerCase();
        return {
          page_id: profile.page_id,
          title: profile.title,
          url: profile.url,
          themes: profile.themes,
          domains,
          counts,
          matches: !query || searchValues.includes(query),
        };
      })
      .filter((profile) => profile.matches && (!mode || profile.counts[mode] > 0))
      .map(({ matches: _matches, ...profile }) => profile);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    } else {
      process.stdout.write(`${catalog.map((profile) => {
        return `${profile.page_id}\t${profile.title}` +
          (mode ? `\t${mode}:${profile.counts[mode]}` : '');
      }).join('\n')}${catalog.length ? '\n' : ''}`);
    }
    return;
  }

  if (command === 'validate') {
    const options = parseOptions(args);
    assertOptions(options, []);
    const validation = validateDataset(dataset);
    if (!validation.valid) {
      process.stderr.write(`${validation.errors.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Valid dataset: ${dataset.profiles.length} profiles, ${dataset.rules.length} rules, ${dataset.golden.length} golden cases\n`,
    );
    return;
  }

  if (command === 'pair' || command === 'judgement') {
    const pageId = args[0];
    if (!pageId) throw new Error(`${command} requires an SCP identifier`);
    const options = parseOptions(args.slice(1));
    assertOptions(
      options,
      command === 'pair'
        ? ['mode', 'setting', 'limit', 'json', 'with', 'explain']
        : ['setting', 'limit', 'json'],
    );
    if (options.json && options.explain) throw new Error('--explain cannot be combined with --json');
    if (command === 'judgement' && options.setting !== undefined) {
      throw new Error('judgement uses its fixed acceptance threshold');
    }
    const mode = command === 'judgement' ? 'cycle' : parseMode(options.mode);
    const normalizedPageId = requireProfile(dataset.profiles, pageId);

    if (command === 'pair' && options.with !== undefined) {
      if (options.setting !== undefined || options.limit !== undefined) {
        throw new Error('--with cannot be combined with --setting or --limit');
      }
      if (typeof options.with !== 'string') throw new Error('--with requires an SCP identifier');
      const candidate = requireProfile(dataset.profiles, options.with);
      const response = engine.inspect({
        pageId: normalizedPageId,
        candidatePageId: candidate,
        mode,
      });
      process.stdout.write(options.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `${formatPairInspection(response, options.explain === true)}\n`);
      return;
    }

    const setting = parseSetting(options.setting);
    const limit = options.limit ? parseLimit(options.limit) : 5;
    const response = engine.pair({ pageId: normalizedPageId, mode, limit, setting });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatPairResponse(response, {
        judgement: command === 'judgement',
        explain: options.explain === true,
        rich: process.stdout.isTTY === true && process.env.TERM !== 'dumb',
        color: process.stdout.isTTY === true && process.env.TERM !== 'dumb' && process.env.NO_COLOR === undefined,
        width: process.stdout.columns || undefined,
      })}\n`);
    }
    return;
  }

  if (command === 'roster') {
    const options = parseOptions(args);
    assertOptions(options, ['sector', 'json']);
    if (options.sector !== 'core') throw new Error('roster requires --sector core');
    const response = engine.coreCycle();
    if (options.json) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else {
      process.stdout.write('LEVEL 6/001 — CENTRAL CONTAINMENT\n');
      process.stdout.write(`${response.cycle.join(' -> ')} -> ${response.cycle[0]}\n`);
      process.stdout.write(`minimum=${response.minimum_edge_score} average=${response.average_edge_score}\n\n${response.disclaimer}\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function requireProfile(profiles: Array<{ page_id: string }>, value: string): string {
  const normalized = normalizePageId(value);
  if (!profiles.some((profile) => profile.page_id === normalized)) {
    throw new Error(
      `Unknown SCP profile: ${normalized}. It is not in the curated catalog; run "isorropia catalog" to list available profiles.`,
    );
  }
  return normalized;
}

function parseOptions(args: string[]): Record<string, string | true> {
  const options: Record<string, string | true> = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (['json', 'explain', 'help'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function assertOptions(options: Record<string, string | true>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const option of Object.keys(options)) {
    if (!allowedSet.has(option)) throw new Error(`Unknown option: --${option}`);
  }
}

function parseMode(value: string | true | undefined): Mode {
  if (typeof value !== 'string' || !MODES.includes(value as Mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(', ')}`);
  }
  return value as Mode;
}

function parseSetting(value: string | true | undefined): Setting | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SETTING_NAMES.includes(value as Setting)) {
    throw new Error(`--setting must be one of: ${SETTING_NAMES.join(', ')}`);
  }
  return value as Setting;
}

function parseLimit(value: string | true): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) {
    throw new Error('--limit must be an integer from 1 to 99');
  }
  return parsed;
}

function isHelpRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === '--help' || args[0] === '-h');
}

function rootHelp(): string {
  return `Isorropía Engine\n\nUsage:\n  isorropia pair <scp-id> --mode <mode> [options]\n  isorropia catalog [options]\n  isorropia validate\n\nRun "isorropia pair --help" or "isorropia catalog --help" for details.\n`;
}

function pairHelp(): string {
  return `Usage:\n  isorropia pair <scp-id> --mode <cycle|breach|double-feature> [--setting <value>] [--limit 5] [--explain] [--json]\n  isorropia pair <scp-id> --mode <mode> --with <scp-id> [--explain] [--json]\n`;
}

function catalogHelp(): string {
  return `Usage:\n  isorropia catalog [--mode <cycle|breach|double-feature>] [--query <text>] [--json]\n`;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

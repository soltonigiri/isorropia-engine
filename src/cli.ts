#!/usr/bin/env node
import { loadDataset } from './data.js';
import {
  IsorropiaEngine,
  SETTING_THRESHOLDS,
  type Setting,
} from './engine.js';
import { formatPairResponse } from './format.js';
import { validateDataset } from './validate.js';
import { MODES, type Mode } from './types.js';

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(helpText());
    return;
  }

  const dataset = await loadDataset();
  const engine = new IsorropiaEngine(dataset);

  if (command === 'validate') {
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
    if (command === 'judgement' && options.setting !== undefined) {
      throw new Error('judgement uses its fixed 0.50 acceptance threshold');
    }
    const mode = command === 'judgement' ? 'cycle' : parseMode(options.mode);
    const setting = parseSetting(options.setting);
    const limit = options.limit ? parseLimit(options.limit) : 5;
    const response = engine.pair({ pageId, mode, limit, setting });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${formatPairResponse(response, {
          judgement: command === 'judgement',
          rich:
            process.stdout.isTTY === true && process.env.TERM !== 'dumb',
          color:
            process.stdout.isTTY === true &&
            process.env.TERM !== 'dumb' &&
            process.env.NO_COLOR === undefined,
          width: process.stdout.columns || undefined,
        })}\n`,
      );
    }
    return;
  }

  if (command === 'roster') {
    const options = parseOptions(args);
    if (options.sector !== 'core') {
      throw new Error('roster requires --sector core');
    }
    const response = engine.coreCycle();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    } else {
      process.stdout.write('LEVEL 6/001 — CENTRAL CONTAINMENT\n');
      process.stdout.write(`${response.cycle.join(' -> ')} -> ${response.cycle[0]}\n`);
      process.stdout.write(
        `minimum=${response.minimum_edge_score} average=${response.average_edge_score}\n\n`,
      );
      process.stdout.write(`${response.disclaimer}\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args: string[]): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function parseMode(value: string | true | undefined): Mode {
  if (typeof value !== 'string' || !MODES.includes(value as Mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(', ')}`);
  }
  return value as Mode;
}

function parseSetting(value: string | true | undefined): Setting | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !(value in SETTING_THRESHOLDS)
  ) {
    throw new Error(
      `--setting must be one of: ${Object.keys(SETTING_THRESHOLDS).join(', ')}`,
    );
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

function helpText(): string {
  return `Isorropía Engine

Usage:
  isorropia pair <scp-id> --mode <cycle|breach|double-feature> [--setting <value>] [--limit 5] [--json]
  isorropia validate
`;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import path from 'node:path';
import {
  createMaintenancePlan,
  publishMaintenanceRun,
  runMaintenance,
  verifyMaintenanceRun,
} from './maintenance.js';

type Parsed = {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
};

async function main(): Promise<unknown> {
  const parsed = parseArguments(process.argv.slice(2));
  const common = {
    ...(stringOption(parsed, '--data-dir') ? {
      dataDirectory: path.resolve(stringOption(parsed, '--data-dir')!),
    } : {}),
    ...(stringOption(parsed, '--private-dir') ? {
      privateDirectory: path.resolve(stringOption(parsed, '--private-dir')!),
    } : {}),
  };
  switch (parsed.command) {
    case 'plan':
      assertOptions(parsed, ['--limit', '--data-dir', '--private-dir']);
      return createMaintenancePlan({
        ...common,
        limit: numberOption(parsed, '--limit'),
      });
    case 'run':
      assertOptions(parsed, ['--dry-run', '--limit', '--data-dir', '--private-dir']);
      return runMaintenance({
        ...common,
        dryRun: parsed.options.has('--dry-run'),
        limit: numberOption(parsed, '--limit'),
      });
    case 'verify': {
      assertOptions(parsed, ['--data-dir', '--private-dir', '--no-source-check']);
      const runId = requiredPositional(parsed, 0, 'run id');
      return verifyMaintenanceRun({
        ...common,
        runId,
        checkSource: !parsed.options.has('--no-source-check'),
      });
    }
    case 'publish': {
      assertOptions(parsed, ['--repository', '--data-dir', '--private-dir']);
      const runId = requiredPositional(parsed, 0, 'run id');
      const repositoryDirectory = path.resolve(
        stringOption(parsed, '--repository') ?? '.',
      );
      return publishMaintenanceRun({
        ...common,
        runId,
        repositoryDirectory,
      });
    }
    default:
      throw new Error(
        'Usage: maintenance <plan|run|verify|publish> [options]',
      );
  }
}

function parseArguments(args: string[]): Parsed {
  const [command = '', ...rest] = args;
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  const flags = new Set(['--dry-run', '--no-source-check']);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    if (flags.has(value)) {
      options.set(value, true);
      continue;
    }
    const next = rest[++index];
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
    options.set(value, next);
  }
  return { command, positional, options };
}

function assertOptions(parsed: Parsed, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const option of parsed.options.keys()) {
    if (!allowedSet.has(option)) throw new Error(`Unknown option: ${option}`);
  }
}

function stringOption(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function numberOption(parsed: Parsed, name: string): number | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function requiredPositional(parsed: Parsed, index: number, name: string): string {
  const value = parsed.positional[index];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

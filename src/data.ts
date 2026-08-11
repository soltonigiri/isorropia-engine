import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Dataset,
  DatasetManifest,
  Edge,
  GoldenCase,
  Profile,
  Rule,
} from './types.js';

export function defaultDataDirectory(): string {
  return fileURLToPath(new URL('../data/', import.meta.url));
}

export async function loadDataset(
  dataDirectory = defaultDataDirectory(),
): Promise<Dataset> {
  const profilesDirectory = path.join(dataDirectory, 'profiles');
  const profileNames = (await readdir(profilesDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();

  const profiles = await Promise.all(
    profileNames.map((name) =>
      readJson<Profile>(path.join(profilesDirectory, name)),
    ),
  );
  const rules = await readJson<Rule[]>(path.join(dataDirectory, 'rules.json'));
  const manifest = await readJson<DatasetManifest>(
    path.join(dataDirectory, 'manifest.json'),
  );
  const golden = await readJson<GoldenCase[]>(
    path.join(dataDirectory, 'golden-pairs.json'),
  );
  const edgeText = await readFile(path.join(dataDirectory, 'edges.jsonl'), 'utf8');
  const edges = edgeText
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Edge;
      } catch (error) {
        throw new Error(`Invalid edge JSON on line ${index + 1}`, {
          cause: error,
        });
      }
    });

  return { profiles, rules, edges, manifest, golden };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

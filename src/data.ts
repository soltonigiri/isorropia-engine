import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Dataset,
  DatasetManifest,
  Edge,
  GoldenCase,
  PairInteraction,
  Profile,
  Rule,
  ScoringPolicy,
  SelectionPolicy,
  AnalysisPolicy,
  SemanticOntology,
  SemanticProfile,
} from './types.js';
import { assertDatasetFile, type DatasetFileKind } from './raw-validation.js';

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
      readJson<Profile>(path.join(profilesDirectory, name), 'profile'),
    ),
  );
  const rules = await readJson<Rule[]>(path.join(dataDirectory, 'rules.json'), 'rules');
  const manifest = await readJson<DatasetManifest>(
    path.join(dataDirectory, 'manifest.json'),
    'manifest',
  );
  const golden = await readJson<GoldenCase[]>(
    path.join(dataDirectory, 'golden-pairs.json'),
    'golden',
  );
  const semantics = await readJson<SemanticProfile[]>(
    path.join(dataDirectory, 'semantics.json'),
    'semantics',
  );
  const interactions = await readJson<PairInteraction[]>(
    path.join(dataDirectory, 'interactions.json'),
    'interactions',
  );
  const selectionPolicy = await readJson<SelectionPolicy>(
    path.join(dataDirectory, 'selection-policy.json'),
    'selection-policy',
  );
  const scoringPolicy = await readJson<ScoringPolicy>(
    path.join(dataDirectory, 'scoring-policy.json'),
    'scoring-policy',
  );
  const semanticOntology = await readJson<SemanticOntology>(
    path.join(dataDirectory, 'semantic-ontology.json'),
    'semantic-ontology',
  );
  const analysisPolicy = await readJson<AnalysisPolicy>(
    path.join(dataDirectory, 'analysis-policy.json'),
    'analysis-policy',
  );
  const edgeText = await readFile(path.join(dataDirectory, 'edges.jsonl'), 'utf8');
  const edges = edgeText
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        assertDatasetFile(parsed, 'edge', `${path.join(dataDirectory, 'edges.jsonl')}:${index + 1}`);
        return parsed as Edge;
      } catch (error) {
        throw new Error(`Invalid edge JSON on line ${index + 1}`, {
          cause: error,
        });
      }
    });

  return {
    profiles,
    rules,
    edges,
    semantics,
    interactions,
    selectionPolicy,
    scoringPolicy,
    semanticOntology,
    analysisPolicy,
    manifest,
    golden,
  };
}

async function readJson<T>(filePath: string, kind: DatasetFileKind): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON`, { cause: error });
  }
  assertDatasetFile(parsed, kind, filePath);
  return parsed as T;
}

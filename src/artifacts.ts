import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDataset, defaultDataDirectory } from './data.js';
import { IsorropiaEngine } from './engine.js';
import { MODES, type Mode, type PairResult } from './types.js';
import { validateDataset } from './validate.js';

export async function buildArtifacts(options: {
  dataDirectory?: string;
  outputDirectory?: string;
} = {}): Promise<{
  json: string;
  sqlite: string;
  profile_count: number;
}> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const outputDirectory = options.outputDirectory ?? path.resolve('release');
  const dataset = await loadDataset(dataDirectory);
  const validation = validateDataset(dataset);
  if (!validation.valid) {
    throw new Error(`Dataset validation failed:\n${validation.errors.join('\n')}`);
  }
  await mkdir(outputDirectory, { recursive: true });
  const engine = new IsorropiaEngine(dataset);
  const rankings = Object.fromEntries(
    dataset.profiles.map((profile) => [
      profile.page_id,
      Object.fromEntries(
        MODES.map((mode) => [
          mode,
          engine.pair({
            pageId: profile.page_id,
            mode,
            limit: 99,
            setting: 'rough',
          }).results,
        ]),
      ),
    ]),
  ) as Record<string, Record<Mode, PairResult[]>>;

  const jsonPath = path.join(outputDirectory, 'isorropia-data.json.gz');
  const payload = JSON.stringify({
    manifest: dataset.manifest,
    profiles: dataset.profiles,
    rules: dataset.rules,
    edges: dataset.edges,
    semantics: dataset.semantics,
    interactions: dataset.interactions,
    selection_policy: dataset.selectionPolicy,
    rankings,
    golden: dataset.golden,
  });
  const compressed = gzipSync(Buffer.from(payload));
  await atomicWrite(jsonPath, compressed);
  const decoded = JSON.parse(gunzipSync(await readFile(jsonPath)).toString('utf8')) as {
    profiles?: unknown[];
  };
  if (decoded.profiles?.length !== dataset.profiles.length) {
    throw new Error('Compressed JSON verification failed');
  }

  const sqlitePath = path.join(outputDirectory, 'isorropia.sqlite');
  const temporarySqlitePath = `${sqlitePath}.tmp`;
  const database = new DatabaseSync(temporarySqlitePath);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profiles (
        page_id TEXT PRIMARY KEY,
        scp_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        profile_json TEXT NOT NULL
      );
      CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        weight REAL NOT NULL,
        rule_json TEXT NOT NULL
      );
      CREATE TABLE edges (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        edge_json TEXT NOT NULL
      );
      CREATE INDEX edges_source_idx ON edges(source);
      CREATE INDEX edges_target_idx ON edges(target);
      CREATE TABLE semantic_profiles (
        page_id TEXT PRIMARY KEY,
        source_revision INTEGER NOT NULL,
        semantic_json TEXT NOT NULL
      );
      CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        left_page_id TEXT NOT NULL,
        right_page_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        verdict TEXT NOT NULL,
        interaction_json TEXT NOT NULL
      );
      CREATE INDEX interactions_left_idx ON interactions(left_page_id, mode);
      CREATE INDEX interactions_right_idx ON interactions(right_page_id, mode);
      CREATE TABLE rankings (
        query_page_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        candidate_page_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        confidence REAL NOT NULL,
        rank INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (query_page_id, mode, candidate_page_id)
      );
      CREATE INDEX rankings_lookup_idx ON rankings(query_page_id, mode, rank);
    `);
    database.exec('BEGIN IMMEDIATE');
    const insertMetadata = database.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?)',
    );
    insertMetadata.run('database_version', dataset.manifest.database_version);
    insertMetadata.run('manifest', JSON.stringify(dataset.manifest));
    const insertProfile = database.prepare(
      'INSERT INTO profiles (page_id, scp_number, title, url, source_revision, profile_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const profile of dataset.profiles) {
      insertProfile.run(
        profile.page_id,
        profile.scp_number,
        profile.title,
        profile.url,
        profile.source_revision,
        JSON.stringify(profile),
      );
    }
    const insertRule = database.prepare(
      'INSERT INTO rules (id, mode, weight, rule_json) VALUES (?, ?, ?, ?)',
    );
    for (const rule of dataset.rules) {
      insertRule.run(rule.id, rule.mode, rule.weight, JSON.stringify(rule));
    }
    const insertEdge = database.prepare(
      'INSERT INTO edges (source, target, type, edge_json) VALUES (?, ?, ?, ?)',
    );
    for (const edge of dataset.edges) {
      insertEdge.run(edge.from, edge.to, edge.type, JSON.stringify(edge));
    }
    const insertSemantic = database.prepare(
      'INSERT INTO semantic_profiles (page_id, source_revision, semantic_json) VALUES (?, ?, ?)',
    );
    for (const semantic of dataset.semantics) {
      insertSemantic.run(
        semantic.page_id,
        semantic.source_revision,
        JSON.stringify(semantic),
      );
    }
    const insertInteraction = database.prepare(
      'INSERT INTO interactions (id, left_page_id, right_page_id, mode, verdict, interaction_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const interaction of dataset.interactions) {
      insertInteraction.run(
        interaction.id,
        interaction.pages[0],
        interaction.pages[1],
        interaction.mode,
        interaction.verdict,
        JSON.stringify(interaction),
      );
    }
    const insertRanking = database.prepare(
      'INSERT INTO rankings (query_page_id, mode, candidate_page_id, score, confidence, rank, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const profile of dataset.profiles) {
      for (const mode of MODES) {
        const results = rankings[profile.page_id]![mode]!;
        results.forEach((result, index) => {
          insertRanking.run(
            profile.page_id,
            mode,
            result.page_id,
            result.score,
            result.confidence,
            index + 1,
            JSON.stringify(result),
          );
        });
      }
    }
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  await rename(temporarySqlitePath, sqlitePath);

  const verification = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = verification
      .prepare('SELECT COUNT(*) AS count FROM profiles')
      .get() as { count: number };
    if (row.count !== dataset.profiles.length) {
      throw new Error('SQLite verification failed');
    }
  } finally {
    verification.close();
  }

  return { json: jsonPath, sqlite: sqlitePath, profile_count: dataset.profiles.length };
}

async function atomicWrite(filePath: string, content: Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, filePath);
}

import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDataset, defaultDataDirectory } from './data.js';
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

  const jsonPath = path.join(outputDirectory, 'isorropia-data.json.gz');
  const payload = JSON.stringify({
    manifest: dataset.manifest,
    profiles: dataset.profiles,
    rules: dataset.rules,
    edges: dataset.edges,
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
    `);
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

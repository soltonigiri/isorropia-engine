import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory } from './data.js';
import {
  fetchItemsIndex,
  normalizedSourceKey,
  sourceRevision,
  type SourceIndexEntry,
} from './source-api.js';
import type { PairInteraction, Profile } from './types.js';

type CurationEntry = {
  page_id: string;
  known_not?: string[];
};

export type RefreshCandidate = {
  page_id: string;
  source_revision: number;
  wikidot_page_id: string;
  title: string;
  url: string;
  series?: string;
  tags: string[];
  references: string[];
};

export type RefreshSummary = {
  checked: number;
  changed: string[];
  unchanged: number;
  written: boolean;
  semantic_refresh_required: string[];
  invalidated_interactions: string[];
};

export async function refreshData(options: {
  check?: boolean;
  dataDirectory?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<RefreshSummary> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const curation = await readJson<CurationEntry[]>(path.join(dataDirectory, 'curation.json'));
  const interactions = await readJsonIfPresent<PairInteraction[]>(
    path.join(dataDirectory, 'interactions.json'),
    [],
  );
  const index = await fetchItemsIndex(options.fetchImpl);
  const candidates = curation.map((entry) =>
    sourceCandidate(entry.page_id, sourceEntry(index, entry.page_id)));
  const existing = await loadExistingProfiles(path.join(dataDirectory, 'profiles'));
  const changed = candidates.filter((candidate) => {
    const previous = existing.get(candidate.page_id);
    return !previous || sourceMetadataChanged(previous, candidate);
  });
  const changedIds = new Set(changed.map((candidate) => candidate.page_id));
  const summary: RefreshSummary = {
    checked: candidates.length,
    changed: [...changedIds].sort(),
    unchanged: candidates.length - changed.length,
    written: !options.check && changed.length > 0,
    semantic_refresh_required: [...changedIds].sort(),
    invalidated_interactions: interactions
      .filter((interaction) => interaction.pages.some((pageId) => changedIds.has(pageId)))
      .map((interaction) => interaction.id)
      .sort(),
  };
  if (options.check || changed.length === 0) return summary;

  const candidatesDirectory = path.join(dataDirectory, 'candidates');
  await mkdir(candidatesDirectory, { recursive: true });
  for (const candidate of changed) {
    await atomicWrite(
      path.join(candidatesDirectory, `${candidate.page_id}.json`),
      stableJson(candidate),
    );
  }
  await atomicWrite(
    path.join(candidatesDirectory, 'refresh-summary.json'),
    stableJson(summary),
  );
  return summary;
}

function sourceCandidate(pageId: string, source: SourceIndexEntry): RefreshCandidate {
  return {
    page_id: pageId,
    source_revision: sourceRevision(source),
    wikidot_page_id: String(source.page_id ?? ''),
    title: source.title ?? pageId.toUpperCase(),
    url: source.url ?? `https://scp-wiki.wikidot.com/${pageId}`,
    ...(source.series ? { series: source.series } : {}),
    tags: sortedStrings(source.tags ?? []),
    references: sortedStrings(source.references ?? []),
  };
}

function sourceMetadataChanged(profile: Profile, candidate: RefreshCandidate): boolean {
  return profile.source_revision !== candidate.source_revision ||
    profile.wikidot_page_id !== candidate.wikidot_page_id ||
    profile.title !== candidate.title ||
    profile.url !== candidate.url ||
    profile.series !== candidate.series ||
    JSON.stringify(profile.tags) !== JSON.stringify(candidate.tags);
}

function sourceEntry(
  index: Record<string, SourceIndexEntry>,
  pageId: string,
): SourceIndexEntry {
  const entry = index[normalizedSourceKey(pageId)];
  if (!entry) throw new Error(`SCP Data API has no entry for ${pageId}`);
  return entry;
}

async function loadExistingProfiles(directory: string): Promise<Map<string, Profile>> {
  const profiles = new Map<string, Profile>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const profile = await readJson<Profile>(path.join(directory, name));
    profiles.set(profile.page_id, profile);
  }
  return profiles;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function readJsonIfPresent<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortedStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string'))].sort();
}

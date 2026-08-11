import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory } from './data.js';
import {
  fetchItemsIndex,
  SCP_DATA_API_INDEX_URL,
  type SourceIndexEntry,
} from './source-api.js';
import type {
  DatasetManifest,
  Edge,
  Effect,
  Profile,
} from './types.js';
import { calculateDatabaseVersion } from './version.js';

type ManualEffect = Omit<Effect, 'evidence'> & {
  section: string;
  locator: string;
};

type CurationEntry = {
  page_id: string;
  focus_tags: string[];
  known_not?: string[];
  manual_effects?: ManualEffect[];
};

type TagEffect = Omit<Effect, 'constraints' | 'evidence'> & {
  constraints?: string[];
};

type CandidateProfile = Omit<Profile, 'curated'> & { curated: false };

export type RefreshSummary = {
  checked: number;
  changed: string[];
  unchanged: number;
  written: boolean;
};

export async function refreshData(options: {
  bootstrap?: boolean;
  check?: boolean;
  dataDirectory?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<RefreshSummary> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const curation = await readJson<CurationEntry[]>(
    path.join(dataDirectory, 'curation.json'),
  );
  const tagEffects = await readJson<Record<string, TagEffect>>(
    path.join(dataDirectory, 'tag-effects.json'),
  );
  const index = await fetchItemsIndex(options.fetchImpl);
  const built = curation.map((entry) =>
    buildProfile({ entry, source: sourceEntry(index, entry.page_id), tagEffects }),
  );

  if (options.bootstrap) {
    if (options.check) throw new Error('--bootstrap and --check cannot be combined');
    await bootstrapDataset(dataDirectory, built, curation, index);
    return {
      checked: built.length,
      changed: built.map((profile) => profile.page_id),
      unchanged: 0,
      written: true,
    };
  }

  const existing = await loadExistingProfiles(path.join(dataDirectory, 'profiles'));
  const changed = built.filter((profile) => {
    const previous = existing.get(profile.page_id);
    return (
      !previous ||
      previous.source_revision !== profile.source_revision ||
      JSON.stringify(previous.tags) !== JSON.stringify(profile.tags)
    );
  });
  const summary: RefreshSummary = {
    checked: built.length,
    changed: changed.map((profile) => profile.page_id),
    unchanged: built.length - changed.length,
    written: !options.check && changed.length > 0,
  };
  if (options.check || changed.length === 0) return summary;

  const candidatesDirectory = path.join(dataDirectory, 'candidates');
  await mkdir(candidatesDirectory, { recursive: true });
  for (const profile of changed) {
    const candidate: CandidateProfile = { ...profile, curated: false };
    await atomicWrite(
      path.join(candidatesDirectory, `${profile.page_id}.json`),
      stableJson(candidate),
    );
  }
  await atomicWrite(
    path.join(candidatesDirectory, 'refresh-summary.json'),
    stableJson(summary),
  );
  return summary;
}

function buildProfile(params: {
  entry: CurationEntry;
  source: SourceIndexEntry;
  tagEffects: Record<string, TagEffect>;
}): Omit<Profile, 'curated'> {
  const sourceTags = sortedStrings(params.source.tags ?? []);
  for (const tag of params.entry.focus_tags) {
    if (!sourceTags.includes(tag)) {
      throw new Error(`${params.entry.page_id} no longer has curated tag: ${tag}`);
    }
  }
  const revision = Math.max(0, (params.source.history?.length ?? 1) - 1);
  const effects: Effect[] = params.entry.focus_tags.flatMap((tag) => {
    const template = params.tagEffects[tag];
    if (!template) {
      throw new Error(`No effect mapping for curated tag: ${tag}`);
    }
    return [
      {
        ...template,
        constraints: template.constraints ?? [],
        evidence: {
          revision,
          section: 'metadata.tags',
          locator: `tag:${tag}`,
        },
      },
    ];
  });
  for (const manual of params.entry.manual_effects ?? []) {
    const { section, locator, ...effect } = manual;
    effects.push({
      ...effect,
      evidence: { revision, section, locator },
    });
  }
  if (effects.length === 0) {
    throw new Error(`${params.entry.page_id} has no mapped effects`);
  }
  const scpNumber = Number(params.entry.page_id.slice(4));
  const creator = (params.source.creator ?? params.source.created_by ?? '').trim();
  return {
    page_id: params.entry.page_id,
    scp_number: scpNumber,
    wikidot_page_id: String(params.source.page_id ?? ''),
    title: params.source.title ?? params.entry.page_id.toUpperCase(),
    url:
      params.source.url ??
      `https://scp-wiki.wikidot.com/${params.entry.page_id}`,
    authors: creator ? [creator] : [],
    language: 'en',
    source_revision: revision,
    ...(params.source.series ? { series: params.source.series } : {}),
    tags: sourceTags,
    themes: [...params.entry.focus_tags],
    effects,
    ...(params.entry.known_not ? { known_not: params.entry.known_not } : {}),
  };
}

async function bootstrapDataset(
  dataDirectory: string,
  profiles: Array<Omit<Profile, 'curated'>>,
  curation: CurationEntry[],
  index: Record<string, SourceIndexEntry>,
): Promise<void> {
  const profilesDirectory = path.join(dataDirectory, 'profiles');
  await mkdir(profilesDirectory, { recursive: true });
  const existing = (await readdir(profilesDirectory)).filter((name) =>
    name.endsWith('.json'),
  );
  if (existing.length > 0) {
    throw new Error('Bootstrap refused: data/profiles already contains JSON files');
  }

  const curatedProfiles: Profile[] = profiles.map((profile) => ({
    ...profile,
    curated: true,
  }));
  for (const profile of curatedProfiles) {
    await atomicWrite(
      path.join(profilesDirectory, `${profile.page_id}.json`),
      stableJson(profile),
    );
  }

  const edges = buildEdges(curation, index, curatedProfiles);
  const manifest = buildManifest(curatedProfiles, edges);
  await atomicWrite(path.join(dataDirectory, 'manifest.json'), stableJson(manifest));
  await atomicWrite(
    path.join(dataDirectory, 'edges.jsonl'),
    `${edges.map((edge) => JSON.stringify(edge)).join('\n')}\n`,
  );
}

function buildManifest(profiles: Profile[], edges: Edge[]): DatasetManifest {
  return {
    database_version: calculateDatabaseVersion(profiles, edges),
    generated_at: new Date().toISOString(),
    source: SCP_DATA_API_INDEX_URL,
    profile_count: profiles.length,
    attributions: profiles.map((profile) => ({
      page_id: profile.page_id,
      title: profile.title,
      url: profile.url,
      authors: profile.authors,
      revision: profile.source_revision,
      license: 'CC BY-SA 3.0',
    })),
  };
}

function buildEdges(
  curation: CurationEntry[],
  index: Record<string, SourceIndexEntry>,
  profiles: Profile[],
): Edge[] {
  const selected = new Set(curation.map((entry) => entry.page_id));
  const revisionById = new Map(
    profiles.map((profile) => [profile.page_id, profile.source_revision]),
  );
  const edges: Edge[] = [];
  for (const entry of curation) {
    const source = sourceEntry(index, entry.page_id);
    for (const reference of source.references ?? []) {
      const target = reference.trim().toLowerCase().replace(/^\//, '');
      if (!selected.has(target) || target === entry.page_id) continue;
      if (Math.abs(Number(target.slice(4)) - Number(entry.page_id.slice(4))) === 1) {
        continue;
      }
      edges.push({
        from: entry.page_id,
        to: target,
        type: 'explicit_link',
        evidence: {
          revision: revisionById.get(entry.page_id) ?? 0,
          section: 'metadata.references',
          locator: `link:${target}`,
        },
      });
    }
  }
  return edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function sourceEntry(
  index: Record<string, SourceIndexEntry>,
  pageId: string,
): SourceIndexEntry {
  const key = `SCP-${pageId.slice(4).padStart(3, '0')}`;
  const entry = index[key];
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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortedStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === 'string'))).sort();
}

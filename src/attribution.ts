import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDirectory } from './data.js';
import type { DatasetManifest, Profile } from './types.js';

const ATTRIBUTION_METADATA_URL =
  'https://scp-wiki.wikidot.com/attribution-metadata';

export async function synchronizeAttribution(options: {
  apply?: boolean;
  dataDirectory?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ checked: number; changed: string[]; applied: boolean }> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const profilesDirectory = path.join(dataDirectory, 'profiles');
  const names = (await readdir(profilesDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const profiles = await Promise.all(
    names.map((name) => readJson<Profile>(path.join(profilesDirectory, name))),
  );
  const overrides = await fetchOfficialAttributions(
    options.fetchImpl ?? globalThis.fetch,
  );
  const resolved = profiles.map((profile) => ({
    profile,
    authors: overrides.get(profile.page_id) ?? profile.authors,
  }));
  const changed = resolved.filter(
    ({ profile, authors }) =>
      authors.length > 0 && JSON.stringify(authors) !== JSON.stringify(profile.authors),
  );
  if (!options.apply || changed.length === 0) {
    return {
      checked: profiles.length,
      changed: changed.map(({ profile }) => profile.page_id),
      applied: false,
    };
  }

  for (const { profile, authors } of changed) {
    const updated: Profile = { ...profile, authors };
    await atomicWrite(
      path.join(profilesDirectory, `${profile.page_id}.json`),
      stableJson(updated),
    );
  }
  const manifestPath = path.join(dataDirectory, 'manifest.json');
  const manifest = await readJson<DatasetManifest>(manifestPath);
  const authorsById = new Map(
    resolved.map(({ profile, authors }) => [
      profile.page_id,
      authors.length > 0 ? authors : profile.authors,
    ]),
  );
  manifest.attributions = manifest.attributions.map((entry) => ({
    ...entry,
    authors: authorsById.get(entry.page_id) ?? entry.authors,
  }));
  await atomicWrite(manifestPath, stableJson(manifest));
  return {
    checked: profiles.length,
    changed: changed.map(({ profile }) => profile.page_id),
    applied: true,
  };
}

async function fetchOfficialAttributions(
  fetchImpl: typeof fetch,
): Promise<Map<string, string[]>> {
  try {
    const response = await fetchImpl(ATTRIBUTION_METADATA_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return new Map();
    return parseOfficialAttributions(await response.text());
  } catch {
    return new Map();
  }
}

function parseOfficialAttributions(html: string): Map<string, string[]> {
  const authors = new Map<string, string[]>();
  const rowPattern =
    /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const pageId = cellText(match[1]!).toLowerCase();
    const author = cellText(match[2]!);
    const type = cellText(match[3]!).toLowerCase();
    if (!/^scp-\d{3,}$/.test(pageId) || type !== 'author' || !author) continue;
    const current = authors.get(pageId) ?? [];
    if (!current.includes(author)) current.push(author);
    authors.set(pageId, current);
  }
  for (const values of authors.values()) {
    values.sort((left, right) => left.localeCompare(right));
  }
  return authors;
}

function cellText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stableDigest } from './analysis-policy.js';
import type { ArticleChunk } from './model-runner.js';
import {
  normalizedSourceKey,
  SCP_DATA_API_ORIGIN,
  sourceRevision,
  type SourceArticle,
  type SourceIndexEntry,
} from './source-api.js';

const MAX_ARTICLES_PER_EXTRACTION = 5;
const MAX_EXTRACTION_CHARACTERS = 200_000;
const MAX_ARTICLE_CHUNK_CHARACTERS = 175_000;

type ArticleEntry = {
  page_id: string;
  source_revision: number;
  title: string;
};

export type SourceSegment = {
  id: string;
  source: string;
  modality: 'wikidot-source' | 'rendered-html';
};

export type LoadedArticle = {
  entry: ArticleEntry;
  source: SourceIndexEntry;
  raw_source: string;
  normalized_source: string;
  source_digest: string;
  segments: SourceSegment[];
  coverage: 'complete' | 'partial';
  unresolved_features: string[];
};

export async function loadArticle(options: {
  entry: ArticleEntry;
  source: SourceIndexEntry;
  privateDirectory: string;
  fetchImpl?: typeof fetch;
  sourceLimits: {
    maximum_depth: number;
    maximum_segments: number;
    maximum_characters: number;
  };
}): Promise<LoadedArticle> {
  const contentFile = options.source.content_file;
  if (!contentFile || !/^[A-Za-z0-9._-]+\.json$/.test(contentFile)) {
    throw new Error(`Invalid content shard for ${options.entry.page_id}`);
  }
  const cachePath = path.join(options.privateDirectory, 'cache', 'shards', contentFile);
  let shardText: string;
  let fromCache = true;
  try {
    shardText = await readFile(cachePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fromCache = false;
    shardText = await fetchContentShard(contentFile, options.fetchImpl);
    await atomicWrite(cachePath, shardText);
  }
  let shard = JSON.parse(shardText) as Record<string, SourceArticle>;
  let article = findArticle(shard, options.entry.page_id, options.source);
  if (fromCache && sourceRevision(article) !== sourceRevision(options.source)) {
    shardText = await fetchContentShard(contentFile, options.fetchImpl);
    await atomicWrite(cachePath, shardText);
    shard = JSON.parse(shardText) as Record<string, SourceArticle>;
    article = findArticle(shard, options.entry.page_id, options.source);
  }
  if (sourceRevision(article) !== sourceRevision(options.source)) {
    throw new Error(`Content revision does not match index: ${options.entry.page_id}`);
  }
  const rawSource = article.raw_source;
  if (!rawSource?.trim()) {
    throw new Error(`SCP Data API has no raw_source for ${options.entry.page_id}`);
  }
  let normalizedSource = normalizeArticleSource(rawSource);
  let segments: SourceSegment[] = normalizedSource
    ? [{ id: 'source', source: normalizedSource, modality: 'wikidot-source' }]
    : [];
  const unresolvedFeatures = detectUnresolvedSourceFeatures(rawSource);
  const rendersDynamicContent =
    /\[\[module\s+ListPages\b[\s\S]*?%%content%%/i.test(rawSource);
  if (
    (rendersDynamicContent || !hasSubstantiveArticleText(normalizedSource)) &&
    article.raw_content?.trim()
  ) {
    const rendered = await loadRenderedArticleSource({
      entry: options.entry,
      source: options.source,
      rawContent: article.raw_content,
      privateDirectory: options.privateDirectory,
      fetchImpl: options.fetchImpl,
      limits: options.sourceLimits,
    });
    if (hasSubstantiveArticleText(rendered.source)) {
      normalizedSource = rendered.source;
      segments = rendered.segments;
      if (rendered.segments.length > 1) {
        const dynamicIndex = unresolvedFeatures.indexOf('dynamic-list');
        if (dynamicIndex >= 0) unresolvedFeatures.splice(dynamicIndex, 1);
      }
    }
    unresolvedFeatures.push(...rendered.unresolved_features);
  }
  if (
    !hasSubstantiveArticleText(normalizedSource) &&
    !unresolvedFeatures.includes('visual-primary')
  ) {
    throw new Error(`SCP Data API has no substantive source for ${options.entry.page_id}`);
  }
  const uniqueUnresolved = [...new Set(unresolvedFeatures)].sort();
  return {
    entry: options.entry,
    source: options.source,
    raw_source: rawSource,
    normalized_source: normalizedSource,
    source_digest: stableDigest(segments.map(({ id, source, modality }) => ({ id, source, modality }))),
    segments,
    coverage: uniqueUnresolved.length > 0 ? 'partial' : 'complete',
    unresolved_features: uniqueUnresolved,
  };
}

async function loadRenderedArticleSource(options: {
  entry: ArticleEntry;
  source: SourceIndexEntry;
  rawContent: string;
  privateDirectory: string;
  fetchImpl?: typeof fetch;
  limits: { maximum_depth: number; maximum_segments: number; maximum_characters: number };
}): Promise<{ source: string; segments: SourceSegment[]; unresolved_features: string[] }> {
  const documents: Array<{ id: string; html: string; url: URL; depth: number }> = [{
    id: 'rendered-root',
    html: options.rawContent,
    url: new URL(options.source.url ?? ''),
    depth: 0,
  }];
  const sourceUrl = new URL(options.source.url ?? '');
  const seen = new Set<string>([sourceUrl.href]);
  const unresolved = new Set<string>();
  let totalCharacters = options.rawContent.length;
  for (let index = 0; index < documents.length; index += 1) {
    const current = documents[index]!;
    for (const reference of renderedReferences(current.html)) {
      let linked: URL;
      try {
        linked = new URL(reference.value, current.url);
      } catch {
        unresolved.add('invalid-rendered-link');
        continue;
      }
      const isOffset = linked.pathname.startsWith(`${sourceUrl.pathname.replace(/\/$/, '')}/offset/`);
      const isFragment = /^\/fragment(?::|%3a)/i.test(linked.pathname);
      const isSamePageFrame = reference.kind === 'frame' && linked.pathname === sourceUrl.pathname;
      if (!isOffset && !isFragment && !isSamePageFrame) {
        if (reference.kind === 'frame' && /^https?:/i.test(linked.protocol)) {
          unresolved.add('external-frame');
        }
        continue;
      }
      if (linked.origin !== sourceUrl.origin || seen.has(linked.href)) continue;
      if (
        current.depth >= options.limits.maximum_depth ||
        documents.length >= options.limits.maximum_segments
      ) {
        unresolved.add('resolution-limit');
        continue;
      }
      seen.add(linked.href);
      const label = isOffset
        ? `offset-${linked.pathname.split('/').at(-1)}`
        : `segment-${stableDigest(`${linked.pathname}${linked.search}`).slice(0, 8)}`;
      const cachePath = path.join(
        options.privateDirectory,
        'cache',
        'rendered',
        `${options.entry.page_id}-r${options.entry.source_revision}-${label}.html`,
      );
      let html: string;
      try {
        html = await readFile(cachePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        let response: Response;
        try {
          response = await fetchArticleResource(
            linked,
            options.fetchImpl ?? globalThis.fetch,
            options.entry.page_id,
          );
        } catch {
          unresolved.add('rendered-request-failed');
          continue;
        }
        if (!response.ok) {
          unresolved.add('rendered-request-failed');
          continue;
        }
        html = await response.text();
        await atomicWrite(cachePath, html);
      }
      totalCharacters += html.length;
      if (totalCharacters > options.limits.maximum_characters) {
        unresolved.add('character-limit');
        continue;
      }
      documents.push({
        id: `${current.id}/${label}`,
        html,
        url: linked,
        depth: current.depth + 1,
      });
    }
  }
  const segments = documents.map((document) => ({
    id: document.id,
    source: normalizeRenderedArticleContent(document.html),
    modality: 'rendered-html' as const,
  })).filter((segment) => segment.source);
  return {
    source: segments.map((segment) => segment.source).join('\n\n'),
    segments,
    unresolved_features: [...unresolved].sort(),
  };
}

function renderedReferences(html: string): Array<{ kind: 'frame' | 'link'; value: string }> {
  const references: Array<{ kind: 'frame' | 'link'; value: string }> = [];
  for (const match of html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    if (isPresentationFrame(match[0], match[1]!)) continue;
    references.push({ kind: 'frame', value: match[1]! });
  }
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    references.push({ kind: 'link', value: match[1]! });
  }
  return references;
}

function detectUnresolvedSourceFeatures(rawSource: string): string[] {
  const unresolved: string[] = [];
  if (/\[\[module\s+ListPages\b[\s\S]*?%%content%%[\s\S]*?\[\[\/module\]\]/i.test(rawSource)) {
    unresolved.push('dynamic-list');
  }
  const includes = [...rawSource.matchAll(/\[\[include\s+([^\]\n]+)/gi)]
    .filter((match) => !isPresentationInclude(match[1]!, rawSource, match.index ?? 0));
  if (includes.length > 0) unresolved.push('unresolved-include');
  if (
    /\[\[(?:[<>=]\s*)?(?:image|iframe)\b/i.test(rawSource) &&
    !hasSubstantiveArticleText(normalizeArticleSource(rawSource))
  ) {
    unresolved.push('visual-primary');
  }
  return unresolved;
}

function isPresentationFrame(tag: string, value: string): boolean {
  return /\bstyle\s*=\s*["'][^"']*display\s*:\s*none/i.test(tag) ||
    /\/(?:style|interwiki)frame\.html(?:\?|$)/i.test(value) ||
    /\bscpnet-interwiki-frame\b/i.test(tag);
}

function isPresentationInclude(value: string, source: string, index: number): boolean {
  const normalized = value.toLowerCase();
  if (
    /(?:^|[/:])theme[:/-]|more-by:|info:(?:start|end)|fragment:[^\s<]*earthworm|component:(?:adult-content-warning|anomaly-class-bar-source|author-label-source|bhl-dark-sidebar|centered-header-bhl|classified-bar-[\w-]+|customizable-acs|djk\b|earthworm\b|image-block|image-features-source|info-[\w-]+|license-box(?:-end)?|object-class-bar-source|object-warning-box-source|pjpss\b|preview\b|rso\b|toggle-sidebar-bhl|wikimodule\b|acs-animation\b)/i.test(normalized)
  ) {
    return true;
  }
  const preceding = source.slice(Math.max(0, index - 500), index);
  return /footer-wikiwalk-nav[\s\S]*$/i.test(preceding) &&
    !/\[\[\/div\]\][\s\S]*$/i.test(preceding.slice(preceding.lastIndexOf('footer-wikiwalk-nav')));
}

function hasSubstantiveArticleText(source: string): boolean {
  const prose = source
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .match(/[\p{L}\p{N}]/gu);
  return (prose?.length ?? 0) >= 12;
}

async function fetchContentShard(
  contentFile: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const url = new URL(`/data/scp/items/${contentFile}`, SCP_DATA_API_ORIGIN);
  const response = await fetchArticleResource(url, fetchImpl, contentFile);
  if (!response.ok) {
    throw new Error(`SCP content request failed (${response.status}) for ${contentFile}`);
  }
  return response.text();
}

async function fetchArticleResource(
  url: URL,
  fetchImpl: typeof fetch,
  context: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'error' });
      if (response.ok || (response.status !== 429 && response.status < 500) || attempt === 3) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`SCP source request failed for ${context}: ${reason}`);
}

function findArticle(
  shard: Record<string, SourceArticle>,
  pageId: string,
  source: SourceIndexEntry,
): SourceArticle {
  const keys = [
    normalizedSourceKey(pageId),
    pageId,
    pageId.toUpperCase(),
    String(source.page_id ?? ''),
  ];
  for (const key of keys) {
    if (shard[key]) return shard[key]!;
  }
  const found = Object.values(shard).find((article) =>
    article.url === source.url ||
    article.link?.replace(/^\//, '').toLowerCase() === pageId,
  );
  if (!found) throw new Error(`Content shard does not contain ${pageId}`);
  return found;
}

export function normalizeArticleSource(rawSource: string): string {
  const lines = rawSource.replace(/\r\n?/g, '\n').split('\n');
  const filtered: string[] = [];
  let inComment = false;
  let skipUntil: RegExp | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skipUntil) {
      if (skipUntil.test(trimmed)) skipUntil = undefined;
      continue;
    }
    if (trimmed.startsWith('[!--')) inComment = true;
    if (inComment) {
      if (trimmed.endsWith('--]')) inComment = false;
      continue;
    }
    if (/^\[\[include\b.*component:license-box/i.test(trimmed)) break;
    if (/^\[\[div\b.*footer-wikiwalk-nav/i.test(trimmed)) {
      skipUntil = /^\[\[\/div\]\]$/i;
      continue;
    }
    if (/^\[\[module\b/i.test(trimmed)) {
      skipUntil = /^\[\[(?:\/module|\/>)\]\]$/i;
      continue;
    }
    if (/^\[\[(?:include|image)\b/i.test(trimmed)) {
      if (!trimmed.endsWith(']]')) skipUntil = /\]\]$/;
      continue;
    }
    if (/^\[\[(?:iftags|\/iftags)\b/i.test(trimmed)) continue;
    if (/^\[\[(?:> |< )?image\b/i.test(trimmed)) continue;
    filtered.push(line.replace(/[ \t]+$/g, ''));
  }
  return filtered
    .join('\n')
    .replace(/\\\s*\n\s*/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function normalizeRenderedArticleContent(rawContent: string): string {
  const pageContent = rawContent.match(/<div\s+id=["']page-content["'][^>]*>/i);
  let content = pageContent
    ? rawContent.slice((pageContent.index ?? 0) + pageContent[0].length)
    : rawContent;
  const boundaries = [
    /<div\s+class=["'][^"']*\bcollection\b/i,
    /<div\s+class=["'][^"']*\bfooter-wikiwalk-nav\b/i,
    /<div\s+class=["'][^"']*\blicensebox\b/i,
    /<div\s+id=["']page-info-break["']/i,
  ].flatMap((pattern) => {
    const match = pattern.exec(content);
    return match?.index === undefined ? [] : [match.index];
  });
  if (boundaries.length > 0) content = content.slice(0, Math.min(...boundaries));
  return decodeHtmlEntities(
    content
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(?:script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|iframe)>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|tr|table|blockquote|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeWikidotDisplayText(source: string): string {
  return source
    .replace(/\[\[\[([^\]\n]+)\]\]\]/g, (_match, body: string) => {
      const separator = body.indexOf('|');
      return (separator >= 0 ? body.slice(separator + 1) : body).trim();
    })
    .replace(/\/\/([^/\n]+)\/\//g, '$1');
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hexadecimal = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

export function articleChunks(article: LoadedArticle): ArticleChunk[] {
  const text = article.normalized_source;
  if (text.length <= MAX_ARTICLE_CHUNK_CHARACTERS) {
    return [{
      page_id: article.entry.page_id,
      source_revision: article.entry.source_revision,
      title: article.entry.title,
      chunk_id: '1/1',
      source: text,
    }];
  }
  const sections = text.split(/(?=^\+{1,6}\s+)/m);
  const chunks: string[] = [];
  let current = '';
  for (const section of sections) {
    if (current && current.length + section.length > MAX_ARTICLE_CHUNK_CHARACTERS) {
      chunks.push(current.trim());
      current = '';
    }
    if (section.length > MAX_ARTICLE_CHUNK_CHARACTERS) {
      for (let offset = 0; offset < section.length; offset += MAX_ARTICLE_CHUNK_CHARACTERS) {
        const piece = section.slice(offset, offset + MAX_ARTICLE_CHUNK_CHARACTERS);
        if (current) chunks.push(current.trim());
        chunks.push(piece.trim());
        current = '';
      }
    } else {
      current += section;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.map((source, index) => ({
    page_id: article.entry.page_id,
    source_revision: article.entry.source_revision,
    title: article.entry.title,
    chunk_id: `${index + 1}/${chunks.length}`,
    source,
  }));
}

export function extractionBatches(chunks: ArticleChunk[]): ArticleChunk[][] {
  const batches: ArticleChunk[][] = [];
  let current: ArticleChunk[] = [];
  let characters = 0;
  let pages = new Set<string>();
  for (const chunk of chunks) {
    const nextPages = new Set(pages).add(chunk.page_id);
    if (
      current.length > 0 &&
      (characters + chunk.source.length > MAX_EXTRACTION_CHARACTERS ||
        nextPages.size > MAX_ARTICLES_PER_EXTRACTION)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
      pages = new Set();
    }
    current.push(chunk);
    characters += chunk.source.length;
    pages.add(chunk.page_id);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, filePath);
}

export const SCP_DATA_API_ORIGIN = 'https://scp-data.tedivm.com';
const INDEX_URL = `${SCP_DATA_API_ORIGIN}/data/scp/items/index.json`;

export type SourceIndexEntry = {
  content_file?: string;
  created_at?: string;
  creator?: string;
  created_by?: string;
  history?: unknown[];
  link?: string;
  page_id?: string | number;
  rating?: number;
  references?: string[];
  scp_number?: number;
  series?: string;
  tags?: string[];
  title?: string;
  url?: string;
};

export type SourceArticle = SourceIndexEntry & {
  raw_content?: string;
  raw_source?: string;
};

export async function fetchItemsIndex(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Record<string, SourceIndexEntry>> {
  const url = new URL(INDEX_URL);
  if (url.origin !== SCP_DATA_API_ORIGIN) throw new Error('Unexpected API origin');
  const response = await fetchImpl(url, { redirect: 'error' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `SCP Data API request failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await response.json()) as Record<string, SourceIndexEntry>;
}

export const SCP_DATA_API_INDEX_URL = INDEX_URL;

export function sourceRevision(entry: SourceIndexEntry): number {
  return Math.max(0, (entry.history?.length ?? 1) - 1);
}

export function normalizedSourceKey(pageId: string): string {
  return `SCP-${pageId.slice(4).padStart(3, '0')}`;
}

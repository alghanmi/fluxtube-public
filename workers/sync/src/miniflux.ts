import { MinifluxEntryNotFoundError } from './types';
import type { MinifluxCategory, MinifluxEntry } from './types';

const FETCH_TIMEOUT_MS = 10_000;
const ENTRIES_PAGE_SIZE = 100;

export class MinifluxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {
    if (!baseUrl) throw new Error('MINIFLUX_URL is required');
    if (!apiToken) throw new Error('MINIFLUX_API_TOKEN is required');
  }

  private url(path: string): string {
    const trimmed = this.baseUrl.replace(/\/+$/, '');
    return `${trimmed}${path}`;
  }

  private async request(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        'X-Auth-Token': this.apiToken,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return fetch(this.url(path), init);
  }

  async listCategories(): Promise<MinifluxCategory[]> {
    const res = await this.request('GET', '/v1/categories');
    if (!res.ok) {
      throw new Error(`miniflux GET /v1/categories failed: ${res.status} ${await safeText(res)}`);
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('miniflux GET /v1/categories returned non-array');
    }
    return data.map((row, i) => {
      if (row === null || typeof row !== 'object') {
        throw new Error(`miniflux category[${i}] is not an object`);
      }
      const obj = row as Record<string, unknown>;
      const id = obj['id'];
      const title = obj['title'];
      if (typeof id !== 'number' || typeof title !== 'string') {
        throw new Error(`miniflux category[${i}] has invalid shape`);
      }
      return { id, title };
    });
  }

  /**
   * List all unread entries in a category, ordered oldest-first by
   * published_at. Pages through results 100 at a time so playlist insertion
   * order is chronological.
   */
  async listUnreadInCategory(categoryId: number): Promise<MinifluxEntry[]> {
    const out: MinifluxEntry[] = [];
    let offset = 0;

    for (;;) {
      const params = new URLSearchParams({
        category_id: String(categoryId),
        status: 'unread',
        order: 'published_at',
        direction: 'asc',
        limit: String(ENTRIES_PAGE_SIZE),
        offset: String(offset),
      });
      const res = await this.request('GET', `/v1/entries?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`miniflux GET /v1/entries failed: ${res.status} ${await safeText(res)}`);
      }
      const body: unknown = await res.json();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('miniflux GET /v1/entries returned non-object');
      }
      const entries = (body as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) {
        throw new Error('miniflux GET /v1/entries response missing `entries` array');
      }

      for (const [i, raw] of entries.entries()) {
        if (raw === null || typeof raw !== 'object') {
          throw new Error(`miniflux entry[${i}] is not an object`);
        }
        const obj = raw as Record<string, unknown>;
        const id = obj['id'];
        const url = obj['url'];
        const title = obj['title'];
        const status = obj['status'];
        if (typeof id !== 'number' || typeof url !== 'string' || typeof title !== 'string') {
          throw new Error(`miniflux entry[${i}] has invalid shape`);
        }
        const narrowedStatus =
          status === 'unread' || status === 'read' || status === 'removed' ? status : 'unread';
        out.push({ id, url, title, status: narrowedStatus });
      }

      if (entries.length < ENTRIES_PAGE_SIZE) break;
      offset += entries.length;
    }

    return out;
  }

  /**
   * Mark one or more entries as read. A 404 from Miniflux indicates the
   * entry no longer exists (rotated out of the feed, deleted by publisher);
   * this is a clean terminal state, surfaced as `MinifluxEntryNotFoundError`
   * so the caller can clean up D1 and continue.
   *
   * 404 handling only applies to single-entry calls — bulk mark-read with a
   * mix of valid and missing IDs would be ambiguous, so we send one at a time
   * when callers want the missing-entry signal. Pass multiple IDs only when
   * you don't care about per-entry 404 differentiation.
   */
  async markRead(entryIds: number[]): Promise<void> {
    if (entryIds.length === 0) return;
    const res = await this.request('PUT', '/v1/entries', {
      entry_ids: entryIds,
      status: 'read',
    });
    if (res.status === 404 && entryIds.length === 1) {
      throw new MinifluxEntryNotFoundError(entryIds[0] as number);
    }
    if (!res.ok) {
      throw new Error(`miniflux PUT /v1/entries failed: ${res.status} ${await safeText(res)}`);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

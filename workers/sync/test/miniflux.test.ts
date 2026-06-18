import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinifluxClient } from '../src/miniflux';
import { MinifluxEntryNotFoundError } from '../src/types';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('MinifluxClient', () => {
  it('sends X-Auth-Token on every request and trims base URL slashes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1, title: 'Cat' }]));
    const client = new MinifluxClient('https://reader.example.com/', 'token123');
    await client.listCategories();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://reader.example.com/v1/categories');
    expect(
      (init.headers as Record<string, string>)['X-Auth-Token'],
    ).toBe('token123');
  });

  it('parses categories', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { id: 1, title: 'YouTube — Cycling' },
        { id: 2, title: 'YouTube — Tech' },
      ]),
    );
    const client = new MinifluxClient('https://reader.example.com', 't');
    expect(await client.listCategories()).toEqual([
      { id: 1, title: 'YouTube — Cycling' },
      { id: 2, title: 'YouTube — Tech' },
    ]);
  });

  it('paginates listUnreadInCategory until a short page is returned', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      url: `https://youtu.be/aaaaaaaaaa${i % 10}`,
      title: `Entry ${i + 1}`,
      status: 'unread',
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: fullPage }))
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            { id: 999, url: 'https://youtu.be/zzzzzzzzzzz', title: 'Last', status: 'unread' },
          ],
        }),
      );

    const client = new MinifluxClient('https://reader.example.com', 't');
    const result = await client.listUnreadInCategory(7);
    expect(result).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstUrl).toMatch(/category_id=7/);
    expect(firstUrl).toMatch(/status=unread/);
    expect(firstUrl).toMatch(/order=published_at/);
    expect(firstUrl).toMatch(/direction=asc/);
    expect(firstUrl).toMatch(/offset=0/);

    const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
    expect(secondUrl).toMatch(/offset=100/);
  });

  it('markRead succeeds on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new MinifluxClient('https://reader.example.com', 't');
    await expect(client.markRead([1, 2, 3])).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ entry_ids: [1, 2, 3], status: 'read' });
  });

  it('markRead throws MinifluxEntryNotFoundError on 404 for a single entry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const client = new MinifluxClient('https://reader.example.com', 't');
    await expect(client.markRead([42])).rejects.toBeInstanceOf(MinifluxEntryNotFoundError);
  });

  it('markRead throws a regular error on 404 for batch (cannot disambiguate)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const client = new MinifluxClient('https://reader.example.com', 't');
    await expect(client.markRead([1, 2])).rejects.toThrow(/404/);
  });

  it('markRead is a no-op when given an empty list', async () => {
    const client = new MinifluxClient('https://reader.example.com', 't');
    await client.markRead([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

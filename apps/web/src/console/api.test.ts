import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';

/** The question routes escape the id in the path (P9-14 review): an id is never a path. */
describe('createApi question routes', () => {
  it('escapes the question id when answering and dismissing', async () => {
    const urls: string[] = [];
    const fakeFetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const api = createApi('tok', fakeFetch);
    await api.answer('q/../x', 'yes', 1);
    await api.dismiss('q/../x', 1);
    expect(urls).toEqual(['/api/questions/q%2F..%2Fx/answer', '/api/questions/q%2F..%2Fx/dismiss']);
  });
});

/** The dashboard routes (P15-04): paths, methods and the layout body. */
describe('createApi dashboard routes', () => {
  it('calls each route with its method, escaping the ids', async () => {
    const calls: [string, string | undefined, string | undefined][] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push([url, init.method, init.body as string | undefined]);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const api = createApi('tok', fakeFetch);
    await api.dashboard('p/1');
    await api.refreshJob('j/1');
    await api.clearPanelHistory('pn/1');
    await api.clearJobValues('j/1');
    await api.arrangePanels('p/1', [{ panelId: 'pn-1', layout: { order: 0, w: 1, h: 1 } }]);
    expect(calls).toEqual([
      ['/api/projects/p%2F1/dashboard', 'GET', undefined],
      ['/api/jobs/j%2F1/refresh', 'POST', undefined],
      ['/api/panels/pn%2F1/clear-history', 'POST', undefined],
      ['/api/jobs/j%2F1/clear-values', 'POST', undefined],
      [
        '/api/projects/p%2F1/dashboard/layout',
        'PUT',
        JSON.stringify({ layouts: [{ panelId: 'pn-1', layout: { order: 0, w: 1, h: 1 } }] }),
      ],
    ]);
  });
});

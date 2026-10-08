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
    expect(urls).toEqual([
      '/api/questions/q%2F..%2Fx/answer',
      '/api/questions/q%2F..%2Fx/dismiss',
    ]);
  });
});

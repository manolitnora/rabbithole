import { test } from 'node:test';
import assert from 'node:assert/strict';
import { braveSearch, braveSearchHTML, parseBraveHTML } from '../src/brave.js';

const FIXTURE = `
<html><body>
<div data-pos="0" data-type="web">
  <a class="button search-snippet-title is-sm" href="https://example.test/first" title="First Result Title">First Result Title</a>
  <div class="snippet-description">A description of the first result. It has a second sentence for the parser.</div>
</div>
<div data-pos="1" data-type="web">
  <a class="search-snippet-title" href="https://other.test/second" title="Second Result Title">Second Result Title</a>
  <div>Another description here.</div>
</div>
</body></html>`;

test('parseBraveHTML maps titles, urls, and descriptions', () => {
  const results = parseBraveHTML(FIXTURE, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'First Result Title');
  assert.equal(results[0].url, 'https://example.test/first');
  assert.ok(results[0].description.startsWith('A description of the first result'));
  assert.equal(results[1].title, 'Second Result Title');
  assert.equal(results[1].url, 'https://other.test/second');
});

test('parseBraveHTML respects the result limit', () => {
  assert.equal(parseBraveHTML(FIXTURE, 1).length, 1);
});

test('parseBraveHTML decodes URL character references exactly once', () => {
  const cases = [
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#x27;', "'"],
    ['&#39;', "'"],
    ['&nbsp;', '\u00a0'],
    ['&#38;', '&'],
    ['&#x26;', '&'],
    ['&#X26;', '&'],
    ['&#128640;', '🚀'],
    ['&#x1F680;', '🚀'],
    ['&amp;lt;', '&lt;'],
    ['&unknown;', '&unknown;'],
  ];
  for (const [encoded, decoded] of cases) {
    const html = FIXTURE.replace('https://example.test/first', `https://example.test/?value=${encoded}`);
    assert.equal(parseBraveHTML(html, 1)[0].url, `https://example.test/?value=${decoded}`, encoded);
  }
});

test('keyless fallback returns decoded query parameters', async () => {
  const html = FIXTURE.replace('https://example.test/first', 'https://example.test/article?id=1&amp;page=2');
  const results = await braveSearch('article', 1, '', () => html);
  assert.equal(results[0].url, 'https://example.test/article?id=1&page=2');
  assert.deepEqual([...new URL(results[0].url).searchParams], [['id', '1'], ['page', '2']]);
});

test('keyless braveSearch uses the HTML fallback', async () => {
  let requested = '';
  const results = await braveSearch('memory research', 5, '', (url) => {
    requested = url;
    return FIXTURE;
  });
  assert.ok(requested.startsWith('https://search.brave.com/search?q='));
  assert.ok(requested.includes('memory%20research'));
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.test/first');
});

test('fallback failure returns an empty list instead of throwing', () => {
  assert.deepEqual(braveSearchHTML('anything', 5, () => { throw new Error('curl missing'); }), []);
});

test('API success preserves results and request options without fetching HTML', async (t) => {
  const expected = [{ title: 'API result', url: 'https://example.test/api', description: 'API description' }];
  const api = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('q'), 'a & b');
    assert.equal(url.searchParams.get('count'), '20');
    assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'test-key');
    return Response.json({ web: { results: expected } });
  });
  assert.deepEqual(await braveSearch('a & b', 25, 'test-key', () => {
    assert.fail('successful API must not fetch HTML');
  }), expected);
  assert.equal(api.mock.callCount(), 1);
});

for (const failure of ['empty', '401', '429', '503', 'network'] as const) {
  test(`API ${failure} falls back with bounded API attempts`, async (t) => {
    const api = t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'network') throw new Error('connection reset');
      return failure === 'empty'
        ? Response.json({ web: { results: [] } })
        : new Response('', { status: Number(failure) });
    });
    let htmlCalls = 0;
    const results = await braveSearch('a & b', 1, 'test-key', url => {
      htmlCalls++;
      assert.equal(new URL(url).searchParams.get('q'), 'a & b');
      return FIXTURE;
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://example.test/first');
    assert.equal(htmlCalls, 1);
    assert.equal(api.mock.callCount(), ['429', '503', 'network'].includes(failure) ? 2 : 1);
  });
}

for (const status of [429, 503]) {
  test(`API recovers after ${status} with exactly one retry and no HTML fetch`, async (t) => {
    let calls = 0;
    const expected = [{ title: 'Recovered', url: 'https://example.test/recovered', description: '' }];
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1
      ? new Response('', { status })
      : Response.json({ web: { results: expected } }));
    assert.deepEqual(await braveSearch('retry', 5, 'test-key', () => {
      assert.fail('recovered API must not fetch HTML');
    }), expected);
    assert.equal(calls, 2);
  });
}

test('missing environment key bypasses API and empty markup is safe', async (t) => {
  const previous = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = previous;
  });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('keyless search must bypass API'); });
  assert.deepEqual(await braveSearch('keyless', 5, undefined, () => '<html></html>'), []);
  assert.equal((await braveSearch('keyless', 1, undefined, () => FIXTURE))[0].title, 'First Result Title');
});

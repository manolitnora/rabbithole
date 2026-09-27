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

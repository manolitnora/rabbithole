import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dive, Store, tunnel } from '../src/index.js';

// Synthetic origin; real HTTP, extraction, engine, and SQLite. Search alone is injected.
test('HTTP 200 challenges never persist prose or teach recipes; genuine articles still learn and reuse recipes', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.challenge-test-'));
  let html = '';
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/article`;
  const page = (title: string, text: string, structure = '') => `<html><head><title>${title}</title></head><body>${structure}<article id="content"><p>${text}</p><a href="/source">Source</a></article></body></html>`;
  const prose = 'Research explains browser verification and its effect on web publishing. '.repeat(10);
  const cases = [
    ['verification id', 'Security verification', prose, '<div id="cf-browser-verification"></div>', true],
    ['challenge class', 'Security verification', prose, '<div class="challenge-running"></div>', true],
    ['challenge script', 'Security verification', prose, '<script src="/cdn-cgi/challenge-platform/h/b/test"></script>', true],
    ['challenge iframe', 'Security verification', prose, '<iframe src="/cdn-cgi/challenge-platform"></iframe>', true],
    ['turnstile script', 'Security verification', prose, '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>', true],
    ['turnstile iframe', 'Security verification', prose, '<iframe src="https://challenges.cloudflare.com/widget"></iframe>', true],
    ['turnstile widget', 'Security verification', prose, '<div class="cf-turnstile"></div>', true],
    ['short title', 'Just a moment...', 'Please wait', '', true],
    ['quoted markers', 'Cloudflare explained', 'checking your browser before accessing cf-browser-verification cdn-cgi/challenge-platform turnstile. ' + prose, '', false],
    ['article title', 'Just a moment', prose, '', false],
    ['article ellipsis title', 'Just a moment...', prose, '', false],
    ['ordinary article', 'Research', prose, '', false],
  ] as const;
  try {
    for (const [i, [name, title, content, structure, rejected]] of cases.entries()) {
      for (const seeded of [false, true]) {
        const storePath = join(dir, `${i}-${seeded}.db`);
        const options = {storePath, maxNodes: 1, maxDepth: 0, minJitter: 0, maxJitter: 0};
        const deps = {search: async () => [{title: 'Candidate', url, description: 'Search description must not mask rejection'}]};
        if (seeded) {
          html = page('Research', prose);
          await dive('learn normal article', options, deps);
        }
        const beforeStore = new Store(storePath);
        const before = beforeStore.getRecipe('127.0.0.1');
        beforeStore.close();
        html = page(title, content, structure);
        const fetched = await tunnel(url, before);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.content, rejected ? '' : content + 'Source');
        assert.equal(fetched.usedRecipe, !rejected && seeded);
        if (rejected) {
          assert.deepEqual(fetched.links, []);
          assert.equal(fetched.fingerprint, null);
          assert.equal(fetched.selector, null);
        }
        const result = await dive(name, options, deps);
        const store = new Store(storePath);
        const node = store.getNodeByTopic(name);
        const recipe = store.getRecipe('127.0.0.1');
        store.close();
        assert.ok(node);
        assert.equal(node.content, rejected ? null : content + 'Source');
        assert.equal(result.nodes[0].content, rejected ? '' : content + 'Source');
        if (rejected) {
          assert.deepEqual(node.subtopics, []);
          assert.equal(recipe?.selector, seeded ? before?.selector : null);
          assert.equal(recipe?.wins, before?.wins ?? 0);
          assert.equal(recipe?.yieldChars, before?.yieldChars ?? 0);
        } else {
          assert.equal(recipe?.selector, 'article#content');
          assert.equal(recipe?.wins, seeded ? 1 : 0);
          assert.ok(recipe?.fingerprint);
        }
        console.log(JSON.stringify({scenario:name, seededRecipe:seeded, httpStatus:fetched.status, extractedCharacters:fetched.yieldChars, usedRecipe:fetched.usedRecipe, storedContent:node.content?.slice(0,160) ?? null, storedRecipe:recipe?.selector, recipeWins:recipe?.wins, subtopics:node.subtopics}));
      }
    }
    assert.equal(hits, cases.length * 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, {recursive:true, force:true});
  }
});

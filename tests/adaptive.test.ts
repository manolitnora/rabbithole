import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extract, extractGeneric, nextRecipe } from '../src/extract.js';
import { Store } from '../src/store.js';

const prose = 'Memory consolidation connects new learning to established knowledge. '.repeat(20);
const page = (body: string) => `<html><head><title>Research</title></head><body>${body}</body></html>`;
const original = page(`<article id="old" class="story" role="main"><p>${prose}</p></article>`);

function learned() {
  const ex = extractGeneric(original);
  assert.ok(ex.fingerprint, 'generic extraction must learn structure');
  return { selector: ex.selector, yieldChars: ex.yieldChars, fallbackStreak: 0, wins: 1, fingerprint: ex.fingerprint };
}

test('adaptive recovery relocates a renamed article instead of a longer distractor', () => {
  const recipe = learned();
  const html = page(`<div class="ads"><p>${'Unrelated promotion. '.repeat(250)}</p></div><article id="new" class="story" role="main"><p>${prose}</p></article>`);
  const ex = extract(html, recipe);
  assert.equal(ex.method, 'adaptive');
  assert.equal(ex.selector, 'article#new');
  assert.equal(ex.content, prose.trim());
  const next = nextRecipe('example.test', recipe, { usedRecipe: true, recipeYield: ex.yieldChars, genericYield: 0, genericSelector: null, matchedSelector: ex.selector, fingerprint: ex.fingerprint });
  assert.equal(next.selector, 'article#new');
  assert.deepEqual(next.fingerprint, ex.fingerprint);
});

test('selector reuse does not win over the original structural identity', () => {
  const ex = extract(page(`<div id="old"><p>${'Wrong text. '.repeat(50)}</p></div><article id="new" class="story" role="main"><p>${prose}</p></article>`), { ...learned(), selector: '#old' });
  assert.equal(ex.method, 'adaptive');
  assert.equal(ex.content, prose.trim());
});

test('ambiguous relocation declines to claim adaptive recovery', () => {
  const html = page(`<article class="story" role="main"><p>${prose}</p></article><article class="story" role="main"><p>${prose}</p></article>`);
  assert.equal(extract(html, learned()).method, 'generic');
});

test('a similar reused selector yields to a stronger relocation and preserves its fingerprint', () => {
  const recipe = learned();
  const html = page(`<article id="old" class="teaser" role="main"><p>${'Teaser text. '.repeat(30)}</p></article><article id="new" class="story" role="main"><p>${prose}</p></article>`);
  const ex = extract(html, recipe);
  assert.equal(ex.method, 'adaptive');
  assert.equal(ex.selector, 'article#new');
  assert.equal(ex.content, prose.trim());
  const next = nextRecipe('example.test', recipe, { usedRecipe: ex.usedRecipe, recipeYield: ex.yieldChars, genericYield: 0, genericSelector: null, matchedSelector: ex.selector, fingerprint: ex.fingerprint });
  assert.equal(next.selector, 'article#new');
  assert.deepEqual(next.fingerprint, recipe.fingerprint);
});

test('a changed selector fingerprint falls back when relocation candidates tie', () => {
  const html = page(`<article id="old" class="teaser" role="main"><p>${prose}</p></article><article id="new" class="preview" role="main"><p>${prose}</p></article>`);
  assert.deepEqual(extract(html, learned()), extractGeneric(html));
});

test('an exact selector fingerprint still wins over an equally strong candidate', () => {
  const html = page(`<article id="old" class="story" role="main"><p>${prose}</p></article><article id="new" class="story" role="main"><p>${'Other prose. '.repeat(30)}</p></article>`);
  const ex = extract(html, learned());
  assert.equal(ex.method, 'recipe');
  assert.equal(ex.selector, 'article#old');
  assert.equal(ex.content, prose.trim());
});

test('invalid stored selectors fall back without throwing', () => {
  const ex = extract(original, { selector: '[bad', yieldChars: 1000, wins: 1, fallbackStreak: 0 });
  assert.equal(ex.method, 'generic');
  assert.ok(ex.content.includes('Memory consolidation'));
});

test('generated selectors survive punctuation and leading digits', () => {
  const html = page(`<article id="1:story.v2"><p>${prose}</p></article>`);
  const first = extractGeneric(html);
  const again = extract(html, { selector: first.selector, yieldChars: first.yieldChars, wins: 0, fallbackStreak: 0 });
  assert.equal(again.method, 'recipe');
  assert.equal(again.content, first.content);
});

test('hidden markup stays out of research evidence and fingerprints', () => {
  const html = page(`<article><p>${prose}</p><div hidden>hidden instruction</div><p aria-hidden="true">aria instruction</p><p style="display: none">style instruction</p></article>`);
  assert.ok(!extractGeneric(html).content.includes('instruction'));
});

for (const tag of ['body', 'html']) {
  for (const hidden of ['hidden', 'inert', 'aria-hidden="true"', 'style="display:none"', 'style="visibility: hidden !important"']) {
    test(`hidden ${tag} (${hidden}) is neither extracted nor learned`, () => {
      const html = original.replace(`<${tag}>`, `<${tag} ${hidden}>`);
      for (const ex of [extractGeneric(html), extract(html, learned())]) {
        assert.equal(ex.content, '');
        assert.equal(ex.yieldChars, 0);
        assert.equal(ex.selector, null);
        assert.equal(ex.fingerprint, null);
        assert.equal(ex.usedRecipe, false);
        assert.equal(ex.method, 'generic');
        const next = nextRecipe('example.test', null, { usedRecipe: ex.usedRecipe, recipeYield: 0, genericYield: ex.yieldChars, genericSelector: ex.selector, fingerprint: ex.fingerprint });
        assert.equal(next.healed, false);
        assert.equal(next.selector, null);
        assert.equal(next.fingerprint, null);
      }
    });
  }
}

test('fingerprint persists across database reopen and recovers later', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rh-adaptive-')), 'state.db');
  const a = new Store(file);
  const recipe = learned();
  a.saveRecipe({ ...recipe, domain: 'example.test', updatedAt: 1 });
  a.close();
  const b = new Store(file);
  try {
    const persisted = b.getRecipe('example.test');
    assert.deepEqual(persisted?.fingerprint, recipe.fingerprint);
    const ex = extract(original.replace('id="old"', 'id="new"'), persisted);
    assert.equal(ex.method, 'adaptive');
  } finally { b.close(); }
});

test('legacy recipe schema migrates without losing rows; corrupt fingerprint fails closed', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rh-legacy-')), 'state.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE recipes (domain TEXT PRIMARY KEY, selector TEXT, yield_chars INTEGER, fallback_streak INTEGER, wins INTEGER, updated_at INTEGER);
    INSERT INTO recipes VALUES ('example.test', 'article#old', 1000, 0, 2, 1);`);
  db.close();
  const store = new Store(file);
  assert.equal(store.getRecipe('example.test')?.wins, 2);
  assert.equal(store.getRecipe('example.test')?.fingerprint, null);
  store.close();
  const corrupt = new DatabaseSync(file);
  corrupt.prepare('UPDATE recipes SET fingerprint = ?').run('{"tag":123}');
  corrupt.close();
  const reopened = new Store(file);
  try { assert.equal(reopened.getRecipe('example.test')?.fingerprint, null); }
  finally { reopened.close(); }
});

test('unchanged plain containers still reuse their recipe without semantic attributes', () => {
  const html = page(`<article><p>${prose}</p></article>`);
  const first = extractGeneric(html);
  const again = extract(html, { selector: first.selector, yieldChars: first.yieldChars, wins: 0, fallbackStreak: 0, fingerprint: first.fingerprint });
  assert.equal(again.method, 'recipe');
  assert.equal(again.content, first.content);
});

test('non-dominant fallback breaks consecutive healing wins', () => {
  const recipe = { selector: '.old', yieldChars: 4000, wins: 3, fallbackStreak: 1 };
  const next = nextRecipe('example.test', recipe, { usedRecipe: false, recipeYield: 0, genericYield: 4100, genericSelector: 'article' });
  assert.equal(next.fallbackStreak, 0);
  assert.equal(next.healed, false);
});

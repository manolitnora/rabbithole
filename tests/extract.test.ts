/**
 * Extract Tests — linkedom parsing, density scoring, recipe healing.
 * Fully local: canned HTML fixtures.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractGeneric, extract, nextRecipe, selectorFor, domainOf } from '../src/extract.js';

const PROSE = 'Episodic memory systems let agents retrieve past episodes and generalize across tasks. '.repeat(20);

function pageWith(body: string, title = 'Test Page'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const ARTICLE_PAGE = pageWith(`
<nav><a href="/home">Home</a> <a href="/about">About</a></nav>
<article id="main-story">
  <h2>Heading</h2>
  <p>${PROSE}</p>
  <p>Read more at <a href="https://else.example/x">the source</a>.</p>
</article>
<footer>copyright nobody</footer>
<script>alert("evil")</script>
`);

const NAV_HEAVY_PAGE = pageWith(`
<div class="menu">
  ${Array.from({ length: 30 }, (_, i) => `<a href="/l${i}">link ${i} text here</a>`).join(' ')}
</div>
<main class="content">
  <p>${PROSE}</p>
</main>
`);

const MALFORMED_PAGE = `<html><head><title>Broken</title><body>
<div class="wrap"><p>Unclosed paragraph ${PROSE}
<ul><li>item one<li>item two</ul>
`;

describe('extractGeneric', () => {
  test('article beats chrome; scripts stripped; links collected', () => {
    const ex = extractGeneric(ARTICLE_PAGE);
    assert.equal(ex.title, 'Test Page');
    assert.ok(ex.content.includes('Episodic memory systems'));
    assert.ok(!ex.content.includes('alert'));
    assert.ok(!ex.content.includes('Home'));
    assert.ok(ex.links.includes('/home'));
    assert.ok(ex.links.includes('https://else.example/x'));
    assert.ok(ex.yieldChars >= 1000);
  });

  test('density scoring prefers prose container over nav-heavy menu', () => {
    const ex = extractGeneric(NAV_HEAVY_PAGE);
    assert.ok(ex.content.includes('Episodic memory'));
    assert.ok(!ex.content.includes('link 0 text'), 'menu links must not dominate content');
    assert.equal(ex.selector, 'main.content');
  });

  test('malformed HTML does not throw and still yields prose', () => {
    const ex = extractGeneric(MALFORMED_PAGE);
    assert.equal(ex.title, 'Broken');
    assert.ok(ex.content.includes('Unclosed paragraph'));
  });

  test('empty input is safe', () => {
    const ex = extractGeneric('');
    assert.equal(ex.title, '');
    assert.equal(ex.content, '');
    assert.deepEqual(ex.links, []);
  });

  test('challenge interstitial is not article text', () => {
    const cf = pageWith(
      `<div id="challenge-running">Checking your browser before accessing pmc.ncbi.nlm.nih.gov ...
Click here if you are not automatically redirected after 5 seconds.</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>`,
      'Just a moment...',
    );
    const ex = extractGeneric(cf);
    assert.equal(ex.yieldChars, 0);
    assert.equal(ex.content, '');
    assert.ok(!ex.content.includes('Checking your browser'));
  });

  test('sectioned layout: sibling sections merge into one extraction', () => {
    // Regression: MediaWiki now splits articles into sibling <section>s;
    // picking only the densest section lost ~95% of the article.
    const sectioned = pageWith(`
    <div id="mw-content">
      <h1>Title</h1>
      <section id="mwQ"><p>Lead. ${PROSE}</p></section>
      <section id="mwR"><p>History. ${PROSE.replace(/Episodic/g, 'Historic')}</p></section>
      <section id="mwS"><p>Practice. ${PROSE.replace(/Episodic/g, 'Practical')}</p></section>
      <nav><a href="/x">nav</a></nav>
    </div>`);
    const ex = extractGeneric(sectioned);
    assert.ok(ex.yieldChars >= PROSE.length * 2, `expected merged sections, got ${ex.yieldChars} chars`);
    assert.ok(ex.content.includes('Lead.') && ex.content.includes('History.') && ex.content.includes('Practice.'), 'all sections present');
    assert.equal(ex.selector, 'div#mw-content');
  });
});

describe('selectorFor', () => {
  test('prefers id, then first class, then bare tag', () => {
    assert.equal(selectorFor({ tagName: 'ARTICLE', getAttribute: (k: string) => (k === 'id' ? 'x' : null) } as never), 'article#x');
    assert.equal(selectorFor({ tagName: 'MAIN', getAttribute: (k: string) => (k === 'class' ? 'content wide' : null) } as never), 'main.content');
    assert.equal(selectorFor({ tagName: 'SECTION', getAttribute: () => null } as never), 'section');
    assert.equal(selectorFor({ tagName: 'BODY', getAttribute: () => null } as never), null);
  });
});

describe('recipe healing', () => {
  const prev = { selector: 'div.old', yieldChars: 4000, fallbackStreak: 0, wins: 5 };

  test('recipe win resets streak and counts', () => {
    const r = nextRecipe('a.example', prev, { usedRecipe: true, recipeYield: 4200, genericYield: 5000, genericSelector: 'article' });
    assert.equal(r.healed, false);
    assert.equal(r.wins, 6);
    assert.equal(r.fallbackStreak, 0);
    assert.equal(r.selector, 'div.old');
  });

  test('one generic fallback does not heal yet (streak=1)', () => {
    const r = nextRecipe('a.example', prev, { usedRecipe: false, recipeYield: 10, genericYield: 9000, genericSelector: 'article' });
    assert.equal(r.healed, false);
    assert.equal(r.fallbackStreak, 1);
    assert.equal(r.selector, 'div.old');
  });

  test('two dominant generic wins heal the recipe', () => {
    const streaking = { ...prev, fallbackStreak: 1 };
    const r = nextRecipe('a.example', streaking, { usedRecipe: false, recipeYield: 10, genericYield: 9000, genericSelector: 'article' });
    assert.equal(r.healed, true);
    assert.equal(r.selector, 'article');
    assert.equal(r.yieldChars, 9000);
    assert.equal(r.wins, 0);
  });

  test('generic wins but not dominant → no heal', () => {
    const streaking = { ...prev, fallbackStreak: 1 };
    const r = nextRecipe('a.example', streaking, { usedRecipe: false, recipeYield: 10, genericYield: 4100, genericSelector: 'article' });
    assert.equal(r.healed, false);
    assert.equal(r.selector, 'div.old');
  });

  test('first-ever run adopts qualifying generic selector', () => {
    const r = nextRecipe('a.example', null, { usedRecipe: false, recipeYield: 0, genericYield: 3000, genericSelector: 'main.content' });
    assert.equal(r.healed, true);
    assert.equal(r.selector, 'main.content');
  });

  test('weak generic on first run adopts nothing', () => {
    const r = nextRecipe('a.example', null, { usedRecipe: false, recipeYield: 0, genericYield: 150, genericSelector: 'aside' });
    assert.equal(r.healed, false);
    assert.equal(r.selector, null);
  });
});

describe('full extract with recipe', () => {
  test('recipe hit uses stored selector and reports usedRecipe', () => {
    const ex = extract(ARTICLE_PAGE, { selector: '#main-story', yieldChars: 0, fallbackStreak: 0, wins: 0 });
    assert.equal(ex.usedRecipe, true);
    assert.equal(ex.selector, '#main-story');
    assert.ok(ex.content.includes('Episodic memory'));
  });

  test('recipe miss falls back to generic extraction', () => {
    const ex = extract(ARTICLE_PAGE, { selector: 'div.does-not-exist', yieldChars: 0, fallbackStreak: 0, wins: 3 });
    assert.equal(ex.usedRecipe, false);
    assert.ok(ex.content.includes('Episodic memory'));
  });

  test('domainOf parses hostname, empty on garbage', () => {
    assert.equal(domainOf('https://sub.example.com/a?b=c'), 'sub.example.com');
    assert.equal(domainOf('not a url'), '');
  });
});

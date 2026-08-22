/**
 * Live integration test — real web, NO Brave key needed.
 *
 * Injects a Wikipedia-API search adapter through the engine's deps seam,
 * so the full compounding loop (dive → persist → resume → staleness)
 * runs against real pages over real HTTP.
 *
 * Run: npx tsx live-test.mts
 */
import { rmSync } from 'node:fs';
import { dive } from './src/rabbithole.js';
import { tunnel } from './src/tunnel.js';
import type { EngineDeps, SearchResult } from './src/rabbithole.js';

const WIKI = 'https://en.wikipedia.org';

/** Keyless search: Wikipedia opensearch API → SearchResult[]. */
async function wikiSearch(query: string, count: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query,
    srlimit: String(count), format: 'json', origin: '*',
  });
  const res = await fetch(`${WIKI}/w/api.php?${params}`, {
    headers: { 'User-Agent': 'rabbithole-live-test/2.0 (local research tool)' },
  });
  if (!res.ok) return [];
  const data = await res.json() as { query?: { search?: Array<{ title: string; snippet: string }> } };
  return (data.query?.search ?? []).map(r => ({
    title: r.title,
    url: `${WIKI}/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    description: r.snippet.replace(/<[^>]+>/g, ''),
  }));
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(` ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ── Part 1: tunnel + extraction against real pages ────────────────
console.log('PART 1 — tunnel/extract on live pages');
{
  // example.com is NXDOMAIN via this network's router DNS — iana.org instead
  const t0 = Date.now();
  const ex = await tunnel('https://www.iana.org/domains/reserved');
  check('iana page extracts title', ex.success && ex.title.length > 3, `"${ex.title}" in ${Date.now()-t0}ms`);

  const t1 = Date.now();
  const wiki = await tunnel('https://en.wikipedia.org/wiki/Zettelkasten');
  check('wikipedia page yields prose ≥1000 chars', wiki.success && wiki.yieldChars >= 1000, `${wiki.yieldChars} chars in ${Date.now()-t1}ms`);
  check('links harvested (≥5)', wiki.links.length >= 5, `${wiki.links.length} links`);
  check('content is chrome-free prose', !wiki.content.includes('Wikipedia®') && wiki.selector !== null, `selector=${wiki.selector}`);

  // Same-domain second fetch: recipe was persisted by first tunnel? No —
  // recipes persist only via engine processing; direct tunnel gets null.
  // Verify determinism instead: identical content → identical hash inputs.
  const again = await tunnel('https://en.wikipedia.org/wiki/Zettelkasten');
  check('repeat fetch deterministic', again.success && again.content === wiki.content, '');
}

// ── Part 2: FULL compounding dive, live, via deps injection ─────────
console.log('\nPART 2 — live dive ×2 (compounding loop)');
rmSync('.rabbithole-livetest', { recursive: true, force: true });
const STORE = '.rabbithole-livetest/state.db';
const OPTS = {
  storePath: STORE,
  maxNodes: 6,
  searchResultsPerQuery: 3,
  minJitter: 250,
  maxJitter: 600,
};
const TOPIC = 'zettelkasten method';
const deps: EngineDeps = { search: wikiSearch };

process.stdout.write(' run 1 (fresh)... ');
const t1 = Date.now();
const r1 = await dive(TOPIC, OPTS, deps);
console.log(`${r1.exitReason} explored=${r1.nodesExplored} complete=${r1.nodesComplete} depth=${r1.maxDepthReached} in ${Math.round((Date.now()-t1)/1000)}s`);
check('run 1 researched multiple nodes', r1.nodesComplete >= 2, JSON.stringify(r1.delta));
check('run 1 expanded frontier', (r1.delta?.expandedNodes ?? 0) > 0, '');

// Recipes must have been learned from real wikipedia DOM
const { Store } = await import('./src/store.js');
const s1 = new Store(STORE);
const recipe = s1.getRecipe('en.wikipedia.org');
check('recipe learned for en.wikipedia.org', recipe !== null && recipe.selector !== null, `selector=${recipe?.selector} yield=${recipe?.yieldChars}`);
s1.close();

process.stdout.write(' run 2 (resume, force-stale)... ');
const t2 = Date.now();
const r2 = await dive(TOPIC, { ...OPTS, resume: true, stalenessTtlMs: 0 }, deps);
console.log(`${r2.exitReason} in ${Math.round((Date.now()-t2)/1000)}s`);
const d = r2.delta!;
check('run 2 revalidated stale nodes', d.revalidated > 0, JSON.stringify(d));
check('stable live pages → mostly unchanged', d.changedNodes <= Math.max(1, Math.floor(d.revalidated / 2)), `${d.changedNodes}/${d.revalidated} changed`);
const accounted = d.skippedResearched + d.changedNodes;
check('delta accounting closes', accounted >= r1.nodesComplete - d.failedNodes - d.changedNodes, `skipped=${d.skippedResearched} of complete=${r1.nodesComplete}`);
check('run 2 exit convergence', r2.exitReason === 'convergence', '');

console.log(`\nLIVE TEST ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);

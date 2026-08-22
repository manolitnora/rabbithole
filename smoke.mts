/**
 * Live smoke: real dive x2 against the web via Brave + tunnel.
 * Run: npx tsx smoke.mts   (requires BRAVE_API_KEY)
 */
import { dive } from './src/rabbithole.js';

const TOPIC = 'zettelkasten method';
const OPTS = { storePath: '.rabbithole-smoke/state.db', maxNodes: 5, searchResultsPerQuery: 3, minJitter: 400, maxJitter: 900 };
import { rmSync } from 'node:fs';
rmSync('.rabbithole-smoke', { recursive: true, force: true }); // fresh experiment every invocation
const t0 = Date.now();
const r1 = await dive(TOPIC, OPTS);
console.log(`exit=${r1.exitReason} explored=${r1.nodesExplored} complete=${r1.nodesComplete} depth=${r1.maxDepthReached} in ${Math.round((Date.now()-t0)/1000)}s`);
console.log('delta:', JSON.stringify(r1.delta));

process.stdout.write('\nRUN 2 (resume, everything stale-checked)...\n');
const t1 = Date.now();
const r2 = await dive(TOPIC, { ...OPTS, resume: true, stalenessTtlMs: 0 });
console.log(`exit=${r2.exitReason} explored=${r2.nodesExplored} complete=${r2.nodesComplete} in ${Math.round((Date.now()-t1)/1000)}s`);
console.log('delta:', JSON.stringify(r2.delta));

const d = r2.delta!;
// Meaningful pass: run 1 actually researched, and run 2 skipped or
// legitimately invalidated everything run 1 completed.
const failedNow = r2.nodes.filter(n => n.status === 'failed').length;
const accounted = d.skippedResearched + d.changedNodes + failedNow;
const pass = r1.nodesComplete > 0 && accounted >= r1.nodesComplete - d.failedNodes && r2.exitReason === 'convergence';
console.log(`\nSMOKE ${pass ? 'PASS' : 'FAIL'}: run1 complete=${r1.nodesComplete}, run2 skipped=${d.skippedResearched} revalidated=${d.revalidated} changed=${d.changedNodes}`);
process.exit(pass ? 0 : 1);

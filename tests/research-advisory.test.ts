import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { previewJevResearch, evaluateJevResearch, type JevResearchApproval, type JevResearchHost } from '../src/research-advisory.js';
import type { ResearchNode } from '../src/dag.js';

const topic = 'memory research';
const node: ResearchNode = { id: 'local-id', topic, parentId: null, depth: 0, status: 'complete', content: 'Evidence about memory consolidation.', sources: ['https://example.test/article'], subTopics: [], timestamp: 1 };
const preview = () => previewJevResearch(topic, [node]);
// Synthetic host fixture, never used with the production transport.
const approval = (): JevResearchApproval => ({ ...preview(), authorityFree: true });
const response = () => ({ model: 'jev-1.13.0', answers: {
  relevance: { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.8, unrelated: 0.1, abstain: 0.1 }, confidence: 0.7 },
  conflict: { type: 'choice', choice: 'none', probabilities: { conflict: 0.1, none: 0.8, abstain: 0.1 }, confidence: 0.7 },
  coverage: { type: 'choice', choice: 'partial', probabilities: { sufficient: 0.1, partial: 0.8, abstain: 0.1 }, confidence: 0.7 },
}, usage: { input_tokens: 100, output_tokens: 40 } });

function synthetic(fetchImpl: typeof fetch, extras: Partial<JevResearchHost> = {}): JevResearchHost {
  return { approval: approval(), getApiKey: () => 'synthetic-test-token', fetchImpl, ...extras };
}

test('no approval or any mismatched hash means no credentials and no network', async () => {
  let calls = 0;
  const host = { getApiKey: () => { calls++; return 'test'; }, fetchImpl: async () => { calls++; throw new Error('must not call'); } };
  assert.equal((await evaluateJevResearch(topic, [node], host)).status, 'not_approved');
  for (const field of ['sourceHash', 'exportHash', 'disclosureHash', 'requestHash'] as const) {
    const changed = { ...approval(), [field]: 'wrong' };
    assert.equal((await evaluateJevResearch(topic, [node], { ...host, approval: changed })).status, 'not_approved');
  }
  assert.equal(calls, 0);
});

test('changed evidence, URL, topic or question bytes cannot reuse approval', async () => {
  let calls = 0;
  const host = synthetic(async () => { calls++; throw new Error('must not call'); });
  for (const changed of [{ ...node, content: 'Changed' }, { ...node, sources: ['https://other.test'] }]) {
    assert.equal((await evaluateJevResearch(topic, [changed], host)).status, 'not_approved');
  }
  assert.equal((await evaluateJevResearch('different topic', [node], host)).status, 'not_approved');
  const tampered = { ...approval(), requestHash: createHash('sha256').update(preview().serialized.replace('relevance', 'differentQuestion')).digest('hex') };
  assert.equal((await evaluateJevResearch(topic, [node], { ...host, approval: tampered })).status, 'not_approved');
  assert.equal(calls, 0);
});

test('preview excludes local IDs/timestamps and labels omitted and excerpted evidence', () => {
  assert.deepEqual(previewJevResearch(topic, [{ ...node, id: 'new', timestamp: 100 }]), preview());
  const nodes = Array.from({ length: 12 }, (_, i) => ({ ...node, topic: `topic ${i}`, content: 'x'.repeat(2000) }));
  const a = previewJevResearch(topic, nodes);
  assert.deepEqual(a, previewJevResearch(topic, [...nodes].reverse()));
  const data = JSON.parse(a.serialized);
  assert.equal(data.state.omittedCompleteNodes, 2);
  assert.equal(data.state.evidence.length, 10);
  assert.equal(data.state.evidence[0].text.length, 1500);
  assert.equal(data.state.evidence[0].excerpted, true);
});

test('approved request sends exactly hashed bytes once and retains distributions', async () => {
  let calls = 0;
  const before = structuredClone(node);
  const result = await evaluateJevResearch(topic, [node], synthetic(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, preview().serialized);
    assert.equal(createHash('sha256').update(String(init?.body)).digest('hex'), approval().requestHash);
    return Response.json(response());
  }));
  assert.equal(calls, 1);
  assert.equal(result.status, 'hypothesis');
  assert.ok('receipt' in result);
  assert.equal(result.epistemicStatus, 'hypothesis');
  assert.deepEqual(result.receipt.answers, response().answers);
  assert.equal(result.receipt.requestedModel, 'jev-latest');
  assert.equal(result.receipt.servedModel, 'jev-1.13.0');
  assert.deepEqual(node, before);
});

test('malformed answers fail closed without carrying provider prose', async () => {
  const changes = [
    (r: ReturnType<typeof response>) => { r.model = 'unknown'; },
    (r: ReturnType<typeof response>) => { r.answers.relevance.choice = 'invented'; },
    (r: ReturnType<typeof response>) => { r.answers.relevance.type = 'score'; },
    (r: ReturnType<typeof response>) => { r.answers.relevance.probabilities.relevant = 0.5; },
    (r: ReturnType<typeof response>) => { r.answers.relevance.choice = 'unrelated'; },
    (r: ReturnType<typeof response>) => { r.answers.relevance.confidence = 2; },
    (r: ReturnType<typeof response>) => { r.usage.input_tokens = -1; },
  ];
  for (const mutate of changes) {
    const raw = response(); mutate(raw);
    assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(async () => Response.json(raw))), { status: 'unavailable', reason: 'malformed_response' });
  }
  assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(async () => new Response('secret error body'))), { status: 'unavailable', reason: 'malformed_response' });
});

test('all abstentions retain the complete exchange without pretending success', async () => {
  const raw = response();
  for (const a of Object.values(raw.answers)) {
    a.choice = 'abstain';
    for (const key of Object.keys(a.probabilities)) Object.assign(a.probabilities, { [key]: key === 'abstain' ? 1 : 0 });
  }
  const result = await evaluateJevResearch(topic, [node], synthetic(async () => Response.json(raw)));
  assert.equal(result.status, 'abstained');
  assert.ok('receipt' in result);
  assert.deepEqual(result.receipt.answers, raw.answers);
});

test('HTTP failure and redirect are terminal with no retry or raw errors', async () => {
  for (const status of [302, 401, 422, 429, 503]) {
    let calls = 0;
    const result = await evaluateJevResearch(topic, [node], synthetic(async () => { calls++; return new Response('untrusted vendor text', { status }); }));
    assert.deepEqual(result, { status: 'unavailable', reason: 'http_error' });
    assert.equal(calls, 1);
  }
});

test('request and response-body timeouts finish even if the transport ignores abort', async () => {
  const never: typeof fetch = () => new Promise(() => {});
  assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(never, { timeoutMs: 20 })), { status: 'unavailable', reason: 'timeout' });
  const stalled: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
  assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(stalled, { timeoutMs: 20 })), { status: 'unavailable', reason: 'timeout' });
});

test('oversized response and missing key fail closed', async () => {
  assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(async () => new Response('x'.repeat(33_000)))), { status: 'unavailable', reason: 'malformed_response' });
  assert.deepEqual(await evaluateJevResearch(topic, [node], synthetic(async () => { throw new Error('must not call'); }, { getApiKey: () => undefined })), { status: 'unavailable', reason: 'missing_api_key' });
});

test('cancellation before approval transport does not read credentials', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await evaluateJevResearch(topic, [node], synthetic(async () => { throw new Error('must not call'); }, { getApiKey: () => { throw new Error('must not read'); } }), controller.signal);
  assert.deepEqual(result, { status: 'unavailable', reason: 'cancelled' });
});

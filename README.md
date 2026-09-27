# rabbithole

Privacy-tunneled recursive research engine that **compounds**: feed it a topic, get back a knowledge DAG that persists in SQLite — the next dive skips what's done, revalidates what's stale, and expands only the frontier. The dive makes zero LLM calls; [JEV evidence review](#optional-jev-evidence-review) is optional and separately approved.

## What it does

```
Topic: "episodic memory in LLM agents"
    ↓
Brave Search (privacy-first, no tracking)
    ↓
Tunnel (fetch with jitter + anti-bot timing)
    ↓
Extract content + sub-topics
    ↓
Spawn child nodes (mitosis)
    ↓
Repeat until MAX_DEPTH (3) or MAX_NODES (20)
    ↓
Return: markdown report + structured DAG
```

Four primitives:

| Primitive | What it does |
|---|---|
| **Search** | Brave Search API — no tracking, no profiling, transient-failure retry |
| **Tunnel** | Fetch with 2-5s jitter, concurrency limits, bounded 429/5xx retries with Retry-After, response size cap |
| **Extract** | linkedom parsing + text-density scoring; per-domain recipes that persist and self-heal |
| **DAG** | Directed Acyclic Graph — depth-limited, no duplicates, breadth-first, **persisted** |

## Install

```bash
git clone https://github.com/manolitnora/rabbithole.git
cd rabbithole
npm install
```

## Usage

```typescript
import { dive } from 'rabbithole';
// First run: full exploration, persisted to .rabbithole/state.db
const r1 = await dive('episodic memory in LLM agents');
console.log(r1.markdown);           // Structured research report
console.log(r1.delta.expandedNodes); // frontier nodes spawned

// A week later: incremental run — skips researched, revalidates stale
const r2 = await dive('episodic memory in LLM agents', { resume: true });
console.log(r2.delta);
// { skippedResearched: 18, revalidated: 5, changedNodes: 2,
//   expandedNodes: 3, failedNodes: 0 }
```

### Individual primitives

```typescript
import { braveSearch, tunnel } from 'rabbithole';

// Search
const results = await braveSearch('transformer attention mechanisms');

// Tunnel into a URL
const page = await tunnel('https://arxiv.org/abs/2401.12345');
console.log(page.content);  // Extracted text, no HTML
```

## Configuration

```typescript
await dive('topic', {
  resume: true,             // incremental: skip done, revalidate stale
  maxDepth: 3,              // max recursion depth
  maxNodes: 20,             // max total nodes in DAG
  maxConcurrent: 3,         // max parallel requests (enforced in tunnel)
  minJitter: 2000,          // ms — minimum delay between requests
  maxJitter: 5000,          // ms — maximum delay between requests
  searchResultsPerQuery: 5, // Brave results per search
  stalenessTtlMs: 604800000, // complete nodes older than this get revalidated (7d)
  maxRevalidate: 5,         // max refetch-based staleness checks per run
  storePath: null,          // null → .rabbithole/state.db (override via RH_HOME)
});
```

## How compounding works

- **Topics are durable keys.** A topic researched under any root, in any run, is never expanded again — cross-run dedup lives in SQLite (`UNIQUE(topic)`), not in memory.
- **Staleness is bounded.** On `resume`, complete nodes older than `stalenessTtlMs` are revalidated oldest-first, at most `maxRevalidate` refetches per run. A page whose content hash changed re-enters research; an unchanged page just has its timestamp touched.
- **Extraction heals itself.** Per-domain recipes persist in SQLite; see [When a site changes](#when-a-site-changes) for relocation and healing.
- **The frontier survives crashes.** Pending nodes are flushed to the store the moment they're spawned, so an interrupted run resumes where it left off.

## When a site changes

- **Anti-bot interstitials yield no content, even with HTTP 200.** Before generic or recipe extraction, documents are rejected if an element's ID or class contains `challenge`, `cf-browser-verification`, or `turnstile` (case-insensitive), or a script/iframe source uses the host `challenges.cloudflare.com` or the path `/cdn-cgi/challenge-platform` (including its subpaths). These structural checks apply to the whole document, including embedded widgets. Without structural markers, only the trimmed, case-insensitive titles `Just a moment` and `Just a moment...` with fewer than 200 extracted characters trigger rejection. Quoting challenge markers in article text alone does not trigger rejection. Rejected pages retain their title but return empty content and links, no selector or fingerprint, and no recipe use, so their challenge prose cannot be stored or learned as a recipe.
- **Recipes relocate by structure.** Each recipe stores a fingerprint of the winning container: tag, semantic attributes (`role`, `itemprop`, `data-testid`), classes, and parent and child tags. A unique selector match with an unchanged fingerprint is reused immediately if its yield is sufficient. When the selector stops matching uniquely or its fingerprint changes, candidates compete by structural similarity, including any reused selector. Only a clear winner is accepted; ties and weak matches fall back to generic extraction. Successful relocation updates the stored selector and fingerprint. Legacy databases migrate automatically; recipes without fingerprints can still use their selectors.
- **Generic extraction heals failed recipes.** If recipe reuse and relocation fail, the generic density pipeline takes over. With the default settings, two consecutive generic yields of at least 200 characters and at least twice the saved recipe yield replace the recipe.
- **Hidden elements are excluded from prose.** `[hidden]`, `[inert]`, `[aria-hidden="true"]`, and inline `display:none` or `visibility:hidden` are excluded before scoring. A hidden body or ancestor yields empty extraction and no learned fingerprint. Stylesheets and computed visibility are not evaluated. This reduces injection surface; it is not a complete prompt-injection defense. Treat page content as untrusted data.

## Bounded fetching

HTTP 429 and 5xx responses and network errors retry up to `retries` (default 1). For retryable HTTP responses, `Retry-After` accepts seconds or an HTTP date; absent or unparseable values use jitter backoff. An HTTP retry delay longer than `maxRetryDelayMs` fails the request instead of retrying early. Failed HTTP response bodies are cancelled. Response bodies larger than `maxResponseBytes` fail without retrying. Concurrency stays inside the tunnel.

```typescript
import { configureTunnel } from 'rabbithole';

configureTunnel({
  retries: 1,
  maxRetryDelayMs: 5000,
  maxResponseBytes: 2_000_000,
});
```

`configureTunnel` rejects invalid numeric settings: jitter bounds, retries, and retry-delay budgets must be nonnegative safe integers; timeout, concurrency, and response-byte limits must be positive safe integers. The minimum jitter cannot exceed the maximum, and retries cannot exceed five.

## Optional JEV evidence review

JEV reviews relevance, conflicts, and coverage after a dive. Review is a separate step so a dive never silently sends its results to another service.

```typescript
import { dive, previewJevResearch, evaluateJevResearch } from 'rabbithole';

const result = await dive('memory consolidation');
const preview = previewJevResearch(result.topic, result.nodes);
console.log(preview.serialized); // Exact request for host review. No network call.

const pending = await evaluateJevResearch(result.topic, result.nodes);
console.log(pending.status); // 'not_approved'. No credentials read, no request sent.
```

To transmit, the calling host supplies a `JevResearchHost` as the third argument to `evaluateJevResearch`. Its `approval` must independently attest `authorityFree: true` and match the preview's `sourceHash`, `exportHash`, `disclosureHash`, and `requestHash`. The request hash binds the questions as well as the evidence. Keep host configuration and approval out of model-callable arguments. Do not generate approval inside a model prompt, and never infer it from an API key.

After approval, the client reads `JEV_API_KEY`, or calls the host's `getApiKey` callback. It sends one request to `https://api.typesafe.ai/v1/systemone`, with no retries and no redirects. Changed evidence requires a new approval.

The request uses JEV's `choice` primitive for three research questions. It exports at most ten completed nodes and 1,500 characters per node. Omitted nodes and excerpted text are explicitly marked. URLs identify candidate sources, not proof of every statement. The complete stable research projection is hashed before excerpting, and local IDs and timestamps are excluded.

Results are `not_approved`, `unavailable`, `abstained`, or `hypothesis`. Successful exchanges retain full answer distributions, usage, request and response hashes, and the served model revision. Confidence measures distribution concentration, not factual truth. Review never changes the DAG, source status, or authority.

## Environment

```bash
export BRAVE_API_KEY=your_brave_search_api_key
```

Get a key at [brave.com/search/api](https://brave.com/search/api/). Free tier: 2,000 queries/month.

## Test

```bash
npm test   # Local HTTP servers + SQLite; synthetic JEV transport, no external service calls
npx tsx live-test.mts   # live integration: full compounding dive ×2 via keyless Wikipedia search
npx tsx smoke.mts   # live 2-run web smoke via Brave (requires BRAVE_API_KEY)
```

## Constraints

| Constraint | Value | Why |
|---|---|---|
| MAX_DEPTH | 3 | Prevent infinite recursion |
| MAX_NODES | 20 | Prevent explosion |
| MAX_CONCURRENT | 3 | Enforced solely in tunnel |
| JITTER | 2-5s | Anti-bot behavior |
| No duplicate topics | — | Enforced across ALL runs via store |

## Architecture

```
rabbithole/
  src/
    brave.ts       Brave Search API client with transient retry
    tunnel.ts      Privacy fetch: jitter, bounded retries, size cap
    extract.ts     linkedom extraction + recipe healing and relocation
    store.ts       node:sqlite persistence — nodes, recipes, runs
    dag.ts         Research DAG — in-memory working set
    rabbithole.ts  The engine — resumable dives, staleness, delta reports
    research-advisory.ts  Host-gated JEV evidence review
    index.ts       Public API exports
  tests/
    rabbithole.test.ts   DAG + tunnel config
    store.test.ts        persistence round-trips, staleness, runs
    extract.test.ts      parsing, density scoring, recipe healing
    adaptive.test.ts     fingerprint relocation, migration, ambiguity
    tunnel.test.ts       Retry-After, retry bounds, body cap
    research-advisory.test.ts  JEV gate and response validation
    integration.test.ts  offline HTTP + SQLite end-to-end
    engine.test.ts       compounding semantics (offline, fake web)
```


## Part of the Verra Stack

```
Layer 4: rabbithole               Privacy-tunneled recursive research
  YOU ARE HERE                    Brave Search + DAG traversal + jitter
                                  github.com/manolitnora/rabbithole

Layer 3: verra-kernel             Computation — 79 MCP tools
                                  github.com/manolitnora/verra-kernel

Layer 2: instruction-catalog      Governance — behavioral instructions
                                  github.com/manolitnora/instruction-catalog

Layer 1: session-scribe           Memory — session documentation
                                  github.com/manolitnora/session-scribe
```

## License

MIT

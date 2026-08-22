# rabbithole

Privacy-tunneled recursive research engine that **compounds**: feed it a topic, get back a knowledge DAG that persists in SQLite — the next dive skips what's done, revalidates what's stale, and expands only the frontier. Zero LLM calls.

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
| **Tunnel** | Fetch with 2-5s jitter, concurrency limits, one retry on 429/5xx, honest error strings |
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
- **Extraction heals itself.** Per domain, the winning container selector is stored as a recipe. When a recipe's yield collapses (<200 chars), the generic density pipeline takes over; after two consecutive dominant generic wins the recipe is rewritten. No LLM involved.
- **The frontier survives crashes.** Pending nodes are flushed to the store the moment they're spawned, so an interrupted run resumes where it left off.

## Environment

```bash
export BRAVE_API_KEY=your_brave_search_api_key
```

Get a key at [brave.com/search/api](https://brave.com/search/api/). Free tier: 2,000 queries/month.

## Test

```bash
npm test   # 43 tests — DAG, store, extract, tunnel config, engine (no network calls)
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
    tunnel.ts      Privacy fetch: jitter, retries, error strings
    extract.ts     linkedom extraction + per-domain recipe healing
    store.ts       node:sqlite persistence — nodes, recipes, runs
    dag.ts         Research DAG — in-memory working set
    rabbithole.ts  The engine — resumable dives, staleness, delta reports
    index.ts       Public API exports
  tests/
    rabbithole.test.ts   DAG + tunnel config
    store.test.ts        persistence round-trips, staleness, runs
    extract.test.ts      parsing, density scoring, recipe healing
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

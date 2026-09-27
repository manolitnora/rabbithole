# rabbithole

Recursive research for LLM agents. Feed it a topic and get a knowledge DAG. Search uses Brave. Page extraction and persistence run locally. Optional JEV review sends only host-approved research excerpts to Typesafe.

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

Three primitives:

| Primitive | What it does |
|---|---|
| **Search** | Brave Search API — no tracking, no profiling |
| **Tunnel** | Fetch with 2-5s jitter, concurrency limits, content extraction |
| **DAG** | Directed Acyclic Graph — depth-limited, no duplicates, breadth-first |

## Install

```bash
git clone https://github.com/manolitnora/rabbithole.git
cd rabbithole
npm install
```

## Usage

```typescript
import { dive } from 'rabbithole';

const result = await dive('episodic memory in LLM agents');

console.log(result.markdown);           // Structured research report
console.log(result.nodesExplored);      // How many topics were researched
console.log(result.maxDepthReached);    // How deep the DAG went
console.log(result.exitReason);         // 'convergence' | 'max_depth' | 'max_nodes'
```

### Optional JEV evidence review

JEV reviews relevance, conflicts, and coverage after a dive. Review is a separate step so a dive never silently sends its results to another service.

```typescript
import { dive, previewJevResearch, evaluateJevResearch } from 'rabbithole';

const result = await dive('memory consolidation');
const preview = previewJevResearch(result.topic, result.nodes);
console.log(preview.serialized); // Exact request for host review. No network call.

const pending = await evaluateJevResearch(result.topic, result.nodes);
console.log(pending.status); // 'not_approved'. No credentials read or request sent.
```

To transmit, the calling host supplies a `JevResearchHost` as the third argument to `evaluateJevResearch`. Its `approval` must independently attest `authorityFree: true` and match the preview's `sourceHash`, `exportHash`, `disclosureHash`, and `requestHash`. The last hash binds the questions as well as the evidence. Do not generate approval inside a model prompt or infer it from an API key.

After approval, the client reads `JEV_API_KEY`, or calls the host's `getApiKey` callback. It sends one request to `https://api.typesafe.ai/v1/systemone`, with no retries or redirects. Changed evidence requires a new approval. The Pi tool does not expose approval as a model-callable argument, and does not automatically invoke JEV.

The request uses JEV's `choice` primitive for three research questions. It exports at most ten completed nodes and 1,500 characters per node. Omitted nodes and excerpted text are explicitly marked. URLs identify candidate sources, not proof of every statement. The full stable research projection is hashed before excerpting. Local IDs and timestamps are excluded.

Results are `not_approved`, `unavailable`, `abstained`, or `hypothesis`. Successful exchanges retain full answer distributions, usage, request and response hashes, and the served model revision. Confidence measures distribution concentration, not factual truth. Review never changes the DAG, source status, or authority.

### Adaptive extraction and bounded fetching

These changes draw on [Scrapling's adaptive extraction and fetch policies](https://github.com/D4Vinci/Scrapling). They use the existing TypeScript parser and SQLite store, not a Python or browser runtime.

- Recipes remember element structure as well as CSS selectors. If a selector breaks, a conservative similarity check can relocate the article. Ambiguous matches fall back to generic extraction.
- Fingerprints persist across runs. Existing databases gain an additive recipe column without losing rows.
- Hidden elements and common page navigation are excluded from prose. This is not a complete prompt-injection defense. Treat page content as untrusted data.
- HTTP 429 and 503 receive at most two retries by default. `Retry-After` is honored. If the requested delay exceeds the budget, the request fails rather than retrying early.
- Timeouts include response bodies. Bodies are limited to 2 MB by default. Challenge pages fail without browser escalation.

```typescript
import { configureTunnel } from 'rabbithole';

configureTunnel({
  maxRetries: 2,
  retryDelayMs: 1000,
  maxRetryDelayMs: 5000,
  timeout: 30000,
  maxResponseBytes: 2_000_000,
});
```

This does not add Scrapling's browser fetchers, proxy rotation, cookie sessions, or full crawler framework. Existing SQLite resume remains in place. Concurrent `dive()` calls still share process-global state and are not supported.

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
import { configure } from 'rabbithole';

configure({
  maxDepth: 3,              // max recursion depth
  maxNodes: 20,             // max total nodes in DAG
  maxConcurrent: 3,         // max parallel requests
  minJitter: 2000,          // ms — minimum delay between requests
  maxJitter: 5000,          // ms — maximum delay between requests
  searchResultsPerQuery: 5, // Brave results per search
});
```

## Environment

```bash
export BRAVE_API_KEY=your_brave_search_api_key
```

Get a key at [brave.com/search/api](https://brave.com/search/api/). Free tier: 2,000 queries/month.

## Test

```bash
npm run build
npm test
```

Tests use isolated temporary databases, local HTTP servers, and synthetic JEV responses. They make no live JEV calls and do not establish production JEV compatibility. `dist/index.js` is the Pi tool's import target, so rebuild after source edits. Reload Pi to replace an already-cached module.

## Constraints

| Constraint | Value | Why |
|---|---|---|
| MAX_DEPTH | 3 | Prevent infinite recursion |
| MAX_NODES | 20 | Prevent explosion |
| MAX_CONCURRENT | 3 | Prevent rate-limiting |
| JITTER | 2-5s | Anti-bot behavior |
| No duplicate topics | — | DAG, not a tree |

## Architecture

```
rabbithole/
  src/
    brave.ts              Brave Search client
    tunnel.ts             Bounded HTTP fetch and retry policy
    extract.ts            Content selection and adaptive recipe recovery
    store.ts              SQLite nodes, recipes, and runs
    dag.ts                Research nodes and edges
    rabbithole.ts         Search, fetch, extraction, and expansion
    research-advisory.ts   Host-gated JEV research review
    index.ts              Public API exports
  tests/                  Parser, persistence, transport, and integration checks
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

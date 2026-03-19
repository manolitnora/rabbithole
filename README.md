# rabbithole

Privacy-tunneled recursive research engine for LLM agents. Feed it a topic, get back a knowledge DAG. No tracking, no cloud dependencies beyond Brave Search API.

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
npm test   # 13 tests — DAG + tunnel config (no network calls)
```

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
    brave.ts       Brave Search API client (54 lines)
    tunnel.ts      Privacy fetch with jitter + extraction (160 lines)
    dag.ts         Research DAG — nodes, edges, limits (180 lines)
    rabbithole.ts  The engine — search, tunnel, extract, spawn (220 lines)
    index.ts       Public API exports
  tests/
    rabbithole.test.ts   13 tests — DAG + config
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

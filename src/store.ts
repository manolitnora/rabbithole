/**
 * Store — Durable persistence for the research DAG, extraction recipes, and runs.
 *
 * SQLite via node:sqlite (Node 22.5+, stable in 24+). WAL mode.
 *
 * Identity model: TOPIC is the durable primary key. In-memory DAG ids are
 * crypto.randomUUID() per run and never persisted; edges are stored as
 * parent_topic. This is what makes research compound across runs: a topic
 * researched under any root, in any run, is never re-explored unless
 * invalidated by staleness.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type NodeStatus = 'pending' | 'researching' | 'complete' | 'failed';

export interface StoredNode {
  /** Normalized (lowercase, trimmed) topic — durable primary key. */
  topic: string;
  rootTopic: string;
  parentTopic: string | null;
  status: NodeStatus;
  depth: number;
  contentHash: string | null;
  content: string | null;
  sources: string[];
  subtopics: string[];
  fetchError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Recipe {
  domain: string;
  selector: string | null;
  yieldChars: number;
  fallbackStreak: number;
  wins: number;
  updatedAt: number;
}

export interface RunDelta {
  skippedResearched: number;
  revalidated: number;
  changedNodes: number;
  expandedNodes: number;
  failedNodes: number;
}

export interface StoredRun {
  id: string;
  rootTopic: string;
  startedAt: number;
  finishedAt: number;
  delta: RunDelta;
}

/** Normalize a topic the way the store keys it. */
export function normalizeTopic(topic: string): string {
  return topic.toLowerCase().trim();
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  topic TEXT PRIMARY KEY,
  root_topic TEXT NOT NULL,
  parent_topic TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  depth INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  content TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  subtopics TEXT NOT NULL DEFAULT '[]',
  fetch_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_root ON nodes(root_topic);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

CREATE TABLE IF NOT EXISTS recipes (
  domain TEXT PRIMARY KEY,
  selector TEXT,
  yield_chars INTEGER NOT NULL DEFAULT 0,
  fallback_streak INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  root_topic TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  delta TEXT NOT NULL DEFAULT '{}'
);
`;

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }


  upsertNode(n: StoredNode): void {
    const topic = normalizeTopic(n.topic);
    const rootTopic = normalizeTopic(n.rootTopic);
    const parentTopic = n.parentTopic === null ? null : normalizeTopic(n.parentTopic);
    this.db.prepare(`
      INSERT INTO nodes (topic, root_topic, parent_topic, status, depth,
                         content_hash, content, sources, subtopics,
                         fetch_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET
        root_topic=excluded.root_topic, parent_topic=excluded.parent_topic,
        status=excluded.status, depth=excluded.depth,
        content_hash=excluded.content_hash, content=excluded.content,
        sources=excluded.sources, subtopics=excluded.subtopics,
        fetch_error=excluded.fetch_error, updated_at=excluded.updated_at
    `).run(
      topic, rootTopic, parentTopic, n.status, n.depth,
      n.contentHash, n.content, JSON.stringify(n.sources),
      JSON.stringify(n.subtopics), n.fetchError, n.createdAt, n.updatedAt,
    );
  }

  getNodeByTopic(topic: string): StoredNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE topic = ?').get(normalizeTopic(topic)) as Record<string, unknown> | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodesByRoot(rootTopic: string): StoredNode[] {
    const rows = this.db.prepare('SELECT rowid AS _rid, * FROM nodes WHERE root_topic = ? ORDER BY depth, created_at, _rid').all(normalizeTopic(rootTopic)) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  /** Complete nodes eligible for staleness revalidation, oldest first. */
  getStaleCandidates(rootTopic: string, olderThanMs: number, limit: number): StoredNode[] {
    const cutoff = Date.now() - olderThanMs;
    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE root_topic = ? AND status = 'complete' AND updated_at < ?
      ORDER BY updated_at ASC LIMIT ?
    `).all(normalizeTopic(rootTopic), cutoff, limit) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  /** Touch a node's updated_at without changing anything else (staleness passed). */
  touchNode(topic: string, at: number): void {
    this.db.prepare('UPDATE nodes SET updated_at = ? WHERE topic = ?').run(at, normalizeTopic(topic));
  }

  /** Topics already present in the store (any run, any root). */
  knownTopics(): Set<string> {
    const rows = this.db.prepare('SELECT topic FROM nodes').all() as Array<{ topic: string }>;
    return new Set(rows.map(r => r.topic));
  }

  // ── Recipes ──────────────────────────────────────────────────────

  getRecipe(domain: string): Recipe | null {
    const row = this.db.prepare('SELECT * FROM recipes WHERE domain = ?').get(domain) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      domain: row.domain as string,
      selector: (row.selector as string) ?? null,
      yieldChars: row.yield_chars as number,
      fallbackStreak: row.fallback_streak as number,
      wins: row.wins as number,
      updatedAt: row.updated_at as number,
    };
  }

  saveRecipe(r: Recipe): void {
    this.db.prepare(`
      INSERT INTO recipes (domain, selector, yield_chars, fallback_streak, wins, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        selector=excluded.selector, yield_chars=excluded.yield_chars,
        fallback_streak=excluded.fallback_streak, wins=excluded.wins,
        updated_at=excluded.updated_at
    `).run(r.domain, r.selector, r.yieldChars, r.fallbackStreak, r.wins, r.updatedAt);
  }

  // ── Runs ─────────────────────────────────────────────────────────

  saveRun(run: StoredRun): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO runs (id, root_topic, started_at, finished_at, delta)
      VALUES (?, ?, ?, ?, ?)
    `).run(run.id, normalizeTopic(run.rootTopic), run.startedAt, run.finishedAt, JSON.stringify(run.delta));
  }

  getLastRun(rootTopic: string): StoredRun | null {
    const row = this.db.prepare(`
      SELECT * FROM runs WHERE root_topic = ? ORDER BY finished_at DESC LIMIT 1
    `).get(normalizeTopic(rootTopic)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      rootTopic: row.root_topic as string,
      startedAt: row.started_at as number,
      finishedAt: row.finished_at as number,
      delta: JSON.parse(row.delta as string) as RunDelta,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ROW MAPPING
// ═══════════════════════════════════════════════════════════════════

function rowToNode(row: Record<string, unknown>): StoredNode {
  return {
    topic: row.topic as string,
    rootTopic: row.root_topic as string,
    parentTopic: (row.parent_topic as string) ?? null,
    status: row.status as NodeStatus,
    depth: row.depth as number,
    contentHash: (row.content_hash as string) ?? null,
    content: (row.content as string) ?? null,
    sources: JSON.parse((row.sources as string) ?? '[]') as string[],
    subtopics: JSON.parse((row.subtopics as string) ?? '[]') as string[],
    fetchError: (row.fetch_error as string) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** Default DB location: .rabbithole/state.db under cwd (override via RH_HOME). */
export function defaultStorePath(): string {
  const home = process.env.RH_HOME ?? join(process.cwd(), '.rabbithole');
  return join(home, 'state.db');
}

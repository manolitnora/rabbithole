/**
 * Tunnel — Privacy-preserving content extraction.
 *
 * Fetches web content with anti-bot jitter, concurrency limits, bounded
 * retries on transient failures, and structure-aware extraction (linkedom +
 * recipes). No browser automation, no Supabase, no cloud — pure Node.js fetch
 * with human-like timing patterns.
 *
 * Concurrency is owned SOLELY here: the engine must not keep its own
 * request counter (double-counting throttled runs to ~1.5 effective slots).
 */

import { extract, type RecipeLike, type Extraction } from './extract.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface TunnelResult extends Extraction {
  success: boolean;
  url: string;
  /** HTTP status of the last attempt (when a response was received). */
  status?: number;
  /** Total attempts made (1 + retries actually used). */
  attempts?: number;
  /** Human-readable failure reason; null on success. */
  error: string | null;
  timestamp: number;
}

export interface TunnelConfig {
  minJitter: number;        // ms — minimum delay between requests
  maxJitter: number;        // ms — maximum delay between requests
  maxConcurrent: number;    // max parallel requests
  timeout: number;          // ms — per-request timeout
  userAgent: string;
  retries: number;          // attempts on 429/5xx/network errors (total tries = 1 + retries)
  maxRetryDelayMs: number;  // a requested Retry-After longer than this fails the request
  maxResponseBytes: number; // response bodies larger than this fail
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: TunnelConfig = {
  minJitter: 2000,
  maxJitter: 5000,
  maxConcurrent: 3,
  timeout: 30000,
  // Full modern Chrome UA — the previous truncated string (no Chrome/Safari
  // tokens) is itself a fingerprint no real browser ever sends.
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  retries: 1,
  maxRetryDelayMs: 5000,
  maxResponseBytes: 2_000_000,
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let config: TunnelConfig = { ...DEFAULT_CONFIG };
let activeRequests = 0;

// ═══════════════════════════════════════════════════════════════════
// JITTER — Anti-bot timing
// ═══════════════════════════════════════════════════════════════════

function jitter(): number {
  return Math.floor(Math.random() * (config.maxJitter - config.minJitter)) + config.minJitter;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After as milliseconds, or null when absent or unparseable. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

class ResponseTooLarge extends Error {}

async function readHtml(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ResponseTooLarge();
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

/**
 * Tunnel into a URL and extract content.
 * Applies jitter delay, concurrency limiting, and bounded retries with
 * backoff on transient failures (429 / 5xx / network errors).
 * `recipe` (optional) enables per-domain extraction memory.
 */
export async function tunnel(url: string, recipe?: RecipeLike | null): Promise<TunnelResult> {
  // Snapshot the policy so a concurrent reconfigure cannot change it mid-request.
  const cfg = { ...config };

  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Wait for slot
  while (activeRequests >= cfg.maxConcurrent) {
    await sleep(500);
  }

  activeRequests++;

  try {
    const started = Date.now();
    let lastError = 'unknown error';
    let lastStatus: number | undefined;
    let attempts = 0;
    let delay = 0;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      if (attempt > 0) await sleep(delay);
      delay = jitter(); // default backoff for a possible retry
      attempts++;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.timeout);

      try {
        const response = await fetch(normalizedUrl, {
          headers: {
            'User-Agent': cfg.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: controller.signal,
        });

        lastStatus = response.status;

        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          await response.body?.cancel().catch(() => {});
          const requested = retryAfterMs(response.headers.get('retry-after'));
          if (requested !== null) delay = requested;
          if (isTransient(response.status) && attempt < cfg.retries && delay <= cfg.maxRetryDelayMs) continue;
          break;
        }

        const html = await readHtml(response, cfg.maxResponseBytes);
        const ex = extract(html, recipe ?? null);
        return {
          ...ex,
          success: true,
          url: normalizedUrl,
          status: response.status,
          attempts,
          error: null,
          timestamp: Date.now(),
        };
      } catch (err) {
        if (err instanceof ResponseTooLarge) {
          lastError = `response body exceeds ${cfg.maxResponseBytes} bytes`;
          break;
        }
        lastError = err instanceof Error
          ? (err.name === 'AbortError' ? `timeout after ${cfg.timeout}ms` : err.message)
          : String(err);
        // network-level errors are transient by definition → retry
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      title: '', content: '', links: [], selector: null, usedRecipe: false, yieldChars: 0,
      success: false,
      url: normalizedUrl,
      status: lastStatus,
      attempts,
      error: lastError,
      timestamp: started,
    };
  } finally {
    activeRequests--;
  }
}

/**
 * Batch tunnel multiple URLs with concurrency control.
 */
export async function tunnelBatch(urls: string[]): Promise<TunnelResult[]> {
  return Promise.all(urls.map(url => tunnel(url)));
}

/**
 * Configure tunnel parameters.
 */
export function configureTunnel(newConfig: Partial<TunnelConfig>): void {
  const next = { ...config, ...newConfig };
  for (const key of ['minJitter', 'maxJitter', 'retries', 'maxRetryDelayMs'] as const) {
    if (!Number.isSafeInteger(next[key]) || next[key] < 0) throw new Error(`invalid ${key}`);
  }
  for (const key of ['timeout', 'maxConcurrent', 'maxResponseBytes'] as const) {
    if (!Number.isSafeInteger(next[key]) || next[key] <= 0) throw new Error(`invalid ${key}`);
  }
  if (next.minJitter > next.maxJitter || next.retries > 5) throw new Error('invalid fetch policy');
  config = next;
}

/**
 * Get tunnel stats.
 */
export function getTunnelStats(): { active: number; config: TunnelConfig } {
  return { active: activeRequests, config };
}
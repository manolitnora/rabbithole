/**
 * Tunnel — Privacy-preserving content extraction.
 *
 * Fetches web content with anti-bot jitter, concurrency limits, one retry on
 * transient failures, and structure-aware extraction (linkedom + recipes).
 * No browser automation, no Supabase, no cloud — pure Node.js fetch with
 * human-like timing patterns.
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

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

/**
 * Tunnel into a URL and extract content.
 * Applies jitter delay, concurrency limiting, and one retry with backoff
 * on transient failures (429 / 5xx / network errors).
 * `recipe` (optional) enables per-domain extraction memory.
 */
export async function tunnel(url: string, recipe?: RecipeLike | null): Promise<TunnelResult> {
  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Wait for slot
  while (activeRequests >= config.maxConcurrent) {
    await sleep(500);
  }

  activeRequests++;

  try {
    const started = Date.now();
    let lastError = 'unknown error';
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (attempt > 0) await sleep(jitter());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeout);

      try {
        const response = await fetch(normalizedUrl, {
          headers: {
            'User-Agent': config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: controller.signal,
        });

        lastStatus = response.status;

        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          if (isTransient(response.status)) continue; // retry
          break;
        }

        const html = await response.text();
        const ex = extract(html, recipe ?? null);
        return {
          ...ex,
          success: true,
          url: normalizedUrl,
          status: response.status,
          error: null,
          timestamp: Date.now(),
        };
      } catch (err) {
        lastError = err instanceof Error
          ? (err.name === 'AbortError' ? `timeout after ${config.timeout}ms` : err.message)
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
  config = { ...config, ...newConfig };
}

/**
 * Get tunnel stats.
 */
export function getTunnelStats(): { active: number; config: TunnelConfig } {
  return { active: activeRequests, config };
}

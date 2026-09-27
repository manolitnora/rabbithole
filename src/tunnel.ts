/**
 * Tunnel — Privacy-preserving content extraction.
 *
 * Fetches web content with anti-bot jitter and concurrency limits.
 * No browser automation, no Supabase, no cloud — pure Node.js fetch
 * with human-like timing patterns.
 *
 * Content is extracted with linkedom (extractGeneric / extract), not regex
 * tag-stripping, so Wikipedia chrome does not leak into page prose.
 *
 * Ported from HybridEngineV3/src/lib/cognition/tunnel.ts
 * Stripped of Supabase edge functions and Capacitor native bridge.
 */

import { extract, type Extraction, type RecipeLike } from './extract.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface TunnelResult extends Extraction {
  success: boolean;
  url: string;
  excerpt: string;
  timestamp: number;
  error: string | null;
  status?: number;
  attempts?: number;
}

export interface TunnelConfig {
  minJitter: number;        // ms — minimum delay between requests
  maxJitter: number;        // ms — maximum delay between requests
  maxConcurrent: number;    // max parallel requests
  timeout: number;          // ms — per-request timeout
  userAgent: string;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxResponseBytes: number;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: TunnelConfig = {
  minJitter: 2000,
  maxJitter: 5000,
  maxConcurrent: 3,
  timeout: 30000,
  maxRetries: 2,
  retryDelayMs: 1000,
  maxRetryDelayMs: 5000,
  maxResponseBytes: 2_000_000,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let config: TunnelConfig = { ...DEFAULT_CONFIG };
let activeRequests = 0;

// ═══════════════════════════════════════════════════════════════════
// JITTER — Anti-bot timing
// ═══════════════════════════════════════════════════════════════════

function jitter(cfg: TunnelConfig): number {
  return Math.floor(Math.random() * (cfg.maxJitter - cfg.minJitter)) + cfg.minJitter;
}

function retryDelay(header: string | null, attempt: number, cfg: TunnelConfig): number {
  if (header !== null) {
    if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(cfg.maxRetryDelayMs, cfg.retryDelayMs * 2 ** (attempt - 1));
}

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
      if (size > limit) throw new Error('response too large');
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emptyExtraction(): Extraction {
  return { title: '', content: '', links: [], selector: null, usedRecipe: false, yieldChars: 0 };
}

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

/**
 * Tunnel into a URL and extract content.
 * Applies jitter delay and concurrency limiting.
 * `recipe` (optional) enables per-domain extraction memory.
 */
export async function tunnel(url: string, recipe?: RecipeLike | null): Promise<TunnelResult> {
  const cfg = { ...config };
  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Wait for slot
  while (activeRequests >= cfg.maxConcurrent) {
    await sleep(25);
  }

  activeRequests++;
  let attempts = 0;

  try {
    await sleep(jitter(cfg));
    for (;;) {
      attempts++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.timeout);
      let delay = 0;
      try {
        const response = await fetch(normalizedUrl, {
          headers: {
            'User-Agent': cfg.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          delay = retryDelay(response.headers.get('retry-after'), attempts, cfg);
          const retry = (response.status === 429 || response.status === 503)
            && attempts <= cfg.maxRetries && delay <= cfg.maxRetryDelayMs;
          if (!retry) {
            return { ...emptyExtraction(), success: false, url: normalizedUrl, excerpt: '',
              timestamp: Date.now(), error: `HTTP ${response.status}`, status: response.status, attempts };
          }
        } else {
          const html = await readHtml(response, cfg.maxResponseBytes);
          const ex = extract(html, recipe ?? null);
          const ok = ex.yieldChars > 0;
          return { ...ex, success: ok, url: normalizedUrl, excerpt: ok ? ex.content.substring(0, 200) : '',
            timestamp: Date.now(), error: ok ? null : 'no extractable article text', status: response.status, attempts };
        }
      } finally { clearTimeout(timeout); }
      await sleep(delay);
    }
  } catch (err) {
    return {
      ...emptyExtraction(),
      success: false,
      url: normalizedUrl,
      excerpt: '',
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
      attempts,
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
  for (const key of ['minJitter', 'maxJitter', 'retryDelayMs', 'maxRetryDelayMs', 'maxRetries'] as const) {
    if (!Number.isSafeInteger(next[key]) || next[key] < 0) throw new Error(`invalid ${key}`);
  }
  for (const key of ['timeout', 'maxConcurrent', 'maxResponseBytes'] as const) {
    if (!Number.isSafeInteger(next[key]) || next[key] <= 0) throw new Error(`invalid ${key}`);
  }
  if (next.minJitter > next.maxJitter || next.maxRetries > 5) throw new Error('invalid fetch policy');
  config = next;
}

/**
 * Get tunnel stats.
 */
export function getTunnelStats(): { active: number; config: TunnelConfig } {
  return { active: activeRequests, config };
}

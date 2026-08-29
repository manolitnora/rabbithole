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
}

export interface TunnelConfig {
  minJitter: number;        // ms — minimum delay between requests
  maxJitter: number;        // ms — maximum delay between requests
  maxConcurrent: number;    // max parallel requests
  timeout: number;          // ms — per-request timeout
  userAgent: string;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: TunnelConfig = {
  minJitter: 2000,
  maxJitter: 5000,
  maxConcurrent: 3,
  timeout: 30000,
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

function jitter(): number {
  return Math.floor(Math.random() * (config.maxJitter - config.minJitter)) + config.minJitter;
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
    // Anti-bot jitter
    await sleep(jitter());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': config.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        ...emptyExtraction(),
        success: false,
        url: normalizedUrl,
        excerpt: '',
        timestamp: Date.now(),
        error: `HTTP ${response.status}`,
        status: response.status,
      };
    }

    const html = await response.text();
    const ex = extract(html, recipe ?? null);
    const ok = ex.yieldChars > 0;

    return {
      ...ex,
      success: ok,
      url: normalizedUrl,
      excerpt: ok ? ex.content.substring(0, 200) : '',
      timestamp: Date.now(),
      error: ok ? null : 'no extractable article text',
      status: response.status,
    };
  } catch (err) {
    return {
      ...emptyExtraction(),
      success: false,
      url: normalizedUrl,
      excerpt: '',
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
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

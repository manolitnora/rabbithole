/**
 * Extract — Structure-aware content extraction with per-domain recipe memory.
 *
 * Replaces regex tag-stripping. linkedom parses; candidate containers are
 * scored by text density (prose beats chrome). The winning selector per
 * domain is persisted as a "recipe"; when a recipe's yield collapses, the
 * generic pipeline takes over and heals the recipe after two consecutive
 * dominant generic wins. All deterministic — no LLM.
 */

import { parseHTML } from 'linkedom';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface Extraction {
  title: string;
  content: string;
  links: string[];
  /** Selector that produced the content (recipe or freshly learned). */
  selector: string | null;
  /** Whether a stored recipe produced the content. */
  usedRecipe: boolean;
  yieldChars: number;
}

export interface RecipeOutcome {
  usedRecipe: boolean;
  recipeYield: number;
  genericYield: number;
  genericSelector: string | null;
}

export interface RecipeLike {
  selector: string | null;
  yieldChars: number;
  fallbackStreak: number;
  wins: number;
}

export interface ExtractConfig {
  /** Recipe yield below this counts as collapsed. */
  minRecipeYield: number;
  /** Generic must exceed recipe yield by this factor to heal. */
  healFactor: number;
  /** Consecutive generic wins required to overwrite a recipe. */
  healStreak: number;
  /** Candidate text below this never becomes a recipe. */
  minRecipeAdoptionYield: number;
}

export const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
  minRecipeYield: 200,
  healFactor: 2,
  healStreak: 2,
  minRecipeAdoptionYield: 200,
};

// ═══════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════════

const CHROME_SELECTORS = 'script, style, nav, footer, header, aside, noscript, template, svg, iframe, form';

const CANDIDATE_TAGS = 'article, main, section, div, td, body';

function stripChrome(root: Element): void {
  root.querySelectorAll(CHROME_SELECTORS).forEach(el => el.remove());
}

function textStats(el: Element): { textLen: number; linkTextLen: number } {
  let textLen = 0;
  let linkTextLen = 0;
  // Walk text nodes: cheap density measure without full TreeWalker support assumptions
  const walk = (node: Element, inLink: boolean): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const len = (child.textContent ?? '').trim().length;
        if (inLink) linkTextLen += len;
        else textLen += len;
      } else if (child.nodeType === 1) {
        walk(child as Element, inLink || (child as Element).tagName === 'A');
      }
    }
  };
  walk(el, false);
  return { textLen, linkTextLen };
}

/**
 * Deterministic container selector: `tag#id` or `tag.first-class`.
 * Returns null for body (no selector worth memorizing).
 */
export function selectorFor(el: Element): string | null {
  const tag = el.tagName?.toLowerCase();
  if (!tag || tag === 'body' || tag === 'html') return null;
  const id = el.getAttribute?.('id');
  if (id) return `${tag}#${id}`;
  const cls = el.getAttribute?.('class')?.trim().split(/\s+/)[0];
  if (cls) return `${tag}.${cls}`;
  return tag;
}

/**
 * Pick the densest prose container, then widen upward: fragmented layouts
 * (e.g. MediaWiki's per-section <section> split) hide most prose in
 * siblings of the densest candidate. The highest ancestor whose density
 * stays within 70% of the winner's captures the whole group while still
 * excluding nav-heavy wrappers.
 */
export function pickContainer(root: Element): { el: Element; selector: string | null } | null {
  const bodyStats = textStats(root);
  if (bodyStats.textLen === 0) return null;
  const bodyScore = bodyStats.textLen / (1 + bodyStats.linkTextLen);

  let best: { el: Element; score: number; stats: { textLen: number; linkTextLen: number } } | null = null;
  for (const el of root.querySelectorAll(CANDIDATE_TAGS)) {
    if ((el as unknown as { tagName?: string }).tagName === 'BODY') continue;
    const s = textStats(el);
    if (s.textLen < 200) continue;
    const score = s.textLen / (1 + s.linkTextLen);
    if (!best || score > best.score) best = { el, score, stats: s };
  }

  if (!best) return null;

  // Widen upward through ancestors that add real prose without being
  // MORE link-diluted than the body itself (relative-to-candidate
  // thresholds never climb: e.g. Wikipedia sections score ~13 vs
  // wrapper chains at ~3, all equally non-chrome relative to body).
  let chosen = best.el;
  let chosenTextLen = best.stats.textLen;
  let cur = best.el.parentElement;
  while (cur && cur !== root && (cur as unknown as { tagName?: string }).tagName !== 'BODY') {
    const s = textStats(cur);
    const density = s.textLen / (1 + s.linkTextLen);
    if (s.textLen > chosenTextLen && density >= bodyScore) {
      chosen = cur;
      chosenTextLen = s.textLen;
      cur = cur.parentElement;
    } else {
      break;
    }
  }

  if (chosenTextLen > best.stats.textLen) {
    return { el: chosen, selector: selectorFor(chosen) };
  }

  // Accept the winner when it genuinely out-densifies the body, OR when
  // it simply holds most of the body's prose at comparable density —
  // wrappers that contain the whole article tie the body's score without
  // being chrome.
  const holdsMostProse = best.stats.textLen >= 0.5 * bodyStats.textLen;
  if (best.score > bodyScore || (holdsMostProse && best.score >= 0.7 * bodyScore)) {
    return { el: best.el, selector: selectorFor(best.el) };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// CORE EXTRACTION
// ═══════════════════════════════════════════════════════════════════

function collectLinks(root: Element): string[] {
  const links: string[] = [];
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) links.push(href);
  });
  return links;
}

/**
 * Generic extraction: strip chrome, density-pick a container, fall back to
 * stripped body text when nothing qualifies.
 */
export function extractGeneric(html: string): Extraction {
  const { document } = parseHTML(html);
  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  // linkedom's .body getter throws when the document has no root element
  // (empty or fragment-only input) — bail out before touching it.
  const body = document.documentElement ? document.body : null;
  if (!body) {
    return { title, content: '', links: [], selector: null, usedRecipe: false, yieldChars: 0 };
  }
  // Harvest links from the full body BEFORE stripping chrome: nav/footer
  // links are real traversal signal; only prose content excludes them.
  const links = collectLinks(body);
  stripChrome(body);
  const picked = pickContainer(body);
  const content = (picked?.el.textContent ?? body.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title,
    content,
    links,
    selector: picked?.selector ?? null,
    usedRecipe: false,
    yieldChars: content.length,
  };
}

/**
 * Full extraction with recipe memory. Tries the stored selector first;
 * on collapse (< minRecipeYield) falls through to the generic pipeline.
 */
export function extract(html: string, recipe: RecipeLike | null, config: Partial<ExtractConfig> = {}): Extraction {
  const cfg = { ...DEFAULT_EXTRACT_CONFIG, ...config };
  const generic = extractGeneric(html);

  if (recipe?.selector) {
    const { document } = parseHTML(html);
    const el = document.querySelector(recipe.selector);
    if (el) {
      stripChrome(el);
      const content = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (content.length >= cfg.minRecipeYield) {
        const links = collectLinks(el);
        return { title: generic.title, content, links, selector: recipe.selector, usedRecipe: true, yieldChars: content.length };
      }
    }
  }

  return generic;
}

// ═══════════════════════════════════════════════════════════════════
// RECIPE HEALING — pure, deterministic
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute the next recipe state from the previous one and this run's outcome.
 *
 - Recipe worked (≥ minRecipeYield): win recorded, streak reset.
 - Recipe collapsed and generic dominated `healStreak` consecutive times by
   `healFactor`: recipe replaced by the generic selector.
 - No recipe and generic yield qualifies: recipe adopted.
 */
export function nextRecipe(
  domain: string,
  prev: RecipeLike | null,
  outcome: RecipeOutcome,
  config: Partial<ExtractConfig> = {},
): { selector: string | null; yieldChars: number; fallbackStreak: number; wins: number; healed: boolean } {
  const cfg = { ...DEFAULT_EXTRACT_CONFIG, ...config };
  const now = { selector: prev?.selector ?? null, yieldChars: prev?.yieldChars ?? 0, fallbackStreak: prev?.fallbackStreak ?? 0, wins: prev?.wins ?? 0 };

  if (outcome.usedRecipe) {
    return { selector: now.selector, yieldChars: outcome.recipeYield, fallbackStreak: 0, wins: now.wins + 1, healed: false };
  }

  const genericDominant = outcome.genericYield >= cfg.minRecipeAdoptionYield
    && outcome.genericYield >= cfg.healFactor * Math.max(now.yieldChars, 1);

  if (!prev?.selector) {
    // No memory yet: adopt the generic selector if it earned one.
    if (outcome.genericSelector && outcome.genericYield >= cfg.minRecipeAdoptionYield) {
      return { selector: outcome.genericSelector, yieldChars: outcome.genericYield, fallbackStreak: 0, wins: 0, healed: true };
    }
    return { ...now, healed: false };
  }

  const streak = now.fallbackStreak + 1;
  if (streak >= cfg.healStreak && genericDominant && outcome.genericSelector) {
    return { selector: outcome.genericSelector, yieldChars: outcome.genericYield, fallbackStreak: 0, wins: 0, healed: true };
  }
  return { selector: now.selector, yieldChars: now.yieldChars, fallbackStreak: streak, wins: now.wins, healed: false };
}

/** Domain extraction from a URL (recipe key). */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

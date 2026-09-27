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

export interface ElementFingerprint {
  tag: string;
  attributes: Record<string, string>;
  classes: string[];
  parentTag: string | null;
  childTags: string[];
}

export interface Extraction {
  title: string;
  content: string;
  links: string[];
  /** Selector that produced the content (recipe or freshly learned). */
  selector: string | null;
  /** Whether a stored recipe produced the content. */
  usedRecipe: boolean;
  yieldChars: number;
  fingerprint?: ElementFingerprint | null;
  method?: 'generic' | 'recipe' | 'adaptive';
}

export interface RecipeOutcome {
  usedRecipe: boolean;
  recipeYield: number;
  genericYield: number;
  genericSelector: string | null;
  matchedSelector?: string | null;
  fingerprint?: ElementFingerprint | null;
}

export interface RecipeLike {
  selector: string | null;
  yieldChars: number;
  fallbackStreak: number;
  wins: number;
  fingerprint?: ElementFingerprint | null;
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

const CHROME_SELECTORS = 'script, style, nav, footer, header, aside, noscript, template, svg, iframe, form, [hidden], [inert], [aria-hidden="true"]';

const CANDIDATE_TAGS = 'article, main, section, div, td, body';

function isHidden(el: Element): boolean {
  for (let current: Element | null = el; current; current = current.parentElement) {
    if (current.matches('[hidden], [inert], [aria-hidden="true"]')
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(current.getAttribute('style') ?? '')) return true;
  }
  return false;
}

function stripChrome(root: Element): void {
  root.querySelectorAll(CHROME_SELECTORS).forEach(el => el.remove());
  root.querySelectorAll('[style]').forEach(el => {
    if (isHidden(el)) el.remove();
  });
}

const FINGERPRINT_ATTRIBUTES = ['role', 'itemprop', 'data-testid'];

function fingerprint(el: Element): ElementFingerprint {
  return {
    tag: el.tagName.toLowerCase(),
    attributes: Object.fromEntries(FINGERPRINT_ATTRIBUTES.flatMap(key => {
      const value = el.getAttribute(key);
      return value ? [[key, value.slice(0, 200)]] : [];
    })),
    classes: [...new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))].sort().slice(0, 20),
    parentTag: el.parentElement?.tagName.toLowerCase() ?? null,
    childTags: [...new Set(Array.from(el.children, child => child.tagName.toLowerCase()))].sort(),
  };
}

export function parseFingerprint(value: unknown): ElementFingerprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('tag' in value && 'attributes' in value && 'classes' in value && 'parentTag' in value && 'childTags' in value)) return null;
  const { tag, attributes, classes, parentTag, childTags } = value;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(s => typeof s === 'string' && s.length <= 200);
  if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  if (parentTag !== null && (typeof parentTag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(parentTag))) return null;
  if (!strings(classes) || !strings(childTags) || !attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  const parsedAttributes: Record<string, string> = {};
  for (const [key, val] of Object.entries(attributes)) {
    if (!FINGERPRINT_ATTRIBUTES.includes(key) || typeof val !== 'string' || val.length > 200) return null;
    parsedAttributes[key] = val;
  }
  return { tag, attributes: parsedAttributes, classes, parentTag, childTags };
}

function overlap(a: string[], b: string[]): number {
  const union = new Set([...a, ...b]);
  return union.size ? a.filter(x => b.includes(x)).length / union.size : 0;
}

function similarity(a: ElementFingerprint, b: ElementFingerprint): number {
  const attrs = Object.entries(a.attributes);
  const attrScore = attrs.length ? attrs.filter(([k, v]) => b.attributes[k] === v).length / attrs.length : 0;
  // Conservative relocation heuristics, not probabilities. Empty features add no evidence.
  return (a.tag === b.tag ? 0.2 : 0) + 0.35 * attrScore
    + 0.2 * overlap(a.classes, b.classes) + 0.15 * overlap(a.childTags, b.childTags)
    + (a.parentTag && a.parentTag === b.parentTag ? 0.1 : 0);
}

function escapeIdentifier(value: string): string {
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, match => Array.from(match, c => `\\${c.codePointAt(0)?.toString(16)} `).join(''));
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
  if (id) return `${tag}#${escapeIdentifier(id)}`;
  const cls = el.getAttribute?.('class')?.trim().split(/\s+/)[0];
  if (cls) return `${tag}.${escapeIdentifier(cls)}`;
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
  if (!body || isHidden(body)) {
    return { title, content: '', links: [], selector: null, usedRecipe: false, yieldChars: 0, fingerprint: null, method: 'generic' };
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
    fingerprint: picked ? fingerprint(picked.el) : null,
    method: 'generic',
  };
}

/**
 * Full extraction with recipe memory. Tries the stored selector first;
 * on collapse (< minRecipeYield) falls through to the generic pipeline.
 */
export function extract(html: string, recipe: RecipeLike | null, config: Partial<ExtractConfig> = {}): Extraction {
  const cfg = { ...DEFAULT_EXTRACT_CONFIG, ...config };
  const generic = extractGeneric(html);

  if (!recipe?.selector || !generic.yieldChars) return generic;
  const { document } = parseHTML(html);
  const body = document.documentElement ? document.body : null;
  if (!body) return generic;
  stripChrome(body);
  const saved = recipe.fingerprint;
  const take = (el: Element, selector: string, method: 'recipe' | 'adaptive'): Extraction | null => {
    const content = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (content.length < cfg.minRecipeYield) return null;
    return { title: generic.title, content, links: collectLinks(el), selector,
      usedRecipe: true, yieldChars: content.length, fingerprint: fingerprint(el), method };
  };
  try {
    const matches = body.querySelectorAll(recipe.selector);
    const el = matches.length === 1 ? matches[0] : null;
    if (el && (!saved || JSON.stringify(saved) === JSON.stringify(fingerprint(el)))) {
      const hit = take(el, recipe.selector, 'recipe');
      if (hit) return hit;
    }
  } catch { return generic; }

  if (saved) {
    const candidates = Array.from(body.querySelectorAll(CANDIDATE_TAGS))
      .filter(el => (el.textContent ?? '').trim().length >= cfg.minRecipeYield)
      .map(el => ({ el, score: similarity(saved, fingerprint(el)) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best && best.score >= 0.65 && best.score - (candidates[1]?.score ?? 0) >= 0.1) {
      const selector = selectorFor(best.el);
      if (selector && body.querySelectorAll(selector).length === 1) {
        const hit = take(best.el, selector, 'adaptive');
        if (hit) return hit;
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
): RecipeLike & { healed: boolean } {
  const cfg = { ...DEFAULT_EXTRACT_CONFIG, ...config };
  const now = { selector: prev?.selector ?? null, yieldChars: prev?.yieldChars ?? 0, fallbackStreak: prev?.fallbackStreak ?? 0, wins: prev?.wins ?? 0, fingerprint: prev?.fingerprint ?? null };

  if (outcome.usedRecipe) {
    return { selector: outcome.matchedSelector ?? now.selector, yieldChars: outcome.recipeYield, fallbackStreak: 0, wins: now.wins + 1, healed: false, fingerprint: outcome.fingerprint ?? now.fingerprint };
  }

  const genericDominant = outcome.genericYield >= cfg.minRecipeAdoptionYield
    && outcome.genericYield >= cfg.healFactor * Math.max(now.yieldChars, 1);

  if (!prev?.selector) {
    // No memory yet: adopt the generic selector if it earned one.
    if (outcome.genericSelector && outcome.genericYield >= cfg.minRecipeAdoptionYield) {
      return { selector: outcome.genericSelector, yieldChars: outcome.genericYield, fallbackStreak: 0, wins: 0, healed: true, fingerprint: outcome.fingerprint ?? null };
    }
    return { ...now, healed: false };
  }

  const streak = genericDominant ? now.fallbackStreak + 1 : 0;
  if (streak >= cfg.healStreak && outcome.genericSelector) {
    return { selector: outcome.genericSelector, yieldChars: outcome.genericYield, fallbackStreak: 0, wins: 0, healed: true, fingerprint: outcome.fingerprint ?? null };
  }
  return { ...now, fallbackStreak: streak, healed: false };
}

/** Domain extraction from a URL (recipe key). */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

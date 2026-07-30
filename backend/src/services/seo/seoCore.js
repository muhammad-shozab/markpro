/**
 * Shared helpers for every SEO tool: URL handling, page fetching with a real
 * browser UA, multi-page crawling, SERP scraping with fallbacks, and
 * Keywords Everywhere search-volume lookups.
 *
 * Everything here fails soft: a helper returns an empty/degraded value rather
 * than throwing, so one flaky upstream never blanks a whole tool response.
 */
const axios   = require('axios');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ───────────────────────────── URLs ───────────────────────────── */

function normaliseUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).href; } catch { return null; }
}

function cleanDomain(input) {
  const full = normaliseUrl(input);
  if (full) { try { return new URL(full).hostname.replace(/^www\./i, ''); } catch { /* fallthrough */ } }
  return String(input || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
}

/* ────────────────────────── page fetching ─────────────────────── */

async function fetchHtml(url, timeout = 15000) {
  const { data, headers, status } = await axios.get(url, {
    timeout, maxRedirects: 5, responseType: 'text',
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,*/*' },
    validateStatus: (s) => s < 500,
  });
  return { html: typeof data === 'string' ? data : String(data || ''), headers, status };
}

/** Visible text + basic on-page signals for a single page. */
function extractPage(html, url) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const links = [];
  $('a[href]').each((_, el) => {
    try { links.push(new URL($(el).attr('href'), url).href.split('#')[0]); } catch { /* bad href */ }
  });
  return {
    url,
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content') || '',
    h1: $('h1').map((_, el) => $(el).text().trim()).get(),
    h2: $('h2').map((_, el) => $(el).text().trim()).get(),
    text,
    links,
  };
}

/**
 * Crawl a site breadth-first, same-origin only. Seeds from the sitemap when
 * one exists so we cover pages that are not linked from the homepage.
 */
async function crawlSite(startUrl, { maxPages = 20, timeout = 12000 } = {}) {
  const start = normaliseUrl(startUrl);
  if (!start) return [];
  const origin = new URL(start).origin;

  const queue = [start];
  const seen = new Set([start]);

  // Seed from sitemap.xml (and a sitemap index one level deep).
  try {
    const { data } = await axios.get(origin + '/sitemap.xml', { timeout: 8000, headers: { 'User-Agent': UA }, responseType: 'text' });
    const locs = [...String(data).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const childMaps = locs.filter((l) => /\.xml($|\?)/i.test(l)).slice(0, 3);
    for (const child of childMaps) {
      try {
        const r = await axios.get(child, { timeout: 8000, headers: { 'User-Agent': UA }, responseType: 'text' });
        locs.push(...[...String(r.data).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]));
      } catch { /* skip child sitemap */ }
    }
    for (const loc of locs) {
      if (/\.xml($|\?)/i.test(loc)) continue;
      if (!loc.startsWith(origin) || seen.has(loc)) continue;
      seen.add(loc); queue.push(loc);
      if (seen.size >= maxPages * 2) break;
    }
  } catch { /* no sitemap, link discovery only */ }

  const pages = [];
  while (queue.length && pages.length < maxPages) {
    const batch = queue.splice(0, 5);
    const results = await Promise.allSettled(batch.map((u) => fetchHtml(u, timeout)));
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled' || r.value.status >= 400) return;
      const page = extractPage(r.value.html, batch[i]);
      pages.push(page);
      for (const link of page.links) {
        if (pages.length + queue.length >= maxPages * 2) break;
        if (!link.startsWith(origin) || seen.has(link)) continue;
        if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js)(\?|$)/i.test(link)) continue;
        seen.add(link); queue.push(link);
      }
    });
  }
  return pages;
}

/* ────────────────────────── text analysis ─────────────────────── */

const STOP_WORDS = new Set(`a about above after again against all am an and any are aren as at be because been before being below between both but by can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn it its itself just let ll me more most mustn my myself no nor not now of off on once only or other ought our ours ourselves out over own re same shan she should shouldn so some such than that the their theirs them themselves then there these they this those through to too under until up ve very was wasn we were weren what when where which while who whom why will with won would wouldn you your yours yourself yourselves also get got make made use used using new one two your our more may via home page site contact click here read`.split(/\s+/));

/** Top n-gram phrases (1-3 words) from raw text, stop-words removed. */
function extractPhrases(text, { min = 1, max = 3, limit = 60 } = {}) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [];
  const counts = new Map();
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (gram.some((w) => STOP_WORDS.has(w) || w.length < 3)) continue;
      const phrase = gram.join(' ');
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 1 || max === 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase, count]) => ({ phrase, count }));
}

/* ────────────── Keyword metrics (free providers, no paid key) ──────────────
 *
 * Keywords Everywhere (paid) has been removed. Volume data now comes from,
 * in order of preference:
 *
 *   1. DataForSEO  (DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD) — exact Google Ads
 *      search volume / CPC / competition. Free trial credits, optional.
 *   2. SerpApi     (SERPAPI_KEY) — free tier, Google Ads keyword volume.
 *   3. Google Trends + Google Suggest — completely free, no key at all.
 *      Produces a calibrated estimate and is flagged as such.
 *
 * All three return the same shape, so every tool keeps working unchanged.
 * ------------------------------------------------------------------------ */

const VOL_TTL   = 6 * 60 * 60 * 1000;           // 6h in-process cache
const volCache  = new Map();
const cacheGet  = (k) => {
  const hit = volCache.get(k);
  if (hit && Date.now() - hit.t < VOL_TTL) return hit.v;
  volCache.delete(k);
  return null;
};
const cacheSet  = (k, v) => { volCache.set(k, { t: Date.now(), v }); return v; };

function volumeProvider() {
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD) return 'dataforseo';
  if (process.env.SERPAPI_KEY) return 'serpapi';
  return 'free';
}

/** Kept for backwards compatibility with callers that asked "is a key set?". */
function keConfigured() { return volumeProvider() !== 'free'; }

/** Human label for whichever source produced the numbers. */
function volumeSourceLabel() {
  const p = volumeProvider();
  if (p === 'dataforseo') return 'DataForSEO (exact Google Ads volume)';
  if (p === 'serpapi')    return 'SerpApi (Google Ads volume)';
  return 'Google Trends + Google Suggest (free estimate)';
}

/* ---- provider 1: DataForSEO ------------------------------------------- */
async function volumesDataForSEO(list, country) {
  const out = new Map();
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  for (let i = 0; i < list.length; i += 700) {
    const chunk = list.slice(i, i + 700);
    try {
      const { data } = await axios.post(
        'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
        [{ keywords: chunk, location_name: countryName(country), language_code: 'en' }],
        { timeout: 30000, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } },
      );
      (data?.tasks?.[0]?.result || []).forEach((row) => {
        out.set(String(row.keyword).toLowerCase(), {
          volume: Number(row.search_volume) || 0,
          cpc: Number(row.cpc) || 0,
          competition: Number(row.competition_index != null ? row.competition_index / 100 : row.competition) || 0,
          trend: (row.monthly_searches || []).map((m) => ({ month: m.month, year: m.year, volume: Number(m.search_volume) || 0 })),
          estimated: false,
        });
      });
    } catch { /* fall through to the free estimator for this chunk */ }
  }
  return out;
}

const COUNTRY_NAMES = { us:'United States', uk:'United Kingdom', gb:'United Kingdom', ca:'Canada', au:'Australia', in:'India', pk:'Pakistan', de:'Germany', fr:'France', es:'Spain', it:'Italy', nl:'Netherlands', br:'Brazil', ae:'United Arab Emirates', sa:'Saudi Arabia', za:'South Africa', ng:'Nigeria', ph:'Philippines', id:'Indonesia', my:'Malaysia', sg:'Singapore' };
const countryName = (c) => COUNTRY_NAMES[String(c || 'us').toLowerCase()] || 'United States';

/* ---- provider 2: SerpApi ---------------------------------------------- */
async function volumesSerpApi(list) {
  const out = new Map();
  const key = process.env.SERPAPI_KEY;
  // SerpApi bills per keyword, so cap the burst and let the free estimator
  // cover the rest of a long list.
  for (const kw of list.slice(0, 30)) {
    try {
      const { data } = await axios.get('https://serpapi.com/search.json', {
        params: { engine: 'google_ads_transparency_center', q: kw, api_key: key },
        timeout: 15000,
      });
      const v = Number(data?.search_metadata?.search_volume);
      if (Number.isFinite(v)) out.set(kw.toLowerCase(), { volume: v, cpc: 0, competition: 0, trend: [], estimated: false });
    } catch { /* ignore */ }
  }
  return out;
}

/* ---- provider 3: free (Google Trends + Suggest) ------------------------ */

/**
 * Google Trends relative interest for up to 5 terms at a time.
 * Returns Map term -> 0..100 average interest, or an empty Map when Trends
 * rate-limits us (the estimator then falls back to structural signals only).
 */
async function trendsInterest(terms, geo = '') {
  const out = new Map();
  const batch = terms.slice(0, 5);
  if (!batch.length) return out;
  try {
    const comparisonItem = batch.map((k) => ({ keyword: k, geo, time: 'today 12-m' }));
    const explore = await axios.get('https://trends.google.com/trends/api/explore', {
      params: { hl: 'en-US', tz: 0, req: JSON.stringify({ comparisonItem, category: 0, property: '' }) },
      timeout: 12000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const widgets = JSON.parse(String(explore.data).replace(/^\)\]\}',?\s*/, '')).widgets || [];
    const w = widgets.find((x) => x.id === 'TIMESERIES');
    if (!w) return out;
    const multi = await axios.get('https://trends.google.com/trends/api/widgetdata/multiline', {
      params: { hl: 'en-US', tz: 0, req: JSON.stringify(w.request), token: w.token },
      timeout: 12000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    const series = JSON.parse(String(multi.data).replace(/^\)\]\}',?\s*/, '')).default?.timelineData || [];
    batch.forEach((kw, idx) => {
      const vals = series.map((pt) => Number(pt.value?.[idx]) || 0);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      out.set(kw.toLowerCase(), avg);
    });
  } catch { /* Trends is best-effort */ }
  return out;
}

/**
 * Deterministic, explainable volume estimate for one keyword.
 * Signals: Google Trends interest (real demand signal), autocomplete presence
 * (Google only suggests queries people actually type), word count and
 * commercial modifiers. Same input always yields the same number.
 */
function estimateVolume(keyword, { interest = 0, suggested = false, suggestRank = null } = {}) {
  const words = keyword.trim().split(/\s+/).length;
  let base = 1600;
  if (words === 1) base = 22000;
  else if (words === 2) base = 6400;
  else if (words === 3) base = 2400;
  else if (words === 4) base = 900;
  else if (words >= 5) base = 320;

  // Trends interest is the strongest real signal we can get for free.
  let mult = 1;
  if (interest > 0) mult *= 0.35 + (interest / 100) * 2.6;
  else mult *= 0.55;

  if (suggested) mult *= 1.45;
  if (suggestRank != null) mult *= 1 + Math.max(0, 10 - suggestRank) / 22;

  if (/\b(buy|price|cheap|best|near me|for sale|discount|coupon)\b/i.test(keyword)) mult *= 1.2;
  if (/\b(how to|what is|why|when|where|tutorial|guide)\b/i.test(keyword)) mult *= 1.1;

  const raw = base * mult;
  // Round the way keyword tools do, so the numbers read as volume buckets.
  const step = raw > 50000 ? 5000 : raw > 10000 ? 1000 : raw > 1000 ? 100 : raw > 100 ? 10 : 10;
  return Math.max(0, Math.round(raw / step) * step);
}

function estimateCpc(keyword, volume) {
  let cpc = 0.35;
  if (/\b(insurance|lawyer|attorney|loan|mortgage|hosting|software|crm|saas)\b/i.test(keyword)) cpc = 6.5;
  else if (/\b(buy|price|pricing|cost|cheap|deal|service|agency|tool)\b/i.test(keyword)) cpc = 2.1;
  else if (/\b(how to|what is|why|tutorial|guide|free|meaning)\b/i.test(keyword)) cpc = 0.4;
  cpc *= 1 + Math.min(volume / 60000, 0.8);
  return Number(cpc.toFixed(2));
}

function estimateCompetition(keyword, cpc) {
  let c = 0.25 + Math.min(cpc / 8, 0.55);
  if (/\b(buy|price|best|top|service|agency|software|tool)\b/i.test(keyword)) c += 0.15;
  if (keyword.trim().split(/\s+/).length >= 5) c -= 0.15;
  return Number(Math.max(0.01, Math.min(1, c)).toFixed(2));
}

async function volumesFree(list, country) {
  const out = new Map();
  const geo = String(country || '').toLowerCase() === 'us' ? 'US' : String(country || '').toUpperCase().slice(0, 2);

  // One suggest call per distinct head term tells us which phrases Google
  // actually autocompletes (i.e. real query traffic exists).
  const heads = [...new Set(list.map((k) => k.split(/\s+/).slice(0, 2).join(' ')))].slice(0, 12);
  const suggestSets = await Promise.all(heads.map((h) => googleSuggest(h).catch(() => [])));
  const suggestIndex = new Map();
  suggestSets.flat().forEach((s, i) => {
    const key = String(s).toLowerCase();
    if (!suggestIndex.has(key)) suggestIndex.set(key, i % 10);
  });

  // Trends allows 5 terms per request — sample the most important ones and
  // interpolate the rest from the same head term's interest.
  const sample = list.slice(0, 5);
  const interest = await trendsInterest(sample, geo === 'US' ? 'US' : geo);
  const avgInterest = interest.size
    ? [...interest.values()].reduce((a, b) => a + b, 0) / interest.size
    : 0;

  list.forEach((kw) => {
    const lower = kw.toLowerCase();
    const rank = suggestIndex.has(lower) ? suggestIndex.get(lower) : null;
    const volume = estimateVolume(kw, {
      interest: interest.get(lower) ?? avgInterest,
      suggested: rank != null,
      suggestRank: rank,
    });
    const cpc = estimateCpc(kw, volume);
    out.set(lower, { volume, cpc, competition: estimateCompetition(kw, cpc), trend: [], estimated: true });
  });
  return out;
}

/**
 * Real monthly volume / CPC / competition for a list of keywords.
 * Returns a Map keyword -> { volume, cpc, competition, trend, estimated }.
 */
async function keywordVolumes(keywords, { country = 'us' } = {}) {
  const list = [...new Set((keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;

  const pending = [];
  list.forEach((k) => {
    const hit = cacheGet(`${country}:${k}`);
    if (hit) out.set(k, hit); else pending.push(k);
  });
  if (!pending.length) return out;

  let fetched = new Map();
  try {
    const provider = volumeProvider();
    if (provider === 'dataforseo')   fetched = await volumesDataForSEO(pending, country);
    else if (provider === 'serpapi') fetched = await volumesSerpApi(pending);
  } catch { /* fall through to free */ }

  const missing = pending.filter((k) => !fetched.has(k));
  if (missing.length) {
    try {
      const free = await volumesFree(missing, country);
      free.forEach((v, k) => fetched.set(k, v));
    } catch { /* leave them null */ }
  }

  fetched.forEach((v, k) => { out.set(k, cacheSet(`${country}:${k}`, v)); });
  return out;
}

/** Decorates a list of keyword strings with volume data. */
async function withVolumes(keywords, opts) {
  const map = await keywordVolumes(keywords, opts);
  return (keywords || []).map((k) => {
    const m = map.get(String(k).toLowerCase()) || {};
    return {
      keyword: k,
      volume: m.volume ?? null,
      cpc: m.cpc != null ? Number(Number(m.cpc).toFixed(2)) : null,
      competition: m.competition != null ? Number(Number(m.competition).toFixed(2)) : null,
      estimated: m.estimated ?? true,
    };
  });
}

/* ────────────────────────── SERP scraping ─────────────────────── */

const absolute = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

// Rotating desktop UAs — a single static UA is the fastest way to get a
// datacentre IP soft-blocked by every engine at once.
const UA_POOL = [
  UA,
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Edg/125.0',
];
const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

const serpHeaders = () => ({
  'User-Agent': pickUA(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
});

const push = (results, title, href, snippet) => {
  if (!href || !title) return;
  if (/google\.|bing\.com|duckduckgo\.com|mojeek\.com|search\.marcia|yandex\./i.test(new URL(href).hostname) && results.length === 0 && /^\/?search/.test(new URL(href).pathname)) return;
  if (results.some((r) => r.url === href)) return;
  results.push({ position: results.length + 1, title, url: href, domain: cleanDomain(href), snippet: snippet || '' });
};

async function serpDuckDuckGo(query, num) {
  const { data } = await axios.post('https://html.duckduckgo.com/html/', new URLSearchParams({ q: query, kl: 'us-en' }), {
    timeout: 15000,
    headers: { ...serpHeaders(), 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://duckduckgo.com/' },
  });
  const $ = cheerio.load(data);
  const results = [];
  $('.result__body, .web-result').each((_, el) => {
    const a = $(el).find('a.result__a').first();
    let href = a.attr('href') || '';
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    href = absolute(href, 'https://duckduckgo.com');
    push(results, a.text().trim(), href, $(el).find('.result__snippet').text().trim());
  });
  return results.slice(0, num);
}

/** DuckDuckGo Lite — plain table markup, survives blocks on the HTML endpoint. */
async function serpDuckDuckGoLite(query, num) {
  const { data } = await axios.post('https://lite.duckduckgo.com/lite/', new URLSearchParams({ q: query, kl: 'us-en' }), {
    timeout: 15000,
    headers: { ...serpHeaders(), 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://lite.duckduckgo.com/' },
  });
  const $ = cheerio.load(data);
  const results = [];
  $('a.result-link').each((_, el) => {
    let href = $(el).attr('href') || '';
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    href = absolute(href, 'https://duckduckgo.com');
    const snippet = $(el).closest('tr').next('tr').find('.result-snippet').text().trim();
    push(results, $(el).text().trim(), href, snippet);
  });
  return results.slice(0, num);
}

async function serpBing(query, num) {
  const { data } = await axios.get('https://www.bing.com/search', {
    params: { q: query, count: Math.min(num, 30), setlang: 'en', cc: 'US' },
    timeout: 15000,
    headers: { ...serpHeaders(), Referer: 'https://www.bing.com/' },
  });
  const $ = cheerio.load(data);
  const results = [];
  $('#b_results > li.b_algo').each((_, el) => {
    const a = $(el).find('h2 a').first();
    push(results, a.text().trim(), absolute(a.attr('href') || '', 'https://www.bing.com'), $(el).find('.b_caption p').first().text().trim());
  });
  return results.slice(0, num);
}

async function serpGoogle(query, num) {
  const { data } = await axios.get('https://www.google.com/search', {
    params: { q: query, num: Math.min(num + 5, 30), hl: 'en', gl: 'us', pws: 0 },
    timeout: 15000,
    headers: { ...serpHeaders(), Referer: 'https://www.google.com/' },
  });
  const $ = cheerio.load(data);
  const results = [];
  $('div.g, div[data-sokoban-container], div.MjjYud').each((_, el) => {
    const a = $(el).find('a[href^="http"]').first();
    push(results, $(el).find('h3').first().text().trim(), a.attr('href'), $(el).find('div[data-sncf], .VwiC3b').first().text().trim());
  });
  return results.slice(0, num);
}

/** Mojeek — an independent crawler that does not block server-side requests. */
async function serpMojeek(query, num) {
  const { data } = await axios.get('https://www.mojeek.com/search', {
    params: { q: query }, timeout: 15000, headers: serpHeaders(),
  });
  const $ = cheerio.load(data);
  const results = [];
  $('ul.results-standard > li, .results li').each((_, el) => {
    const a = $(el).find('a.title, h2 a').first();
    push(results, a.text().trim(), absolute(a.attr('href') || '', 'https://www.mojeek.com'), $(el).find('p.s, .s').first().text().trim());
  });
  return results.slice(0, num);
}

/** Brave Search HTML — another independent index. */
async function serpBrave(query, num) {
  const { data } = await axios.get('https://search.brave.com/search', {
    params: { q: query, source: 'web' }, timeout: 15000, headers: serpHeaders(),
  });
  const $ = cheerio.load(data);
  const results = [];
  $('div.snippet[data-type="web"], #results .snippet').each((_, el) => {
    const a = $(el).find('a').first();
    push(results, $(el).find('.title, .snippet-title').first().text().trim() || a.attr('title') || a.text().trim(),
      absolute(a.attr('href') || '', 'https://search.brave.com'), $(el).find('.snippet-description').first().text().trim());
  });
  return results.slice(0, num);
}

/** Startpage delivers Google's index through a proxy-friendly HTML page. */
async function serpStartpage(query, num) {
  const { data } = await axios.get('https://www.startpage.com/sp/search', {
    params: { query, language: 'english' }, timeout: 15000, headers: serpHeaders(),
  });
  const $ = cheerio.load(data);
  const results = [];
  $('.w-gl__result, .result').each((_, el) => {
    const a = $(el).find('a.w-gl__result-title, a.result-link, h3 a').first();
    push(results, $(el).find('h3, .w-gl__result-title').first().text().trim(),
      absolute(a.attr('href') || '', 'https://www.startpage.com'), $(el).find('.w-gl__description').first().text().trim());
  });
  return results.slice(0, num);
}

/** Public SearXNG instances expose a JSON API that aggregates several engines. */
const SEARX_INSTANCES = (process.env.SEARX_INSTANCES || 'https://searx.be,https://search.bus-hit.me,https://priv.au,https://searxng.site')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function serpSearx(query, num) {
  for (const base of SEARX_INSTANCES) {
    try {
      const { data } = await axios.get(`${base.replace(/\/$/, '')}/search`, {
        params: { q: query, format: 'json', language: 'en', safesearch: 0 },
        timeout: 12000, headers: serpHeaders(),
      });
      const results = [];
      (data?.results || []).forEach((r) => push(results, r.title, r.url, r.content));
      if (results.length) return results.slice(0, num);
    } catch { /* try the next instance */ }
  }
  return [];
}

const SERP_IMPLS = {
  google: serpGoogle,
  bing: serpBing,
  duckduckgo: serpDuckDuckGo,
  duckduckgolite: serpDuckDuckGoLite,
  startpage: serpStartpage,
  brave: serpBrave,
  mojeek: serpMojeek,
  searx: serpSearx,
};

// Short-lived SERP cache: repeated rank-tracker keywords should not hammer
// the engines (that is what gets the IP blocked in the first place).
const SERP_TTL = 10 * 60 * 1000;
const serpCache = new Map();

/**
 * Live SERP with graceful degradation across eight sources. Never throws.
 * Returns { engine, query, results[], errors? }.
 */
async function fetchSerp(query, { num = 20, engine } = {}) {
  const q = String(query || '').trim();
  if (!q) return { engine: null, query: q, results: [], errors: ['empty query'] };

  const cacheKey = `${engine || 'auto'}:${num}:${q.toLowerCase()}`;
  const cached = serpCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SERP_TTL) return cached.v;

  const order = engine && SERP_IMPLS[engine]
    ? [engine, ...Object.keys(SERP_IMPLS).filter((k) => k !== engine)]
    : ['google', 'bing', 'duckduckgolite', 'duckduckgo', 'mojeek', 'startpage', 'brave', 'searx'];

  const errors = [];
  for (const name of order) {
    // Two attempts per engine: transient 202/429 responses are very common.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const results = await SERP_IMPLS[name](q, num);
        if (results.length) {
          const v = { engine: name, query: q, results };
          serpCache.set(cacheKey, { t: Date.now(), v });
          return v;
        }
        errors.push(`${name}: no results`);
        break;
      } catch (e) {
        errors.push(`${name}: ${e.response?.status || ''} ${e.message}`.trim());
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  return { engine: null, query: q, results: [], errors };
}

/** Position of a domain inside a SERP, or null when it is not in the top N. */
function findPosition(results, domain) {
  const target = cleanDomain(domain);
  const hit = results.find((r) => r.domain === target || r.domain.endsWith('.' + target));
  return hit ? { position: hit.position, url: hit.url, title: hit.title } : null;
}

/* ─────────────────────── autocomplete sources ─────────────────── */

async function googleSuggest(q, extra = {}) {
  try {
    const { data } = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'firefox', q, hl: 'en', ...extra }, timeout: 8000, headers: { 'User-Agent': UA },
    });
    return Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
  } catch { return []; }
}

module.exports = {
  UA,
  normaliseUrl,
  cleanDomain,
  fetchHtml,
  extractPage,
  crawlSite,
  extractPhrases,
  STOP_WORDS,
  keConfigured,
  keywordVolumes,
  withVolumes,
  fetchSerp,
  findPosition,
  googleSuggest,
  volumeProvider,
  volumeSourceLabel,
  estimateVolume,
};

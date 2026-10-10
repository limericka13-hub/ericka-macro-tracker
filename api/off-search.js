/**
 * Open Food Facts name-search proxy.
 *
 * Exists because search.openfoodfacts.org (search-a-licious) does not send an
 * Access-Control-Allow-Origin header, so the browser cannot call it directly.
 * The main world.openfoodfacts.org search endpoints do allow CORS but are
 * unreliable - measured at roughly a 50% failure rate - while this one is fast
 * and consistent. Going through the server sidesteps CORS entirely and lets us
 * send the identifying User-Agent that Open Food Facts asks for and that
 * browsers refuse to set.
 */

const SEARCH_URL = 'https://search.openfoodfacts.org/search';
const FIELDS = 'code,product_name,brands,nutriments,image_front_small_url,serving_size';
const USER_AGENT = 'MacroTracker/1.0 (personal macro tracker; https://github.com/pontes-ss)';
const PAGE_SIZE = 25;
const TIMEOUT_MS = 6000;

const first = (v) => String(Array.isArray(v) ? v[0] : (v || ''));

export default async function handler(req, res) {
  const query = first(req.query && req.query.q).trim().slice(0, 100);
  const page = Math.min(20, Math.max(1, parseInt(first(req.query && req.query.page), 10) || 1));
  // Store filter. Quoted so multi-word brands stay one term, and stripped of
  // quotes first so the value cannot break out of the query expression.
  const brand = first(req.query && req.query.brand).trim().replace(/["\\]/g, '').slice(0, 40);

  // An empty or single-character query is not worth a round trip.
  if (query.length < 2 && !brand) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).json({ products: [], count: 0, page });
  }

  const q = brand ? `${query} brands:"${brand}"`.trim() : query;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&page_size=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`;

  // Never leave the client hanging on a slow upstream - the food search is a
  // type-ahead, so a late answer is no better than no answer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal
    });

    if (!upstream.ok) {
      // Degrade quietly: the client still has USDA and the local database.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ products: [], count: 0, page });
    }

    const data = await upstream.json();
    const products = Array.isArray(data && data.hits) ? data.hits : [];
    const count = typeof (data && data.count) === 'number' ? data.count : products.length;

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    // `count` lets the client decide whether a "show more" control is worth
    // rendering - there are often thousands behind a single page.
    return res.status(200).json({ products, count, page, pageSize: PAGE_SIZE });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ products: [], count: 0, page });
  } finally {
    clearTimeout(timer);
  }
}

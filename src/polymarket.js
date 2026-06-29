const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const POLYMARKET_SITE = 'https://polymarket.com';

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value == null || value === '') {
    return [];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Polymarket API error ${response.status}`);
  }

  return response.json();
}

function getPolymarketMarketUrl(market) {
  if (market.slug) {
    return `${POLYMARKET_SITE}/market/${market.slug}`;
  }

  if (market.eventSlug) {
    return `${POLYMARKET_SITE}/event/${market.eventSlug}`;
  }

  return POLYMARKET_SITE;
}

function normalizePolymarketMarket(rawMarket) {
  const outcomes = parseMaybeJsonArray(rawMarket.outcomes).map((outcome) => String(outcome).trim()).filter(Boolean);
  const outcomePrices = parseMaybeJsonArray(rawMarket.outcomePrices).map((price) => Number(price));
  const question = rawMarket.question || rawMarket.title || rawMarket.groupItemTitle || rawMarket.eventTitle || rawMarket.slug;
  const id = rawMarket.id || rawMarket.conditionId || rawMarket.questionID;

  return {
    id: String(id || '').trim(),
    question: String(question || 'Untitled Polymarket market').trim(),
    slug: rawMarket.slug || null,
    eventSlug: rawMarket.eventSlug || rawMarket.event?.slug || null,
    outcomes,
    outcomePrices,
    active: rawMarket.active !== false && rawMarket.closed !== true && rawMarket.archived !== true,
    closed: Boolean(rawMarket.closed),
    archived: Boolean(rawMarket.archived),
    volume: Number(rawMarket.volume || rawMarket.volumeNum || 0),
    liquidity: Number(rawMarket.liquidity || rawMarket.liquidityNum || rawMarket.liquidityClob || 0),
    endDate: rawMarket.endDate || rawMarket.endDateIso || rawMarket.end_date_iso || null,
    url: getPolymarketMarketUrl(rawMarket),
  };
}

function formatPolymarketPrice(price) {
  if (!Number.isFinite(price)) {
    return '가격 없음';
  }

  return `${Math.round(price * 100)}%`;
}

async function searchPolymarketMarkets(query, limit = 5) {
  const params = new URLSearchParams({
    q: query,
    cache: 'true',
    events_status: 'active',
    keep_closed_markets: '0',
    limit_per_type: String(limit),
    page: '1',
    search_profiles: 'false',
  });
  const data = await fetchJson(`${POLYMARKET_GAMMA_API}/public-search?${params}`);
  const markets = [];

  for (const event of data.events || []) {
    for (const market of event.markets || []) {
      markets.push({
        ...market,
        eventTitle: event.title,
        eventSlug: event.slug,
      });
    }
  }

  for (const market of data.markets || []) {
    markets.push(market);
  }

  const seen = new Set();
  return markets
    .map(normalizePolymarketMarket)
    .filter((market) => market.id && market.outcomes.length >= 2)
    .filter((market) => {
      if (seen.has(market.id)) {
        return false;
      }

      seen.add(market.id);
      return true;
    })
    .slice(0, limit);
}

async function fetchPolymarketMarket(marketId) {
  const market = await fetchJson(`${POLYMARKET_GAMMA_API}/markets/${encodeURIComponent(marketId)}`);
  return normalizePolymarketMarket(market);
}

module.exports = {
  fetchPolymarketMarket,
  formatPolymarketPrice,
  searchPolymarketMarkets,
};

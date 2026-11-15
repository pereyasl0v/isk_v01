/**
 * Parse a raw WB search JSON or a browser HAR entirely on the client.
 * Never sends HAR contents, cookies, request headers or other browser data to a server.
 */
const searchPath = /\/(?:__internal\/u-search\/)?exactmatch\/ru\/common\/v\d+\/search(?:$|\?)/i;

export function normalizedQuery(value) {
  let text = String(value || "").replace(/\+/g, " ");
  // Some WB requests contain URL-encoded UTF-8 inside the query parameter itself.
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(text); i++) {
    try { text = decodeURIComponent(text); } catch { break; }
  }
  return text.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
}

function parseCards(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const data = root.data && typeof root.data === "object" ? root.data : root;
  const cards = Array.isArray(data.products) ? data.products : Array.isArray(data.cards) ? data.cards : null;
  if (!cards) return [];
  return cards.slice(0, 10).map((card, idx) => {
    const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
    const size = sizes.find(s => s?.price && typeof s.price === "object" && s.price.product != null)
      || sizes.find(s => s?.price && typeof s.price === "object");
    const kopecks = size?.price || {};
    const rub = v => {
      const num = Number(v);
      return v == null || !Number.isFinite(num) || num <= 0 ? null : Math.round(num) / 100;
    };
    const directRub = v => {
      const num = Number(v);
      return v == null || !Number.isFinite(num) || num <= 0 ? null : num;
    };
    return {
      position: idx + 1,
      id: String(card.id ?? card.nmId ?? ""),
      name: String(card.name ?? "Без названия"),
      brand: String(card.brand ?? ""),
      price_rub: directRub(card.price_rub) ?? rub(kopecks.product ?? card.salePriceU),
      basic_price_rub: directRub(card.basic_price_rub) ?? rub(kopecks.basic ?? card.priceU),
      rating: card.reviewRating ?? card.rating ?? null,
      feedbacks: card.feedbacks ?? null
    };
  }).filter(p => p.id && (p.price_rub !== null || p.basic_price_rub !== null))
    .map((p, i) => ({...p, position: i + 1}));
}

function entryQuery(url) {
  try {
    const u = new URL(url);
    return normalizedQuery(u.searchParams.get("query"));
  } catch { return ""; }
}

export function parseWBCaptureText(text, expectedQuery = "") {
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("Файл не является корректным JSON или HAR.");
  }

  if (Array.isArray(data?.log?.entries)) {
    const candidates = [];
    const expected = normalizedQuery(expectedQuery);
    for (const [index, entry] of data.log.entries.entries()) {
      const url = entry?.request?.url || "";
      if (!searchPath.test(url) || entry?.response?.status !== 200) continue;
      const content = entry?.response?.content || {};
      if (typeof content.text !== "string") continue;
      let body = content.text;
      if (content.encoding === "base64") {
        try { body = atob(body); } catch { continue; }
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { continue; }
      const products = parseCards(parsed);
      if (!products.length) continue;
      const urlObj = new URL(url);
      const query = entryQuery(url);
      const page = urlObj.searchParams.get("page");
      const appType = urlObj.searchParams.get("appType");
      const score = (
        (expected && query === expected ? 10000 : 0)
        + (!page ? 1000 : page === "1" ? 500 : 0)
        + (appType === "64" ? 100 : 0)
        + (products.length === 10 ? 50 : 0)
        + index / 10000
      );
      candidates.push({query, products, score});
    }
    if (!candidates.length) {
      throw new Error("В HAR не найден успешный поисковый ответ WB с товарами и ценами. Запишите HAR после открытия поиска на WB с включённым сохранением ответов.");
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return {query: best.query, products: best.products, source: "HAR браузера WB"};
  }

  const products = parseCards(data);
  if (!products.length) {
    throw new Error("JSON не содержит карточек WB с распознанными ценами.");
  }
  return {
    query: normalizedQuery(data?.query ?? data?.metadata?.query ?? ""),
    products,
    source: "поисковый JSON WB"
  };
}

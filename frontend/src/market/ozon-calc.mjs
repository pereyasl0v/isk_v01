export const OZON_DEFAULTS = Object.freeze({
  category: "",
  volumeL: 0,
  weightKg: 0,
  commissionPct: 23,
  commissionModifierPct: 0,
  loyaltyPayoutRub: 0,
  acquiringPct: 1,
  fboLogistics: 29,
  fbsLogistics: 29,
  fbsHandling: 10,
  lastMile: 25,
  storage: 0,
  fboOther: 0,
  fbsOther: 0,
  taxPct: 6,
  krPct: 0,
  returnRatePct: 0,
  priceDiscountPct: 0
});

const number = value => {
  const n = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, number(value)));
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function summarizeOzonPrices(values) {
  const prices = values.map(number).filter(value => value > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const middle = Math.floor(prices.length / 2);
  return {
    min: prices[0],
    median: prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2,
    average: prices.reduce((sum, value) => sum + value, 0) / prices.length,
    count: prices.length
  };
}

export function calculateOzonScenario({ buyerPrice, cost = 0, settings = {}, scheme = "FBO" }) {
  const s = { ...OZON_DEFAULTS, ...settings };
  const buyer = Math.max(0, number(buyerPrice));
  const discount = clamp(s.priceDiscountPct, 0, 90);
  const sellerPrice = buyer / (1 - discount / 100);
  const kr = clamp(s.krPct, 0, 100) / 100;
  const isFbs = scheme === "FBS";

  const pctl = sellerPrice;
  const nominalRate = clamp(number(s.commissionPct) - number(s.commissionModifierPct), 0, 100) / 100;
  const kp = pctl > 0
    ? clamp((pctl - buyer - number(s.loyaltyPayoutRub)) / pctl * 100, 0, 100) / 100
    : 0;
  // Official Ozon formula: max(ПЦТ × (ПП−Км) × 1%, ПЦТ × (ПП−Км−Кп)).
  const commission = Math.max(pctl * nominalRate * 0.01, pctl * Math.max(0, nominalRate - kp));
  const acquiring = buyer * clamp(s.acquiringPct, 0, 100) / 100;
  const handling = isFbs ? number(s.fbsHandling) : 0;
  const logisticsCap = isFbs ? number(s.fbsLogistics) : number(s.fboLogistics);
  const logistics = logisticsCap * (1 - kr);
  const lastMile = number(s.lastMile) * (1 - kr);
  // Ozon's tariff page says reverse logistics is priced at the same tariff as forward logistics.
  // This is an expected-cost reserve, not a guaranteed per-order charge.
  const reverseReserve = logistics * clamp(s.returnRatePct, 0, 100) / 100;
  const storage = number(s.storage);
  const other = isFbs ? number(s.fbsOther) : number(s.fboOther);
  const ozonCosts = commission + acquiring + handling + logistics + lastMile + reverseReserve + storage + other;
  // Conservative assumption: the visible sale price is the seller revenue base unless a separate Ozon subsidy is known.
  const payout = buyer - ozonCosts;
  const tax = buyer * clamp(s.taxPct, 0, 100) / 100;
  const productCost = Math.max(0, number(cost));
  const profit = payout - tax - productCost;

  return {
    scheme, buyerPrice: round2(buyer), sellerPrice: round2(sellerPrice), pctl: round2(pctl), kpPct: round2(kp * 100),
    commission: round2(commission), acquiring: round2(acquiring),
    handling: round2(handling), logistics: round2(logistics),
    lastMile: round2(lastMile), reverseReserve: round2(reverseReserve),
    storage: round2(storage), other: round2(other),
    ozonCosts: round2(ozonCosts), payout: round2(payout),
    tax: round2(tax), cost: round2(productCost), profit: round2(profit),
    margin: sellerPrice > 0 ? round2(profit / sellerPrice * 100) : 0,
    roi: productCost > 0 ? round2(profit / productCost * 100) : 0
  };
}

export function calculateOzonScenarios(prices, cost, settings) {
  const summary = summarizeOzonPrices(prices);
  if (!summary) return [];
  return ["min", "median", "average"].map(key => {
    const buyerPrice = summary[key];
    return {
      key, count: summary.count, buyerPrice: round2(buyerPrice),
      fbo: calculateOzonScenario({ buyerPrice, cost, settings, scheme: "FBO" }),
      fbs: calculateOzonScenario({ buyerPrice, cost, settings, scheme: "FBS" })
    };
  });
}

export function parseOzonCaptureText(text) {
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error("Файл не является корректным JSON."); }

  const sourceProducts = Array.isArray(payload?.products)
    ? payload.products
    : Array.isArray(payload?.data?.products) ? payload.data.products : null;
  if (!sourceProducts) throw new Error("В JSON не найден массив products.");

  const products = sourceProducts.slice(0, 10).map((product, index) => {
    const rawPrice = product?.price_rub ?? product?.priceRub ?? product?.price;
    const price = number(rawPrice);
    const id = String(product?.id ?? product?.product_id ?? product?.sku ?? "");
    const name = String(product?.name ?? product?.title ?? "Без названия").trim();
    return {
      position: index + 1,
      id,
      name,
      brand: String(product?.brand ?? ""),
      url: String(product?.url ?? ""),
      price_rub: price > 0 ? round2(price) : null
    };
  }).filter(product => product.price_rub !== null);

  if (!products.length) throw new Error("В файле нет карточек с распознанными ценами в рублях.");
  return {
    source: String(payload?.source ?? "Ozon JSON import"),
    query: String(payload?.query ?? ""),
    captured_at: String(payload?.captured_at ?? ""),
    products
  };
}

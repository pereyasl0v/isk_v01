const DAY_MS = 86400000;

function parseIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : day;
}

const isoDay = value => value.toISOString().slice(0, 10);
const number = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};
const round = value => value === null || value === undefined ? null : Number(number(value).toFixed(2));
const divide = (a, b) => number(b) ? number(a) / number(b) : null;
const percent = (a, b) => number(b) ? number(a) / number(b) * 100 : null;

/** The comparison window is the immediately preceding range of equal length. */
export function previousPeriodRange(first, last, maxDays = 31) {
  const start = parseIsoDay(first);
  const end = parseIsoDay(last);
  if (!start || !end || end < start) return null;
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > maxDays) return null;
  const previousTo = new Date(start.getTime() - DAY_MS);
  const previousFrom = new Date(previousTo.getTime() - (days - 1) * DAY_MS);
  return {from: isoDay(previousFrom), to: isoDay(previousTo), days};
}

export function compareMetric(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const currentValue = Number(current);
  const previousValue = Number(previous);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return null;
  const delta = round(currentValue - previousValue);
  const changePercent = previousValue === 0
    ? (currentValue === 0 ? 0 : null)
    : round(delta / Math.abs(previousValue) * 100);
  return {
    previous: round(previousValue),
    delta,
    changePercent,
    trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    fromZero: previousValue === 0 && currentValue !== 0,
  };
}

export function comparisonTone(comparison, direction = 'higher') {
  if (!comparison || comparison.trend === 'flat' || direction === 'neutral') return 'neutral';
  const improved = direction === 'lower'
    ? comparison.trend === 'down'
    : comparison.trend === 'up';
  return improved ? 'positive' : 'negative';
}

/** Recalculate period-derived cards with the same locally configured costs and tax settings. */
export function calculateDigitizationPeriodMetrics(digi, costs = {}, settings = {}) {
  if (!digi?.metrics) return null;
  const m = digi.metrics;
  const c = digi.components || {};
  const discount = number(m.discount_points);
  const realization = number(m.realization);
  const sales = round(number(m.sales_amount) || realization - discount);
  const salesQuantity = m.sales_quantity ?? null;
  const orders = number(m.orders_amount);
  const ordersQuantity = m.orders_quantity ?? null;
  const logistics = number(m.logistics);
  const commission = number(m.nominal_commission);
  const acquiring = number(m.acquiring);
  const advertising = number(m.advertising);
  const storage = number(m.storage);
  const paidAcceptance = number(m.paid_acceptance);
  const penalties = number(m.penalties);
  const other = number(m.other_deductions);
  const compensationWithoutPoints = number(m.compensations);
  const compensationWithPoints = discount;
  const foreignCommission = number(c.marketplace_buyout_commission);

  const soldRows = (digi.products || []).filter(row => number(row.sales_quantity) !== 0);
  const hasCost = row => costs[String(row.sku)]?.cost != null;
  const allSoldCosts = soldRows.length > 0 && soldRows.every(hasCost);
  const unitCost = sku => number(costs[String(sku)]?.cost) + number(costs[String(sku)]?.fulfillment);
  const cogs = allSoldCosts
    ? round(soldRows.reduce((sum, row) => sum + number(row.sales_quantity) * unitCost(row.sku), 0))
    : null;
  const averageCogs = cogs !== null && number(salesQuantity) > 0 ? round(cogs / number(salesQuantity)) : null;

  const taxRate = settings.taxRate ?? 6;
  const vatRate = settings.vatRate ?? 0;
  const operationalExpenses = number(settings.operationalExpenses);
  const operationalIncome = number(settings.operationalIncome);
  const taxIncome = sales === null ? null : round(sales + compensationWithoutPoints - foreignCommission + operationalIncome);
  const outgoingVat = taxIncome === null ? null : round(taxIncome * number(vatRate) / (100 + number(vatRate)));
  const taxBase = taxIncome === null ? null : round(taxIncome - number(outgoingVat));
  const taxes = taxBase === null ? null : round(number(outgoingVat) + taxBase * number(taxRate) / 100);
  const cleanWithoutOps = cogs === null || sales === null || taxes === null ? null : round(
    sales - logistics - advertising - storage - paidAcceptance - other - cogs - taxes - commission - acquiring - penalties
    + compensationWithPoints + compensationWithoutPoints
  );
  const cleanProfit = cleanWithoutOps === null ? null : round(cleanWithoutOps - operationalExpenses);
  const margin = cleanProfit === null ? null : round(percent(cleanProfit, realization));
  const marginWithoutOps = cleanWithoutOps === null ? null : round(percent(cleanWithoutOps, realization));
  const roi = cleanProfit === null || !number(cogs) ? null : round(percent(cleanProfit, cogs));
  const averageProfit = cleanProfit === null || !number(salesQuantity) ? null : round(cleanProfit / number(salesQuantity));
  const drr = round(percent(advertising, realization));
  const drrOrders = round(percent(advertising, orders));
  const priceBefore = round(divide(realization, salesQuantity));
  const averageSale = round(divide(sales, salesQuantity));
  const averageLogistics = round(divide(logistics, salesQuantity));

  return {
    cleanProfit, cleanWithoutOps, sales, salesQuantity, realization, orders, ordersQuantity,
    buyoutPercent: m.buyout_percent ?? null, logistics, advertising, storage, paidAcceptance,
    other, cogs, operationalExpenses, taxes, taxBase, commission, acquiring, roi,
    averageCogs, priceBefore, averageSale, drr, drrOrders, averageProfit, averageLogistics,
    margin, marginWithoutOps, penalties, discount, compensationWithPoints, compensationWithoutPoints,
  };
}

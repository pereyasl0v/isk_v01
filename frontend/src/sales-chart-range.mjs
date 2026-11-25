import {getDigitizationPeriod} from './digitization-period.mjs';

/**
 * Visible, evenly spaced dates on the Ozon order chart.
 * Reserve a full step before the final tick so the last two labels never overlap.
 */
export function salesTickIndexes(length, maxLabels = 14) {
  if (!Number.isInteger(length) || length <= 0) return [];
  if (length <= maxLabels) return Array.from({length}, (_, i) => i);
  const gap = Math.ceil((length - 1) / (maxLabels - 1));
  const result = [0];
  for (let i = gap; i < length - 1; i += gap) {
    if (length - 1 - i >= gap) result.push(i);
  }
  result.push(length - 1);
  return result;
}

/** Aggregate the selected days of the currently displayed product series. */
export function salesRangeTotals(points, first, last) {
  if (!Array.isArray(points) || !points.length ||
      !Number.isInteger(first) || !Number.isInteger(last)) return null;
  const startIndex = Math.max(0, Math.min(points.length - 1, Math.min(first, last)));
  const endIndex = Math.max(0, Math.min(points.length - 1, Math.max(first, last)));
  const selected = points.slice(startIndex, endIndex + 1);
  const finiteNumber = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  let units = 0, amountCents = 0, deliveredUnits = 0, deliveredKnownDays = 0;
  let deliveryPartial = false;
  for (const point of selected) {
    units += finiteNumber(point.ordered_units);
    amountCents += Math.round(finiteNumber(point.ordered_revenue) * 100);
    if (point.delivered_units !== null && point.delivered_units !== undefined) {
      deliveredUnits += finiteNumber(point.delivered_units);
      deliveredKnownDays++;
    }
    if (point.delivery_partial) deliveryPartial = true;
  }
  return {
    startIndex, endIndex,
    from: selected[0].date,
    to: selected[selected.length - 1].date,
    days: selected.length,
    orderedUnits: units,
    orderedAmount: Math.round(amountCents) / 100,
    deliveredUnits,
    deliveredKnownDays,
    deliveryComplete: !deliveryPartial && deliveredKnownDays === selected.length
  };
}

/**
 * Show the same completed Moscow reporting days as Digitization, plus today.
 * A chart labeled "90 дн." therefore contains 91 daily points.
 * Do not silently accept a stale 90-point cache as a complete window.
 */
export function salesChartWindow(rows, days, now = new Date()) {
  const {from, to: lastClosed} = getDigitizationPeriod(days, now);
  const current = new Date(lastClosed + 'T00:00:00Z');
  current.setUTCDate(current.getUTCDate() + 1);
  const to = current.toISOString().slice(0, 10);
  const points = Array.isArray(rows)
    ? rows.filter(row => typeof row?.date === 'string' && row.date >= from && row.date <= to)
    : [];
  const uniqueDays = new Set(points.map(row => row.date));
  return {
    from, to, points,
    complete: points.length === days + 1 && uniqueDays.size === days + 1
  };
}

/**
 * Show posting history on precisely the same Moscow calendar dates as the
 * order chart. Ozon normally sends timezone-aware ISO timestamps, while some
 * archived rows may already contain Moscow-local timestamps without an offset.
 */
export function postingMoscowDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(parsed);
  const part = name => parts.find(item => item.type === name)?.value;
  return [part('year'),part('month'),part('day')].join('-');
}

export function postingsInChartWindow(postings, chartWindow) {
  if (!Array.isArray(postings) || !chartWindow?.from || !chartWindow?.to) return [];
  return postings.filter(posting => {
    const day = postingMoscowDay(posting?.created_at || posting?.in_process_at);
    return day !== null && day >= chartWindow.from && day <= chartWindow.to;
  });
}


/**
 * A brushed selection on "Заказано товаров" is the history's time range too.
 * If the points have not loaded (or the selection became stale), fall back to
 * the chosen 7/14/30/90-day chart window without inventing a narrower range.
 */
export function salesSelectionWindow(chartWindow, selectedRange) {
  if (!Array.isArray(selectedRange) || selectedRange.length !== 2 ||
      !Array.isArray(chartWindow?.points)) return chartWindow;
  const dates = new Set(chartWindow.points.map(point => point.date));
  const [a, b] = selectedRange;
  if (!dates.has(a) || !dates.has(b)) return chartWindow;
  const from = a <= b ? a : b;
  const to = a <= b ? b : a;
  return {...chartWindow, from, to};
}

/**
 * Scope shipment history to the same selected product as the order chart.
 * A shipment may contain several products; show and count only lines matching
 * the selected SKU. Never attribute a whole multi-product shipment to one SKU.
 * Older rows without SKU can match an offer ID only when a known product in
 * the inventory maps that offer to the requested SKU.
 */
export function postingsForSalesSelection(postings, chartWindow, sku = 'all', products = []) {
  const inWindow = postingsInChartWindow(postings, chartWindow);
  if (sku === 'all' || sku === null || sku === undefined) return inWindow;
  const wanted = String(sku).trim();
  if (!wanted) return [];
  const offers = new Set((Array.isArray(products) ? products : [])
    .filter(product => String(product?.sku ?? '').trim() === wanted)
    .map(product => String(product?.offer_id ?? '').trim())
    .filter(Boolean));
  return inWindow.flatMap(posting => {
    const matching = (Array.isArray(posting?.products) ? posting.products : [])
      .filter(product => {
        const rowSku = String(product?.sku ?? '').trim();
        if (rowSku) return rowSku === wanted;
        const offer = String(product?.offer_id ?? '').trim();
        return Boolean(offer && offers.has(offer));
      });
    return matching.length ? [{...posting, products: matching}] : [];
  });
}

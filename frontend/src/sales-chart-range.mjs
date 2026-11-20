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

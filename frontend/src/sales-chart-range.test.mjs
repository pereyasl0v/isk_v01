import test from 'node:test';
import assert from 'node:assert/strict';
import {salesRangeTotals, salesTickIndexes} from './sales-chart-range.mjs';

test('90-day chart keeps last two tick labels separated', () => {
  const ticks = salesTickIndexes(90);
  assert.equal(ticks[0], 0);
  assert.equal(ticks.at(-1), 89);
  assert.ok(ticks.length <= 14);
  assert.ok(ticks.at(-1) - ticks.at(-2) >= 7);
  assert.ok(ticks.every((tick, i) => i === 0 || tick - ticks[i - 1] >= 7));
});
test('short windows show all dates', () => {
  assert.deepEqual(salesTickIndexes(7), [0,1,2,3,4,5,6]);
  assert.deepEqual(salesTickIndexes(14), [...Array(14).keys()]);
  assert.deepEqual(salesTickIndexes(0), []);
});

const points = [
  {date:'2026-11-17',ordered_units:1,ordered_revenue:99.20,delivered_units:1},
  {date:'2026-11-18',ordered_units:5,ordered_revenue:873.33,delivered_units:null,delivery_partial:true},
  {date:'2026-11-19',ordered_units:3,ordered_revenue:150.47,delivered_units:2},
  {date:'2026-11-20',ordered_units:0,ordered_revenue:0,delivered_units:0}
];
test('sum a dragged range in either direction using cents', () => {
  const forward = salesRangeTotals(points, 1, 2);
  const reverse = salesRangeTotals(points, 2, 1);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.from, '2026-11-18');
  assert.equal(forward.to, '2026-11-19');
  assert.equal(forward.days, 2);
  assert.equal(forward.orderedUnits, 8);
  assert.equal(forward.orderedAmount, 1023.8);
  assert.equal(forward.deliveredUnits, 2);
  assert.equal(forward.deliveredKnownDays, 1);
  assert.equal(forward.deliveryComplete, false);
});
test('single-day selections and bounds work', () => {
  const one = salesRangeTotals(points, 3, 3);
  assert.equal(one.days, 1);
  assert.equal(one.orderedUnits, 0);
  assert.equal(one.orderedAmount, 0);
  assert.equal(one.deliveryComplete, true);
  assert.equal(salesRangeTotals(points, -30, 99).days, 4);
  assert.equal(salesRangeTotals([], 0, 0), null);
});

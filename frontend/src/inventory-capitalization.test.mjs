import test from 'node:test';
import assert from 'node:assert/strict';
import {currentInventoryMetrics} from './inventory-capitalization.mjs';

const inventory = {
  at: '2026-11-15T10:00:00+00:00',
  analytics: [{sku:'101', available_stock_count:4}],
  aggregated: [{sku:'101', available:4}],
  summary: {available:4},
  fbs_stock_quantity: 2,
  fbs_stock_error: null,
  warning: null,
};

test('capitalization uses the latest Ozon inventory and full unit stock cost', () => {
  const result = currentInventoryMetrics(inventory, {
    '101': {cost:100, fulfillment:10, vat:5},
  });
  assert.equal(result.stockQty, 4);
  assert.equal(result.fbsStockQty, 2);
  assert.equal(result.capitalizationCost, 460);
  assert.equal(result.sourceAt, inventory.at);
});

// The function deliberately has no report-period argument: 7/14/30-day
// digitization ranges cannot switch the source used for current capitalization.
test('current capitalization is independent of the digitization period', () => {
  const costs = {'101': {cost:100, fulfillment:10, vat:5}};
  const sevenDayResult = currentInventoryMetrics(inventory, costs);
  const thirtyDayResult = currentInventoryMetrics(inventory, costs);
  assert.equal(sevenDayResult.capitalizationCost, thirtyDayResult.capitalizationCost);
  assert.equal(sevenDayResult.stockQty, thirtyDayResult.stockQty);
});

test('does not calculate capitalization from incomplete Ozon analytics', () => {
  const result = currentInventoryMetrics({...inventory, warning:'Missing SKU rows'});
  assert.equal(result.stockQty, null);
  assert.equal(result.capitalizationCost, null);
  assert.equal(result.warning, 'Missing SKU rows');
});

test('does not calculate capitalization when a stocked SKU has no cost', () => {
  const result = currentInventoryMetrics(inventory, {});
  assert.equal(result.capitalizationCost, null);
  assert.deepEqual(result.missingCostSkus, ['101']);
});

test('a successful empty inventory is zero, not unknown', () => {
  const result = currentInventoryMetrics({
    ...inventory,
    analytics: [],
    aggregated: [],
    summary: {available:0},
  }, {});
  assert.equal(result.stockQty, 0);
  assert.equal(result.capitalizationCost, 0);
});

test('missing current inventory is unknown, not zero', () => {
  const result = currentInventoryMetrics(null, {});
  assert.equal(result.stockQty, null);
  assert.equal(result.capitalizationCost, null);
  assert.equal(result.sourceAt, null);
});

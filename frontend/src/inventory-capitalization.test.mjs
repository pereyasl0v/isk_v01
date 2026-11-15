import test from 'node:test';
import assert from 'node:assert/strict';
import {currentInventoryMetrics} from './inventory-capitalization.mjs';

const inventory = {
  at: '2026-11-15T10:00:00+00:00',
  analytics: [{
    sku:'101',
    available_stock_count:4,
    outbound_pending_delivery:2,
    outbound_returns_return_to_seller:1,
  }],
  aggregated: [{
    sku:'101',
    available:4,
    outbound_pending_delivery:2,
    outbound_returns_return_to_seller:1,
    capitalization_quantity:7,
  }],
  summary: {
    available:4,
    outbound_fields_available:true,
    outbound_pending_delivery:2,
    outbound_returns:1,
    capitalization_quantity:7,
  },
  fbs_stock_quantity: 2,
  fbs_stock_error: null,
  warning: null,
};

test('capitalization includes warehouse stock, customer delivery and returns', () => {
  const result = currentInventoryMetrics(inventory, {
    '101': {cost:100, fulfillment:10, vat:5},
  });
  assert.equal(result.stockQty, 7);
  assert.equal(result.availableStockQty, 4);
  assert.equal(result.outboundToClientQty, 2);
  assert.equal(result.outboundReturnsQty, 1);
  assert.equal(result.fbsStockQty, 2);
  assert.equal(result.capitalizationCost, 805);
  assert.equal(result.sourceAt, inventory.at);
});

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

test('does not calculate capitalization when Ozon omits outbound stock statuses', () => {
  const result = currentInventoryMetrics({
    ...inventory,
    summary: {available:4},
    aggregated: [{sku:'101',available:4}],
  }, {'101': {cost:100}});
  assert.equal(result.stockQty, null);
  assert.equal(result.capitalizationCost, null);
  assert.equal(result.outboundFieldsAvailable, false);
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
    summary: {
      available:0,
      outbound_fields_available:true,
      outbound_pending_delivery:0,
      outbound_returns:0,
      capitalization_quantity:0,
    },
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

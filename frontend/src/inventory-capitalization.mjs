const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Capitalization is based on the latest successful inventory response from
 * Ozon, never on a historical inventory snapshot selected by the report range.
 * Historical snapshots remain useful for average capitalization only.
 */
export function currentInventoryMetrics(inventory, costs = {}) {
  const hasInventory = Boolean(
    inventory?.at &&
    Array.isArray(inventory.analytics) &&
    Array.isArray(inventory.aggregated)
  );
  const complete = hasInventory && !inventory.warning;
  const available = inventory?.summary?.available;
  const stockQty = complete && available !== null && available !== undefined &&
    Number.isFinite(Number(available)) ? Number(available) : null;

  const fbsValue = inventory?.fbs_stock_quantity;
  const fbsStockQty = hasInventory && !inventory.fbs_stock_error &&
    fbsValue !== null && fbsValue !== undefined && Number.isFinite(Number(fbsValue))
    ? Number(fbsValue)
    : null;

  const activeStock = complete
    ? inventory.aggregated.filter(row => number(row.available) > 0)
    : [];
  const missingCostSkus = activeStock
    .filter(row => !Object.prototype.hasOwnProperty.call(costs, String(row.sku)))
    .map(row => String(row.sku));

  const capitalizationCost = complete && missingCostSkus.length === 0
    ? activeStock.reduce((sum, row) => {
        const cost = costs[String(row.sku)] || {};
        const unitCost = number(cost.cost) + number(cost.fulfillment) + number(cost.vat);
        return sum + number(row.available) * unitCost;
      }, 0)
    : null;

  return {
    stockQty,
    fbsStockQty,
    capitalizationCost,
    sourceAt: hasInventory ? inventory.at : null,
    warning: hasInventory ? inventory.warning || null : null,
    missingCostSkus,
  };
}

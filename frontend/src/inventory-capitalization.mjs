const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * TrueStats-style FBO capitalization includes warehouse stock plus goods
 * currently being delivered to customers and goods in the Ozon return flow.
 * The report-period selector must never choose the source for current stock.
 */
export function currentInventoryMetrics(inventory, costs = {}) {
  const hasInventory = Boolean(
    inventory?.at &&
    Array.isArray(inventory.analytics) &&
    Array.isArray(inventory.aggregated)
  );
  const complete = hasInventory && !inventory.warning;
  const summary = inventory?.summary || {};
  const outboundFieldsAvailable = summary.outbound_fields_available === true;
  const stockQty = complete && outboundFieldsAvailable &&
    summary.capitalization_quantity !== null &&
    summary.capitalization_quantity !== undefined &&
    Number.isFinite(Number(summary.capitalization_quantity))
    ? Number(summary.capitalization_quantity)
    : null;

  const fbsValue = inventory?.fbs_stock_quantity;
  const fbsStockQty = hasInventory && !inventory.fbs_stock_error &&
    fbsValue !== null && fbsValue !== undefined && Number.isFinite(Number(fbsValue))
    ? Number(fbsValue)
    : null;

  const activeStock = complete && outboundFieldsAvailable
    ? inventory.aggregated.filter(row => number(row.capitalization_quantity) > 0)
    : [];
  const missingCostSkus = activeStock
    .filter(row => !Object.prototype.hasOwnProperty.call(costs, String(row.sku)))
    .map(row => String(row.sku));

  const capitalizationCost = complete && outboundFieldsAvailable && missingCostSkus.length === 0
    ? activeStock.reduce((sum, row) => {
        const cost = costs[String(row.sku)] || {};
        const unitCost = number(cost.cost) + number(cost.fulfillment) + number(cost.vat);
        return sum + number(row.capitalization_quantity) * unitCost;
      }, 0)
    : null;

  return {
    stockQty,
    availableStockQty: complete && summary.available !== null && summary.available !== undefined
      ? Number(summary.available) : null,
    outboundToClientQty: outboundFieldsAvailable ? number(summary.outbound_pending_delivery) : null,
    outboundReturnsQty: outboundFieldsAvailable ? number(summary.outbound_returns) : null,
    outboundFieldsAvailable,
    fbsStockQty,
    capitalizationCost,
    sourceAt: hasInventory ? inventory.at : null,
    warning: hasInventory ? inventory.warning || null : null,
    missingCostSkus,
  };
}

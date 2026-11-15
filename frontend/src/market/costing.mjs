export const n = value => {
  const parsed = Number(String(value ?? 0).replace(",", "."));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

export function calculateProductCost(product, shipment, products = []) {
  const quantity = n(product.quantity ?? 1);
  const yuan = n(product.yuan);
  const purchaseRate = n(product.rate);
  const localDelivery = n(product.deliveryToGuangzhouYuan);
  if (!shipment || !product.shipmentId) {
    const unitCost = yuan * purchaseRate + n(product.freight);
    return {
      costPerUnit: unitCost,
      purchaseRub: unitCost * quantity,
      transportRub: 0,
      sharedExpensesRub: 0,
      allocationShare: 0,
      allocatedGrossWeightKg: 0,
      shipmentName: null,
      source: "manual",
    };
  }

  const lines = products.filter(row => String(row.shipmentId || "") === String(shipment.id));
  const assigned = lines.length ? lines : [product];
  const totalQuantity = assigned.reduce((sum, row) => sum + n(row.quantity ?? 1), 0);
  const totalProductNet = assigned.reduce((sum, row) => sum + n(row.unitNetWeightG) * n(row.quantity ?? 1) / 1000, 0);
  const netWeight = n(shipment.netWeightKg) || totalProductNet;
  const grossWeight = n(shipment.grossWeightKg) || netWeight;
  const packagingWeight = Math.max(0, grossWeight - netWeight);
  const weightedLines = assigned.map(row => {
    const net = n(row.unitNetWeightG) * n(row.quantity ?? 1) / 1000;
    const packaging = netWeight > 0 ? packagingWeight * net / netWeight : 0;
    return { row, gross: net + packaging };
  });
  const totalAllocatedWeight = weightedLines.reduce((sum, row) => sum + row.gross, 0);
  const method = shipment.distributionMethod || "weight";
  let allocationShare = 0;
  let allocatedGrossWeightKg = 0;
  for (const entry of weightedLines) {
    if (String(entry.row.id) !== String(product.id)) continue;
    allocatedGrossWeightKg = entry.gross;
    if (method === "quantity") {
      allocationShare = totalQuantity > 0 ? n(entry.row.quantity ?? 1) / totalQuantity : 0;
    } else if (method === "equal") {
      allocationShare = weightedLines.length ? 1 / weightedLines.length : 0;
    } else {
      allocationShare = totalAllocatedWeight > 0 ? entry.gross / totalAllocatedWeight : 0;
    }
    break;
  }

  const transportUsd = n(shipment.autoFreightUsdPerKg) * grossWeight
    + n(shipment.packagingPerBoxUsd) * n(shipment.boxCount);
  const transportTotalRub = transportUsd * n(shipment.usdToYuanRate) * n(shipment.yuanToRubRate);
  const sharedTotalRub = n(shipment.deliveryToSpbRub) + n(shipment.deliveryToHomeRub)
    + n(shipment.loadersRub) + n(shipment.packingRub);
  const purchaseTotalRub = (quantity * yuan + localDelivery) * purchaseRate;
  const transportRub = transportTotalRub * allocationShare;
  const sharedExpensesRub = sharedTotalRub * allocationShare;
  return {
    costPerUnit: quantity > 0 ? (purchaseTotalRub + transportRub + sharedExpensesRub) / quantity : 0,
    purchaseRub: purchaseTotalRub,
    transportRub,
    sharedExpensesRub,
    allocationShare,
    allocatedGrossWeightKg,
    shipmentName: shipment.name || null,
    source: "shipment",
  };
}

export function calculateWorkspaceCosts(products = [], shipments = []) {
  const byId = new Map(shipments.map(shipment => [String(shipment.id), shipment]));
  return Object.fromEntries(products.map(product => {
    const shipment = byId.get(String(product.shipmentId || ""));
    return [String(product.id), calculateProductCost(product, shipment, products)];
  }));
}

export function withLandedCosts(products = [], shipments = []) {
  const costs = calculateWorkspaceCosts(products, shipments);
  return products.map(product => ({
    ...product,
    landedCostPerUnit: costs[String(product.id)]?.costPerUnit ?? 0,
    costBreakdown: costs[String(product.id)] || null,
  }));
}

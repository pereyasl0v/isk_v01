export const DEFAULT_ROUTE1 = {
  yuanToRubRate: 14.2,
  purchaseMarkupPercent: 7,
  // Source workbook: 17,000 * 95 / 65 * product volume.
  freightRateRubPerM3: 17000 * 95 / 65,
  dutyableFreightPercent: 60,
  vatPercent: 22,
  ownTaxPercent: 20,
  deliveryToSpbRub: 0,
  loadersRub: 0,
  unloadersRub: 0,
  otherRub: 0,
  allocationMethod: "volume",
};

export const DEFAULT_ROUTE2 = {
  purchaseYuanToRubRate: 11.8,
  usdToYuanRate: 6.8,
  freightYuanToRubRate: 12.4,
  autoFreightUsdPerKg: 3.2,
  packagingPerBoxUsd: 3,
  boxCount: 0,
  grossWeightKg: 0,
  deliveryToSpbRub: 0,
  deliveryToHomeRub: 0,
  loadersRub: 0,
  packingRub: 0,
  otherRub: 0,
};

export const createProduct = () => ({
  id: globalThis.crypto?.randomUUID?.() || ("product-" + Date.now() + "-" + Math.random().toString(16).slice(2)),
  name: "",
  article: "",
  quantity: 1,
  unitPriceYuan: 0,
  deliveryToSashaYuan: 0,
  deliveryToGuangzhouYuan: 0,
  dutyPercent: 6.5,
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  volumeM3: 0,
  grossWeightKg: 0,
  netWeightKg: 0,
  unitNetWeightG: 0,
});

export const createDraft = () => ({
  products: [createProduct()],
  route1: { ...DEFAULT_ROUTE1 },
  route2: { ...DEFAULT_ROUTE2 },
});

export const n = value => {
  const parsed = Number(String(value ?? 0).replace(",", "."));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

export function batchVolumeM3(product) {
  const dimensions = [product.lengthCm, product.widthCm, product.heightCm].map(n);
  if (dimensions.every(value => value === 0)) return n(product.volumeM3);
  return dimensions.reduce((volume, size) => volume * size, n(product.quantity)) / 1_000_000;
}

function shares(products, method) {
  let weights;
  if (method === "volume") weights = products.map(product => n(product.volumeM3));
  else if (method === "weight") weights = products.map(product =>
    n(product.grossWeightKg) || n(product.netWeightKg) || n(product.unitNetWeightG) * n(product.quantity) / 1000
  );
  else if (method === "value") weights = products.map(product => n(product.unitPriceYuan) * n(product.quantity));
  else weights = products.map(product => n(product.quantity));
  let total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    weights = products.map(product => n(product.quantity));
    total = weights.reduce((sum, value) => sum + value, 0);
  }
  return weights.map(value => total > 0 ? value / total : 0);
}

export function calculatePreliminaryCost(draft) {
  const products = Array.isArray(draft?.products)
    ? draft.products.map(product => ({ ...product, volumeM3: batchVolumeM3(product) }))
    : [];
  const route1 = { ...DEFAULT_ROUTE1, ...(draft?.route1 || {}) };
  const route2 = { ...DEFAULT_ROUTE2, ...(draft?.route2 || {}) };
  if (!products.length) return { products: [], summary: null, warnings: [] };

  const warnings = [];
  const route1Shares = shares(products, route1.allocationMethod);
  const route1Shared = n(route1.deliveryToSpbRub) + n(route1.loadersRub)
    + n(route1.unloadersRub) + n(route1.otherRub);

  const route1Rows = products.map((product, index) => {
    const quantity = Math.max(1, n(product.quantity));
    const supplierTotalYuan = quantity * n(product.unitPriceYuan) + n(product.deliveryToSashaYuan);
    const goodsRub = supplierTotalYuan * n(route1.yuanToRubRate)
      * (1 + n(route1.purchaseMarkupPercent) / 100);
    const freightToRostovRub = n(product.volumeM3) * n(route1.freightRateRubPerM3);
    const taxableFreightRub = freightToRostovRub * n(route1.dutyableFreightPercent) / 100;
    const dutyGoodsRub = goodsRub * n(product.dutyPercent) / 100;
    const dutyFreightRub = taxableFreightRub * n(product.dutyPercent) / 100;
    const vatGoodsRub = goodsRub * n(route1.vatPercent) / 100;
    const vatFreightRub = taxableFreightRub * n(route1.vatPercent) / 100;
    const taxBase = freightToRostovRub + goodsRub + dutyGoodsRub + dutyFreightRub + vatGoodsRub + vatFreightRub;
    const ownTaxRub = taxBase * n(route1.ownTaxPercent) / 100;
    const allocatedAdditionalRub = route1Shared * route1Shares[index];
    const totalRub = taxBase + ownTaxRub + allocatedAdditionalRub;
    if (n(route1.freightRateRubPerM3) && !n(product.volumeM3)) {
      warnings.push("«" + (product.name || "Без названия") + "»: укажите длину, ширину и высоту одной штуки для расчёта доставки через Ростов.");
    }
    return {
      id: product.id,
      supplierTotalYuan,
      goodsRub,
      freightToRostovRub,
      taxableFreightRub,
      dutyGoodsRub,
      dutyFreightRub,
      vatGoodsRub,
      vatFreightRub,
      ownTaxRub,
      allocatedAdditionalRub,
      allocationShare: route1Shares[index],
      totalRub,
      costPerUnit: totalRub / quantity,
    };
  });

  const totalQuantity = products.reduce((sum, product) => sum + Math.max(1, n(product.quantity)), 0);
  const route1Total = route1Rows.reduce((sum, row) => sum + row.totalRub, 0);

  const netWeights = products.map(product => n(product.unitNetWeightG) * n(product.quantity) / 1000);
  const totalNetWeight = netWeights.reduce((sum, value) => sum + value, 0);
  let grossWeight = n(route2.grossWeightKg) || totalNetWeight;
  if (grossWeight < totalNetWeight) {
    warnings.push("Маршрут через Южные ворота: брутто меньше суммарного нетто. Для расчёта использован вес нетто.");
    grossWeight = totalNetWeight;
  }
  const packagingWeight = Math.max(0, grossWeight - totalNetWeight);
  let route2Shares;
  if (grossWeight <= 0 || totalNetWeight <= 0) {
    route2Shares = shares(products, "quantity");
    warnings.push("Маршрут через Южные ворота: укажи вес нетто товара и брутто всей партии для точного распределения доставки.");
  } else {
    route2Shares = netWeights.map(net =>
      (net + packagingWeight * net / totalNetWeight) / grossWeight
    );
  }

  const transportUsd = n(route2.autoFreightUsdPerKg) * grossWeight
    + n(route2.packagingPerBoxUsd) * n(route2.boxCount);
  const transportRub = transportUsd * n(route2.usdToYuanRate) * n(route2.freightYuanToRubRate);
  const route2Shared = n(route2.deliveryToSpbRub) + n(route2.deliveryToHomeRub)
    + n(route2.loadersRub) + n(route2.packingRub) + n(route2.otherRub);

  const route2Rows = products.map((product, index) => {
    const quantity = Math.max(1, n(product.quantity));
    const netWeightKg = netWeights[index];
    const allocatedPackagingKg = totalNetWeight > 0 ? packagingWeight * netWeightKg / totalNetWeight : 0;
    const allocatedGrossWeightKg = netWeightKg + allocatedPackagingKg;
    const purchaseTotalYuan = quantity * n(product.unitPriceYuan) + n(product.deliveryToGuangzhouYuan);
    const purchaseRub = purchaseTotalYuan * n(route2.purchaseYuanToRubRate);
    const allocatedTransportRub = transportRub * route2Shares[index];
    const sharedExpensesRub = route2Shared * route2Shares[index];
    const totalRub = purchaseRub + allocatedTransportRub + sharedExpensesRub;
    return {
      id: product.id,
      netWeightKg,
      allocatedPackagingKg,
      allocatedGrossWeightKg,
      allocationShare: route2Shares[index],
      purchaseTotalYuan,
      purchaseRub,
      transportRub: allocatedTransportRub,
      sharedExpensesRub,
      totalRub,
      costPerUnit: totalRub / quantity,
    };
  });

  const route2Total = route2Rows.reduce((sum, row) => sum + row.totalRub, 0);
  const cheaperRoute = route1Total < route2Total ? "rostov"
    : route2Total < route1Total ? "south_gates" : null;

  return {
    products: products.map((product, index) => ({
      ...product,
      route1: route1Rows[index],
      route2: route2Rows[index],
      differencePerUnit: route1Rows[index].costPerUnit - route2Rows[index].costPerUnit,
    })),
    summary: {
      route1: {
        totalRub: route1Total,
        averageCostPerUnit: totalQuantity ? route1Total / totalQuantity : 0,
        sharedExpensesRub: route1Shared,
        totalQuantity,
      },
      route2: {
        totalRub: route2Total,
        averageCostPerUnit: totalQuantity ? route2Total / totalQuantity : 0,
        transportRub,
        sharedExpensesRub: route2Shared,
        grossWeightKg: grossWeight,
        netWeightKg: totalNetWeight,
        totalQuantity,
      },
      cheaperRoute,
      differenceRub: Math.abs(route1Total - route2Total),
    },
    warnings: [...new Set(warnings)],
  };
}

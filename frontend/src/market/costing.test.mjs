import test from "node:test";
import assert from "node:assert/strict";
import {calculateProductCost,calculateWorkspaceCosts,withLandedCosts} from "./costing.mjs";

const shipment = {
  id:"s1",name:"AUA-2510-18-6",netWeightKg:280.9,grossWeightKg:291,
  autoFreightUsdPerKg:3.2,packagingPerBoxUsd:3,boxCount:6,
  usdToYuanRate:6.8,yuanToRubRate:12.4,
  deliveryToSpbRub:5111,deliveryToHomeRub:2000,loadersRub:2000,packingRub:1536,
  distributionMethod:"weight"
};
const products = [
  {id:"p1",shipmentId:"s1",name:"Щипцы СВП",unitNetWeightG:320,quantity:800,yuan:3.6,rate:11.8,deliveryToGuangzhouYuan:340},
  {id:"p2",shipmentId:"s1",name:"Уменьшители размера",unitNetWeightG:5,quantity:1500,yuan:0.6,rate:11.8,deliveryToGuangzhouYuan:0},
  {id:"p3",shipmentId:"s1",name:"Шпилькосъёмник",unitNetWeightG:29,quantity:600,yuan:1.45,rate:11.8,deliveryToGuangzhouYuan:25}
];

test("allocates transport and common shipment expenses by gross weight",()=>{
  const costs=calculateWorkspaceCosts(products,[shipment]);
  assert.ok(Math.abs(costs.p1.costPerUnit-150.8012800997)<1e-8);
  assert.ok(Math.abs(costs.p2.costPerUnit-8.6941606266)<1e-8);
  assert.ok(Math.abs(costs.p3.costPerUnit-26.9637983007)<1e-8);
  const shares=Object.values(costs).reduce((sum,row)=>sum+row.allocationShare,0);
  assert.ok(Math.abs(shares-1)<1e-12);
  const allocated=Object.values(costs).reduce((sum,row)=>sum+row.transportRub+row.sharedExpensesRub,0);
  const expectedTransport=(3.2*291+3*6)*6.8*12.4;
  assert.ok(Math.abs(allocated-(expectedTransport+10647))<1e-8);
});

test("supports quantity and equal distribution methods",()=>{
  const byQuantity=calculateWorkspaceCosts(products,[{...shipment,distributionMethod:"quantity"}]);
  assert.ok(Math.abs(byQuantity.p1.allocationShare-800/2900)<1e-12);
  const equal=calculateWorkspaceCosts(products,[{...shipment,distributionMethod:"equal"}]);
  assert.ok(Math.abs(equal.p1.allocationShare-1/3)<1e-12);
});

test("keeps the legacy manual unit-cost formula for products without a shipment",()=>{
  const row=calculateProductCost({id:"x",yuan:3.6,rate:11.8,freight:12,quantity:10},null,[]);
  assert.equal(row.costPerUnit,54.48);
  assert.equal(row.source,"manual");
});

test("attaches calculated landed cost for downstream WB and Ozon calculators",()=>{
  const rows=withLandedCosts(products,[shipment]);
  assert.ok(Math.abs(rows[0].landedCostPerUnit-150.8012800997)<1e-8);
  assert.equal(rows[0].costBreakdown.shipmentName,"AUA-2510-18-6");
});

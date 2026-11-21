import assert from "node:assert/strict";
import test from "node:test";
import { calculatePreliminaryCost } from "./preliminary-costing.mjs";

const sample = () => ({
  products: [
    {id:"p1",name:"Щипцы СВП",quantity:800,unitPriceYuan:3.6,deliveryToSashaYuan:0,deliveryToGuangzhouYuan:340,dutyPercent:6.5,volumeM3:.3,grossWeightKg:291,netWeightKg:256,unitNetWeightG:320},
    {id:"p2",name:"Уменьшители размера",quantity:1500,unitPriceYuan:.6,deliveryToSashaYuan:0,deliveryToGuangzhouYuan:0,dutyPercent:10,volumeM3:.3,grossWeightKg:7.5,netWeightKg:7.5,unitNetWeightG:5},
    {id:"p3",name:"Шпилькосъемник",quantity:600,unitPriceYuan:1.45,deliveryToSashaYuan:0,deliveryToGuangzhouYuan:25,dutyPercent:6.5,volumeM3:2,grossWeightKg:17.4,netWeightKg:17.4,unitNetWeightG:29},
  ],
  route1:{yuanToRubRate:14.2,purchaseMarkupPercent:7,freightRateRubPerM3:17000*95/65,dutyableFreightPercent:60,vatPercent:22,ownTaxPercent:20,deliveryToSpbRub:0,loadersRub:0,unloadersRub:0,otherRub:0,allocationMethod:"volume"},
  route2:{purchaseYuanToRubRate:11.8,usdToYuanRate:6.8,freightYuanToRubRate:12.4,autoFreightUsdPerKg:3.2,packagingPerBoxUsd:3,boxCount:6,grossWeightKg:291,deliveryToSpbRub:5111,deliveryToHomeRub:2000,loadersRub:2000,packingRub:1536,otherRub:0},
});

test("route one matches formulas from workbook 2",()=>{
  const draft={products:[{id:"p1",name:"Лестница",quantity:200,unitPriceYuan:8.65,deliveryToSashaYuan:0,dutyPercent:6.5,volumeM3:.3}],route1:{yuanToRubRate:14.2,purchaseMarkupPercent:7,freightRateRubPerM3:17000*95/65,dutyableFreightPercent:60,vatPercent:22,ownTaxPercent:20},route2:{}};
  const row=calculatePreliminaryCost(draft).products[0].route1;
  assert.ok(Math.abs(row.goodsRub-26285.62)<1e-7);
  assert.ok(Math.abs(row.freightToRostovRub-7453.846153846)<1e-7);
  assert.ok(Math.abs(row.totalRub-51006.570655384625)<1e-7);
  assert.ok(Math.abs(row.costPerUnit-255.03285327692313)<1e-7);
});

test("route two matches Nastya workbook and allocates shared costs once",()=>{
  const result=calculatePreliminaryCost(sample());
  const rows=result.products;
  assert.ok(Math.abs(rows[0].route2.costPerUnit-150.80128009967962)<1e-7);
  assert.ok(Math.abs(rows[1].route2.costPerUnit-8.694160626557494)<1e-7);
  assert.ok(Math.abs(rows[2].route2.costPerUnit-26.963798300700134)<1e-7);
  assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.route2.allocationShare,0)-1)<1e-9);
  assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.route2.sharedExpensesRub,0)-10647)<1e-7);
  assert.ok(Math.abs(result.summary.route2.totalRub-149860.54399999998)<1e-5);
});

test("Rostov route allocates shared local delivery and handling exactly once",()=>{
  const draft=sample();
  draft.route1.deliveryToSpbRub=12000;
  draft.route1.loadersRub=3000;
  const result=calculatePreliminaryCost(draft);
  assert.ok(Math.abs(result.products.reduce((sum,row)=>sum+row.route1.allocatedAdditionalRub,0)-15000)<1e-7);
});

test("weight allocation falls back safely when source weights are absent",()=>{
  const draft=sample();
  draft.products.forEach(product=>{product.unitNetWeightG=0; product.netWeightKg=0});
  draft.route2.grossWeightKg=0;
  const result=calculatePreliminaryCost(draft);
  assert.ok(Math.abs(result.products.reduce((sum,row)=>sum+row.route2.allocationShare,0)-1)<1e-9);
  assert.ok(result.warnings.some(message=>message.includes("вес нетто")));
});

test("dimensions drive freight for the selected quantity and preserve legacy volume",()=>{
  const draft=sample();
  const [product,legacy]=draft.products;
  draft.products=[product,legacy];
  Object.assign(product,{lengthCm:"2,5",widthCm:4,heightCm:5,quantity:1000,unitNetWeightG:15});
  Object.assign(draft.route1,{freightRateRubPerM3:1000,deliveryToSpbRub:700});
  const [first,second]=calculatePreliminaryCost(draft).products;
  assert.equal(first.volumeM3,0.05);
  assert.equal(first.netWeightKg,15);
  assert.equal(first.route2.netWeightKg,15);
  assert.equal(first.route1.freightToRostovRub,50);
  assert.ok(Math.abs(first.route1.allocatedAdditionalRub-100)<1e-8);
  assert.equal(second.volumeM3,0.3);
  product.quantity=2000;
  assert.equal(calculatePreliminaryCost(draft).products[0].volumeM3,0.1);
  assert.equal(calculatePreliminaryCost(draft).products[0].netWeightKg,30);
  product.heightCm="";
  assert.equal(calculatePreliminaryCost(draft).products[0].volumeM3,0);
});

test("shared yuan rate applies to both purchases and to shipping",()=>{
  const draft=sample();
  const before=calculatePreliminaryCost(draft).products[0];
  const after=calculatePreliminaryCost({...draft,yuanToRubRate:"15,5"}).products[0];
  assert.ok(Math.abs(after.route1.goodsRub-before.route1.goodsRub*15.5/14.2)<1e-8);
  assert.ok(Math.abs(after.route2.purchaseRub-before.route2.purchaseRub*15.5/11.8)<1e-8);
  assert.ok(Math.abs(after.route2.transportRub-before.route2.transportRub*15.5/12.4)<1e-8);
});

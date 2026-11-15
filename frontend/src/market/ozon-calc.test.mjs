import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateOzonScenario, calculateOzonScenarios,
  parseOzonCaptureText, summarizeOzonPrices, OZON_DEFAULTS
} from "./ozon-calc.mjs";

test("Ozon XLSX example reproduces FBO and FBS marketplace expenses", () => {
  const fbo = calculateOzonScenario({buyerPrice:271, cost:0, settings:OZON_DEFAULTS, scheme:"FBO"});
  const fbs = calculateOzonScenario({buyerPrice:271, cost:0, settings:OZON_DEFAULTS, scheme:"FBS"});
  assert.equal(Math.round(fbo.commission), 62);
  assert.equal(Math.round(fbo.acquiring), 3);
  assert.equal(Math.round(fbo.logistics + fbo.lastMile), 54);
  assert.equal(Math.round(fbo.ozonCosts), 119);
  assert.equal(Math.round(fbo.payout), 152);
  assert.equal(Math.round(fbs.handling), 10);
  assert.equal(Math.round(fbs.ozonCosts), 129);
  assert.equal(Math.round(fbs.payout), 142);
});

test("Ozon commission uses PCT, PP, Km and Kp formula", () => {
  const result = calculateOzonScenario({
    buyerPrice:271,
    settings:{...OZON_DEFAULTS, priceDiscountPct:10, commissionModifierPct:0, loyaltyPayoutRub:0},
    scheme:"FBO"
  });
  assert.equal(result.kpPct, 10);
  assert.equal(result.pctl, 301.11);
  assert.equal(result.commission, 39.14);
});

test("tax and product cost are deducted after Ozon payout", () => {
  const result = calculateOzonScenario({
    buyerPrice:271, cost:50,
    settings:{...OZON_DEFAULTS, taxPct:6}, scheme:"FBO"
  });
  assert.equal(result.tax, 16.26);
  assert.equal(result.cost, 50);
  assert.equal(result.profit, 85.7);
});

test("Ozon reverse logistics reserve is optional and based on return rate", () => {
  const base = calculateOzonScenario({buyerPrice:271, settings:OZON_DEFAULTS, scheme:"FBO"});
  const reserved = calculateOzonScenario({
    buyerPrice:271, settings:{...OZON_DEFAULTS, returnRatePct:10}, scheme:"FBO"
  });
  assert.equal(base.reverseReserve, 0);
  assert.equal(reserved.reverseReserve, 2.9);
});

test("summarizes the first ten imported price values", () => {
  assert.deepEqual(summarizeOzonPrices([300,100,200,400]), {
    min:100, median:250, average:250, count:4
  });
  assert.equal(calculateOzonScenarios([100,200,300], 50, OZON_DEFAULTS).length, 3);
});

test("imports the extension JSON contract and ignores empty prices", () => {
  const result = parseOzonCaptureText(JSON.stringify({
    source:"market-calculate-ozon-browser",
    query:"дрель",
    products:[
      {id:"123",name:"Дрель",price_rub:2499},
      {id:"456",name:"Дрель без цены",price_rub:null}
    ]
  }));
  assert.equal(result.query, "дрель");
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].price_rub, 2499);
});

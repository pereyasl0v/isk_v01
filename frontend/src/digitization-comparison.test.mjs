import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {previousPeriodRange, compareMetric, comparisonTone, calculateDigitizationPeriodMetrics} from './digitization-comparison.mjs';

test('previous range matches the selected period length for a week, two weeks and a month', () => {
  assert.deepEqual(previousPeriodRange('2026-11-13', '2026-11-19'), {from:'2026-11-06',to:'2026-11-12',days:7});
  assert.deepEqual(previousPeriodRange('2026-11-06', '2026-11-19'), {from:'2026-10-23',to:'2026-11-05',days:14});
  assert.deepEqual(previousPeriodRange('2026-10-21', '2026-11-19'), {from:'2026-09-21',to:'2026-10-20',days:30});
});

test('comparison supports a full 31-day calendar month and rejects longer ranges', () => {
  assert.deepEqual(previousPeriodRange('2026-10-01','2026-10-31'), {from:'2026-08-31',to:'2026-09-30',days:31});
  assert.equal(previousPeriodRange('2026-08-22','2026-11-19'), null);
  assert.equal(previousPeriodRange('2026-11-19','2026-11-18'), null);
});

test('comparison calculates signed differences and handles a zero baseline', () => {
  assert.deepEqual(compareMetric(549,785), {previous:785,delta:-236,changePercent:-30.06,trend:'down',fromZero:false});
  assert.equal(compareMetric(120,100).changePercent,20);
  assert.equal(compareMetric(0,0).changePercent,0);
  assert.equal(compareMetric(10,0).changePercent,null);
  assert.equal(compareMetric(null,10),null);
  assert.equal(compareMetric(0,-100).changePercent,100);
});

test('positive and negative tone follows whether higher or lower is better', () => {
  const up=compareMetric(12,10),down=compareMetric(8,10);
  assert.equal(comparisonTone(up,'higher'),'positive');
  assert.equal(comparisonTone(up,'lower'),'negative');
  assert.equal(comparisonTone(down,'lower'),'positive');
  assert.equal(comparisonTone(down,'higher'),'negative');
  assert.equal(comparisonTone(up,'neutral'),'neutral');
});

test('period metrics use the same local product costs and tax settings', () => {
  const digi={metrics:{sales_amount:1000,sales_quantity:10,realization:1100,orders_amount:1200,orders_quantity:12,discount_points:100,logistics:50,nominal_commission:100,acquiring:10,advertising:20,storage:5,paid_acceptance:3,penalties:2,other_deductions:4,compensations:6,buyout_percent:90},components:{marketplace_buyout_commission:30},products:[{sku:'1',sales_quantity:10}]};
  const result=calculateDigitizationPeriodMetrics(digi,{'1':{cost:40,fulfillment:5}},{taxRate:6,vatRate:0,operationalExpenses:10,operationalIncome:0});
  assert.equal(result.cogs,450);
  assert.equal(result.sales,1000);
  assert.equal(result.buyoutPercent,90);
  assert.equal(result.averageCogs,45);
  assert.equal(result.operationalExpenses,10);
  assert.equal(result.taxBase,976);
  assert.equal(result.taxes,58.56);
  assert.equal(result.cleanWithoutOps,403.44);
  assert.equal(result.cleanProfit,393.44);
});


test('cached comparison stays readable while Ozon job is rate-limited or running', () => {
  const component=readFileSync(new URL('./Digitization.jsx',import.meta.url),'utf8');
  const loadingEffect=component.slice(
    component.indexOf('// Read the preceding period from SQLite'),
    component.indexOf(' const saveSetting=',component.indexOf('// Read the preceding period from SQLite'))
  );
  assert.ok(loadingEffect.includes("fetch('/api/digitization?'+q"));
  assert.doesNotMatch(loadingEffect,/if\(state\?\.job\?\.running\)return;/,
    'Local comparison read must not be blocked by a running Ozon job');
  assert.match(loadingEffect,/autoLoadComparisons&&!state\?\.job\?\.running&&shouldAutoLoadDigitization/,
    'Network sync still must not start when an Ozon job already runs');
  assert.match(component,/comparisonRange&&comparisonState\.loading&&/,
    'Loading state follows local DB fetch, never Ozon job state');
  assert.doesNotMatch(component,/comparisonState\.loading\|\|state\?\.job\?\.running/,
    'Do not show waiting for Ozon when data is already available in SQLite');
});

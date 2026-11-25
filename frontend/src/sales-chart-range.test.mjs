import test from 'node:test';
import assert from 'node:assert/strict';
import {salesChartWindow, salesRangeTotals, salesTickIndexes, postingsInChartWindow, postingMoscowDay, salesSelectionWindow, postingsForSalesSelection} from './sales-chart-range.mjs';

test('90-day chart keeps last two tick labels separated', () => {
  const ticks = salesTickIndexes(90);
  assert.equal(ticks[0], 0);
  assert.equal(ticks.at(-1), 89);
  assert.ok(ticks.length <= 14);
  assert.ok(ticks.at(-1) - ticks.at(-2) >= 7);
  assert.ok(ticks.every((tick, i) => i === 0 || tick - ticks[i - 1] >= 7));
});
test('short windows show all dates', () => {
  assert.deepEqual(salesTickIndexes(7), [0,1,2,3,4,5,6]);
  assert.deepEqual(salesTickIndexes(14), [...Array(14).keys()]);
  assert.deepEqual(salesTickIndexes(0), []);
});

const points = [
  {date:'2026-11-17',ordered_units:1,ordered_revenue:99.20,delivered_units:1},
  {date:'2026-11-18',ordered_units:5,ordered_revenue:873.33,delivered_units:null,delivery_partial:true},
  {date:'2026-11-19',ordered_units:3,ordered_revenue:150.47,delivered_units:2},
  {date:'2026-11-20',ordered_units:0,ordered_revenue:0,delivered_units:0}
];
test('sum a dragged range in either direction using cents', () => {
  const forward = salesRangeTotals(points, 1, 2);
  const reverse = salesRangeTotals(points, 2, 1);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.from, '2026-11-18');
  assert.equal(forward.to, '2026-11-19');
  assert.equal(forward.days, 2);
  assert.equal(forward.orderedUnits, 8);
  assert.equal(forward.orderedAmount, 1023.8);
  assert.equal(forward.deliveredUnits, 2);
  assert.equal(forward.deliveredKnownDays, 1);
  assert.equal(forward.deliveryComplete, false);
});
test('single-day selections and bounds work', () => {
  const one = salesRangeTotals(points, 3, 3);
  assert.equal(one.days, 1);
  assert.equal(one.orderedUnits, 0);
  assert.equal(one.orderedAmount, 0);
  assert.equal(one.deliveryComplete, true);
  assert.equal(salesRangeTotals(points, -30, 99).days, 4);
  assert.equal(salesRangeTotals([], 0, 0), null);
});

test('90 дн. means 90 completed Moscow days plus today (91 points)', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const allDates = Array.from({length: 91}, (_, i) => {
    const day = new Date('2026-08-22T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + i);
    return {date: day.toISOString().slice(0, 10), ordered_units: i};
  });
  const window = salesChartWindow(allDates, 90, now);
  assert.equal(window.from, '2026-08-22');
  assert.equal(window.to, '2026-11-20');
  assert.equal(window.points.length, 91);
  assert.equal(window.complete, true);
  assert.equal(salesChartWindow(allDates.slice(1), 90, now).complete, false);
  assert.equal(salesChartWindow(allDates.slice(0, -1), 90, now).complete, false);
  assert.equal(salesChartWindow(allDates.filter(p => p.date !== '2026-10-01'), 90, now).complete, false);
  assert.equal(salesTickIndexes(window.points.length).at(-1), 90);
});

test('chart ignores old cached dates and uses Moscow today across midnight', () => {
  const now = new Date('2026-11-19T22:30:00Z'); // already Nov 20 in Moscow
  const rows = [
    {date:'2026-11-12'}, {date:'2026-11-13'}, {date:'2026-11-14'},
    {date:'2026-11-15'}, {date:'2026-11-16'}, {date:'2026-11-17'},
    {date:'2026-11-18'}, {date:'2026-11-19'}, {date:'2026-11-20'}
  ];
  const window = salesChartWindow(rows, 7, now);
  assert.equal(window.from, '2026-11-13');
  assert.equal(window.to, '2026-11-20');
  assert.equal(window.points.length, 8);
  assert.equal(window.complete, true);
  assert.deepEqual(salesChartWindow([], 7, now).points, []);
});

test('posting history uses exactly the chart period, including today in Moscow', () => {
 const now = new Date('2026-11-24T18:00:00Z');
 const chartWindow = salesChartWindow([], 14, now);
 assert.deepEqual({from: chartWindow.from,to: chartWindow.to},{from:'2026-11-10',to:'2026-11-24'});
 const postings = [
  {number:'before',created_at:'2026-11-09T20:59:59Z'}, // 09 Nov 23:59 MSK
  {number:'first',created_at:'2026-11-09T21:00:00Z'},  // 10 Nov 00:00 MSK
  {number:'middle',created_at:'2026-11-20T10:30:00+03:00'},
  {number:'last',created_at:'2026-11-24T20:59:59Z'},  // 24 Nov 23:59 MSK
  {number:'after',created_at:'2026-11-24T21:00:00Z'}, // 25 Nov 00:00 MSK
  {number:'naive',in_process_at:'2026-11-20T15:00:00'},
  {number:'unknown'}
 ];
 assert.deepEqual(postingsInChartWindow(postings,chartWindow).map(p=>p.number),
  ['first','middle','last','naive']);
 assert.equal(postingMoscowDay('2026-11-24T22:00:00Z'),'2026-11-25');
 assert.equal(postingMoscowDay('2026-11-24T11:45:00'),'2026-11-24');
 assert.equal(postingMoscowDay(null),null);
});

test('changing chart controls also changes the posting history time coverage',()=>{
 const now = new Date('2026-11-24T18:00:00Z');
 const postings = [
  {number:'nov-15',created_at:'2026-11-15T12:00:00Z'},
  {number:'nov-20',created_at:'2026-11-20T12:00:00Z'},
  {number:'nov-24',created_at:'2026-11-24T12:00:00Z'}
 ];
 assert.deepEqual(postingsInChartWindow(postings,salesChartWindow([],7,now)).map(p=>p.number),
  ['nov-20','nov-24']);
 assert.deepEqual(postingsInChartWindow(postings,salesChartWindow([],14,now)).map(p=>p.number),
  ['nov-15','nov-20','nov-24']);
 assert.deepEqual(postingsInChartWindow(postings,salesChartWindow([],30,now)).map(p=>p.number),
  ['nov-15','nov-20','nov-24']);
});


test('brushed chart dates also define the shipment history range, including reverse selection',()=>{
 const now=new Date('2026-11-24T18:00:00Z');
 const points=['2026-11-20','2026-11-21','2026-11-22','2026-11-23','2026-11-24'].map(date=>({date}));
 const chart={...salesChartWindow([],14,now),points};
 const selected=salesSelectionWindow(chart,['2026-11-23','2026-11-21']);
 assert.deepEqual({from:selected.from,to:selected.to},{from:'2026-11-21',to:'2026-11-23'});
 const postings=[
  {number:'before',created_at:'2026-11-20T12:00:00Z'},
  {number:'first',created_at:'2026-11-21T12:00:00Z'},
  {number:'last',created_at:'2026-11-23T12:00:00Z'},
  {number:'after',created_at:'2026-11-24T12:00:00Z'}
 ];
 assert.deepEqual(postingsInChartWindow(postings,selected).map(p=>p.number),['first','last']);
 assert.equal(salesSelectionWindow(chart,null),chart);
 assert.equal(salesSelectionWindow(chart,['2026-11-10','2026-11-21']),chart);
 assert.equal(salesSelectionWindow({...chart,points:[]},['2026-11-21','2026-11-23']).from,chart.from);
});

test('choosing one product filters shipment dates and product lines, preserving source data',()=>{
 const chart={from:'2026-11-21',to:'2026-11-23'};
 const postings=[
  {number:'mixed',created_at:'2026-11-22T12:00:00Z',status:'delivered',products:[
   {sku:'100',offer_id:'A',quantity:2},
   {sku:200,offer_id:'B',quantity:5}
  ]},
  {number:'other',created_at:'2026-11-22T15:00:00Z',status:'cancelled',products:[{sku:'200',offer_id:'B',quantity:3}]},
  {number:'outside',created_at:'2026-11-24T15:00:00Z',products:[{sku:'100',quantity:7}]},
  {number:'matching',created_at:'2026-11-23T10:00:00Z',products:[{sku:100,quantity:1}]}
 ];
 const result=postingsForSalesSelection(postings,chart,'100');
 assert.deepEqual(result.map(p=>p.number),['mixed','matching']);
 assert.deepEqual(result.map(p=>p.products.reduce((sum,item)=>sum+item.quantity,0)),[2,1]);
 assert.equal(result[0].status,'delivered');
 assert.equal(postings[0].products.length,2,'Must not mutate multi-product shipment');
 assert.deepEqual(postingsForSalesSelection(postings,chart,'all').map(p=>p.number),['mixed','other','matching']);
 assert.deepEqual(postingsForSalesSelection(postings,chart,'999'),[]);
});

test('SKU match has priority; missing SKU may use a verified inventory offer ID',()=>{
 const chart={from:'2026-11-22',to:'2026-11-23'};
 const productCatalog=[{sku:'100',offer_id:'OZ-100'}];
 const postings=[
  {number:'legacy',created_at:'2026-11-22T12:00:00Z',products:[
   {sku:null,offer_id:'OZ-100',quantity:2},
   {sku:'200',offer_id:'OZ-100',quantity:5}
  ]},
  {number:'unknown',created_at:'2026-11-22T12:00:00Z',products:[{sku:null,offer_id:'UNKNOWN',quantity:1}]}
 ];
 const rows=postingsForSalesSelection(postings,chart,'100',productCatalog);
 assert.deepEqual(rows.map(p=>p.number),['legacy']);
 assert.deepEqual(rows[0].products,[{sku:null,offer_id:'OZ-100',quantity:2}]);
 assert.deepEqual(postingsForSalesSelection(postings,chart,'100',[]),[]);
});

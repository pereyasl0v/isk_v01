import test from 'node:test';
import assert from 'node:assert/strict';
import {postingStatusGroup,shipmentStatusSummary} from './shipment-status-summary.mjs';
import {postingsInChartWindow,salesChartWindow} from './sales-chart-range.mjs';

test('group Ozon delivery, received and cancelled statuses without counting pending as delivered',()=>{
 assert.equal(postingStatusGroup({status:'delivering',substatus:'posting_on_way_to_city'}),'delivering');
 assert.equal(postingStatusGroup({status:'delivered',substatus:'posting_received'}),'delivered');
 assert.equal(postingStatusGroup({status:'cancelled'}),'cancelled');
 assert.equal(postingStatusGroup({status:'canceled'}),'cancelled');
 assert.equal(postingStatusGroup({status:'awaiting_packaging',substatus:'posting_created'}),'other');
 assert.equal(postingStatusGroup({status:'awaiting_deliver'}),'other');
 assert.equal(postingStatusGroup({substatus:'posting_received'}),'delivered');
 assert.equal(postingStatusGroup({substatus:'posting_on_way_to_city'}),'delivering');
 assert.equal(postingStatusGroup({status:'unknown'}),'other');
});

test('mini chart counts statuses and expanded diagram accounts for every posting',()=>{
 const summary=shipmentStatusSummary([
  {status:'delivering'},{status:'delivering'},
  {status:'delivered'},{status:'cancelled'},
  {status:'awaiting_packaging'},{status:'awaiting_deliver'}
 ]);
 assert.equal(summary.total,6);
 assert.deepEqual(summary.preview.map(({key,count})=>[key,count]),[
  ['delivering',2],['delivered',1],['cancelled',1]
 ]);
 assert.equal(summary.items[3].count,2);
 assert.ok(Math.abs(summary.items.reduce((sum,item)=>sum+item.percentage,0)-100)<1e-8);
 assert.match(summary.gradient,/conic-gradient/);
 const empty=shipmentStatusSummary([]);
 assert.equal(empty.total,0);
 assert.ok(empty.items.every(item=>item.percentage===0));
 assert.equal(empty.gradient,'#e7ece9');
});

test('status summary reflects the same selected Moscow days as the orders chart',()=>{
 const now=new Date('2026-11-24T18:00:00Z');
 const postings=[
  {status:'delivered',created_at:'2026-11-15T12:00:00Z'},
  {status:'delivering',created_at:'2026-11-20T12:00:00Z'},
  {status:'cancelled',created_at:'2026-11-24T12:00:00Z'},
  {status:'awaiting_packaging',created_at:'2026-11-24T12:00:00Z'}
 ];
 const week=shipmentStatusSummary(postingsInChartWindow(postings,salesChartWindow([],7,now)));
 const fortnight=shipmentStatusSummary(postingsInChartWindow(postings,salesChartWindow([],14,now)));
 assert.deepEqual(week.items.map(x=>x.count),[1,0,1,1]);
 assert.deepEqual(fortnight.items.map(x=>x.count),[1,1,1,1]);
});


test('shipment count and item quantities are distinct, including cancelled items',()=>{
 const summary=shipmentStatusSummary([
  {status:'delivered',products:[{sku:'1',quantity:2}]},
  {status:'cancelled',products:[{sku:'2',quantity:1}]}
 ]);
 assert.equal(summary.total,2);
 assert.equal(summary.units,3);
 assert.equal(summary.cancelledPostings,1);
 assert.equal(summary.cancelledUnits,1);
 assert.equal(summary.items.find(item=>item.key==='delivered').count,1);
 const empty=shipmentStatusSummary([]);
 assert.equal(empty.units,0);
 assert.equal(empty.cancelledUnits,0);
});

test('selected-SKU shipments count only matched units, not the entire bundle',()=>{
 const summary=shipmentStatusSummary([
  {status:'cancelled',products:[{sku:'100',quantity:1}]},
  {status:'delivered',products:[{sku:'100',quantity:2}]}
 ]);
 assert.deepEqual({postings:summary.total,units:summary.units,cancelled:summary.cancelledUnits},
  {postings:2,units:3,cancelled:1});
});

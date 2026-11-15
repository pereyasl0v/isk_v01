import test from 'node:test';
import assert from 'node:assert/strict';
import {getDigitizationPeriod} from './digitization-period.mjs';

test('7-day range ends yesterday and includes exactly seven calendar days',()=>{
 assert.deepEqual(getDigitizationPeriod(7,new Date(2026,10,15,12)),{
  from:'2026-11-08',to:'2026-11-14'
 });
});

test('14-day range ends yesterday and includes exactly fourteen calendar days',()=>{
 assert.deepEqual(getDigitizationPeriod(14,new Date(2026,10,15,12)),{
  from:'2026-11-01',to:'2026-11-14'
 });
});

test('30-day range ends yesterday and includes exactly thirty calendar days',()=>{
 assert.deepEqual(getDigitizationPeriod(30,new Date(2026,10,15,12)),{
  from:'2026-10-16',to:'2026-11-14'
 });
});

test('range crosses a year boundary correctly',()=>{
 assert.deepEqual(getDigitizationPeriod(7,new Date(2026,0,3,12)),{
  from:'2025-12-27',to:'2026-01-02'
 });
});

test('range handles leap day correctly',()=>{
 assert.deepEqual(getDigitizationPeriod(30,new Date(2024,2,1,12)),{
  from:'2024-01-31',to:'2024-02-29'
 });
});

test('rejects non-positive or fractional day counts',()=>{
 assert.throws(()=>getDigitizationPeriod(0),RangeError);
 assert.throws(()=>getDigitizationPeriod(1.5),RangeError);
});

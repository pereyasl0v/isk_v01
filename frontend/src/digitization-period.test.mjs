import test from 'node:test';
import assert from 'node:assert/strict';
import {getDigitizationPeriod, shouldAutoLoadDigitization} from './digitization-period.mjs';

test('7-day range ends yesterday in Moscow time',()=>{
 assert.deepEqual(getDigitizationPeriod(7,new Date('2026-11-15T09:00:00Z')),{
  from:'2026-11-08',to:'2026-11-14'
 });
});

test('14-day range ends yesterday in Moscow time',()=>{
 assert.deepEqual(getDigitizationPeriod(14,new Date('2026-11-15T09:00:00Z')),{
  from:'2026-11-01',to:'2026-11-14'
 });
});

test('30-day range ends yesterday in Moscow time',()=>{
 assert.deepEqual(getDigitizationPeriod(30,new Date('2026-11-15T09:00:00Z')),{
  from:'2026-10-16',to:'2026-11-14'
 });
});

test('uses Moscow date even before midnight in the browser timezone',()=>{
 // 22:30 UTC is already 01:30 the next day in Moscow.
 assert.deepEqual(getDigitizationPeriod(7,new Date('2026-11-14T22:30:00Z')),{
  from:'2026-11-08',to:'2026-11-14'
 });
});

test('range crosses a year boundary correctly',()=>{
 assert.deepEqual(getDigitizationPeriod(7,new Date('2026-01-03T09:00:00Z')),{
  from:'2025-12-27',to:'2026-01-02'
 });
});

test('range handles leap day correctly',()=>{
 assert.deepEqual(getDigitizationPeriod(30,new Date('2024-03-01T09:00:00Z')),{
  from:'2024-01-31',to:'2024-02-29'
 });
});

test('rejects non-positive or fractional day counts',()=>{
 assert.throws(()=>getDigitizationPeriod(0),RangeError);
 assert.throws(()=>getDigitizationPeriod(1.5),RangeError);
});

test('auto loading skips fully cached periods and unknown coverage',()=>{
 const now=new Date('2026-11-24T16:14:00Z'); // 19:14 Moscow
 assert.equal(shouldAutoLoadDigitization({missing_days:[]},now),false);
 assert.equal(shouldAutoLoadDigitization({},now),false);
 assert.equal(shouldAutoLoadDigitization(null,now),false);
});

test('auto loading fetches only when a missing day is eligible',()=>{
 const before=new Date('2026-11-24T04:59:00Z'); // 07:59 Moscow
 const after=new Date('2026-11-24T05:00:00Z'); // 08:00 Moscow
 assert.equal(shouldAutoLoadDigitization({missing_days:['2026-11-23']},before),false);
 assert.equal(shouldAutoLoadDigitization({missing_days:['2026-11-23']},after),true);
 assert.equal(shouldAutoLoadDigitization({missing_days:['2026-11-22','2026-11-23']},before),true);
 assert.equal(shouldAutoLoadDigitization({missing_days:['2026-11-24']},after),false);
});

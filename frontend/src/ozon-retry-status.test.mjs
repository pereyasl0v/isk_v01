import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ozonRetryRemainingSeconds,
  formatOzonRetryDuration,
  isOzonRetryWaiting
} from './ozon-retry-status.mjs';

test('show 26 min 2 sec instead of an alarming raw Ozon error',()=>{
  assert.equal(formatOzonRetryDuration(1562), '26 мин 2 сек');
  assert.equal(formatOzonRetryDuration(60), '1 мин 0 сек');
  assert.equal(formatOzonRetryDuration(59), '59 сек');
  assert.equal(formatOzonRetryDuration(0), '0 сек');
});

test('countdown follows server deadline and is resilient to invalid dates',()=>{
  const start=Date.parse('2026-11-25T12:00:00.000Z');
  const retryAt='2026-11-25T12:26:02.000Z';
  assert.equal(ozonRetryRemainingSeconds(retryAt,start),1562);
  assert.equal(ozonRetryRemainingSeconds(retryAt,start+1000),1561);
  assert.equal(ozonRetryRemainingSeconds(retryAt,start+1562*1000),0);
  assert.equal(ozonRetryRemainingSeconds(retryAt,start+2000*1000),0);
  assert.equal(ozonRetryRemainingSeconds('not a date',start),0);
  assert.equal(ozonRetryRemainingSeconds(null,start),0);
});

test('friendly countdown only appears for actively paused digitization',()=>{
  const retry_at='2026-11-25T12:01:00Z';
  assert.equal(isOzonRetryWaiting({kind:'digitization',running:true,retry_at}),true);
  assert.equal(isOzonRetryWaiting({kind:'digitization',running:false,retry_at}),false);
  assert.equal(isOzonRetryWaiting({kind:'digitization',running:true,retry_at:null}),false);
  assert.equal(isOzonRetryWaiting({kind:'sales',running:true,retry_at}),false);
  assert.equal(isOzonRetryWaiting(null),false);
});

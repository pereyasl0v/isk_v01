import test from 'node:test';
import assert from 'node:assert/strict';
import {statePollDelay,keepUnchangedState} from './state-polling.mjs';

test('active jobs are polled promptly, idle and background tabs conservatively',()=>{
 assert.equal(statePollDelay(true,true),2_000);
 assert.equal(statePollDelay(false,true),30_000);
 assert.equal(statePollDelay(true,false),60_000);
 assert.equal(statePollDelay(false,false),60_000);
});

test('identical polling responses preserve React state identity',()=>{
 const previous={account_id:'a',job:{running:false,message:'Готово'},digitization_days:{updated_at:'2026-11-24'}};
 const equal=JSON.parse(JSON.stringify(previous));
 assert.equal(keepUnchangedState(previous,equal),previous);
 const changed={...equal,job:{...equal.job,running:true}};
 assert.equal(keepUnchangedState(previous,changed),changed);
 assert.deepEqual(keepUnchangedState(null,changed),changed);
});

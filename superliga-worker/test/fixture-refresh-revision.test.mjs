import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/durable/update-coordinator.js',import.meta.url),'utf8');
const start=source.indexOf('  async runFixtures('),end=source.indexOf('  async runFlashscoreFixtures(');

async function run(result){
  const Coordinator=vm.runInNewContext('class Coordinator {\n'+source.slice(start,end)+'\n}; Coordinator',{
    refreshFixtures:async()=>result,FIXTURE_REFRESH_REVISION:'b55-lpf-november-dst'
  });
  const writes=[],scheduler={fixtureRefreshRevision:'old'};
  const instance=new Coordinator();
  instance.env={};instance.ctx={storage:{put:async(key,value)=>writes.push({key,value})}};
  instance.readSchedulerState=async()=>scheduler;
  instance.writeSchedulerState=async value=>Object.assign(scheduler,value);
  instance.updateState=async()=>{};
  await instance.runFixtures();
  return {writes,scheduler};
}

test('a failed fixture refresh retains the last known cache and is retried after deployment',async()=>{
  const {writes,scheduler}=await run({ok:false,written:false,warnings:['source unavailable']});
  assert.equal(writes.length,0);
  assert.equal(scheduler.fixtureRefreshRevision,'old');
  assert.ok(scheduler.lastFixtureRefreshAttemptAt);
});

test('only a complete persisted LPF refresh completes the deployed repair revision',async()=>{
  const result={ok:true,written:true,fixtures:[{id:'m1'}],sourceCount:240,count:240,warnings:[]};
  const {writes,scheduler}=await run(result);
  assert.equal(writes[0].key,'fixtures-cache');
  assert.equal(scheduler.fixtureRefreshRevision,'b55-lpf-november-dst');
  assert.ok(scheduler.lastFixtureRefreshSuccessAt);
  assert.equal((await run({...result,warnings:['incomplete fixture coverage']})).scheduler.fixtureRefreshRevision,'old');
});

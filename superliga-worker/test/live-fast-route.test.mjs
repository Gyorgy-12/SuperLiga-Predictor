import test from 'node:test';
import assert from 'node:assert/strict';
import { liveResultsRoute } from '../src/routes/live-results.route.js';
import { getMemory } from '../src/services/memory-cache.service.js';

test('live-only fast requests never wait for Firestore or a provider refresh',async()=>{
  const paths=[],updatedAt=new Date().toISOString();
  const fixture={id:'live1',date:updatedAt.slice(0,10),kickoffAt:new Date(Date.now()-30*60000).toISOString()};
  const row={id:'live1',started:true,finished:false,h:2,a:1,minute:'30'};
  const env={UPDATE_COORDINATOR:{getByName:()=>({fetch:async url=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/live-results-cache')return Response.json({results:{live1:row},activeIds:['live1'],updatedAt});
    if(path==='/fixtures-cache')return Response.json({fixtures:[fixture]});
    if(path==='/ensure-alarm')return Response.json({ok:true});
    throw new Error('Unexpected request '+path);
  }})}};
  const pending=[];
  const response=await liveResultsRoute(new Request('https://app.test/live-results?fast=1&liveOnly=1'),env,{waitUntil:p=>pending.push(p)});
  const payload=await response.json();
  assert.equal(payload.results.live1.h,2);
  assert.equal(payload.fixtures,undefined);
  assert.deepEqual(paths.sort(),['/ensure-alarm','/fixtures-cache','/live-results-cache']);
  await Promise.all(pending);
});

test('a filtered no-sync read still returns the requested stored final',async()=>{
  const memory=getMemory();
  memory.finalResults={final1:{id:'final1',finished:true,h:1,a:0},final2:{id:'final2',finished:true,h:0,a:0}};
  memory.finalResultsHydrated=true;
  try{
    const response=await liveResultsRoute(new Request('https://app.test/live-results?nosync=1&ids=final1'),{},{});
    const payload=await response.json();
    assert.deepEqual(Object.keys(payload.results),['final1']);
    assert.equal(payload.results.final1.h,1);
  }finally{
    memory.finalResults={};memory.finalResultsHydrated=false;
  }
});

test('targeted historical refresh runs in the coordinator and returns only the requested match',async()=>{
  const row={id:'final1',finished:true,h:1,a:0};
  let call;
  const env={UPDATE_COORDINATOR:{getByName:()=>({fetch:async url=>{
    call=new URL(url);
    return Response.json({ok:true,active:[{id:'final1',date:'2026-07-20',t:'21:00'}],results:{final1:row}});
  }})}};
  const response=await liveResultsRoute(new Request('https://app.test/live-results?force=1&fresh=1&ids=final1'),env,{});
  const payload=await response.json();
  assert.equal(call.pathname,'/run');
  assert.equal(call.searchParams.get('task'),'repair-events');
  assert.equal(call.searchParams.get('ids'),'final1');
  assert.equal(call.searchParams.has('force'),false,'historical repair must respect the coordinator lock');
  assert.deepEqual(Object.keys(payload.results),['final1']);
  assert.deepEqual(Object.keys(payload.sync.results),['final1']);
});

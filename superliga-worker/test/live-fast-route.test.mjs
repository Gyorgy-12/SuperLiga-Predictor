import test from 'node:test';
import assert from 'node:assert/strict';
import { liveResultsRoute } from '../src/routes/live-results.route.js';

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
  assert.equal(payload.fixtures[0].id,'live1');
  assert.deepEqual(paths.sort(),['/ensure-alarm','/fixtures-cache','/live-results-cache']);
  await Promise.all(pending);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const liveSource=readFileSync(new URL('../src/services/live-results.js',import.meta.url),'utf8');
const modalSource=readFileSync(new URL('../src/views/match-modal.view.js',import.meta.url),'utf8');
const cardSource=readFileSync(new URL('../src/core/card-events.js',import.meta.url),'utf8');

test('a live score is applied while bootstrap and archive requests are still pending',async()=>{
  let releaseBootstrap,releaseArchive,liveApplied=false;
  const bootstrap=new Promise(resolve=>{releaseBootstrap=resolve});
  const archive=new Promise(resolve=>{releaseArchive=resolve});
  const context={
    FROZEN_MODE:false,superligaSyncInFlight:null,superligaBootstrapDone:false,superligaBootstrapFailed:false,
    SUPERLIGA_RESULTS_READ_URL:'results',SUPERLIGA_RESULTS_SYNC_URL:'live',
    superligaInterestingMatches:()=>[],loadBootstrapLight:()=>bootstrap,loadMatchResultsFromBackendDb:()=>archive,
    loadLiveSnapshotFromWorker:async()=>{liveApplied=true;return true},loadLiveResultsFromWorker:async()=>true,
    superligaRepairMissingScorers:async()=>false
  };
  vm.createContext(context);
  vm.runInContext(liveSource.slice(liveSource.indexOf('async function syncLiveResults('),liveSource.indexOf('let superligaTabLiveRefreshQueued')),context);
  const pending=context.syncLiveResults({force:true});
  await Promise.resolve();
  assert.equal(liveApplied,true);
  releaseBootstrap(false);releaseArchive(false);
  assert.equal(await pending,true);
});

test('a quick live snapshot cannot overwrite the authoritative fixture schedule',async()=>{
  let scheduleWrites=0,liveWrites=0;
  const context={FROZEN_MODE:false,SUPERLIGA_RESULTS_SYNC_URL:'live',window:{},
    addParams:url=>url,fetchWorkerJson:async()=>({fixtures:[{id:'m1',t:'21:00'}],results:{m1:{h:1,a:0}}}),
    applyFixtureList:()=>{scheduleWrites++},mergeLiveResults:()=>{liveWrites++;return true}
  };
  vm.createContext(context);
  vm.runInContext(liveSource.slice(liveSource.indexOf('let superligaLiveSnapshotInFlight'),liveSource.indexOf('async function loadLiveResultsFromWorker')),context);
  assert.equal(await context.loadLiveSnapshotFromWorker(),true);
  assert.equal(liveWrites,1);
  assert.equal(scheduleWrites,0);
});

test('the match timeline puts the second caution before the dismissal at the same minute',()=>{
  const context={esc:String};
  vm.createContext(context);
  vm.runInContext(cardSource+'\n'+modalSource.slice(0,modalSource.indexOf('function superligaFrozenMetric')),context);
  const result={
    yellowCards:[{team:'a',minute:'58',player:'N. Kukovec'},{team:'a',minute:'77',player:'N. Kukovec'}],
    redCards:[{team:'a',minute:'77',player:'N. Kukovec'}]
  };
  const html=context.goalScorersHtml(result,{});
  const rows=html.split('<div class="goal-scorer-row').slice(1);
  assert.equal(rows.length,3);
  assert.match(rows[1],/yellow-card-mark/);
  assert.match(rows[2],/yellow-red-card-mark/);
  assert.ok(rows[1].includes('77&#39;')&&rows[2].includes('77&#39;'));
});

test('two visible cautions and a second-yellow dismissal incur one fair-play dismissal penalty',()=>{
  const source=readFileSync(new URL('../src/core/standings-engine.js',import.meta.url),'utf8');
  const context={ALL:['Home','Away'],FX:[{id:'m1',h:'Home',a:'Away'}],LIVE_RESULTS:{m1:{finished:true,
    yellowCards:[{team:'a',player:'A. Player',minute:'30'},{team:'a',player:'A. Player',minute:'70'}],
    redCards:[{team:'a',player:'A. Player',minute:'70',yellowRed:true}]
  }}};
  vm.createContext(context);
  vm.runInContext(source.slice(0,source.indexOf('function cmpTeam(')),context);
  const stats=context.calcFairPlay().Away;
  assert.equal(stats.yellow,2);
  assert.equal(stats.yellowRed,1);
  assert.equal(stats.red,0);
  assert.equal(stats.score,-3);
});

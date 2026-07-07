// Live-result normalization and economical sync scheduling.
// No DOM micro-patching here: data changes flow through one render path.

const FX_BY_ID=Object.fromEntries(FX.map(m=>[m.id,m]));
let superligaSyncTimer=null;
let superligaSyncInFlight=false;
let LIVE_RESULTS=FROZEN_MODE&&window.__SUPERLIGA_LIVE_RESULTS__?window.__SUPERLIGA_LIVE_RESULTS__:superligaSafeJson(sessionStorage.getItem(SUPERLIGA_CACHE_KEYS.liveSnapshot),{});
let SUPERLIGA_ODDS={};

function saveLiveResults(){try{sessionStorage.setItem(SUPERLIGA_CACHE_KEYS.liveSnapshot,JSON.stringify(LIVE_RESULTS))}catch(e){}}
function fixtureKickoff(m){return new Date(m.date+'T'+m.t+':00+03:00').getTime()}
function localMatchTime(m,tz){try{return new Date(fixtureKickoff(m)).toLocaleTimeString('hu-HU',{hour:'2-digit',minute:'2-digit',timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone})}catch(e){return m.t}}
function localMatchDate(m,tz){try{return new Date(fixtureKickoff(m)).toLocaleDateString('hu-HU',{month:'short',day:'numeric',timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone}).replace(/\u00a0/g,' ')}catch(e){return m.d}}
function matchSortKey(m){return (m.date||'9999-99-99')+'T'+(m.t||'99:99')+'|'+String(m.r||'').padStart(2,'0')+'|'+(m.g||'')+'|'+(m.id||'')}
function sortMatchesChronological(rows){return rows.slice().sort((a,b)=>matchSortKey(a).localeCompare(matchSortKey(b)))}
function matchLockState(m){let r=LIVE_RESULTS[m.id];if(r&&r.finished)return'finished';if(r&&r.started)return'live';return Date.now()>=fixtureKickoff(m)?'live':'open'}
function actualFor(m){return LIVE_RESULTS[m.id]||null}
function fmtPts(n){let x=Math.round((+n||0)*100)/100;return(Math.round(x*100)%50===0)?x.toFixed(1):x.toFixed(2)}
function tipScore(m){let p=getPred(m.id),r=actualFor(m);if(!p||!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return{cat:'',pts:0};let ph=+p.h,pa=+p.a,rh=+r.h,ra=+r.a;if(ph===rh&&pa===ra)return{cat:'exact',pts:1};let pdiff=ph-pa,rdiff=rh-ra;if(pdiff===rdiff)return{cat:'diff',pts:0.5};let pout=Math.sign(ph-pa),rout=Math.sign(rh-ra);if(pout===rout)return{cat:'outcome',pts:0.25};return{cat:'miss',pts:0}}
function gradeKoTip(p,r){if(!p||!r||!validScore(p.h)||!validScore(p.a)||!validScore(r.h)||!validScore(r.a))return{cat:'miss',pts:0,label:'Nincs tipp'};let ph=+p.h,pa=+p.a,rh=+r.h,ra=+r.a,pdiff=ph-pa,rdiff=rh-ra;if(ph===rh&&pa===ra)return{cat:'exact',pts:1,label:'Pontos'};if(pdiff===rdiff)return{cat:'diff',pts:0.5,label:'Gólkülönbség'};let pout=Math.sign(ph-pa),rout=Math.sign(rh-ra);if(pout===rout)return{cat:'outcome',pts:0.25,label:'Kimenetel'};return{cat:'miss',pts:0,label:'Téves'}}
function pctBar(val,total,clr){let p=total?+((val/total)*100).toFixed(2):0;return '<div class="stat-bar-row"><div class="stat-bar-track"><div class="stat-bar-fill" style="width:'+p+'%;background:'+clr+'"></div></div><span class="stat-bar-val">'+p+'%</span></div>'}

function parseMaybeArray(v){try{return typeof v==='string'?JSON.parse(v):(Array.isArray(v)?v:[])}catch(e){return[]}}
function normalizeLiveResult(id,d){
  if(!d)return null;
  let h=d.h??d.home??d.homeScore??d.home_score??d.scoreHome,a=d.a??d.away??d.awayScore??d.away_score??d.scoreAway;
  if(!validScore(h)||!validScore(a))return null;
  let pH=d.pH??d.penH??d.penaltyHome??d.pen_h??d.homePen??null,pA=d.pA??d.penA??d.penaltyAway??d.pen_a??d.awayPen??null;
  let rawStatus=d.status||d.matchStatus||'',status=String(rawStatus).toLowerCase();
  let finished=!!d.finished||status==='ft'||status==='finished'||status.includes('full')||status.includes('vége');
  let started=d.started!==false||finished||status==='live'||status.includes('élő')||status.includes('in_play')||status.includes('in play');
  let scorers=parseMaybeArray(d.scorers);
  let rawCards=[...parseMaybeArray(d.redCards),...parseMaybeArray(d.reds),...parseMaybeArray(d.cards),...parseMaybeArray(d.bookings),...parseMaybeArray(d.events),...parseMaybeArray(d.yellowCards)];
  let rawCardsNorm=rawCards.map(c=>({...c,team:(c.team==='a'||c.team==='away'||c.side==='away'||c.teamSide==='away')?'a':'h',player:c.player||c.playerName||c.name||c.person||''}));
  let redCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||c.name||'').toLowerCase();return c.red||c.yellowRed||c.isRed||c.redCard||t==='rc'||t.includes('red')||t.includes('second yellow')||t.includes('second_yellow')}).map(c=>{let t=String(c.type||c.card||c.eventType||'').toLowerCase();let yr=c.yellowRed||c.secondYellow||t.includes('second yellow')||t.includes('yellow-red')||t.includes('second_yellow');return yr?{...c,yellowRed:true,red:true}:{...c,red:true}});
  let yellowCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||'').toLowerCase();return c.yellow||t==='yc'||t==='yellow'||(t.includes('yellow')&&!t.includes('red')&&!t.includes('second'))});
  let odds=null;try{odds=typeof d.odds==='string'?JSON.parse(d.odds):(d.odds&&typeof d.odds==='object'?d.odds:null)}catch(e){odds=null}
  return{started:!!started,finished:!!finished,h:+h,a:+a,pH:validScore(pH)?+pH:null,pA:validScore(pA)?+pA:null,minute:d.minute??d.matchMinute??d.elapsed??d.currentMinute??d.liveMinute??d.matchTime??d.time??d.statusMinute??null,status:rawStatus,scorers,redCards,yellowCards,odds,source:d.source||'SuperLiga backend',updatedAt:d.updatedAt||d.updated||new Date().toISOString()};
}
function liveResultFingerprint(r){return JSON.stringify({s:r.started,f:r.finished,h:r.h,a:r.a,pH:r.pH,pA:r.pA,m:r.minute,st:r.status,sc:r.scorers,rc:r.redCards,yc:r.yellowCards,od:r.odds})}
function mergeLiveResults(next){
  let changed=false,pruneNeeded=false;
  Object.entries(next||{}).forEach(([id,obj])=>{
    let r=normalizeLiveResult(id,obj);if(!r)return;
    let old=LIVE_RESULTS[id];if(old&&old.finished&&!r.finished)return;
    if(!old||liveResultFingerprint(old)!==liveResultFingerprint(r)){
      LIVE_RESULTS[id]=r;changed=true;
      if(r.finished&&(!old||!old.finished||old.h!==r.h||old.a!==r.a))pruneNeeded=true;
    }
  });
  if(changed){
    saveLiveResults();
    if(pruneNeeded)pruneStaleKoPred(true);
    if(['overview','matches','table','stats','community','knockout','baraj'].includes(S.tab))superligaRequestRender('live-results');
    if(typeof refreshCommunityPreviews==='function')refreshCommunityPreviews();
  }
  return changed;
}
function superligaInterestingMatches(now=Date.now()){
  return FX.filter(m=>{let ko=fixtureKickoff(m),r=LIVE_RESULTS[m.id];if(r&&r.finished)return false;return now>=ko-SUPERLIGA_SYNC_BEFORE_MS&&now<=ko+SUPERLIGA_SYNC_AFTER_MS});
}
function superligaNextInterestingDelay(now=Date.now()){
  let active=superligaInterestingMatches(now);if(active.length)return SUPERLIGA_SYNC_LIVE_MS;
  let next=FX.map(fixtureKickoff).filter(t=>t>now).sort((a,b)=>a-b)[0];
  if(!next)return SUPERLIGA_SYNC_IDLE_MS;
  return Math.max(60*1000,Math.min(SUPERLIGA_SYNC_IDLE_MS,next-now-SUPERLIGA_SYNC_BEFORE_MS));
}
function superligaWorkerBase(){try{let b=String(SUPERLIGA_WORKER_URL||'').replace(/\/$/,'');if(b)return b;return String(SUPERLIGA_RESULTS_READ_URL||'').replace(/\/results(?:\?.*)?$/,'')}catch(e){return''}}
function addParams(url,params){let u=new URL(url,location.href);Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,v)});return u.toString()}
let superligaBootstrapDone=false,superligaBootstrapFailed=false,superligaBootstrapInFlight=null;
function applyOddsMap(odds){
  if(!odds||typeof odds!=='object')return false;
  let changed=false;
  Object.entries(odds).forEach(([id,o])=>{
    if(!id||!o||typeof o!=='object')return;
    let next={h:o.h??o.home??o.homeOdd,d:o.d??o.draw??o.drawOdd,a:o.a??o.away??o.awayOdd,provider:o.provider||o.source||'odds'};
    if(!validOdds(next.h)||!validOdds(next.d)||!validOdds(next.a))return;
    if(JSON.stringify(SUPERLIGA_ODDS[id]||null)!==JSON.stringify(next)){SUPERLIGA_ODDS[id]=next;changed=true;}
  });
  if(changed&&['matches','overview','table','knockout'].includes(S.tab))try{superligaRequestRender('odds')}catch(e){}
  return changed;
}
function applyTeamRatingsPayload(payload){
  if(!payload||typeof payload!=='object')return false;
  let ratings=payload.ratings||payload.elo||payload.teamElo||null;
  let markets=payload.marketValues||payload.market||payload.tm||payload.teamMarket||null;
  let changed=false;
  if(ratings&&typeof ratings==='object')Object.entries(ratings).forEach(([name,val])=>{if(typeof val==='number'&&isFinite(val)&&TEAM_ELO[name]!==val){TEAM_ELO[name]=val;changed=true}});
  if(markets&&typeof markets==='object')Object.entries(markets).forEach(([name,val])=>{if(typeof val==='number'&&isFinite(val)&&TEAM_MARKET[name]!==val){TEAM_MARKET[name]=val;changed=true}});
  if(changed&&['matches','table','overview','knockout'].includes(S.tab))try{superligaRequestRender('ratings')}catch(e){}
  return changed;
}
async function loadFirebasePublicCacheDoc(docId){
  if(!SUPERLIGA_FIREBASE_RESULTS_FALLBACK||!superligaFirebaseConfigured()||!SUPERLIGA_COLLECTIONS.publicCache)return null;
  try{
    if(!superligaDb){let ok=await loadSuperligaFirebase();if(!ok||!superligaDb)return null;}
    let doc=await superligaDb.collection(SUPERLIGA_COLLECTIONS.publicCache).doc(docId).get();
    return doc.exists?(doc.data()||null):null;
  }catch(e){return null}
}
function applyFixtureList(list){
  if(!Array.isArray(list)||!list.length)return false;
  let byId={};list.forEach(f=>{if(f&&f.id)byId[f.id]=f});
  let changed=false;
  FX.forEach(x=>{let ov=byId[x.id];if(!ov)return;let date=ov.date||ov.d,time=ov.t||ov.time;if(!date||!time)return;let yr=+String(date).slice(0,4),delta=Math.abs(Date.parse(date)-Date.parse(x.date))/86400000;if(yr!==2026||delta>14)return;if(date!==x.date||time!==x.t){x.date=date;x.t=time;x.day=+(String(date).replace(/-/g,'')+String(time).replace(':',''));changed=true}});
  if(changed){FX.sort((a,b)=>a.day-b.day||a.g.localeCompare(b.g)||a.r-b.r);try{superligaRequestRender('fixtures')}catch(e){}}
  return changed;
}
async function loadBootstrapLight(opts={}){
  if(FROZEN_MODE||superligaBootstrapDone)return false;
  if(superligaBootstrapInFlight)return superligaBootstrapInFlight;
  let url=SUPERLIGA_BOOTSTRAP_LIGHT_URL||'';
  if(!url){let b=superligaWorkerBase();if(b)url=b+'/bootstrap-light'}
  if(!url||superligaBootstrapFailed&&!opts.retry)return false;
  superligaBootstrapInFlight=(async()=>{
    try{
      let data=null,usedPrefetch=false;
      try{if(!opts.retry&&window.__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH__&&typeof window.__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH__.then==='function'){data=await window.__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH__;usedPrefetch=!!(data&&data.ok!==false)}}catch(e){data=null}
      if(!data){let r=await fetch(addParams(url,{v:'superliga-bootstrap'}),{headers:{Accept:'application/json'},credentials:'omit',cache:'no-store'});if(!r.ok)throw new Error('bootstrap-light HTTP '+r.status);data=await r.json().catch(()=>null)}
      if(!data||data.ok===false)throw new Error((data&&data.error)||'bootstrap-light invalid payload');
      let changed=false;
      if(data.fixtures)changed=applyFixtureList(data.fixtures)||changed;
      if(data.results)changed=mergeLiveResults(data.results)||changed;
      if(data.live)changed=mergeLiveResults(data.live)||changed;
      if(data.odds)changed=applyOddsMap(data.odds)||changed;
      if(data.ratings||data.marketValues||data.elo)changed=applyTeamRatingsPayload(data)||changed;
      superligaBootstrapDone=true;superligaBootstrapFailed=false;
      try{window.SUPERLIGA_BOOTSTRAP_DEBUG={ok:true,tookMs:data.tookMs||null,resultsCount:data.resultsCount||Object.keys(data.results||{}).length,liveCount:data.liveCount||Object.keys(data.live||{}).length,fixturesCount:data.fixturesCount||(data.fixtures||[]).length,usedPrefetch,changed,at:new Date().toISOString(),prefetchMeta:window.__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH_META__||null}}catch(e){}
      return changed||true;
    }catch(e){superligaBootstrapFailed=true;try{window.SUPERLIGA_BOOTSTRAP_DEBUG={ok:false,error:e&&e.message?e.message:String(e),at:new Date().toISOString()}}catch(_e){}return false}
    finally{superligaBootstrapInFlight=null}
  })();
  return superligaBootstrapInFlight;
}
async function fetchWorkerJson(url){let r=await fetch(url,{cache:'no-store',credentials:'omit',headers:{Accept:'application/json'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json().catch(()=>null)}
async function loadMatchResultsFromBackendDb(){
  if(FROZEN_MODE)return false;
  if(!superligaBootstrapDone&&!superligaBootstrapFailed){let ok=await loadBootstrapLight({fallback:false});if(ok)return true}
  if(!SUPERLIGA_RESULTS_READ_URL){let cached=await loadFirebasePublicCacheDoc('results');return cached&&cached.results?mergeLiveResults(cached.results):false;}
  try{let data=await fetchWorkerJson(SUPERLIGA_RESULTS_READ_URL);let changed=data&&data.results?mergeLiveResults(data.results):false;if(data&&data.fixtures)changed=applyFixtureList(data.fixtures)||changed;return changed}catch(e){return false}
}
async function loadLiveResultsFromWorker(opts={}){
  if(!SUPERLIGA_RESULTS_SYNC_URL)return false;
  let changed=false;
  let forced=!!(opts.force||opts.forceLive);
  try{let fast=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_SYNC_URL,{fast:1,t:Date.now()}));if(fast&&fast.results)changed=mergeLiveResults(fast.results)||changed}catch(e){}
  let freshDelay=forced?120:420;
  setTimeout(async()=>{try{let fresh=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_SYNC_URL,{fresh:1,live:1,t:Date.now()}));if(fresh&&fresh.results)mergeLiveResults(fresh.results)}catch(e){}},freshDelay);
  return changed;
}
async function loadMatchResultsOnceFromSdk(ids){
  if(!superligaDb)return false;
  let wanted=Array.isArray(ids)&&ids.length?ids:superligaInterestingMatches().map(m=>m.id);
  if(!wanted.length)return false;
  try{
    let incoming={};
    await Promise.all(wanted.map(async id=>{let doc=await superligaDb.collection(SUPERLIGA_COLLECTIONS.results).doc(id).get();if(doc.exists){let data=doc.data(),r=normalizeLiveResult(id,data);if(r)incoming[id]=r}}));
    return mergeLiveResults(incoming);
  }catch(e){superligaBackendError=e.message||String(e);return false}
}
async function loadMatchResultsOnceFromFirestore(){return loadMatchResultsOnceFromSdk()}
async function syncLiveResults(opts={}){
  if(FROZEN_MODE||superligaSyncInFlight)return false;
  let forced=!!(opts.force||opts.forceLive),active=superligaInterestingMatches();
  if(!forced&&!active.length&&!SUPERLIGA_RESULTS_SYNC_URL&&!SUPERLIGA_RESULTS_READ_URL)return false;
  superligaSyncInFlight=true;
  try{
    if(!superligaBootstrapDone&&!superligaBootstrapFailed)await loadBootstrapLight({fallback:false});
    if(SUPERLIGA_RESULTS_SYNC_URL)return await loadLiveResultsFromWorker(opts);
    if(SUPERLIGA_RESULTS_READ_URL)return await loadMatchResultsFromBackendDb();
    if(SUPERLIGA_FIREBASE_RESULTS_FALLBACK&&superligaFirebaseConfigured()&&!superligaDb)await loadSuperligaFirebase();
    return await loadMatchResultsOnceFromSdk(active.map(m=>m.id));
  }finally{superligaSyncInFlight=false}
}
function nextLiveSyncDelay(){return document.hidden?Math.max(SUPERLIGA_SYNC_IDLE_MS,90*1000):superligaNextInterestingDelay()}
function scheduleLiveSync(delay){if(FROZEN_MODE)return;clearTimeout(superligaSyncTimer);superligaSyncTimer=setTimeout(async()=>{await syncLiveResults();scheduleLiveSync()},delay??nextLiveSyncDelay())}
function listenMatchResults(){return syncLiveResults({force:true})}
async function applyTeamElo(){if(FROZEN_MODE)return false;try{let data=null;if(SUPERLIGA_RESULTS_READ_URL){let base=SUPERLIGA_RESULTS_READ_URL.replace(/\/results$/,'');data=await fetch(base+'/team-ratings',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)||await fetch(base+'/elo',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);}else{data=await loadFirebasePublicCacheDoc('elo');}return applyTeamRatingsPayload(data)}catch(e){return false}}
async function applyFixtureOverrides(){if(FROZEN_MODE)return false;try{let data=null;if(SUPERLIGA_RESULTS_READ_URL){let url=SUPERLIGA_RESULTS_READ_URL.replace(/\/results$/,'/fixtures');data=await fetch(url,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);}else{data=await loadFirebasePublicCacheDoc('fixtures');}let list=data&&Array.isArray(data.fixtures)?data.fixtures:null;return applyFixtureList(list)}catch(e){return false}}

// Live-result normalization and economical sync scheduling.
// No DOM micro-patching here: data changes flow through one render path.

const FX_BY_ID=Object.fromEntries(FX.map(m=>[m.id,m]));
let superligaSyncTimer=null;
let superligaSyncInFlight=null;
let LIVE_RESULTS=FROZEN_MODE&&window.__SUPERLIGA_LIVE_RESULTS__?window.__SUPERLIGA_LIVE_RESULTS__:superligaSafeJson(sessionStorage.getItem(SUPERLIGA_CACHE_KEYS.liveSnapshot),{});

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
function superligaTeamKey(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&amp;/g,' and ').replace(/\b(afc|afk|fk|acs|acsc|as|csm|cs|fc|osk|sc|cf|clubul|fotbal|fotbalistic|sa)\b/g,' ').replace(/\b(1923|1948|2013|52)\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function superligaSameTeamName(a,b){let x=superligaTeamKey(a),y=superligaTeamKey(b);if(!x||!y)return false;if(x===y||x.includes(y)||y.includes(x))return true;let xa=new Set(x.split(' ')),ya=new Set(y.split(' ')),hit=0;xa.forEach(t=>{if(ya.has(t))hit++});return hit/Math.max(xa.size,ya.size)>=.6}
function resolveIncomingFixtureId(rawId,d){
  let direct=FX_BY_ID[String(rawId)]||null;
  let home=d&&(d.homeTeam||d.home?.name||d.homeName||d.hTeam||d.teamHome)||'',away=d&&(d.awayTeam||d.away?.name||d.awayName||d.aTeam||d.teamAway)||'';
  if(direct&&(!home||!away||(superligaSameTeamName(home,direct.h)&&superligaSameTeamName(away,direct.a))))return String(rawId);
  if(!home||!away)return String(rawId);
  let candidates=FX.filter(m=>superligaSameTeamName(home,m.h)&&superligaSameTeamName(away,m.a));
  if(!candidates.length)return String(rawId);
  let date=String(d.date||d.matchDate||d.kickoffAt||'').slice(0,10);
  if(date){let exact=candidates.find(m=>String(m.date||'').slice(0,10)===date);if(exact)return String(exact.id)}
  if(candidates.length===1)return String(candidates[0].id);
  return String(rawId);
}
function superligaEventMinute(v){return String(v??'').replace(/[’'′]+/g,'').trim()}
function superligaEventTeam(e){return(e&&(['a','away','2'].includes(String(e.team||'').toLowerCase())||String(e.side||'').toLowerCase()==='away'||String(e.teamSide||'').toLowerCase()==='away'||e.isHome===false))?'a':'h'}
function superligaEventPlayer(e){
  let vals=[e?.fullName,e?.displayName,e?.playerName,e?.player?.fullName,e?.player?.displayName,e?.player?.name,e?.person?.name,e?.player,e?.name,e?.person];
  let names=vals.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
  if(!names.length)return'';
  return names.sort((a,b)=>superligaPlayerNameScore(b)-superligaPlayerNameScore(a))[0];
}
function superligaPlayerNameScore(name){
  let s=String(name||'').trim(),parts=s.split(/\s+/).filter(Boolean),initials=(s.match(/\b\p{L}\./gu)||[]).length;
  return s.length+(parts.length>=2?20:0)-initials*12;
}
function superligaEventBlob(e){try{return JSON.stringify(e||{}).toLowerCase()}catch(_e){return''}}
function superligaEventOwnGoal(e){let b=superligaEventBlob(e),t=String(e?.type||e?.kind||e?.label||e?.detail||e?.reason||e?.note||e?.goalType||e?.code||'').toLowerCase();return!!(e?.og===true||e?.ownGoal===true||e?.isOwnGoal===true||/\bown[ _-]?goal\b|\bautogol\b|\böngól\b/.test(t+' '+b))}
function superligaEventPenalty(e){let b=superligaEventBlob(e),t=String(e?.type||e?.kind||e?.label||e?.detail||e?.reason||e?.note||e?.goalType||e?.code||'').toLowerCase();return!!(e?.penalty===true||e?.pen===true||e?.pk===true||e?.fromPenalty===true||t==='p'||t==='pg'||t==='pen'||t.includes('penalty')||t.includes('spot kick')||/"(?:penalty|pen|pk|frompenalty)"\s*:\s*true/.test(b))}
function superligaNameKey(v){return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
const SUPERLIGA_EVENT_CORRECTIONS=[
  {h:'FC Voluntari',a:'FC Botoșani',minute:'15',aliases:['Diarra M.','D. M.','M. Diarra','Mamadou Diarra'],player:'Mamadou Diarra',team:'h',og:true},
  {h:'FC Voluntari',a:'FC Botoșani',minute:'19',aliases:['Dumiter A.','D. A.','A. Dumiter','Andrei Dumiter'],player:'Andrei Dumiter',team:'a'},
  {h:'FC Voluntari',a:'FC Botoșani',minute:'47',aliases:['Mitrov Z.','M. Z.','Z. Mitrov','Zoran Mitrov'],player:'Zoran Mitrov',team:'a'},
  {h:'FC Voluntari',a:'FC Botoșani',minute:'88',aliases:['Merloi G.','M. G.','G. Merloi','George Merloi','George Cristian Merloi'],player:'George Merloi',team:'h'}
];
function superligaApplyEventCorrection(id,e){
  let m=FX_BY_ID[id],minute=superligaEventMinute(e.minute),key=superligaNameKey(e.player);
  if(!m)return e;
  let fix=SUPERLIGA_EVENT_CORRECTIONS.find(x=>x.h===m.h&&x.a===m.a&&x.minute===minute&&x.aliases.some(a=>superligaNameKey(a)===key));
  return fix?{...e,player:fix.player,team:fix.team||e.team,og:fix.og===true||e.og===true}:e;
}
function normalizeScorerEvent(id,e){
  if(!e||typeof e!=='object')return null;
  let out={...e,team:superligaEventTeam(e),minute:superligaEventMinute(e.minute??e.matchMinute??e.elapsed??e.time??e.statusMinute),player:superligaEventPlayer(e),og:superligaEventOwnGoal(e),penalty:superligaEventPenalty(e)};
  return superligaApplyEventCorrection(id,out);
}
function normalizeLiveResult(id,d){
  if(!d)return null;
  let h=d.h??d.home??d.homeScore??d.home_score??d.scoreHome,a=d.a??d.away??d.awayScore??d.away_score??d.scoreAway;
  if(!validScore(h)||!validScore(a))return null;
  let pH=d.pH??d.penH??d.penaltyHome??d.pen_h??d.homePen??null,pA=d.pA??d.penA??d.penaltyAway??d.pen_a??d.awayPen??null;
  let rawStatus=d.status||d.matchStatus||'',status=String(rawStatus).toLowerCase();
  let finished=!!d.finished||status==='ft'||status==='finished'||status.includes('full')||status.includes('vége');
  let started=d.started!==false||finished||status==='live'||status.includes('élő')||status.includes('in_play')||status.includes('in play');
  let scorers=parseMaybeArray(d.scorers).map(e=>normalizeScorerEvent(id,e)).filter(Boolean);
  let rawCards=[...parseMaybeArray(d.redCards),...parseMaybeArray(d.reds),...parseMaybeArray(d.cards),...parseMaybeArray(d.bookings),...parseMaybeArray(d.events),...parseMaybeArray(d.yellowCards)];
  let rawCardsNorm=rawCards.map(c=>({...c,team:superligaEventTeam(c),minute:superligaEventMinute(c.minute??c.matchMinute??c.elapsed??c.time),player:superligaEventPlayer(c)}));
  let redCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||c.name||'').toLowerCase();return c.red||c.yellowRed||c.isRed||c.redCard||t==='rc'||t.includes('red')||t.includes('second yellow')||t.includes('second_yellow')}).map(c=>{let t=String(c.type||c.card||c.eventType||'').toLowerCase();let yr=c.yellowRed||c.secondYellow||t.includes('second yellow')||t.includes('yellow-red')||t.includes('second_yellow');return yr?{...c,yellowRed:true,red:true}:{...c,red:true}});
  let yellowCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||'').toLowerCase();return c.yellow||t==='yc'||t==='yellow'||(t.includes('yellow')&&!t.includes('red')&&!t.includes('second'))});
  let odds=null;try{odds=typeof d.odds==='string'?JSON.parse(d.odds):(d.odds&&typeof d.odds==='object'?d.odds:null)}catch(e){odds=null}
  return{started:!!started,finished:!!finished,h:+h,a:+a,pH:validScore(pH)?+pH:null,pA:validScore(pA)?+pA:null,minute:d.minute??d.matchMinute??d.elapsed??d.currentMinute??d.liveMinute??d.matchTime??d.time??d.statusMinute??null,status:rawStatus,scorers,redCards,yellowCards,odds,source:d.source||'SuperLiga backend',updatedAt:d.updatedAt||d.updated||new Date().toISOString()};
}
(function normalizeCachedSuperligaEvents(){let fixed={};Object.entries(LIVE_RESULTS||{}).forEach(([rawId,row])=>{let id=resolveIncomingFixtureId(rawId,row),r=normalizeLiveResult(id,row);if(r)fixed[id]=r});LIVE_RESULTS=fixed;saveLiveResults()})();
function liveResultFingerprint(r){return JSON.stringify({s:r.started,f:r.finished,h:r.h,a:r.a,pH:r.pH,pA:r.pA,m:r.minute,st:r.status,sc:r.scorers,rc:r.redCards,yc:r.yellowCards,od:r.odds})}
function mergeLiveResults(next){
  let changed=false,pruneNeeded=false;
  Object.entries(next||{}).forEach(([rawId,obj])=>{
    let id=resolveIncomingFixtureId(rawId,obj),r=normalizeLiveResult(id,obj);if(!r)return;
    let old=LIVE_RESULTS[id];if(old&&old.finished&&!r.finished)return;
    if(!old||liveResultFingerprint(old)!==liveResultFingerprint(r)){
      LIVE_RESULTS[id]=r;changed=true;
      if(r.finished&&(!old||!old.finished||old.h!==r.h||old.a!==r.a))pruneNeeded=true;
    }
  });
  if(changed){
    saveLiveResults();
    if(pruneNeeded)superligaResetPostseasonTipsIfSeedChanged();
    if(['overview','matches','table','stats','community','knockout','baraj'].includes(S.tab))superligaRequestRender('live-results');
    if(typeof refreshCommunityPreviews==='function')refreshCommunityPreviews();
  }
  return changed;
}
function superligaInterestingMatches(now=Date.now()){
  return FX.filter(m=>{let ko=fixtureKickoff(m),r=LIVE_RESULTS[m.id];if(r&&r.finished)return false;if(r&&r.started&&!r.finished)return now<=ko+4*60*60*1000;return now>=ko-SUPERLIGA_SYNC_BEFORE_MS&&now<=ko+SUPERLIGA_SYNC_AFTER_MS});
}
function superligaNextInterestingDelay(now=Date.now()){
  let active=superligaInterestingMatches(now);if(active.length)return SUPERLIGA_SYNC_LIVE_MS;
  let next=FX.map(fixtureKickoff).filter(t=>t>now).sort((a,b)=>a-b)[0];
  if(!next)return SUPERLIGA_SYNC_IDLE_MS;
  return Math.max(60*1000,Math.min(SUPERLIGA_SYNC_IDLE_MS,next-now-SUPERLIGA_SYNC_BEFORE_MS));
}
function superligaWorkerBase(){try{let b=String(SUPERLIGA_WORKER_URL||'').replace(/\/$/,'');if(b)return b;return String(SUPERLIGA_RESULTS_READ_URL||'').replace(/\/results(?:\?.*)?$/,'')}catch(e){return''}}
function addParams(url,params){let u=new URL(url,location.href);Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,v)});return u.toString()}

function applyOddsMap(odds){
  if(!odds||typeof odds!=='object')return false;
  let changed=false;
  Object.entries(odds).forEach(([id,o])=>{if(!id||!o)return;let old=SUPERLIGA_ODDS[id];let fp=JSON.stringify({h:o.h,d:o.d,a:o.a,provider:o.provider,updatedAt:o.updatedAt});if(!old||JSON.stringify({h:old.h,d:old.d,a:old.a,provider:old.provider,updatedAt:old.updatedAt})!==fp){SUPERLIGA_ODDS[id]=o;changed=true}});
  if(changed&&['matches','table','overview','knockout','baraj','stats'].includes(S.tab))superligaRequestRender('odds');
  return changed;
}
function applyTeamRatingsData(data){
  if(!data||typeof data!=='object')return false;
  let changed=false,ratings=data.ratings||data.elo||{},mv=data.marketValues||data.values||{};
  Object.entries(ratings).forEach(([name,val])=>{let n=Number(val);if(Number.isFinite(n)&&TEAM_ELO[name]!==n){TEAM_ELO[name]=n;changed=true}});
  Object.entries(mv).forEach(([name,val])=>{let n=Number(val);if(Number.isFinite(n)&&TEAM_MARKET[name]!==n){TEAM_MARKET[name]=n;changed=true}});
  if(changed&&typeof refreshOpenMatchModalModel==='function')refreshOpenMatchModalModel();
  if(changed&&['matches','table','overview','knockout','baraj','stats'].includes(S.tab))superligaRequestRender('team-ratings');
  return changed;
}
let superligaBootstrapDone=false,superligaBootstrapFailed=false,superligaBootstrapInFlight=null;
function applyFixtureList(list){
  if(!Array.isArray(list)||!list.length)return false;
  let byId={};list.forEach(f=>{if(f&&f.id)byId[String(f.id)]=f});
  let changed=false;
  FX.forEach(x=>{
    let ov=byId[String(x.id)];if(!ov)return;
    let date=ov.date||ov.d||x.date,time=ov.t||ov.time||x.t;
    if(!date||!time)return;
    let yr=+String(date).slice(0,4);if(yr!==2026)return;
    let fields={date:String(date),t:String(time),label:ov.label||x.label,kickoffAt:ov.kickoffAt||null,livescoreId:ov.livescoreId||x.livescoreId||null,sofascoreId:ov.sofascoreId||x.sofascoreId||null,fixtureSource:ov.fixtureSource||ov.source||x.fixtureSource||null,fixtureUpdatedAt:ov.fixtureUpdatedAt||ov.fixtureCacheUpdatedAt||x.fixtureUpdatedAt||null};
    Object.entries(fields).forEach(([k,v])=>{if(v!==undefined&&v!==null&&x[k]!==v){x[k]=v;changed=true}});
    let day=+(String(x.date).replace(/-/g,'')+String(x.t).replace(':',''));
    if(x.day!==day){x.day=day;changed=true;}
  });
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
      if(data.odds)changed=applyOddsMap(data.odds)||changed;
      if(data.ratings||data.marketValues)changed=applyTeamRatingsData(data)||changed;
      if(data.results)changed=mergeLiveResults(data.results)||changed;
      if(data.live)changed=mergeLiveResults(data.live)||changed;
      superligaBootstrapDone=true;superligaBootstrapFailed=false;
      try{window.SUPERLIGA_BOOTSTRAP_DEBUG={ok:true,tookMs:data.tookMs||null,resultsCount:data.resultsCount||Object.keys(data.results||{}).length,liveCount:data.liveCount||Object.keys(data.live||{}).length,fixturesCount:data.fixturesCount||(data.fixtures||[]).length,usedPrefetch,changed,at:new Date().toISOString(),prefetchMeta:window.__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH_META__||null}}catch(e){}
      return changed||true;
    }catch(e){superligaBootstrapFailed=true;try{window.SUPERLIGA_BOOTSTRAP_DEBUG={ok:false,error:e&&e.message?e.message:String(e),at:new Date().toISOString()}}catch(_e){}return false}
    finally{superligaBootstrapInFlight=null}
  })();
  return superligaBootstrapInFlight;
}
async function fetchWorkerJson(url,timeoutMs=20000){let ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);try{let r=await fetch(url,{cache:'no-store',credentials:'omit',headers:{Accept:'application/json'},signal:ctrl.signal});if(!r.ok)throw new Error('HTTP '+r.status);let data=await r.json().catch(()=>null);if(!data||data.ok===false)throw new Error(data&&data.error||'Invalid worker payload');return data}finally{clearTimeout(timer)}}
async function loadMatchResultsFromBackendDb(){
  if(FROZEN_MODE)return false;
  if(!superligaBootstrapDone&&!superligaBootstrapFailed){let ok=await loadBootstrapLight({fallback:false});if(ok)return true}
  if(!SUPERLIGA_RESULTS_READ_URL)return false;
  try{let data=await fetchWorkerJson(SUPERLIGA_RESULTS_READ_URL);let changed=data&&data.results?mergeLiveResults(data.results):false;if(data&&data.fixtures)changed=applyFixtureList(data.fixtures)||changed;return changed}catch(e){return false}
}
async function loadLiveResultsFromWorker(opts={}){
  if(!SUPERLIGA_RESULTS_SYNC_URL)return false;
  let changed=false,forced=!!(opts.force||opts.forceLive),active=superligaInterestingMatches(),lastError=null;
  let dates=[...new Set(active.map(m=>String(m.date||'').slice(0,10)).filter(Boolean))],rounds=[...new Set(active.map(m=>String(m.r||'')).filter(Boolean))];
  function payloadHasActive(data){
    if(!active.length)return true;
    return Object.entries(data&&data.results||{}).some(([rawId,row])=>{
      let id=resolveIncomingFixtureId(rawId,row),m=FX_BY_ID[id];
      return !!(m&&active.some(a=>String(a.id)===String(id))&&row&&(row.started||row.finished||validScore(row.h??row.homeScore)||validScore(row.a??row.awayScore)));
    });
  }
  async function use(mode,variant='fast'){
    let params={t:Date.now()};
    if(mode==='fast')params.fast=1;
    else{
      params.fresh=1;params.live=1;params.scheduled=1;params.maxDates=10;
      if(variant==='date'&&dates.length===1)params.date=dates[0];
      else if(variant==='round'&&rounds.length===1){params.round=rounds[0];params.limit=16}
      else{let ids=active.map(m=>m.id).join(',');if(ids)params.ids=ids}
    }
    let data=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_SYNC_URL,params),mode==='fresh'?30000:10000);
    if(data&&data.results&&typeof data.results==='object')changed=mergeLiveResults(data.results)||changed;
    try{window.SUPERLIGA_LIVE_SYNC_DEBUG={ok:true,mode,variant,count:Object.keys(data&&data.results||{}).length,activeIds:active.map(m=>m.id),activeDates:dates,sync:data&&data.sync||null,updatedAt:data&&data.updatedAt||null,fetchedAt:new Date().toISOString()}}catch(e){}
    return data;
  }
  let freshFirst=forced||active.length>0;
  if(freshFirst){
    try{
      let data=await use('fresh',dates.length===1?'date':'ids');
      if(active.length&&!payloadHasActive(data)&&rounds.length===1)await use('fresh','round');
      return changed;
    }catch(e){lastError=e}
  }
  try{await use('fast','fast')}catch(e){lastError=lastError||e}
  if(lastError)try{window.SUPERLIGA_LIVE_SYNC_DEBUG={ok:false,error:lastError.message||String(lastError),activeIds:active.map(m=>m.id),activeDates:dates,fetchedAt:new Date().toISOString()}}catch(e){}
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
  if(FROZEN_MODE)return false;
  if(superligaSyncInFlight)return superligaSyncInFlight;
  superligaSyncInFlight=(async()=>{
    let forced=!!(opts.force||opts.forceLive),active=superligaInterestingMatches();
    if(!forced&&!active.length&&!SUPERLIGA_RESULTS_SYNC_URL&&!SUPERLIGA_RESULTS_READ_URL)return false;
    if(!superligaBootstrapDone&&!superligaBootstrapFailed)await loadBootstrapLight({fallback:false});
    if(SUPERLIGA_RESULTS_SYNC_URL)return await loadLiveResultsFromWorker(opts);
    if(SUPERLIGA_RESULTS_READ_URL)return await loadMatchResultsFromBackendDb();
    return await loadMatchResultsOnceFromSdk(active.map(m=>m.id));
  })();
  try{return await superligaSyncInFlight}finally{superligaSyncInFlight=null}
}
function nextLiveSyncDelay(){return document.hidden?Math.max(SUPERLIGA_SYNC_IDLE_MS,90*1000):superligaNextInterestingDelay()}
function scheduleLiveSync(delay){if(FROZEN_MODE)return;clearTimeout(superligaSyncTimer);superligaSyncTimer=setTimeout(async()=>{await Promise.allSettled([syncLiveResults(),maybeRefreshOddsFromWorker(false)]);scheduleLiveSync()},delay??nextLiveSyncDelay())}
function listenMatchResults(){return syncLiveResults({force:true})}
let superligaRatingsInFlight=null;
async function applyTeamElo(opts={}){
  if(FROZEN_MODE)return false;
  if(superligaRatingsInFlight&&!opts.force)return superligaRatingsInFlight;

  superligaRatingsInFlight=(async()=>{
    let base=superligaWorkerBase();
    let ratingsUrl=SUPERLIGA_TEAM_RATINGS_URL||(base?base+'/team-ratings':'');
    let marketUrl=SUPERLIGA_MARKET_VALUES_URL||(base?base+'/market-values':'');
    let stamp=Date.now();

    let [ratingsData,marketData]=await Promise.all([
      ratingsUrl
        ? fetchWorkerJson(addParams(ratingsUrl,{fresh:1,nocache:1,t:stamp})).catch(error=>({__error:error?.message||String(error)}))
        : Promise.resolve(null),
      marketUrl
        ? fetchWorkerJson(addParams(marketUrl,{fresh:1,nocache:1,t:stamp})).catch(error=>({__error:error?.message||String(error)}))
        : Promise.resolve(null)
    ]);

    let changed=false;
    if(ratingsData&&!ratingsData.__error)changed=applyTeamRatingsData(ratingsData)||changed;
    if(marketData&&!marketData.__error){
      changed=applyTeamRatingsData({
        marketValues:marketData.marketValues||marketData.values||{}
      })||changed;
    }

    try{
      window.SUPERLIGA_RATINGS_DEBUG={
        ok:!ratingsData?.__error&&!marketData?.__error,
        ratingsError:ratingsData?.__error||null,
        marketError:marketData?.__error||null,
        ratingsUpdatedAt:ratingsData?.updatedAt||null,
        marketUpdatedAt:marketData?.updatedAt||null,
        ratingsCount:Object.keys(ratingsData?.ratings||{}).length,
        marketCount:Object.keys(marketData?.marketValues||marketData?.values||ratingsData?.marketValues||{}).length,
        changed,
        fetchedAt:new Date().toISOString()
      };
    }catch(e){}

    return changed;
  })();

  try{return await superligaRatingsInFlight}
  finally{superligaRatingsInFlight=null}
}
window.superligaRefreshRatings=()=>applyTeamElo({force:true});
let superligaOddsPullAt=0,superligaOddsPullInFlight=null;
async function applyOddsFromWorker(opts={}){
  if(FROZEN_MODE)return false;
  if(superligaOddsPullInFlight&&!opts.force)return superligaOddsPullInFlight;
  let base=superligaWorkerBase();if(!base)return false;
  superligaOddsPullInFlight=(async()=>{try{
    let data=await fetchWorkerJson(addParams(base+'/odds',{fresh:1,nocache:1,t:Date.now()}),15000);
    superligaOddsPullAt=Date.now();
    let changed=applyOddsMap(data&&data.odds);
    try{window.SUPERLIGA_ODDS_DEBUG={ok:true,count:Object.keys(data&&data.odds||{}).length,source:data&&data.source||null,updatedAt:data&&data.updatedAt||null,fetchedAt:new Date().toISOString()}}catch(e){}
    return changed;
  }catch(e){try{window.SUPERLIGA_ODDS_DEBUG={ok:false,error:e.message||String(e),fetchedAt:new Date().toISOString()}}catch(_e){}return false}})();
  try{return await superligaOddsPullInFlight}finally{superligaOddsPullInFlight=null}
}
function maybeRefreshOddsFromWorker(force=false){return force||Date.now()-superligaOddsPullAt>=5*60*1000?applyOddsFromWorker({force}):Promise.resolve(false)}
window.superligaRefreshOdds=()=>applyOddsFromWorker({force:true});
async function applyFixtureOverrides(){if(FROZEN_MODE||!SUPERLIGA_RESULTS_READ_URL)return false;try{let url=SUPERLIGA_RESULTS_READ_URL.replace(/\/results$/,'/fixtures');let data=await fetch(addParams(url,{fresh:1,t:Date.now()}),{cache:'no-store'}).then(r=>r.ok?r.json():null);let list=data&&Array.isArray(data.fixtures)?data.fixtures:null;return applyFixtureList(list)}catch(e){return false}}

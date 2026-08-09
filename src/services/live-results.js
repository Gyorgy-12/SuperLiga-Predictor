// Live-result normalization and economical sync scheduling.
// No DOM micro-patching here: data changes flow through one render path.

const FX_BY_ID=Object.fromEntries(FX.map(m=>[m.id,m]));
let superligaSyncTimer=null;
let superligaSyncInFlight=null;
let LIVE_RESULTS=FROZEN_MODE&&window.__SUPERLIGA_LIVE_RESULTS__?window.__SUPERLIGA_LIVE_RESULTS__:superligaSafeJson(sessionStorage.getItem(SUPERLIGA_CACHE_KEYS.liveSnapshot),{});
let LIGA2_STANDINGS=superligaNormalizeLiga2Standings(FROZEN_MODE&&window.__SUPERLIGA_LIGA2_STANDINGS__?window.__SUPERLIGA_LIGA2_STANDINGS__:superligaSafeJson(sessionStorage.getItem(SUPERLIGA_CACHE_KEYS.liga2Standings),null));
superligaPublishLiga2Logos();

function saveLiveResults(){try{sessionStorage.setItem(SUPERLIGA_CACHE_KEYS.liveSnapshot,JSON.stringify(LIVE_RESULTS))}catch(e){}}
function fixtureKickoff(m){let exact=Date.parse(String(m&&m.kickoffAt||''));if(Number.isFinite(exact))return exact;let raw=String(m&&m.t||''),time=/^\d{1,2}:\d{2}$/.test(raw)?raw:'12:00';return new Date(m.date+'T'+time+':00+03:00').getTime()}
function localMatchTime(m,tz){try{return new Date(fixtureKickoff(m)).toLocaleTimeString('hu-HU',{hour:'2-digit',minute:'2-digit',timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone})}catch(e){return m.t}}
function localMatchDate(m,tz){try{return new Date(fixtureKickoff(m)).toLocaleDateString('hu-HU',{month:'short',day:'numeric',timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone}).replace(/\u00a0/g,' ')}catch(e){return m.d}}
function matchSortKey(m){return (m.date||'9999-99-99')+'T'+(m.t||'99:99')+'|'+String(m.r||'').padStart(2,'0')+'|'+(m.g||'')+'|'+(m.id||'')}
const SUPERLIGA_LATE_LIVE_CLOCK_STALE_MS=15*60*1000;
const SUPERLIGA_ABSOLUTE_LIVE_CUTOFF_MS=3*60*60*1000+15*60*1000;
const SUPERLIGA_PREMATURE_LIVE_TOLERANCE_MS=5*60*1000;
function superligaLiveMatchesFixtureWindow(r,m,now=Date.now()){
  if(!r||!r.started||r.finished||!m)return true;
  let kickoff=fixtureKickoff(m);
  return !Number.isFinite(kickoff)||kickoff<=now+SUPERLIGA_PREMATURE_LIVE_TOLERANCE_MS;
}
function superligaTerminalStatusText(r){
  let meta=r&&r.matchMeta&&typeof r.matchMeta==='object'?r.matchMeta:{};
  return [r?.status,r?.period,r?.shortDetail,r?.detail,r?.displayClock,r?.statusText,r?.phaseCode,r?.statusCode,meta.currentPeriod,meta.phaseCode,meta.statusCode]
    .map(v=>String(v||'')).join(' ').toUpperCase();
}
function superligaClockMinuteOrder(value){
  let m=String(value??'').replace(/[’'′]+/g,'').trim().match(/^(\d{1,3})(?:\+(\d{0,2}))?$/);
  return m?Number(m[1])+Number(m[2]||0)/100:-1;
}
function superligaResultObservedAt(r){
  let parsed=Date.parse(String(r?.clockObservedAt||r?.updatedAt||''));
  if(Number.isFinite(parsed))return parsed;
  let numeric=Number(r?._clockObservedAt||r?._receivedAt);
  return Number.isFinite(numeric)?numeric:null;
}
function superligaAddedTimeParts(value){
  let token=String(value??'').replace(/[’'′]/g,'').trim(),match=token.match(/^(\d{1,3})\+(\d{0,2})$/);
  if(!match)return null;
  return{base:Number(match[1]),extra:match[2]===''?null:Number(match[2])};
}
function superligaTimestampMs(value){
  if(Number.isFinite(Number(value))&&String(value??'').trim()!=='')return Number(value);
  let parsed=Date.parse(String(value||''));
  return Number.isFinite(parsed)?parsed:null;
}
function superligaAddedTimeStartMs(token,explicitStart,observedAt){
  let parts=superligaAddedTimeParts(token);
  if(!parts)return null;
  let explicit=superligaTimestampMs(explicitStart);
  if(Number.isFinite(explicit))return explicit;
  let observed=superligaTimestampMs(observedAt);
  if(!Number.isFinite(observed))observed=Date.now();
  let extra=parts.extra===null?1:Math.max(1,parts.extra);
  return observed-(extra-1)*60*1000;
}
function superligaAddedTimeLabel(token,r,now=Date.now()){
  let parts=superligaAddedTimeParts(token);
  if(!parts)return token?token+"'":'';
  if(parts.extra!==null)return parts.base+'+'+parts.extra+"'";
  let started=superligaAddedTimeStartMs(token,r?._addedTimeStartedAt??r?.addedTimeStartedAt,r?._clockObservedAt??r?.clockObservedAt);
  let elapsed=Number.isFinite(started)?Math.max(0,Math.floor((now-started)/60000)):0;
  return parts.base+'+'+Math.min(30,elapsed+1)+"'";
}
function superligaIsEffectivelyFinished(r,m){
  if(!r)return false;
  let status=superligaTerminalStatusText(r);
  if(r.finished||status==='FT'||/\bFT\b/.test(status)||status.includes('FULL TIME')||status.includes('FINISHED')||status.includes('FINAL'))return true;
  if(!r.started)return false;
  if(/\b(POSTPONED|SUSPENDED|ABANDONED|CANCELLED|CANCELED|DELAYED)\b/.test(status))return false;
  let observed=superligaResultObservedAt(r),providerOrder=superligaClockMinuteOrder(r.providerMinute??r.minute);
  if(providerOrder>=90&&Number.isFinite(observed)&&Date.now()-observed>=SUPERLIGA_LATE_LIVE_CLOCK_STALE_MS)return true;
  let kickoff=Number(r._kickoffMs);
  if(!Number.isFinite(kickoff)){
    let fixture=m||(r._fixtureId&&FX_BY_ID[r._fixtureId])||null;
    if(fixture)kickoff=fixtureKickoff(fixture);
  }
  return Number.isFinite(kickoff)&&Date.now()>=kickoff+SUPERLIGA_ABSOLUTE_LIVE_CUTOFF_MS;
}
function superligaShouldDisplayLive(r,m){return !!(r&&r.started&&superligaLiveMatchesFixtureWindow(r,m)&&!superligaIsEffectivelyFinished(r,m))}
function matchLockState(m){let r=LIVE_RESULTS[m.id];if(r&&superligaIsEffectivelyFinished(r,m))return'finished';if(r&&r.started&&superligaLiveMatchesFixtureWindow(r,m))return'live';return Date.now()>=fixtureKickoff(m)?'live':'open'}
function actualFor(m){return LIVE_RESULTS[m.id]||null}
function fmtPts(n){let x=Math.round((+n||0)*100)/100;return(Math.round(x*100)%50===0)?x.toFixed(1):x.toFixed(2)}
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
function superligaFiniteOrNull(value){if(value===null||value===undefined||value==='')return null;let n=Number(value);return Number.isFinite(n)?n:null}
function superligaNormalizeRatingsSnapshot(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  let out={schemaVersion:1,frozenAt:value.frozenAt||null,ratingsUpdatedAt:value.ratingsUpdatedAt||null,homeTeam:value.homeTeam||null,awayTeam:value.awayTeam||null,homeElo:superligaFiniteOrNull(value.homeElo),awayElo:superligaFiniteOrNull(value.awayElo),homeMarketValueM:superligaFiniteOrNull(value.homeMarketValueM),awayMarketValueM:superligaFiniteOrNull(value.awayMarketValueM),ratingsSource:value.ratingsSource||null,marketSource:value.marketSource||null};
  return[out.homeElo,out.awayElo,out.homeMarketValueM,out.awayMarketValueM].every(Number.isFinite)?out:null;
}
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
  let started=d.started===true||finished||status==='live'||status.includes('élő')||status.includes('in_play')||status.includes('in play');
  let scorers=parseMaybeArray(d.scorers).map(e=>normalizeScorerEvent(id,e)).filter(Boolean);
  let events=parseMaybeArray(d.events).map(e=>normalizeScorerEvent(id,e)).filter(Boolean);
  let rawCards=[...parseMaybeArray(d.redCards),...parseMaybeArray(d.reds),...parseMaybeArray(d.cards),...parseMaybeArray(d.bookings),...parseMaybeArray(d.events),...parseMaybeArray(d.yellowCards),...parseMaybeArray(d.doubleYellowCards)];
  let rawCardsNorm=rawCards.map(c=>({...c,team:superligaEventTeam(c),minute:superligaEventMinute(c.minute??c.matchMinute??c.elapsed??c.time),player:superligaEventPlayer(c)}));
  let redCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||c.name||'').toLowerCase();return c.red||c.yellowRed||c.isRed||c.redCard||t==='rc'||t.includes('red')||t.includes('second yellow')||t.includes('second_yellow')}).map(c=>{let t=String(c.type||c.card||c.eventType||'').toLowerCase();let yr=c.yellowRed||c.secondYellow||t.includes('second yellow')||t.includes('yellow-red')||t.includes('second_yellow');return yr?{...c,yellowRed:true,red:true}:{...c,red:true}});
  let yellowCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||'').toLowerCase();return c.yellow||t==='yc'||t==='yellow'||(t.includes('yellow')&&!t.includes('red')&&!t.includes('second'))});
  let doubleYellowCards=rawCardsNorm.filter(c=>{let t=String(c.type||c.card||c.eventType||c.kind||'').toLowerCase();return c.yellowRed||c.secondYellow||t.includes('second yellow')||t.includes('yellow-red')||t.includes('second_yellow')}).map(c=>({...c,yellowRed:true,red:true}));
  let penalties=parseMaybeArray(d.penalties).map(e=>({...e,team:superligaEventTeam(e),minute:superligaEventMinute(e.minute??e.matchMinute??e.elapsed??e.time),player:superligaEventPlayer(e)}));
  let substitutions=parseMaybeArray(d.substitutions).map(e=>({...e,team:superligaEventTeam(e),minute:superligaEventMinute(e.minute??e.matchMinute??e.elapsed??e.time)}));
  let odds=null;try{odds=typeof d.odds==='string'?JSON.parse(d.odds):(d.odds&&typeof d.odds==='object'?d.odds:null)}catch(e){odds=null}
  let fixture=FX_BY_ID[id]||null,kickoffMs=fixture?fixtureKickoff(fixture):null;
  let matchMeta=d.matchMeta&&typeof d.matchMeta==='object'?d.matchMeta:null;
  let period=d.period??d.currentPeriod??d.matchPeriod??d.phase??matchMeta?.currentPeriod??null;
  let shortDetail=d.shortDetail??d.shortStatus??d.statusShort??null;
  let detail=d.detail??d.statusDetail??d.description??null;
  let displayClock=d.displayClock??d.clock??null;
  let statusText=d.statusText??d.statusName??null;
  let phaseCode=d.phaseCode??matchMeta?.phaseCode??null;
  let statusCode=d.statusCode??matchMeta?.statusCode??null;
  let liveCode=d.liveCode??matchMeta?.liveCode??null;
  let minute=d.minute??d.matchMinute??d.elapsed??d.currentMinute??d.liveMinute??d.matchTime??d.time??d.statusMinute??null;
  let providerMinute=d.providerMinute??(superligaTickerTrustedClockSource(d.minuteSource)?d.minute:null);
  let clockObservedMs=Date.parse(d.clockObservedAt||'');
  let addedTimeStartedMs=superligaAddedTimeStartMs(providerMinute??minute,d.addedTimeStartedAt??d._addedTimeStartedAt,Number.isFinite(clockObservedMs)?clockObservedMs:d._clockObservedAt);
  let addedTimeStartedAt=Number.isFinite(addedTimeStartedMs)?new Date(addedTimeStartedMs).toISOString():null;
  return{_fixtureId:id,_receivedAt:Date.now(),_clockObservedAt:Number.isFinite(clockObservedMs)?clockObservedMs:Date.now(),_addedTimeStartedAt:addedTimeStartedMs,_kickoffMs:Number.isFinite(kickoffMs)?kickoffMs:null,started:!!started,finished:!!finished,h:+h,a:+a,pH:validScore(pH)?+pH:null,pA:validScore(pA)?+pA:null,minute,providerMinute,addedTimeStartedAt,latestIncidentMinute:d.latestIncidentMinute??null,minuteSource:d.minuteSource??null,clockObservedAt:d.clockObservedAt??null,status:rawStatus,period,shortDetail,detail,displayClock,statusText,phaseCode,statusCode,liveCode,matchMeta,scorers,events,redCards,yellowCards,doubleYellowCards,penalties,substitutions,odds,ratingsSnapshot:superligaNormalizeRatingsSnapshot(d.ratingsSnapshot),source:d.source||'SuperLiga backend',updatedAt:d.updatedAt||d.updated||new Date().toISOString()};
}
(function normalizeCachedSuperligaEvents(){let fixed={};Object.entries(LIVE_RESULTS||{}).forEach(([rawId,row])=>{let id=resolveIncomingFixtureId(rawId,row),r=normalizeLiveResult(id,row),m=FX_BY_ID[id]||null;if(r&&superligaLiveMatchesFixtureWindow(r,m))fixed[id]=r});LIVE_RESULTS=fixed;saveLiveResults()})();
function superligaLiveEventKey(e,kind='event'){
  if(!e||typeof e!=='object')return kind+'|';
  let id=String(e.eventId||e.id||'').trim();
  if(id)return kind+'|id|'+id;
  let type=String(e.type||e.kind||e.label||e.card||'').toLowerCase();
  let minute=superligaEventMinute(e.minute??e.matchMinute??e.elapsed??e.time);
  let team=superligaEventTeam(e),player=superligaNameKey(superligaEventPlayer(e));
  return [kind,type,minute,team,player].join('|');
}
function superligaMergeEventRows(oldRows,newRows,kind='event'){
  let out=[],byKey=new Map();
  [...(Array.isArray(oldRows)?oldRows:[]),...(Array.isArray(newRows)?newRows:[])].forEach(row=>{
    if(!row||typeof row!=='object')return;
    let key=superligaLiveEventKey(row,kind),prev=byKey.get(key);
    byKey.set(key,prev?{...prev,...row}:row);
  });
  byKey.forEach(v=>out.push(v));
  return out.sort((a,b)=>(parseInt(superligaEventMinute(a.minute),10)||0)-(parseInt(superligaEventMinute(b.minute),10)||0));
}
function superligaReconcileLiveResult(old,r){
  if(!old)return r;
  if(old.ratingsSnapshot)r.ratingsSnapshot=old.ratingsSnapshot;
  let oldAdded=superligaAddedTimeParts(old.providerMinute??old.minute),nextAdded=superligaAddedTimeParts(r.providerMinute??r.minute);
  if(oldAdded&&nextAdded&&oldAdded.base===nextAdded.base){
    let anchors=[old._addedTimeStartedAt,r._addedTimeStartedAt].map(Number).filter(Number.isFinite);
    if(anchors.length){
      r._addedTimeStartedAt=Math.min(...anchors);
      r.addedTimeStartedAt=new Date(r._addedTimeStartedAt).toISOString();
    }
  }
  let sameScore=old.h===r.h&&old.a===r.a,expected=Math.max(0,(+r.h||0)+(+r.a||0));
  let incomingScorers=Array.isArray(r.scorers)?r.scorers:[],oldScorers=Array.isArray(old.scorers)?old.scorers:[];
  if(sameScore&&incomingScorers.length<expected&&oldScorers.length){
    let merged=superligaMergeEventRows(oldScorers,incomingScorers,'goal');
    if(merged.length>=incomingScorers.length)r.scorers=merged;
  }
  if(sameScore){
    r.redCards=superligaMergeEventRows(old.redCards,r.redCards,'red');
    r.yellowCards=superligaMergeEventRows(old.yellowCards,r.yellowCards,'yellow');
    r.doubleYellowCards=superligaMergeEventRows(old.doubleYellowCards,r.doubleYellowCards,'yellowRed');
    r.penalties=superligaMergeEventRows(old.penalties,r.penalties,'penalty');
    r.substitutions=superligaMergeEventRows(old.substitutions,r.substitutions,'substitution');
    r.events=superligaMergeEventRows(old.events,r.events,'timeline');
  }
  return r;
}
function liveResultFingerprint(r){return JSON.stringify({s:r.started,f:r.finished,h:r.h,a:r.a,pH:r.pH,pA:r.pA,m:r.minute,pm:r.providerMinute,ats:r.addedTimeStartedAt,mis:r.minuteSource,lim:r.latestIncidentMinute,st:r.status,pr:r.period,sd:r.shortDetail,dt:r.detail,dc:r.displayClock,tx:r.statusText,pc:r.phaseCode,scd:r.statusCode,lc:r.liveCode,sc:r.scorers,ev:r.events,rc:r.redCards,yc:r.yellowCards,dy:r.doubleYellowCards,pe:r.penalties,su:r.substitutions,od:r.odds,rs:r.ratingsSnapshot})}
function mergeLiveResults(next){
  let changed=false,pruneNeeded=false;
  Object.entries(next||{}).forEach(([rawId,obj])=>{
    let id=resolveIncomingFixtureId(rawId,obj),r=normalizeLiveResult(id,obj);if(!r)return;
    let old=LIVE_RESULTS[id];if(old&&old.finished&&!r.finished)return;
    if(!superligaLiveMatchesFixtureWindow(r,FX_BY_ID[id]||null)){
      if(old&&!old.finished){delete LIVE_RESULTS[id];changed=true}
      return;
    }
    r=superligaReconcileLiveResult(old,r);
    if(!old||liveResultFingerprint(old)!==liveResultFingerprint(r)){
      LIVE_RESULTS[id]=r;changed=true;
      if(r.finished&&(!old||!old.finished||old.h!==r.h||old.a!==r.a))pruneNeeded=true;
    }else if(old){
      // Even an identical provider snapshot is a fresh clock anchor. Without
      // this, the client clock keeps advancing from the first time that minute
      // was seen and can run several minutes ahead of Flashscore.
      old._receivedAt=r._receivedAt;
      if(Number.isFinite(Number(r._clockObservedAt)))old._clockObservedAt=Number(r._clockObservedAt);
      if(r.clockObservedAt)old.clockObservedAt=r.clockObservedAt;
      if(Number.isFinite(Number(r._kickoffMs)))old._kickoffMs=Number(r._kickoffMs);
      if(r.updatedAt)old.updatedAt=r.updatedAt;
    }
  });
  if(changed){
    saveLiveResults();
    if(pruneNeeded)superligaResetPostseasonTipsIfSeedChanged();
    if(['overview','matches','table','stats','community','knockout','baraj'].includes(S.tab))superligaRequestRender('live-results');
    if(typeof refreshOpenMatchModalModel==='function')refreshOpenMatchModalModel();
    if(typeof refreshCommunityPreviews==='function')refreshCommunityPreviews();
  }
  return changed;
}
function superligaInterestingMatches(now=Date.now()){
  return FX.filter(m=>{let ko=fixtureKickoff(m),r=LIVE_RESULTS[m.id];if(r&&r.finished)return false;if(r&&r.started&&!r.finished&&superligaLiveMatchesFixtureWindow(r,m,now))return now<=ko+4*60*60*1000;return now>=ko-SUPERLIGA_SYNC_BEFORE_MS&&now<=ko+SUPERLIGA_SYNC_AFTER_MS});
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
  let ratingMeta=data.ratingsMeta||(data.sources&&data.sources.elo)||null;
  if(Object.keys(ratings).length&&ratingMeta){let oldMeta=window.SUPERLIGA_RATING_META||null;if(JSON.stringify(oldMeta)!==JSON.stringify(ratingMeta)){window.SUPERLIGA_RATING_META=ratingMeta;changed=true}}
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
    let yr=+String(date).slice(0,4);if(yr<2026||yr>2027)return;
    let fields={date:String(date),t:String(time),label:ov.label||x.label,kickoffAt:ov.kickoffAt||null,livescoreId:ov.livescoreId||x.livescoreId||null,sofascoreId:ov.sofascoreId||x.sofascoreId||null,fixtureSource:ov.fixtureSource||ov.source||x.fixtureSource||null,fixtureUpdatedAt:ov.fixtureUpdatedAt||ov.fixtureCacheUpdatedAt||x.fixtureUpdatedAt||null};
    Object.entries(fields).forEach(([k,v])=>{if(k==='kickoffAt'){let next=v||null;if(x[k]!==next){x[k]=next;changed=true}}else if(v!==undefined&&v!==null&&x[k]!==v){x[k]=v;changed=true}});
    let timeKey=/^\d{1,2}:\d{2}$/.test(String(x.t||''))?String(x.t).replace(':',''):'1200';
    let day=+(String(x.date).replace(/-/g,'')+timeKey);
    if(x.day!==day){x.day=day;changed=true;}
  });
  Object.entries(LIVE_RESULTS||{}).forEach(([id,row])=>{
    if(row&&!row.finished&&!superligaLiveMatchesFixtureWindow(row,FX_BY_ID[id]||null)){
      delete LIVE_RESULTS[id];changed=true;
    }
  });
  if(changed)saveLiveResults();
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
function superligaNormalizeLiga2Standings(data){
  if(!data||!Array.isArray(data.standings)||data.standings.length<4)return null;
  let standings=data.standings.slice(0,4).map((row,index)=>({
    position:Number(row&&row.position)||index+1,
    name:String(row&&row.name||'').trim(),
    teamId:String(row&&row.teamId||''),
    teamUrl:String(row&&row.teamUrl||''),
    logo:String(row&&row.logo||''),
    played:Number(row&&row.played)||0,
    won:Number(row&&row.won)||0,
    drawn:Number(row&&row.drawn)||0,
    lost:Number(row&&row.lost)||0,
    goalsFor:Number(row&&row.goalsFor)||0,
    goalsAgainst:Number(row&&row.goalsAgainst)||0,
    goalDifference:Number(row&&row.goalDifference)||0,
    points:Number(row&&row.points)||0
  })).filter(row=>row.name);
  if(standings.length<4)return null;
  let phase=data.phase==='promotion'?'promotion':'regular';
  return {
    competition:'Liga 2',season:String(data.season||''),phase,
    phaseLabel:String(data.phaseLabel||(phase==='promotion'?'Feljutási rájátszás':'Alapszakasz')),
    provisional:phase!=='promotion',updatedAt:String(data.updatedAt||''),source:String(data.source||''),
    standings,directPromotion:standings.slice(0,2),baraj:standings.slice(2,4)
  };
}
function superligaLiga2Fingerprint(data){return JSON.stringify(data&&{season:data.season,phase:data.phase,standings:data.standings.map(row=>[row.position,row.name,row.logo,row.played,row.goalDifference,row.points])})}
function superligaPublishLiga2Logos(){let logos={};(LIGA2_STANDINGS&&LIGA2_STANDINGS.standings||[]).forEach(row=>{if(row&&row.name&&row.logo)logos[row.name]=row.logo});window.__SUPERLIGA_LIGA2_LOGOS__=logos}
function saveLiga2Standings(){try{if(LIGA2_STANDINGS)sessionStorage.setItem(SUPERLIGA_CACHE_KEYS.liga2Standings,JSON.stringify(LIGA2_STANDINGS))}catch(e){}}
const SUPERLIGA_LIGA2_POLL_MS=2*60*60*1000;
let superligaLiga2PullAt=0,superligaLiga2InFlight=null;
async function applyLiga2Standings(opts={}){
  if(FROZEN_MODE)return false;
  if(superligaLiga2InFlight)return superligaLiga2InFlight;
  if(!opts.force&&Date.now()-superligaLiga2PullAt<SUPERLIGA_LIGA2_POLL_MS)return false;
  let endpoint=SUPERLIGA_LIGA2_STANDINGS_URL||'';
  if(!endpoint){let base=superligaWorkerBase();if(base)endpoint=base+'/liga2-standings'}
  if(!endpoint)return false;
  superligaLiga2InFlight=(async()=>{
    try{
      let params=opts.force?{fresh:1,t:Date.now()}:{v:'liga2-top4-v4'};
      let data=await fetchWorkerJson(addParams(endpoint,params),15000),normalized=superligaNormalizeLiga2Standings(data);
      if(!normalized)throw new Error('Invalid Liga 2 standings payload');
      superligaLiga2PullAt=Date.now();
      let changed=superligaLiga2Fingerprint(LIGA2_STANDINGS)!==superligaLiga2Fingerprint(normalized);
      LIGA2_STANDINGS=normalized;superligaPublishLiga2Logos();saveLiga2Standings();
      if(changed&&S.tab==='baraj'&&typeof render==='function')render();
      try{window.SUPERLIGA_LIGA2_DEBUG={ok:true,season:normalized.season,phase:normalized.phase,count:normalized.standings.length,changed,updatedAt:normalized.updatedAt,fetchedAt:new Date().toISOString()}}catch(e){}
      return changed;
    }catch(e){
      superligaLiga2PullAt=Date.now();
      try{window.SUPERLIGA_LIGA2_DEBUG={ok:false,error:e&&e.message?e.message:String(e),cached:!!LIGA2_STANDINGS,fetchedAt:new Date().toISOString()}}catch(_e){}
      return false;
    }finally{superligaLiga2InFlight=null}
  })();
  return superligaLiga2InFlight;
}
window.superligaRefreshLiga2Standings=()=>applyLiga2Standings({force:true});
setInterval(()=>{if(!document.hidden)applyLiga2Standings()},SUPERLIGA_LIGA2_POLL_MS);
let superligaFinalResultsReadAt=0,superligaFinalResultsReadInFlight=null;
async function loadMatchResultsFromBackendDb(opts={}){
  if(FROZEN_MODE||!SUPERLIGA_RESULTS_READ_URL)return false;
  if(superligaFinalResultsReadInFlight&&!opts.force)return superligaFinalResultsReadInFlight;
  if(!opts.force&&Date.now()-superligaFinalResultsReadAt<90*1000)return false;
  superligaFinalResultsReadInFlight=(async()=>{
    try{
      let data=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_READ_URL,{fresh:1,nocache:1,t:Date.now()}),20000);
      superligaFinalResultsReadAt=Date.now();
      let changed=data&&data.results?mergeLiveResults(data.results):false;
      if(data&&data.fixtures)changed=applyFixtureList(data.fixtures)||changed;
      try{window.SUPERLIGA_FINAL_RESULTS_DEBUG={ok:true,count:Object.keys(data&&data.results||{}).length,changed,updatedAt:data&&data.updatedAt||null,fetchedAt:new Date().toISOString()}}catch(e){}
      return changed;
    }catch(e){
      try{window.SUPERLIGA_FINAL_RESULTS_DEBUG={ok:false,error:e&&e.message?e.message:String(e),fetchedAt:new Date().toISOString()}}catch(_e){}
      return false;
    }finally{superligaFinalResultsReadInFlight=null}
  })();
  return superligaFinalResultsReadInFlight;
}
let superligaPublicFreshAt=0,superligaPublicFreshErrors=0,superligaPublicFreshBackoffUntil=0;
async function loadLiveResultsFromWorker(opts={}){
  if(!SUPERLIGA_RESULTS_SYNC_URL)return false;
  let changed=false,forced=!!(opts.force||opts.forceLive),active=superligaInterestingMatches(),lastError=null,fastData=null;
  function payloadHasActive(data){
    if(!active.length)return true;
    return Object.entries(data&&data.results||{}).some(([rawId,row])=>{
      let id=resolveIncomingFixtureId(rawId,row),m=FX_BY_ID[id];
      return !!(m&&active.some(a=>String(a.id)===String(id))&&row&&(row.started||row.finished||validScore(row.h??row.homeScore)||validScore(row.a??row.awayScore)));
    });
  }
  async function use(mode){
    let params={t:Date.now()};
    if(mode==='fast')params.fast=1;
    else{
      params.live=1;params.refresh=1;
    }
    let data=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_SYNC_URL,params),mode==='fresh'?20000:10000);
    if(data&&data.results&&typeof data.results==='object')changed=mergeLiveResults(data.results)||changed;
    try{window.SUPERLIGA_LIVE_SYNC_DEBUG={ok:true,mode,count:Object.keys(data&&data.results||{}).length,activeIds:active.map(m=>m.id),sync:data&&data.sync||null,coordinatorCache:data&&data.coordinatorCache||null,updatedAt:data&&data.updatedAt||null,fetchedAt:new Date().toISOString()}}catch(e){}
    return data;
  }

  // Read the shared coordinator cache first. This is cheap and cannot fan out
  // to Flashscore once per browser tab.
  if(!forced){
    try{fastData=await use('fast')}catch(e){lastError=e}
  }

  const now=Date.now();
  const cacheMiss=active.length>0&&!payloadHasActive(fastData);
  const refreshDue=forced||cacheMiss||(active.length>0&&now-superligaPublicFreshAt>=75*1000);
  if(refreshDue&&now>=superligaPublicFreshBackoffUntil){
    try{
      await use('fresh');
      superligaPublicFreshAt=Date.now();
      superligaPublicFreshErrors=0;
      superligaPublicFreshBackoffUntil=0;
    }catch(e){
      lastError=e;
      superligaPublicFreshErrors=Math.min(6,superligaPublicFreshErrors+1);
      superligaPublicFreshBackoffUntil=Date.now()+Math.min(3*60*1000,15*1000*(2**(superligaPublicFreshErrors-1)));
    }
  }

  if(forced&&!refreshDue){
    try{await use('fresh')}catch(e){lastError=e}
  }
  if(lastError)try{window.SUPERLIGA_LIVE_SYNC_DEBUG={ok:false,error:lastError.message||String(lastError),activeIds:active.map(m=>m.id),retryAfterMs:Math.max(0,superligaPublicFreshBackoffUntil-Date.now()),fetchedAt:new Date().toISOString()}}catch(e){}
  return changed;
}
let superligaScorerRepairAt=0,superligaScorerRepairInFlight=null;
function superligaGoalLikeEvent(e){
  if(!e||typeof e!=='object')return false;
  let t=String(e.type||e.kind||e.label||e.detail||e.goalType||'').toLowerCase();
  let blob='';try{blob=JSON.stringify(e).toLowerCase()}catch(_e){}
  if(/missed|saved|not scored|failed|kihagyott|ratat/.test(t+' '+blob))return false;
  return e.goal===true||e.isGoal===true||e.og===true||e.ownGoal===true||Number(e.code)===10||/\bgoal\b|penalty_goal|penalty scored|own goal|autogol|öngól/.test(t+' '+blob);
}
function superligaKnownGoalCount(r){
  let rows=[...(Array.isArray(r?.scorers)?r.scorers:[])];
  if(!rows.length&&Array.isArray(r?.events))rows=r.events.filter(superligaGoalLikeEvent);
  let keys=new Set(rows.map(e=>superligaLiveEventKey(e,'goal')));
  return keys.size;
}
function superligaMissingScorerIds(){
  let now=Date.now();
  return FX.filter(m=>{
    let r=LIVE_RESULTS[m.id];
    if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return false;
    if(now<fixtureKickoff(m))return false;
    let expected=Math.max(0,Number(r.h)+Number(r.a));
    return expected>0&&superligaKnownGoalCount(r)<expected;
  }).map(m=>String(m.id));
}
async function superligaRepairMissingScorers(opts={}){
  if(FROZEN_MODE||!SUPERLIGA_RESULTS_SYNC_URL)return false;
  if(superligaScorerRepairInFlight)return superligaScorerRepairInFlight;
  let ids=superligaMissingScorerIds();
  if(!ids.length)return false;
  let force=!!opts.force,wait=force?0:60*1000;
  if(!force&&Date.now()-superligaScorerRepairAt<wait)return false;
  superligaScorerRepairAt=Date.now();
  superligaScorerRepairInFlight=(async()=>{
    let changed=false,errors=[];
    for(let i=0;i<ids.length;i+=12){
      let batch=ids.slice(i,i+12);
      try{
        let data=await fetchWorkerJson(addParams(SUPERLIGA_RESULTS_SYNC_URL,{fresh:1,force:1,events:1,detail:1,ids:batch.join(','),t:Date.now()}),35000);
        if(data&&data.results)changed=mergeLiveResults(data.results)||changed;
      }catch(e){errors.push(e?.message||String(e));}
    }
    try{window.SUPERLIGA_SCORER_REPAIR_DEBUG={ok:errors.length===0,ids,remaining:superligaMissingScorerIds(),errors,changed,at:new Date().toISOString()}}catch(_e){}
    return changed;
  })();
  try{return await superligaScorerRepairInFlight}finally{superligaScorerRepairInFlight=null}
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
async function syncLiveResults(opts={}){
  if(FROZEN_MODE)return false;
  if(superligaSyncInFlight)return superligaSyncInFlight;
  superligaSyncInFlight=(async()=>{
    let forced=!!(opts.force||opts.forceLive),active=superligaInterestingMatches(),changed=false;
    if(!forced&&!active.length&&!SUPERLIGA_RESULTS_SYNC_URL&&!SUPERLIGA_RESULTS_READ_URL)return false;
    if(!superligaBootstrapDone&&!superligaBootstrapFailed)await loadBootstrapLight({fallback:false});

    // Final results are the base layer. Always hydrate them first on startup/force,
    // because finished matches are intentionally absent from the live window.
    if(SUPERLIGA_RESULTS_READ_URL){
      changed=(await loadMatchResultsFromBackendDb({force:forced}))||changed;
    }

    // Live data is only an overlay. A stale live row cannot overwrite a finished row
    // because mergeLiveResults protects old.finished above.
    if(SUPERLIGA_RESULTS_SYNC_URL){
      changed=(await loadLiveResultsFromWorker(opts))||changed;
      changed=(await superligaRepairMissingScorers({force:forced}))||changed;
      return changed;
    }
    if(!SUPERLIGA_RESULTS_READ_URL){
      changed=(await loadMatchResultsOnceFromSdk(active.map(m=>m.id)))||changed;
    }
    return changed;
  })();
  try{return await superligaSyncInFlight}finally{superligaSyncInFlight=null}
}
let superligaTabLiveRefreshQueued=false;
async function superligaRefreshLiveForView(tab){
  if(FROZEN_MODE)return false;
  let requestedAt=new Date().toISOString(),changed=false,error=null;
  if(superligaSyncInFlight){
    superligaTabLiveRefreshQueued=true;
    try{await superligaSyncInFlight}catch(e){}
    if(!superligaTabLiveRefreshQueued)return false;
    superligaTabLiveRefreshQueued=false;
  }
  try{
    changed=await syncLiveResults({force:true,forceLive:true});
    return changed;
  }catch(e){
    error=e&&e.message?e.message:String(e);
    return false;
  }finally{
    try{window.SUPERLIGA_TAB_LIVE_SYNC_DEBUG={tab:String(tab||''),requestedAt,completedAt:new Date().toISOString(),changed,error}}catch(e){}
    scheduleLiveSync();
  }
}
window.superligaRefreshResults=()=>superligaRefreshLiveForView(S.tab);
window.superligaRefreshLiveForView=superligaRefreshLiveForView;
function nextLiveSyncDelay(){return document.hidden?Math.max(SUPERLIGA_SYNC_IDLE_MS,90*1000):superligaNextInterestingDelay()}
function scheduleLiveSync(delay){if(FROZEN_MODE)return;clearTimeout(superligaSyncTimer);superligaSyncTimer=setTimeout(async()=>{await Promise.allSettled([syncLiveResults(),maybeRefreshOddsFromWorker(false)]);scheduleLiveSync()},delay??nextLiveSyncDelay())}
function superligaTickerMinuteToken(value){
  let s=String(value??'').trim();
  if(!s||/^\d{1,2}:\d{2}$/.test(s))return null;
  let m=s.match(/(?:^|\s)(\d{1,3}(?:\+(?:\d{1,2})?)?)(?:[’'′]|\s|$)/);
  return m?m[1]:null;
}
function superligaTickerFormattedMinute(token,r){return superligaAddedTimeLabel(token,r)}
function superligaTickerTrustedClockSource(value){
  let s=String(value||'').toLowerCase();
  return s.includes('provider')||s.includes('flashscore-list')||s.includes('flashscore-mobile')||s.includes('mobile-page')||s.includes('flashscore-clock');
}
function superligaClientClockLabel(id,r){
  if(!r||!r.started||r.finished)return'';
  let blob=[r.status,r.period,r.shortDetail,r.detail,r.statusText,r.displayClock,r.matchMeta?.currentPeriod]
    .map(v=>String(v||'')).join(' ').toUpperCase();
  if(/\b(HT|INT)\b/.test(blob)||blob.includes('HALF TIME')||blob.includes('HALFTIME')||blob.includes('INTERVAL'))return'HT';
  if(/\bAET\b/.test(blob)||blob.includes('EXTRA TIME'))return'AET';
  if(/\bPEN\b/.test(blob)||blob.includes('SHOOTOUT'))return'PEN';

  // Display only an explicit provider clock. Status text, incident minutes and
  // kickoff-based interpolation are not clocks and can jump ahead to 45'/90'.
  let providerToken=superligaTickerMinuteToken(r.providerMinute);
  let source=String(r.minuteSource||'').toLowerCase();
  if(!providerToken&&superligaTickerTrustedClockSource(source)){
    providerToken=superligaTickerMinuteToken(r.minute);
  }
  if(!providerToken&&!String(r.source||'').toLowerCase().includes('flashscore')){
    providerToken=[r.minute,r.matchMinute,r.elapsed,r.currentMinute,r.liveMinute,r.matchTime,r.statusMinute]
      .map(superligaTickerMinuteToken).find(Boolean)||null;
  }
  return providerToken?superligaTickerFormattedMinute(providerToken,r):'Élő';
}

function superligaRefreshVisibleClockPills(){
  if(FROZEN_MODE)return;
  document.querySelectorAll('.match-row[data-mid],.match-row[data-ko-mid]').forEach(row=>{
    let id=row.getAttribute('data-mid')||row.getAttribute('data-ko-mid'),r=LIVE_RESULTS[id],fixture=FX_BY_ID[id]||null;
    if(!r||!r.started)return;
    if(!superligaShouldDisplayLive(r,fixture)){
      let clockRow=row.querySelector('.mr-clock-row');
      if(clockRow)clockRow.remove();
      row.classList.remove('live-locked');
      row.classList.add('finished','locked');
      return;
    }
    let label=superligaClientClockLabel(id,r);
    let pill=row.querySelector('.mr-clock');
    if(pill&&label&&pill.textContent!==label)pill.textContent=label;
  });

  let ov=document.querySelector('.tip-overlay[data-tip-id]');
  if(ov){
    let id=ov.dataset.tipId,r=LIVE_RESULTS[id],fixture=FX_BY_ID[id]||null;
    if(r&&r.started){
      let pill=ov.querySelector('.wc26-modal-pill');
      if(!superligaShouldDisplayLive(r,fixture)){
        if(pill){
          pill.textContent='FT';
          pill.dataset.state='ft';
        }
      }else{
        let label=superligaClientClockLabel(id,r);
        if(pill&&label&&pill.textContent!==label){
          pill.textContent=label;
          pill.dataset.state=/^(HT|AET|PEN)$/.test(label)?label.toLowerCase():'live';
        }
      }
    }
  }
}
let superligaUiClockTimer=null;
function startSuperligaUiClock(){
  if(FROZEN_MODE||superligaUiClockTimer)return;
  let tick=()=>{
    if(document.hidden)return;
    if(Object.values(LIVE_RESULTS||{}).some(r=>r&&r.started&&!r.finished))superligaRefreshVisibleClockPills();
  };
  tick();
  superligaUiClockTimer=setInterval(tick,5000);
}
startSuperligaUiClock();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)superligaRefreshVisibleClockPills()});

const SUPERLIGA_RATINGS_POLL_MS=30*60*1000;
let superligaRatingsInFlight=null,superligaRatingsPullAt=0;
async function applyTeamElo(opts={}){
  if(FROZEN_MODE)return false;
  if(superligaRatingsInFlight&&!opts.force)return superligaRatingsInFlight;
  if(!opts.force&&Date.now()-superligaRatingsPullAt<SUPERLIGA_RATINGS_POLL_MS)return false;

  superligaRatingsInFlight=(async()=>{
    let base=superligaWorkerBase();
    let ratingsUrl=SUPERLIGA_TEAM_RATINGS_URL||(base?base+'/team-ratings':'');
    let marketUrl=SUPERLIGA_MARKET_VALUES_URL||(base?base+'/market-values':'');
    let stamp=Date.now();

    let ratingsData=ratingsUrl
      ? await fetchWorkerJson(addParams(ratingsUrl,{fresh:1,nocache:1,t:stamp})).catch(error=>({__error:error?.message||String(error)}))
      : null;
    let marketData=null;
    let ratingsHasMarket=Object.keys(ratingsData?.marketValues||ratingsData?.values||{}).length>0;
    if(!ratingsHasMarket&&marketUrl&&marketUrl!==ratingsUrl){
      marketData=await fetchWorkerJson(addParams(marketUrl,{fresh:1,nocache:1,t:stamp})).catch(error=>({__error:error?.message||String(error)}));
    }

    let changed=false;
    if(ratingsData&&!ratingsData.__error)changed=applyTeamRatingsData(ratingsData)||changed;
    if(marketData&&!marketData.__error){
      changed=applyTeamRatingsData({
        marketValues:marketData.marketValues||marketData.values||{}
      })||changed;
    }
    if((ratingsData&&!ratingsData.__error)||(marketData&&!marketData.__error))superligaRatingsPullAt=Date.now();

    try{
      window.SUPERLIGA_RATINGS_DEBUG={
        ok:!ratingsData?.__error&&!marketData?.__error,
        ratingsError:ratingsData?.__error||null,
        marketError:marketData?.__error||null,
        ratingsUpdatedAt:ratingsData?.updatedAt||null,
        marketUpdatedAt:marketData?.updatedAt||ratingsData?.updatedAt||null,
        checkedAt:ratingsData?.checkedAt||marketData?.checkedAt||null,
        lastSuccessfulRefreshAt:ratingsData?.lastSuccessfulRefreshAt||marketData?.lastSuccessfulRefreshAt||null,
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
setInterval(()=>{if(!document.hidden)applyTeamElo()},SUPERLIGA_RATINGS_POLL_MS);
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

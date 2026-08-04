// Layout sync, router, control events and startup boot sequence.

let suppressShrinkUntil=0;
let superligaRenderQueued=false;
let matchAutoScrolledKey='';
let matchAutoScrollTimer=null;
let matchAutoScrollToken=0;

function visibleMatchAutoScrollCandidates(){
  const root=document.getElementById('main');
  if(!root||S.tab!=='matches')return[];
  let postseason=[];
  try{postseason=typeof buildAllPostseasonMatches==='function'?buildAllPostseasonMatches():[]}catch(e){postseason=[]}
  const byId=new Map(FX.concat(postseason).map(match=>[String(match.id),match]));
  return [...root.querySelectorAll('[data-mid],[data-ko-mid]')].map(row=>{
    const id=String(row.dataset.mid||row.dataset.koMid||'');
    const match=byId.get(id);
    if(!match)return null;
    let kickoff=NaN;
    try{kickoff=fixtureKickoff(match)}catch(e){}
    let result=null;
    try{result=typeof actualFor==='function'?actualFor({id}):null}catch(e){}
    return{id,match,row,result,kickoff};
  }).filter(item=>item&&Number.isFinite(item.kickoff));
}

function autoScrollResultFinished(result){
  if(!result)return false;
  if(result.finished)return true;
  const status=String(result.status||result.state||result.statusText||'').trim().toUpperCase();
  return /^(FT|AET|PEN|FINAL|FINISHED|FULL_TIME|COMPLETE)$/.test(status)
    || status.includes('FULL TIME')
    || status.includes('FINISHED');
}

function currentOrNextVisibleMatch(){
  const now=Date.now();
  const candidates=visibleMatchAutoScrollCandidates();
  if(!candidates.length)return null;
  const chronological=rows=>rows.slice().sort((a,b)=>a.kickoff-b.kickoff||a.id.localeCompare(b.id));
  const liveWindowAfter=4*60*60*1000;
  const liveWindowBefore=10*60*1000;

  // First choice: a genuinely live match. The kickoff window also covers the
  // short period before the backend sends its first live status.
  const live=chronological(candidates.filter(item=>{
    if(autoScrollResultFinished(item.result))return false;
    const explicitLive=!!(item.result&&item.result.started&&!item.result.finished);
    const insideKickoffWindow=now>=item.kickoff-liveWindowBefore&&now<=item.kickoff+liveWindowAfter;
    return insideKickoffWindow&&(explicitLive||now>=item.kickoff-liveWindowBefore);
  }));
  if(live.length)return live[0];

  // Otherwise jump to the first fixture that has not kicked off yet.
  const upcoming=chronological(candidates.filter(item=>{
    if(autoScrollResultFinished(item.result))return false;
    return item.kickoff>now;
  }));
  return upcoming[0]||null;
}

function matchesStickyBottom(){
  const top=byId('topBar');
  const controls=byId('ctrlWrap');
  const topBottom=top?Math.max(0,top.getBoundingClientRect().bottom):0;
  const controlsBottom=controls?Math.max(0,controls.getBoundingClientRect().bottom):0;
  return Math.ceil(Math.max(topBottom,controlsBottom));
}

function scrollMatchesToCurrentOrNext(){
  matchAutoScrollTimer=null;
  const token=++matchAutoScrollToken;
  if(S.tab!=='matches'||matchAutoScrolledKey)return false;
  const target=currentOrNextVisibleMatch();
  if(!target||!target.row)return false;

  // Match the WC/VB behaviour: collapse the big header first, then measure the
  // final sticky header/control height and align the exact match row below it.
  suppressShrinkUntil=0;
  topBar.classList.add('shrunken');
  syncSoon();

  setTimeout(()=>{
    if(token!==matchAutoScrollToken||S.tab!=='matches'||matchAutoScrolledKey)return;
    if(!document.documentElement.contains(target.row))return;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(token!==matchAutoScrollToken||S.tab!=='matches'||matchAutoScrolledKey)return;
      const stickyBottom=matchesStickyBottom();
      const rowDocumentTop=target.row.getBoundingClientRect().top+window.pageYOffset;
      const top=Math.max(0,Math.round(rowDocumentTop-stickyBottom-10));
      const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      matchAutoScrolledKey=target.id;
      window.scrollTo({top,behavior:reduced?'auto':'smooth'});
    }));
  },260);
  return true;
}

function queueMatchAutoScroll(delay=120){
  if(S.tab!=='matches'||matchAutoScrolledKey)return;
  if(matchAutoScrollTimer)clearTimeout(matchAutoScrollTimer);
  matchAutoScrollTimer=setTimeout(scrollMatchesToCurrentOrNext,delay);
}

function byId(id){return document.getElementById(id)}
function syncSpacer(){let t=byId('topBar'),s=byId('spacer'),h=Math.ceil(t?.getBoundingClientRect().height||t?.offsetHeight||148);if(s)s.style.height=h+'px';document.documentElement.style.setProperty('--top-h',h+'px');document.documentElement.style.setProperty('--control-top',(h+2)+'px');let cw=byId('ctrlWrap'),active=cw?[...cw.children].filter(x=>!x.classList.contains('hidden')):[],ch=active.reduce((sum,x)=>sum+Math.ceil(x.getBoundingClientRect().height||x.offsetHeight||0),0);document.documentElement.style.setProperty('--ctrl-h',ch+'px');if(cw)cw.classList.toggle('controls-empty',ch<=0)}
function syncSoon(){syncSpacer();requestAnimationFrame(syncSpacer);setTimeout(syncSpacer,90);setTimeout(syncSpacer,220);setTimeout(syncSpacer,360)}
function superligaRequestRender(){if(superligaRenderQueued)return;superligaRenderQueued=true;requestAnimationFrame(()=>{superligaRenderQueued=false;render();syncSoon()})}
function renderTableLike(){if(S.tab==='knockout')renderKO();else renderTables()}
function closeDropdowns(){vDrop.classList.remove('open');roundSelDrop.classList.remove('open');teamSelDrop.classList.remove('open');tblRoundDrop.classList.remove('open')}
function syncCommunityLifecycle(){if(typeof setCommunityActive==='function')setCommunityActive(S.tab==='community')}
function render(){
  document.documentElement.dataset.superligaTab=S.tab||'overview';
  const mainEl=byId('main');
  if(mainEl&&!mainEl._firstRender){mainEl._firstRender=true;mainEl.style.opacity='0';requestAnimationFrame(()=>{mainEl.style.transition='opacity .2s ease';mainEl.style.opacity='1'})}
  enforcePostseasonSeed();
  if(S.tab!=='community')document.querySelectorAll('.community-preview').forEach(x=>x.remove());
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===S.tab));
  tblCtrl.classList.toggle('hidden',!(S.tab==='table'||S.tab==='knockout'));
  koCtrl.classList.add('hidden');
  mCtrl.classList.toggle('hidden',S.tab!=='matches');
  mRoundBar.classList.toggle('hidden',!(S.tab==='matches'&&MS.filt==='round'));
  mTeamBar.classList.toggle('hidden',!(S.tab==='matches'&&MS.filt==='team'));
  syncCommunityLifecycle();
  if(S.tab==='overview')renderOverview();
  else if(S.tab==='table')renderTables();
  else if(S.tab==='matches'){renderMatches();queueMatchAutoScroll();}
  else if(S.tab==='knockout')renderKO();
  else if(S.tab==='baraj')renderBaraj();
  else if(S.tab==='stats')renderStats();
  else if(S.tab==='community')renderCommunity();
  else renderOverview();
  syncSpacer();
}

tabs.onclick=e=>{let b=e.target.closest('.tab');if(!b)return;closeAllModals();S.tab=b.dataset.tab;if(S.tab==='matches'){if(!/^\d+$/.test(String(MS.round)))MS.round=1;matchAutoScrolledKey='';matchAutoScrollToken++;suppressShrinkUntil=0}else window.scrollTo({top:0,behavior:'instant'});try{sessionStorage.setItem('superliga_active_tab',S.tab)}catch(err){}render();syncSoon()};
tblCtrl.onclick=e=>{let b=e.target.closest('[data-f]');if(!b)return;S.filt=b.dataset.f;document.querySelectorAll('[data-f]').forEach(x=>x.classList.toggle('active',x===b));renderTableLike()};
tblRoundBtn.onclick=e=>{e.stopPropagation();tblRoundDrop.classList.toggle('open')};
tblRoundDrop.onclick=e=>{let b=e.target.closest('[data-tr]');if(!b)return;if(S.tab==='knockout'){S.postRound=b.dataset.tr||'current';}else{S.tblRound=+b.dataset.tr||0;}tblRoundTxt.innerHTML=b.innerHTML;tblRoundDrop.querySelectorAll('[data-tr]').forEach(x=>x.classList.toggle('active',x===b));tblRoundDrop.classList.remove('open');renderTableLike()};
vBtn.onclick=e=>{e.stopPropagation();vDrop.classList.toggle('open')};
vDrop.onclick=e=>{e.stopPropagation();let b=e.target.closest('[data-v]');if(!b)return;S.view=b.dataset.v;vDrop.querySelectorAll('[data-v]').forEach(x=>x.classList.toggle('active',x===b));vDrop.classList.remove('open');renderTableLike()};
mCtrl.onclick=e=>{let b=e.target.closest('[data-mf]');if(!b)return;MS.filt=b.dataset.mf;matchAutoScrolledKey='';matchAutoScrollToken++;document.querySelectorAll('[data-mf]').forEach(x=>x.classList.toggle('active',x===b));if(MS.filt!=='date')scrollTo({top:0,behavior:'auto'});render();syncSoon()};
roundSelDrop.innerHTML=Array.from({length:30},(_,i)=>'<button data-r="'+(i+1)+'"'+(MS.round===(i+1)?' class="active"':'')+'>'+(i+1)+'. forduló</button>').join('')+postseasonRoundOptions().map(o=>'<button data-r="'+o.key+'"'+(MS.round===o.key?' class="active"':'')+'>'+o.label+'</button>').join('');
roundSelBtn.onclick=e=>{e.stopPropagation();roundSelDrop.classList.toggle('open')};
roundSelDrop.onclick=e=>{let b=e.target.closest('[data-r]');if(!b)return;let v=b.dataset.r;MS.round=/^\d+$/.test(v)?+v:v;matchAutoScrolledKey='';matchAutoScrollToken++;roundSelTxt.innerHTML=b.innerHTML;roundSelDrop.classList.remove('open');scrollTo({top:0,behavior:'auto'});renderMatches();queueMatchAutoScroll();syncSoon()};
teamSelDrop.innerHTML=ALL.map(t=>'<button data-team="'+esc(t)+'">'+esc(t)+'</button>').join('');
teamSelBtn.onclick=e=>{e.stopPropagation();teamSelDrop.classList.toggle('open')};
teamSelDrop.onclick=e=>{let b=e.target.closest('[data-team]');if(!b)return;MS.team=b.dataset.team;matchAutoScrolledKey='';matchAutoScrollToken++;teamSelTxt.textContent=MS.team;teamSelDrop.classList.remove('open');scrollTo({top:0,behavior:'auto'});renderMatches();queueMatchAutoScroll();syncSoon()};
document.onclick=closeDropdowns;
window.addEventListener('scroll',()=>{if(Date.now()<suppressShrinkUntil){if(pageYOffset<=12)topBar.classList.remove('shrunken');syncSoon();return}topBar.classList.toggle('shrunken',pageYOffset>12);syncSoon()},{passive:true});
let __desktopNamesState=isDesktopNames();
window.addEventListener('resize',()=>{let next=isDesktopNames();syncSoon();if(next!==__desktopNamesState){__desktopNamesState=next;superligaRequestRender()}},{passive:true});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&!FROZEN_MODE){
    Promise.all([
      syncLiveResults({force:true}),
      applyTeamElo({force:true}),
      applyOddsFromWorker()
    ]).finally(()=>scheduleLiveSync());
  }
});
if(window.ResizeObserver)new ResizeObserver(syncSpacer).observe(topBar);
if(window.ResizeObserver){let cw=byId('ctrlWrap');if(cw)new ResizeObserver(syncSpacer).observe(cw)}
topBar.addEventListener('transitionend',syncSpacer);
async function startSuperligaApp(){
  if(!FROZEN_MODE){
    // Avoid painting the placeholder fixture seed while the head prefetch is
    // already resolving the authoritative schedule. Keep startup bounded so
    // the application remains usable while offline.
    await Promise.race([
      loadBootstrapLight({fallback:false}),
      new Promise(resolve=>setTimeout(resolve,2500))
    ]);
  }
  applyTeamElo({force:true});
  applyOddsFromWorker();
  pruneStaleKoPred(false);
  render();
  syncSoon();
  syncLiveResults({force:true}).then(()=>scheduleLiveSync());
}
startSuperligaApp();
let __syncTicks=0,__syncTimer=setInterval(()=>{syncSpacer();__syncTicks++;if(__syncTicks>20)clearInterval(__syncTimer)},150);setInterval(syncSpacer,2000);
(function(){let dragging=false,startX=0,startScroll=0,moved=false,el=null;document.addEventListener('mousedown',e=>{let br=e.target.closest('.ko-bracket');if(!br||e.target.closest('[data-koid]'))return;dragging=true;moved=false;el=br;startX=e.pageX;startScroll=br.scrollLeft;br.classList.add('ko-dragging')});document.addEventListener('mousemove',e=>{if(!dragging||!el)return;let dx=e.pageX-startX;if(Math.abs(dx)>4)moved=true;el.scrollLeft=startScroll-dx});document.addEventListener('mouseup',()=>{if(dragging&&el){dragging=false;el.classList.remove('ko-dragging');KO_SCROLL=el.scrollLeft;el=null}});document.addEventListener('click',e=>{if(moved&&e.target.closest('.ko-bracket')){e.preventDefault();e.stopPropagation();moved=false}},true)})();

// Shared predictor match modal flow for regular-season and postseason matches.
// Shared behaviour intentionally mirrors the World Cup predictor: same overlay class,
// same sheet structure, same lock/save/delete lifecycle, and no ad-hoc DOM patching.

function findRegularMatch(id){return FX.find(x=>x.id===id)||null}
function closeTip(){document.querySelectorAll('.tip-overlay').forEach(el=>el.remove());syncModalOpenClass()}
function modalScoreIsReal(r,locked){return !!(r&&(r.started||r.finished||locked)&&validScore(r.h)&&validScore(r.a))}
function modalClockPill(r){
  if(!r)return'';
  if(r.finished)return'<span class="tip-live-clock">FT</span>';
  let clock=liveClockLabel(r),isInt=String(r.status||'').toUpperCase().includes('INT');
  return (clock?'<span class="tip-live-clock">'+esc(clock)+'</span>':'')+(isInt?'<span class="tip-live-clock int-modal-badge">INT.</span>':'');
}
function superligaModalStatusHtml(r){let pills=(typeof superligaStatusPills==='function')?superligaStatusPills(r,{mode:'modal'}):'';return pills?'<div class="wc26-modal-status">'+pills+'</div>':''}

function shortPlayerName(name){
  let parts=String(name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length<2)return name||'';
  return parts[0].charAt(0)+'. '+parts[parts.length-1];
}
function eventTeam(e){return e&&(['a','away'].includes(String(e.team||'').toLowerCase())||String(e.side||'').toLowerCase()==='away'||String(e.teamSide||'').toLowerCase()==='away')?'a':'h'}
function eventMinute(e){return (e&&(e.minute??e.matchMinute??e.elapsed??e.time??e.statusMinute))||''}
function isPenaltyGoal(s){
  let t=String(s?.type||s?.detail||s?.note||s?.goalType||s?.code||s?.Cd||'').toLowerCase();
  let blob='';
  try{blob=JSON.stringify(s||{}).toLowerCase()}catch(e){}
  return !!(s?.penalty===true||s?.pen===true||s?.pk===true||s?.fromPenalty===true||t==='p'||t==='pg'||t==='pen'||t==='penalty'||t.includes('spot kick')||/"(penalty|pen|pk|frompenalty)"\s*:\s*true/.test(blob)||/\b11m\b/.test(blob)||blob.includes('spot kick'));
}
function goalScorersHtml(r,m){
  let events=[];
  if(r&&Array.isArray(r.scorers))events=events.concat(r.scorers.map(s=>({...s,_kind:'goal'})));
  if(r&&Array.isArray(r.redCards))events=events.concat(r.redCards.map(s=>({...s,_kind:s.yellowRed?'yellowRed':'red'})));
  if(r&&Array.isArray(r.yellowCards))events=events.concat(r.yellowCards.map(s=>({...s,_kind:'yellow'})));
  if(!events.length)return'';
  let sorted=events.sort((a,b)=>(parseInt(eventMinute(a),10)||0)-(parseInt(eventMinute(b),10)||0));
  let infoCell=s=>{
    if(s._kind==='red')return'<span class="red-card-mark"></span><span class="goal-scorer-name">'+(s.player?esc(shortPlayerName(s.player)):'Piros lap')+'</span>';
    if(s._kind==='yellowRed')return'<span class="yellow-red-card-mark"></span><span class="goal-scorer-name">'+(s.player?esc(shortPlayerName(s.player)):'2× Sárga')+'</span>';
    if(s._kind==='yellow')return'<span class="yellow-card-mark"></span><span class="goal-scorer-name">'+(s.player?esc(shortPlayerName(s.player)):'Sárga lap')+'</span>';
    let name=s.player?esc(shortPlayerName(s.player)):'',og=s.og?'<span class="goal-scorer-og">(&ouml;ng.)</span>':'',pen=isPenaltyGoal(s)?'<span class="goal-scorer-pen">(11-es)</span>':'';
    return'<span class="goal-scorer-ball">&#9917;</span><span class="goal-scorer-name">'+name+'</span>'+og+pen;
  };
  let rows=sorted.map(s=>{
    let team=eventTeam(s),home=team!=='a'?infoCell(s):'',away=team==='a'?infoCell(s):'',min=eventMinute(s)?esc(eventMinute(s))+"&#39;":'',cls=s._kind==='red'?' red-card-row':s._kind==='yellowRed'?' red-card-row yellow-red-row':s._kind==='yellow'?' yellow-card-row':'';
    return'<div class="goal-scorer-row'+cls+'"><div class="goal-scorers-col">'+home+'</div><span class="goal-scorer-min">'+min+'</span><div class="goal-scorers-col">'+away+'</div></div>';
  }).join('');
  return'<div class="goal-scorers">'+rows+'</div>';
}
function modalGoalRows(r,m){
  let clock=modalClockPill(r),events=goalScorersHtml(r,m);
  if(!clock&&!events)return'';
  return'<div class="tip-below-score">'+clock+events+'</div>';
}

function superligaMarketValue(team){let v=TEAM_MARKET&&TEAM_MARKET[team];return Number.isFinite(+v)?+v:10}
function superligaElo(team){let v=TEAM_ELO&&TEAM_ELO[team];return Number.isFinite(+v)?+v:1450}
function superligaMarketLabel(v){v=Number(v);return '€'+(Number.isFinite(v)?v:0).toFixed(2)+'M'}
function teamModelScore(team){let elo=superligaElo(team),mv=superligaMarketValue(team),market=Math.log(mv+10)*72;return elo+market}
function matchProb(m){let diff=teamModelScore(m.h)-teamModelScore(m.a),draw=Math.max(.18,Math.min(.30,.27-Math.abs(diff)/2800)),homeShare=1/(1+Math.exp(-diff/285)),rem=1-draw,home=rem*homeShare,away=rem*(1-homeShare),sum=home+draw+away;return{home:home/sum,draw:draw/sum,away:away/sum,diff}}
function impliedProbFromOdds(odds){if(!odds||!validOdds(odds.h)||!validOdds(odds.d)||!validOdds(odds.a))return null;let h=1/+odds.h,d=1/+odds.d,a=1/+odds.a,sum=h+d+a;if(!sum)return null;return{home:h/sum,draw:d/sum,away:a/sum}}
function liveOrCachedOdds(m,r){return (r&&r.odds)||((typeof SUPERLIGA_ODDS!=='undefined'&&m&&m.id)?SUPERLIGA_ODDS[m.id]:null)||null}
function matchProbWithMarket(m,r){let model=matchProb(m),market=impliedProbFromOdds(liveOrCachedOdds(m,r));if(!market)return{...model,fromMarket:false};let mw=.7,sw=.3,home=market.home*mw+model.home*sw,draw=market.draw*mw+model.draw*sw,away=market.away*mw+model.away*sw,sum=home+draw+away;return{home:home/sum,draw:draw/sum,away:away/sum,diff:model.diff,fromMarket:true}}
function pct(v){return Math.round((+v||0)*100)}
function odd(v){return v?Math.max(1.01,1/v).toFixed(2):'-'}
function modelMeta(team){return '<span class="model-pill">Elo '+Math.round(superligaElo(team))+'</span><span class="model-pill">'+superligaMarketLabel(superligaMarketValue(team))+'</span>'}
function modalTeamName(team){return typeof teamNameFor==='function'?teamNameFor(team,'match-modal'):(typeof stn==='function'?stn(team):team)}
function probRow(name,v,clr,act,rawOdd){return '<div class="tip-prob-row'+(act?' tip-prob-row-actual':'')+'"><div class="tip-prob-name">'+esc(name)+'</div><div class="tip-prob-track"><div class="tip-prob-fill" style="width:'+pct(v)+'%;background:'+clr+'"></div></div><div class="tip-prob-pct">'+pct(v)+'%</div><div class="tip-prob-odd">'+(rawOdd!=null?(+rawOdd).toFixed(2):odd(v))+'</div></div>'}
function modalProbCard(m,r){
  if(!m||!m.h||!m.a||m.h==='?'||m.a==='?')return'';
  if(!r||!r.odds){let lr=m.id?LIVE_RESULTS[m.id]:null;if(lr&&lr.odds)r=lr;}
  let odds=liveOrCachedOdds(m,r),p=matchProbWithMarket(m,r),outcome=null;
  if(r&&r.finished&&validScore(r.h)&&validScore(r.a))outcome=r.h>r.a?'home':r.h<r.a?'away':'draw';
  let market=odds&&validOdds(odds.h)&&validOdds(odds.d)&&validOdds(odds.a)?odds:null;
  let subtitle=market?'Piaci odds (70%) + Elo (30%)':'Elo + keretérték';
  return '<div class="tip-prob-card"><div class="tip-prob-title"><span>Modellezett esélyek</span><span>'+esc(subtitle)+'</span></div>'
    +probRow(modalTeamName(m.h),p.home,'linear-gradient(90deg,#27c96a,#8df0b0)',outcome==='home',market?market.h:null)
    +probRow('Döntetlen',p.draw,'linear-gradient(90deg,#7e8c96,#c8d2d8)',outcome==='draw',market?market.d:null)
    +probRow(modalTeamName(m.a),p.away,'linear-gradient(90deg,#6ec6ff,#9ba7ff)',outcome==='away',market?market.a:null)
    +'</div>'
}
function refreshOpenMatchModalModel(){
  let ov=document.querySelector('.tip-overlay[data-tip-id]');
  if(!ov)return false;
  let id=ov.dataset.tipId,isKo=ov.dataset.tipKind==='postseason';
  let m=isKo?findKoMatch(id):findRegularMatch(id);
  if(!m)return false;

  let teams=ov.querySelectorAll('.tip-team');
  if(teams[0]){
    let meta=teams[0].querySelector('.tip-team-meta');
    if(meta)meta.innerHTML=modelMeta(m.h);
  }
  if(teams[1]){
    let meta=teams[1].querySelector('.tip-team-meta');
    if(meta)meta.innerHTML=modelMeta(m.a);
  }

  let oldCard=ov.querySelector('.tip-prob-card');
  let html=modalProbCard(m,actualFor({id}));
  if(oldCard&&html){
    let holder=document.createElement('div');
    holder.innerHTML=html;
    let next=holder.firstElementChild;
    if(next)oldCard.replaceWith(next);
  }
  return true;
}
function modalSheetGrade(tip,r,isKo){
  if(!tip||!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return r&&r.started?' live-locked':'';
  let g=isKo?gradeKoTip(tip,r):gradeTip(tip,r);
  return g.cat?' result-'+g.cat:'';
}



function modalBarajAggregateHtml(m,p){
  if(!m||!superligaIsSurvivalBarajSecondLeg(m.id))return'';
  return '<div class="baraj-modal-aggregate" data-baraj-aggregate>'
    +'<div class="baraj-modal-aggregate-head"><span>Összesítés</span><small>oda-visszavágó</small></div>'
    +'<div class="baraj-modal-first-leg" data-baraj-first-leg></div>'
    +'<strong class="baraj-modal-aggregate-score" data-baraj-aggregate-score>–</strong>'
    +'<div class="baraj-modal-aggregate-note" data-baraj-aggregate-note></div>'
  +'</div>';
}
function modalBarajPenaltyHtml(m,p,locked){
  if(!m||!(superligaIsConferenceBaraj(m.id)||superligaIsSurvivalBarajSecondLeg(m.id)))return'';
  let state=superligaBarajPenaltyState(m,p?.h,p?.a),show=!!state.needed,dis=locked||!show?' disabled':'';
  return '<div class="penalty-box'+(show?'':' hidden')+'" data-baraj-penalty-box'+(show?'':' hidden')+' aria-hidden="'+(show?'false':'true')+'">'
    +'<div class="penalty-title"><span>Tizenegyesek</span><span>'+(superligaIsSurvivalBarajSecondLeg(m.id)?'csak összesített döntetlennél':'csak döntetlennél')+'</span></div>'
    +'<div class="penalty-grid"><div class="pen-team">'+esc(modalTeamName(m.h))+'</div><div class="pen-inputs">'
      +'<input id="penH" type="number" min="0" max="99" inputmode="numeric" autocomplete="off" value="'+esc(p?.pH??'')+'" aria-label="Hazai tizenegyesek"'+dis+'><span class="tip-dash">-</span>'
      +'<input id="penA" type="number" min="0" max="99" inputmode="numeric" autocomplete="off" value="'+esc(p?.pA??'')+'" aria-label="Idegen tizenegyesek"'+dis+'>'
    +'</div><div class="pen-team">'+esc(modalTeamName(m.a))+'</div></div>'
    +'<div class="pen-note">'+(superligaIsSurvivalBarajSecondLeg(m.id)?'A visszavágó pályaválasztása szerinti tizenegyeseredményt add meg.':'Döntetlennél add meg a tizenegyespárbaj eredményét is.')+'</div>'
  +'</div>';
}
function modalUpdateBarajState(ov,m,locked){
  if(!ov||!m)return;
  let h=ov.querySelector('#tipH')?.value??'',a=ov.querySelector('#tipA')?.value??'',state=superligaBarajPenaltyState(m,h,a);
  let card=ov.querySelector('[data-baraj-aggregate]');
  if(card){
    let first=card.querySelector('[data-baraj-first-leg]'),score=card.querySelector('[data-baraj-aggregate-score]'),note=card.querySelector('[data-baraj-aggregate-note]'),aggregate=state.aggregate;
    card.classList.remove('is-tied','has-winner','is-pending');
    if(aggregate?.firstMatch&&aggregate?.firstScore&&!aggregate.firstScore.pending){
      first.textContent='1. mérkőzés ('+(aggregate.firstScore.source==='actual'?'lezárt':'tipp')+'): '+modalTeamName(aggregate.firstMatch.h)+' '+aggregate.firstScore.h+' - '+aggregate.firstScore.a+' '+modalTeamName(aggregate.firstMatch.a);
    }else first.textContent='Az első mérkőzéshez még nincs használható tipp vagy végeredmény.';
    if(!aggregate?.ready){
      score.textContent='Összesítés: –';
      note.textContent=aggregate?.reason==='first-leg-live'?'Az első mérkőzés még folyamatban van.':'Add meg az első mérkőzés tippjét vagy várd meg a végeredményét.';
      card.classList.add('is-pending');
    }else{
      score.textContent=modalTeamName(aggregate.homeTeam)+' '+aggregate.h+' - '+aggregate.a+' '+modalTeamName(aggregate.awayTeam);
      if(aggregate.tied){note.textContent='Az összesítés döntetlen — tizenegyespárbaj szükséges.';card.classList.add('is-tied')}
      else{note.textContent='Továbbjutó / bennmaradó: '+modalTeamName(aggregate.winner);card.classList.add('has-winner')}
    }
  }
  let box=ov.querySelector('[data-baraj-penalty-box]'),penH=ov.querySelector('#penH'),penA=ov.querySelector('#penA');
  if(box&&penH&&penA){
    let show=!!state.needed;
    box.classList.toggle('hidden',!show);box.hidden=!show;box.setAttribute('aria-hidden',show?'false':'true');
    penH.disabled=locked||!show;penA.disabled=locked||!show;
  }
}
function modalWireBarajState(ov,m,locked){
  if(!ov||!m||!(superligaIsConferenceBaraj(m.id)||superligaIsSurvivalBarajSecondLeg(m.id)))return;
  let h=ov.querySelector('#tipH'),a=ov.querySelector('#tipA'),sync=()=>modalUpdateBarajState(ov,m,locked);
  if(h&&a){['input','change'].forEach(evt=>{h.addEventListener(evt,sync);a.addEventListener(evt,sync)})}
  sync();
}

function openMatchTipModal(cfg){
  const m=cfg.match,isKo=!!cfg.isKo,id=m.id;
  if(FROZEN_MODE&&!READONLY_MODE)return;
  document.querySelectorAll('.tip-overlay').forEach(el=>el.remove());
  let r=actualFor({id}),state=isKo?(m.locked?'locked':matchLockState({id})) : matchLockState(m);
  let locked=READONLY_MODE||FROZEN_MODE||m.locked||state!=='open';
  let p=isKo?(koPred(id)||{}):(getPred(id)||{});
  let hasReal=modalScoreIsReal(r,locked),dis=locked?' disabled':'',grade=modalSheetGrade(p,r,isKo);
  let scoreBox=hasReal
    ? '<div class="tip-score tip-score-real"><div class="tip-real-cell tip-real-h">'+esc(r.h)+'</div><span class="tip-dash">-</span><div class="tip-real-cell tip-real-a">'+esc(r.a)+'</div><input id="tipH" type="hidden" value="'+esc(p.h??'')+'"><input id="tipA" type="hidden" value="'+esc(p.a??'')+'"></div>'
    : '<div class="tip-score"><input id="tipH" type="number" min="0" max="99" inputmode="numeric" autocomplete="off" value="'+esc(p.h??'')+'" aria-label="Hazai gól"'+dis+'><span class="tip-dash">-</span><input id="tipA" type="number" min="0" max="99" inputmode="numeric" autocomplete="off" value="'+esc(p.a??'')+'" aria-label="Idegen gól"'+dis+'></div>';
  let yourTipHtml=(hasReal&&validScore(p.h)&&validScore(p.a))?'<div class="tip-your-tip-banner'+(grade.trim()?(' grade-'+grade.trim().replace('result-','').replace('live-locked','')):'')+'"><span class="tip-your-tip-label">A te tipped</span><span class="tip-your-tip-score">'+esc(p.h)+' - '+esc(p.a)+'</span></div>':'';
  let title=locked?'Mérkőzés állapota':'Mérkőzés tippelése';
  let phase=isKo?(m.title||postseasonCategory(m)||'Rájátszás'):(compLabel(m.g)+' · '+m.r+'. forduló');
  let date=isKo?matchDateTitle(m.date||'Rájátszás'):localMatchDate(m);
  let time=isKo?(m.t||'21:00'):localMatchTime(m);
  let lockNote=locked
    ? '<div class="sheet-verdict"><b>Zárolva</b> A mérkőzés már elkezdődött, lezárult, vagy az ág még nem tippelhető, ezért a tipped nem módosítható.</div>'
    : '<div class="sheet-verdict"><b>Mentés után</b> a tabella, playoff/playout és statisztika automatikusan újraszámolódik.</div>';
  let ov=document.createElement('div');
  ov.className='overlay tip-overlay';
  ov.dataset.tipId=id;
  ov.dataset.tipKind=isKo?'postseason':'regular';
  ov.innerHTML='<div class="sheet tip-sheet '+grade+'"><div class="sheet-top"><div class="sheet-pill"></div><button class="sheet-x" type="button" data-close-tip>&times;</button></div><div class="sheet-title">'+esc(title)+'</div><div class="tip-head"><span>'+esc(date)+' &middot; '+esc(phase)+'</span><span class="tip-time-pill">🕒 '+esc(time)+'</span></div>'+yourTipHtml+'<div class="tip-match"><div class="tip-teams"><div class="tip-team">'+crest(m.h)+'<span>'+esc(modalTeamName(m.h))+'</span><div class="tip-team-meta">'+modelMeta(m.h)+'</div></div>'+scoreBox+superligaModalStatusHtml(r)+'<div class="tip-team">'+crest(m.a)+'<span>'+esc(modalTeamName(m.a))+'</span><div class="tip-team-meta">'+modelMeta(m.a)+'</div></div></div>'+modalGoalRows(r,m)+'</div>'+modalProbCard(m,r)+modalBarajAggregateHtml(m,p)+modalBarajPenaltyHtml(m,p,locked)+'<div class="tip-msg" id="tipMsg"></div><div class="tip-actions"><button class="tip-btn clear" type="button" data-clear-tip'+dis+'>Tipp törlése</button><button class="tip-btn save" type="button" data-save-tip'+dis+'>'+(locked?'Zárolva':'Mentés')+'</button></div>'+lockNote+'</div>';
  document.body.appendChild(ov);
  syncModalOpenClass();
  activateCrests();
  if(isKo)modalWireBarajState(ov,m,locked);
  ov.onclick=e=>{if(e.target===ov||e.target.closest('[data-close-tip]'))closeTip()};
  ov.querySelector('[data-save-tip]').onclick=()=>{if(!locked)(isKo?saveKoTip(id):saveTip(id))};
  ov.querySelector('[data-clear-tip]').onclick=async()=>{if(locked)return;if(isKo){await superligaDeleteKoTip(id)}else{await superligaDeleteGroupTip(id)}closeTip();render()};
  requestAnimationFrame(()=>{
    let sheet=ov.querySelector('.tip-sheet');
    if(sheet)sheet.scrollTop=0;
  });
}
function openTip(id){let m=findRegularMatch(id);if(m)openMatchTipModal({match:m,isKo:false})}
async function saveTip(id){
  if(READONLY_MODE)return;
  let m=findRegularMatch(id),ov=document.querySelector('.tip-overlay[data-tip-id="'+CSS.escape(id)+'"]'),msg=ov&&ov.querySelector('#tipMsg');
  if(!m||!ov)return;
  if(matchLockState(m)!=='open'){if(msg)msg.textContent='Ez a mérkőzés már elkezdődött vagy lezárult, ezért nem módosítható.';return}
  let h=ov.querySelector('#tipH').value,a=ov.querySelector('#tipA').value;
  if(h===''&&a===''){await superligaDeleteGroupTip(id);closeTip();render();return}
  if(!validScore(h)||!validScore(a)){if(msg)msg.textContent='Adj meg két 0 és 99 közötti egész számot.';return}
  PRED[id]={h:+h,a:+a,hTeam:m.h,aTeam:m.a,round:m.r};
  await superligaPersistTipsNow();
  closeTip();
  render();
}
function openKoTip(id){let m=findKoMatch(id);if(m)openMatchTipModal({match:m,isKo:true})}
async function saveKoTip(id){
  if(READONLY_MODE)return;
  let m=findKoMatch(id),ov=document.querySelector('.tip-overlay[data-tip-id="'+CSS.escape(id)+'"]'),msg=ov&&ov.querySelector('#tipMsg');
  if(!m||!ov)return;
  let r=actualFor({id});
  if(m.locked||r&&r.started){if(msg)msg.textContent='Ez a mérkőzés még nem tippelhető, már elkezdődött, vagy lezárult.';return}
  let h=ov.querySelector('#tipH').value,a=ov.querySelector('#tipA').value;
  if(h===''&&a===''){await superligaDeleteKoTip(id);closeTip();render();return}
  if(!validScore(h)||!validScore(a)){if(msg)msg.textContent='Adj meg két 0 és 99 közötti egész számot.';return}
  let penaltyState=superligaBarajPenaltyState(m,h,a),payload={h:+h,a:+a,hTeam:m.h,aTeam:m.a,round:m.title||m.r,seedSignature:superligaPostseasonSeedSignature()};
  if(superligaIsSurvivalBarajSecondLeg(id)&&!penaltyState.aggregate?.ready){
    if(msg)msg.textContent=penaltyState.aggregate?.reason==='first-leg-live'?'Az első mérkőzés még nem zárult le, ezért az összesítés nem számolható.':'A visszavágó előtt add meg az első mérkőzés tippjét vagy várd meg annak végeredményét.';
    return;
  }
  if(penaltyState.aggregate?.ready){
    Object.assign(payload,{firstLegId:penaltyState.aggregate.firstId,firstLegH:+penaltyState.aggregate.firstScore.h,firstLegA:+penaltyState.aggregate.firstScore.a,aggregateH:+penaltyState.aggregate.h,aggregateA:+penaltyState.aggregate.a,aggregateHomeTeam:penaltyState.aggregate.homeTeam,aggregateAwayTeam:penaltyState.aggregate.awayTeam,aggregateTied:!!penaltyState.aggregate.tied});
  }
  if(penaltyState.needed){
    let pH=ov.querySelector('#penH')?.value??'',pA=ov.querySelector('#penA')?.value??'';
    if(!superligaValidPenaltyScore(pH)||!superligaValidPenaltyScore(pA)){if(msg)msg.textContent=superligaIsSurvivalBarajSecondLeg(id)?'Döntetlen összesítésnél add meg a tizenegyespárbaj eredményét is.':'Döntetlennél add meg a tizenegyespárbaj eredményét is.';return}
    if(+pH===+pA){if(msg)msg.textContent='A tizenegyespárbaj nem végződhet döntetlenre.';return}
    payload.pH=+pH;payload.pA=+pA;payload.decidedBy='penalties';
  }else payload.decidedBy=superligaIsSurvivalBarajSecondLeg(id)?'aggregate':'regular-time';
  KO_PRED[id]=payload;
  await superligaPersistTipsNow();
  closeTip();
  render();
}

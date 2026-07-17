// Playoff, playout and baraj generation plus match display helpers


function calcFullStandings(){let oldRound=S.tblRound;S.tblRound=0;let rows=groupRows(GROUPS[0]);S.tblRound=oldRound;return rows}
function groupsComplete(){return FX.every(m=>getPred(m.id)||((LIVE_RESULTS[m.id]||{}).finished&&validScore(LIVE_RESULTS[m.id].h)&&validScore(LIVE_RESULTS[m.id].a)))}
function splitPostseason(){let st=calcFullStandings();return{po:st.slice(0,6),pl:st.slice(6,16)}}
function roundRobin(names,doubleRound){let arr=names.slice(),bye=null;if(arr.length%2){bye='__BYE__';arr.push(bye)}let n=arr.length,rounds=[];for(let r=0;r<n-1;r++){let pairs=[];for(let i=0;i<n/2;i++){let h=arr[i],a=arr[n-1-i];if(h!==bye&&a!==bye){if(r%2)pairs.push([a,h]);else pairs.push([h,a])}}rounds.push(pairs);arr=[arr[0]].concat([arr[n-1]],arr.slice(1,n-1))}if(doubleRound){let second=rounds.map(rd=>rd.map(p=>[p[1],p[0]]));rounds=rounds.concat(second)}return rounds}
function koRoundDate(kind,r){let base=kind==='PO'?Date.parse('2027-03-20T21:00:00'):Date.parse('2027-03-21T21:00:00'),d=new Date(base+(r-1)*7*86400000),pad=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function buildPostseasonMatches(){let sp=splitPostseason(),poNames=sp.po.map(x=>x.name),plNames=sp.pl.map(x=>x.name),locked=!groupsComplete(),out=[];roundRobin(poNames,true).forEach((rd,ri)=>rd.forEach((p,i)=>out.push({id:'PO-'+(ri+1)+'-'+(i+1),g:'PO',r:'PO'+(ri+1),date:koRoundDate('PO',ri+1),t:'21:00',d:'Playoff '+(ri+1)+'. forduló',title:'Playoff '+(ri+1)+'. forduló',index:i+1,h:p[0],a:p[1],locked})));roundRobin(plNames,false).forEach((rd,ri)=>rd.forEach((p,i)=>out.push({id:'PL-'+(ri+1)+'-'+(i+1),g:'PL',r:'PL'+(ri+1),date:koRoundDate('PL',ri+1),t:'21:00',d:'Playout '+(ri+1)+'. forduló',title:'Playout '+(ri+1)+'. forduló',index:i+1,h:p[0],a:p[1],locked})));return out}
function koWinner(m){let p=KO_PRED[m.id]||actualFor(m);if(!p||!validScore(p.h)||!validScore(p.a))return null;if(+p.h===+p.a)return null;return +p.h>+p.a?m.h:m.a}
function buildBarajMatches(){let sp=splitPostseason(),po=postseasonStandings('PO',sp.po,'all'),pl=postseasonStandings('PL',sp.pl,'all'),pl7=pl[0]?.name||'Playout 7.',pl8=pl[1]?.name||'Playout 8.',po3=po[2]?.name||'Playoff 3.',pl13=pl[6]?.name||'Playout 13.',pl14=pl[7]?.name||'Playout 14.',ready=postseasonComplete(),cb1={id:'CB-1-1',g:'CB',r:'CB1',date:'2027-05-24',t:'21:00',d:'Konferencialiga-baraj elődöntő',title:'Konferencialiga-baraj elődöntő',index:1,h:pl7,a:pl8,locked:!ready},cbWinner=koWinner(cb1)||'ECL-elődöntő győztese',cb2={id:'CB-2-1',g:'CB',r:'CB2',date:'2027-05-28',t:'21:00',d:'Konferencialiga-baraj döntő',title:'Konferencialiga-baraj döntő',index:1,h:po3,a:cbWinner,locked:!ready||!koWinner(cb1)},rel=[{id:'BR-1-1',g:'BR',r:'BR1',date:'2027-05-29',t:'21:00',d:'Bentmaradás-baraj 1. párharc - 1. mérkőzés',title:'Bentmaradás-baraj 1. párharc - 1. mérkőzés',index:1,h:pl13,a:'Liga 2 rájátszás 3. hely',locked:!ready},{id:'BR-1-2',g:'BR',r:'BR1',date:'2027-06-02',t:'21:00',d:'Bentmaradás-baraj 1. párharc - visszavágó',title:'Bentmaradás-baraj 1. párharc - visszavágó',index:2,h:'Liga 2 rájátszás 3. hely',a:pl13,locked:!ready},{id:'BR-2-1',g:'BR',r:'BR2',date:'2027-05-30',t:'21:00',d:'Bentmaradás-baraj 2. párharc - 1. mérkőzés',title:'Bentmaradás-baraj 2. párharc - 1. mérkőzés',index:1,h:pl14,a:'Liga 2 rájátszás 4. hely',locked:!ready},{id:'BR-2-2',g:'BR',r:'BR2',date:'2027-06-03',t:'21:00',d:'Bentmaradás-baraj 2. párharc - visszavágó',title:'Bentmaradás-baraj 2. párharc - visszavágó',index:2,h:'Liga 2 rájátszás 4. hely',a:pl14,locked:!ready}];return[cb1,cb2].concat(rel)}
function buildAllPostseasonMatches(){return buildPostseasonMatches().concat(buildBarajMatches())}
function findKoMatch(id){return buildAllPostseasonMatches().find(m=>m.id===id)||null}
function postseasonComplete(){let ms=buildPostseasonMatches();return ms.length&&ms.every(m=>KO_PRED[m.id]||((LIVE_RESULTS[m.id]||{}).finished&&validScore(LIVE_RESULTS[m.id].h)&&validScore(LIVE_RESULTS[m.id].a)))}
function postseasonRoundOptions(){let a=[];for(let i=1;i<=10;i++)a.push({key:'R'+i,label:'Rájátszás '+i+'. forduló'});a.push({key:'CB1',label:'ECL elődöntő'},{key:'CB2',label:'ECL döntő'},{key:'BR1',label:'Baraj 1'},{key:'BR2',label:'Baraj 2'});return a}
function postseasonCategory(m){return m.g==='PO'?'Playoff':m.g==='PL'?'Playout':m.g==='CB'?'Konferencialiga-baraj':'Bentmaradás-baraj'}
function koPred(id){let p=KO_PRED[id];if(!p||!validScore(p.h)||!validScore(p.a))return null;return{h:+p.h,a:+p.a}}
function resultForMatch(m,isKo){let r=actualFor(m);if(r&&(r.started||r.finished)&&validScore(r.h)&&validScore(r.a))return r;return isKo?koPred(m.id):getPred(m.id)}
function matchStageText(m,isKo){
  if(!isKo)return m.r+'. forduló';
  if(m.g==='PO')return 'Playoff '+String(m.r||'').replace('PO','')+'. ford.';
  if(m.g==='PL')return 'Playout '+String(m.r||'').replace('PL','')+'. ford.';
  if(m.g==='CB')return m.r==='CB1'?'ECL elődöntő':'ECL döntő';
  if(m.g==='BR'){
    let leg=m.index===2?'visszavágó':'1. meccs';
    return (m.r==='BR2'?'Baraj 2':'Baraj 1')+' · '+leg;
  }
  return 'Rájátszás';
}
function matchDateTitle(k){if(!k||k==='Rájátszás')return'Rájátszás';if(/^\d{4}-\d{2}-\d{2}$/.test(k)){let d=new Date(k+'T12:00:00+03:00');return d.toLocaleDateString('hu-HU',{month:'short',day:'numeric',timeZone:'Europe/Bucharest'}).replace(/\u00a0/g,' ')}return k}
function matchGradeClass(tip,r,isKo){if(!tip||!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return'';let g=isKo?gradeKoTip(tip,r):gradeTip(tip,r);return' result-'+(g.cat==='exact'?'exact':g.cat==='diff'?'diff':g.cat==='outcome'?'outcome':'miss')}
function superligaHasPenScore(obj){return obj&&validScore(obj.pH)&&validScore(obj.pA)}
function superligaPenPair(obj){return superligaHasPenScore(obj)?(+obj.pH)+'-'+(+obj.pA):''}
function superligaMiniPen(v){return validScore(v)?'<span class="wc26-mini-pen-label">('+esc(v)+')</span>':''}
function superligaScoreWithPen(score,pen){return superligaMiniPen(pen)+'<span>'+esc(score)+'</span>'}
function liveClockLabel(r){
  if(!r||r.finished)return'';
  let vals=[r.minute,r.status,r.matchMinute,r.elapsed,r.currentMinute,r.liveMinute,r.matchTime,r.time,r.statusMinute];
  let raw=vals.map(v=>v==null?'':String(v).trim()).find(Boolean)||'';
  let up=raw.toUpperCase();
  if(up==='HT'||up.includes('HALF'))return'HT';
  if(up==='INT'||up.includes('INTERVAL'))return'INT.';
  if(raw&&up!=='LIVE'&&raw!=='Élő')return raw;
  return'Élő';
}
function superligaStatusPills(r,opts={}){
  if(!r)return'';
  let s=String((r.status||'')+' '+(r.minute||'')+' '+(r.period||'')+' '+(r.shortDetail||'')+' '+(r.displayClock||'')).toUpperCase();
  let pills=[];
  const finished=!!r.finished||s==='FT'||s.includes('FULL TIME')||s.includes('FINAL')||s.includes('FINISHED');
  if(!finished&&(s==='HT'||s.includes('HALF')||/\bHT\b/.test(s)))pills.push(['ht','HT']);
  if(opts.mode!=='card'){
    if(finished)pills.push(['ft','FT']);
    if(superligaHasPenScore(r)||s.includes('PEN')||s.includes('AFTER PEN')||/\bAP\b/.test(s))pills.push(['pen','PEN']);
    else if(s.includes('AET'))pills.push(['aet','AET']);
  }
  if(!pills.length)return'';
  return '<span class="wc26-state-indicators">'+pills.map(([c,t])=>'<span class="wc26-status-pill '+c+'">'+t+'</span>').join('')+'</span>';
}
function superligaCardTipPenHtml(p){return superligaHasPenScore(p)?'<em class="mr-tip-pen">PEN '+superligaPenPair(p)+'</em>':''}
function superligaCompactCardScore(score){return '<span>'+esc(score)+'</span>'}
function superligaPenaltyIndicatorHtml(obj,cls=''){
  if(!superligaHasPenScore(obj))return '';
  return '<span class="mr-pen-indicator'+(cls?' '+cls:'')+'"><span class="lab">PEN</span><b class="val">'+esc(obj.pH)+'-'+esc(obj.pA)+'</b></span>';
}
function superligaGradeBadge(cat){
  if(cat==='exact'||cat==='exact-pen-exact')return'<em class="mr-live-state ok">Pontos</em>';
  if(cat==='diff'||cat==='exact-pen-diff'||cat==='draw-pen-diff')return'<em class="mr-live-state diff">G&oacute;lk&uuml;l.</em>';
  if(cat==='outcome'||cat==='exact-pen-outcome'||cat==='draw-pen-outcome'||cat==='draw')return'<em class="mr-live-state outcome">Kimenetel</em>';
  if(cat==='miss')return'<em class="mr-live-state bad">Hib&aacute;s</em>';
  return'';
}
function matchTipBadge(m,isKo){let tip=isKo?koPred(m.id):getPred(m.id);return tip?'<em class="mr-tip">Tippelve</em>':''}
function matchStateBadge(m,isKo){
  let tip=isKo?koPred(m.id):getPred(m.id),r=actualFor(m),st=isKo?(m.locked?'locked':matchLockState({id:m.id})):matchLockState(m);
  if(tip&&r&&(r.started||r.finished)&&validScore(r.h)&&validScore(r.a)){
    let g=isKo?gradeKoTip(tip,r):gradeTip(tip,r),grade=superligaGradeBadge(g.cat);
    if(grade)return grade;
  }
  if(st==='finished')return'';
  if(st==='live')return'<em class="mr-live-state live"><span></span>'+(esc(liveClockLabel(r)||'Élő'))+'</em>';
  if(st==='open')return'<em class="mr-live-state open">Tippelhet&#337;</em>';
  return'<em class="mr-live-state neutral">Z&aacute;rolva</em>';
}
function scoreHtml(m,isKo){
  let tip=isKo?koPred(m.id):getPred(m.id),r=actualFor(m),hasReal=r&&(r.started||r.finished||matchLockState({id:m.id})!=="open")&&validScore(r.h)&&validScore(r.a),clock=liveClockLabel(r),rawSt=r&&r.status?String(r.status).toUpperCase():'',isInt=rawSt.includes('INT'),lines='';
  if(tip&&hasReal){
    lines='<div class="mr-score-compare">'
      +'<div class="mr-score-row"><span class="mr-score-real">'+superligaCompactCardScore(r.h)+'</span><span class="mr-score-tip">'+esc(tip.h)+'</span></div>'
      +'<div class="mr-score-row"><span class="mr-score-real">'+superligaCompactCardScore(r.a)+'</span><span class="mr-score-tip">'+esc(tip.a)+'</span></div>'
      +'</div>';
  }else if(tip){
    lines='<div class="mr-score-tip-only">'
      +'<div class="mr-score-row single"><span class="mr-score-single">'+superligaCompactCardScore(tip.h)+'</span></div>'
      +'<div class="mr-score-row single"><span class="mr-score-single">'+superligaCompactCardScore(tip.a)+'</span></div>'
      +'</div>';
  }else if(hasReal){
    lines='<div class="mr-score-actual-only">'
      +'<div class="mr-score-row single"><span class="mr-score-single">'+superligaCompactCardScore(r.h)+'</span></div>'
      +'<div class="mr-score-row single"><span class="mr-score-single">'+superligaCompactCardScore(r.a)+'</span></div>'
      +'</div>';
  }else lines='<div class="match-empty">-</div><div class="match-empty">-</div>';
  let penObj=hasReal&&superligaHasPenScore(r)?r:(tip&&superligaHasPenScore(tip)?tip:null);
  let scoreMain='<div class="mr-score-main'+(penObj?' has-pen':'')+'"><div class="mr-score-lines">'+lines+'</div>'+superligaPenaltyIndicatorHtml(penObj,'side')+'</div>';
  let pills=superligaStatusPills(r,{mode:'card'}),clockRow=(hasReal&&r&&!r.finished&&(clock||isInt||pills))?'<div class="mr-clock-row">'+pills+(clock?'<span class="mr-clock">'+esc(clock)+'</span>':'')+(isInt?'<span class="mr-int-badge">INT.</span>':'')+'</div>':'';
  return clockRow?'<div class="mr-score-wrap '+(tip?'':'no-tip')+'">'+clockRow+scoreMain+'</div>':scoreMain;
}

// Matches, KO, baraj and stats renderers

function matchRow(m,isKo){
  let tip=isKo?koPred(m.id):getPred(m.id),r=actualFor(m),locked=isKo?(m.locked||!!(r&&r.started)):matchLockState(m)!=='open',live=r&&r.started&&!r.finished,done=r&&r.finished,cls=(done?' finished':live?' live-locked':tip?' predicted':'')+(locked?' locked':'')+matchGradeClass(tip,r,!!isKo),attr=isKo?'data-ko-mid':'data-mid',edit=(FROZEN_MODE&&!READONLY_MODE)||locked?'':'<div class="mr-bell">✎</div>';
  return '<div class="match-row'+cls+'" '+attr+'="'+esc(m.id)+'" role="button" tabindex="0">'
    +'<div class="mr-date">'+esc(m.t||'21:00')+'<span>'+esc(matchStageText(m,!!isKo))+'</span>'+matchTipBadge(m,!!isKo)+matchStateBadge(m,!!isKo)+'</div>'
    +'<div class="mr-sep"></div>'
    +'<div class="mr-teams"><div class="mr-team">'+crest(m.h)+'<span class="mr-tname">'+esc(stn(m.h))+'</span></div><div class="mr-team">'+crest(m.a)+'<span class="mr-tname">'+esc(stn(m.a))+'</span></div></div>'
    +'<div class="mr-scores">'+scoreHtml(m,!!isKo)+'</div>'+edit+'</div>';
}
function bindMatchCardOpeners(root){
  if(!root)return;
  root.onclick=e=>{
    let row=e.target.closest&&e.target.closest('[data-mid],[data-ko-mid]');
    if(!row||!root.contains(row))return;
    e.preventDefault();e.stopPropagation();
    if(row.dataset.mid)openTip(row.dataset.mid);
    else if(row.dataset.koMid)openKoTip(row.dataset.koMid);
  };
  root.onkeydown=e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    let row=e.target.closest&&e.target.closest('[data-mid],[data-ko-mid]');
    if(!row||!root.contains(row))return;
    e.preventDefault();
    if(row.dataset.mid)openTip(row.dataset.mid);
    else if(row.dataset.koMid)openKoTip(row.dataset.koMid);
  };
  root.querySelectorAll('[data-mid],[data-ko-mid]').forEach(el=>{
    el.onclick=e=>{
      e.preventDefault();e.stopPropagation();
      if(el.dataset.mid)openTip(el.dataset.mid);
      else if(el.dataset.koMid)openKoTip(el.dataset.koMid);
    };
  });
}
function matchRoundTitle(key){if(/^\d+$/.test(String(key)))return key+'. forduló';let opt=postseasonRoundOptions().find(o=>o.key===key);return opt?opt.label:String(key)}function renderMatches(){
  let m=document.getElementById('main');m.className='main matches-main';
  let base=FX.slice(),post=buildAllPostseasonMatches(),all=base.concat(post),list=[];
  if(MS.filt==='round'){let key=MS.round;if(/^\d+$/.test(String(key)))list=base.filter(x=>x.r===+key);else list=post.filter(x=>x.r===key)}
  else if(MS.filt==='team'){let t=MS.team||ALL[0];list=all.filter(x=>x.h===t||x.a===t)}
  else list=all.slice().sort((a,b)=>matchSortKey(a).localeCompare(matchSortKey(b)));
  function section(title,arr){let groups={};arr.sort((a,b)=>matchSortKey(a).localeCompare(matchSortKey(b))).forEach(x=>{let label=x.g==='SL'?(compLabel(x.g)+' · '+x.r+'. forduló'):postseasonCategory(x);(groups[label]||(groups[label]=[])).push(x)});return'<section class="card"><h2 class="card-title">'+esc(matchDateTitle(title))+'</h2>'+Object.entries(groups).map(([label,rows])=>'<div class="round-comp"><span>🏆</span><b>'+esc(label)+'</b></div><div class="matches">'+rows.map(x=>matchRow(x,x.g!=='SL')).join('')+'</div>').join('')+'</section>'}
  let out='';
  if(MS.filt==='round'){out=section(matchRoundTitle(MS.round),list)}
  else{let by={};list.forEach(x=>{let k=x.date||'Rájátszás';(by[k]||(by[k]=[])).push(x)});out=Object.entries(by).map(([k,arr])=>section(k,arr)).join('')}
  m.innerHTML=out||'<section class="card"><div class="updated">Nincs megjeleníthető mérkőzés.</div></section>';
  activateCrests();
  bindMatchCardOpeners(m);
}
function postseasonCmpTeam(a,b){
  if(b.pts!==a.pts)return b.pts-a.pts;
  if(!!a.oddRegular!==!!b.oddRegular)return a.oddRegular?1:-1;
  return cmpTeam(a,b);
}
function postseasonRoundCutoff(){
  const key=String(S.postRound||'current');
  if(key==='seed')return 0;
  if(key==='current')return 99;
  const m=key.match(/^R(\d+)$/);
  return m?+m[1]:99;
}
function postseasonMatchIncluded(m){
  const cutoff=postseasonRoundCutoff();
  if(cutoff===0)return false;
  const n=+String(m.r||'').replace(/^(PO|PL)/,'');
  return Number.isFinite(n)&&n<=cutoff;
}
function postseasonStandings(kind,baseRows,filt){
  let rows={};
  baseRows.forEach(r=>{
    let row=rows[r.name]=mk(r.name,kind),raw=+(r.pts||0),base=Math.ceil(raw/2);
    row.pts=base;row.basePts=base;row.regularPts=raw;row.oddRegular=raw%2===1;
    row.home.pts=base;row.away.pts=base;
  });
  buildPostseasonMatches().filter(m=>m.g===kind&&postseasonMatchIncluded(m)).forEach(m=>{let r=actualFor(m),p=(r&&(r.started||r.finished)&&validScore(r.h)&&validScore(r.a))?r:koPred(m.id);if(p&&rows[m.h]&&rows[m.a])applyResult(rows,m,p)});
  return Object.values(rows).sort(postseasonCmpTeam)
}
function halvingMeta(baseRows){
  let items=baseRows.map(r=>{let raw=+(r.pts||0),base=Math.ceil(raw/2),star=raw%2===1?'*':'';return '<span>'+esc(stn(r.name))+star+' <b>'+base+'</b></span>'}).join('');
  return '<div class="halving-meta"><div class="halving-title">Felezés után</div><div class="halving-list">'+items+'</div><div class="halving-note">* páratlan alapszakasz-pont → pontegyenlőségnél hátrány a nem csillagozott csapatokkal szemben.</div></div>'
}
function renderKO(){
  syncTblRoundDrop();
  let m=document.getElementById('main');m.className='main';
  let sp=splitPostseason(),po=postseasonStandings('PO',sp.po,'all'),pl=postseasonStandings('PL',sp.pl,'all');
  const playoffZones=[
    {clr:'var(--green)',lbl:'Bajnok → BL-selejtező',rows:po.slice(0,1)},
    {clr:'var(--cyan)',lbl:'Európai kupaselejtező',rows:po.slice(1,2)},
    {clr:'var(--blue)',lbl:'ECL-baraj döntő',rows:po.slice(2,3)},
    {rows:po.slice(3,6)}
  ];
  const playoutZones=[
    {clr:'var(--cyan)',lbl:'ECL-baraj elődöntő',rows:pl.slice(0,2)},
    {rows:pl.slice(2,6)},
    {clr:'var(--orange)',lbl:'Bentmaradás-baraj',rows:pl.slice(6,8)},
    {clr:'var(--red)',lbl:'Kiesés Liga 2-be',rows:pl.slice(8,10)}
  ];
  m.innerHTML='<section class="card"><h2 class="card-title">Playoff</h2>'+tableHtml({key:'PO',title:'Playoff',zones:playoffZones})+halvingMeta(sp.po)+'</section><section class="card"><h2 class="card-title">Playout</h2>'+tableHtml({key:'PL',title:'Playout',zones:playoutZones})+halvingMeta(sp.pl)+'</section>';
  activateCrests()
}
function currentPostseasonSeed(){let sp=splitPostseason();return JSON.stringify({po:sp.po.map(x=>x.name),pl:sp.pl.map(x=>x.name)})}
let LAST_POSTSEASON_SEED=(function(){try{return localStorage.getItem('superliga_postseason_seed_v1')||''}catch(e){return ''}})();
function enforcePostseasonSeed(){if(FROZEN_MODE)return false;let seed=currentPostseasonSeed();if(seed===LAST_POSTSEASON_SEED)return false;LAST_POSTSEASON_SEED=seed;try{localStorage.setItem('superliga_postseason_seed_v1',seed)}catch(e){}return typeof pruneStaleKoPred==='function'?pruneStaleKoPred(false):false}function statEffForMatches(matches,preds,isKo){let out={pts:0,max:0,pct:0,exact:0,diff:0,outcome:0,miss:0};matches.forEach(m=>{let r=actualFor({id:m.id});if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return;out.max++;let g=isKo?gradeKoTip((preds||{})[m.id],r):gradeTip((preds||{})[m.id],r);out.pts+=g.pts;out[g.cat]=(out[g.cat]||0)+1});out.pct=out.max?+(out.pts/out.max*100).toFixed(2):0;return out}
function statRoundCard(label,e){let muted=e.max?'':' muted';return'<div class="stat-round-card'+muted+'"><div class="stat-round-label">'+label+'</div><div class="stat-round-pct">'+e.pct+'%</div><div class="stat-round-sub">'+fmtPts(e.pts)+' / '+e.max+' pont</div><div class="eff-mini-bar"><div class="eff-mini-bar-fill" style="width:'+Math.min(100,e.pct)+'%"></div></div><div class="eff-split-dots"><span class="eff-sdot exact">'+e.exact+' pontos</span><span class="eff-sdot diff">'+e.diff+' gólkül.</span><span class="eff-sdot outcome">'+e.outcome+' kimen.</span><span class="eff-sdot miss">'+e.miss+' téves</span></div></div>'}
function statsRoundEfficiencyHtml(){
  let cards=[];
  for(let n=1;n<=30;n++){
    let e=statEffForMatches(FX.filter(m=>m.r===n),PRED,false);
    if(e.max)cards.push([n+'. forduló',e]);
  }
  let post=[];
  try{post=buildPostseasonMatches()}catch(e){post=[]}
  for(let n=1;n<=10;n++){
    let e=statEffForMatches(post.filter(m=>m.g==='PO'&&m.r==='PO'+n),KO_PRED,true);
    if(e.max)cards.push(['Playoff '+n+'. forduló',e]);
  }
  for(let n=1;n<=9;n++){
    let e=statEffForMatches(post.filter(m=>m.g==='PL'&&m.r==='PL'+n),KO_PRED,true);
    if(e.max)cards.push(['Playout '+n+'. forduló',e]);
  }
  let bar=[];
  try{bar=buildBarajMatches()}catch(e){bar=[]}
  [
    ['ECL elődöntő',bar.filter(m=>m.r==='CB1')],
    ['ECL döntő',bar.filter(m=>m.r==='CB2')],
    ['Baraj 1 · 1. meccs',bar.filter(m=>m.id==='BR-1-1')],
    ['Baraj 1 · visszavágó',bar.filter(m=>m.id==='BR-1-2')],
    ['Baraj 2 · 1. meccs',bar.filter(m=>m.id==='BR-2-1')],
    ['Baraj 2 · visszavágó',bar.filter(m=>m.id==='BR-2-2')]
  ].forEach(pair=>{
    let e=statEffForMatches(pair[1],KO_PRED,true);
    if(e.max)cards.push([pair[0],e]);
  });
  if(!cards.length){
    return '<section class="card stat-round-section"><h2 class="card-title">Hatékonyság fordulónként</h2><div class="stat-round-empty">Még nincs élő vagy lezárt meccs. Amint lesz eredmény, itt külön kártyán jelenik meg minden konkrét forduló: alapszakasz, playoff, playout, ECL-baraj és bentmaradás-baraj.</div></section>';
  }
  return '<section class="card stat-round-section"><h2 class="card-title">Hatékonyság fordulónként</h2><div class="stat-round-grid">'+cards.map(x=>statRoundCard(x[0],x[1])).join('')+'</div></section>';
}function barajMatchTone(m){
  if(m.locked)return ' locked';
  let r=actualFor(m),tip=koPred(m.id);
  if(r&&r.started&&!r.finished)return ' live';
  if(r&&r.finished)return ' finished';
  if(tip)return ' predicted';
  return '';
}
function barajScore(m){
  let r=actualFor(m),tip=koPred(m.id),hasReal=r&&validScore(r.h)&&validScore(r.a),p=hasReal?r:tip;
  if(!p)return'<em>–</em>';
  let pen=superligaHasPenScore(p)?'<small class="baraj-score-pen"><span>PEN</span><b>'+esc(p.pH)+'-'+esc(p.pA)+'</b></small>':'';
  return '<div class="baraj-score-stack"><div class="baraj-score-main">'+esc(p.h)+'<span>-</span>'+esc(p.a)+'</div>'+pen+'</div>';
}
function barajResultSource(m){
  let r=actualFor(m),tip=koPred(m.id);
  if(r&&r.finished&&validScore(r.h)&&validScore(r.a))return 'Lezárt';
  if(r&&r.started&&validScore(r.h)&&validScore(r.a))return liveClockLabel(r)||'Élő';
  if(tip)return 'Tipp';
  if(m.locked)return 'Zárolva';
  return 'Tippelhető';
}
function barajTeamHtml(name,side){
  return '<div class="baraj-team '+side+'">'+crest(name,'30px')+'<span>'+esc(stn(name))+'</span></div>'
}
function barajMiniMatch(m){
  return '<button class="baraj-match-card'+barajMatchTone(m)+'" type="button" data-ko-mid="'+esc(m.id)+'">'
    +'<div class="baraj-match-top"><span>'+esc(matchDateTitle(m.date))+'</span><b>'+esc(m.t||'21:00')+'</b></div>'
    +'<div class="baraj-match-body">'+barajTeamHtml(m.h,'home')+'<div class="baraj-score">'+barajScore(m)+'</div>'+barajTeamHtml(m.a,'away')+'</div>'
    +'<div class="baraj-match-bottom"><span>'+esc(m.index===2?'Visszavágó':m.id.startsWith('CB-2')?'Döntő':m.id.startsWith('CB-1')?'Elődöntő':'1. mérkőzés')+'</span><strong>'+esc(barajResultSource(m))+'</strong></div>'
  +'</button>'
}
function aggregateForRows(rows){
  let aggregate=superligaBarajAggregateForRows(rows);
  if(!aggregate)return'';
  let penalty=aggregate.penalty?'<small class="baraj-aggregate-pen"><span>PEN</span><b>'+esc(aggregate.penalty.h)+'-'+esc(aggregate.penalty.a)+'</b></small>':'';
  let state=aggregate.ready?(aggregate.tied&&!aggregate.penalty?' · tizenegyesek szükségesek':aggregate.winner?' · '+esc(stn(aggregate.winner)):''):' · 1. mérkőzés';
  return '<div class="baraj-aggregate'+(aggregate.tied?' is-tied':'')+'"><span>Összesítés'+state+'</span><div class="baraj-aggregate-right"><b>'+esc(stn(aggregate.homeTeam))+' '+aggregate.h+' - '+aggregate.a+' '+esc(stn(aggregate.awayTeam))+'</b>'+penalty+'</div></div>';
}
function barajPathCard(opts){
  let rows=opts.rows||[];
  return '<section class="baraj-path-card '+esc(opts.tone||'')+'">'
    +'<div class="baraj-path-head"><div class="baraj-path-badge">'+esc(opts.badge||'')+'</div><div><h2>'+esc(opts.title)+'</h2><p>'+esc(opts.sub||'')+'</p></div></div>'
    +(opts.note?'<div class="baraj-path-note">'+esc(opts.note)+'</div>':'')
    +'<div class="baraj-match-grid '+(rows.length>2?'two-leg':'')+'">'+rows.map(barajMiniMatch).join('')+'</div>'
    +aggregateForRows(rows)
  +'</section>'
}
function relegatedTile(t,pos){
  if(!t)return '';
  return '<div class="baraj-relegated-tile"><span>'+pos+'. hely</span><div>'+crest(t.name,'32px')+'<b>'+esc(stn(t.name))+'</b></div><strong>Kiesés</strong></div>'
}
function renderBaraj(){
  let m=document.getElementById('main');m.className='main baraj-main';
  const st=calcFullStandings(),po=postseasonStandings('PO',st.slice(0,6),'all'),pl=postseasonStandings('PL',st.slice(6,16),'all');
  const pl15=pl[8],pl16=pl[9],brReady=postseasonComplete(),all=buildBarajMatches(),conf=all.filter(x=>x.id.startsWith('CB-')),rel1=all.filter(x=>x.id.startsWith('BR-1-')),rel2=all.filter(x=>x.id.startsWith('BR-2-'));
  let out='<section class="baraj-hero card"><div><span class="baraj-eyebrow">Szezonvégi döntések</span><h1>Baraj</h1><p>Konferencialiga-hely és bentmaradás, külön ágakban. Csak akkor tippelhető, ha a rájátszás mezőnye már eldőlt.</p></div><div class="baraj-hero-chips"><span>ECL</span><span>Bentmaradás</span><span>Liga 2</span></div></section>';
  if(!brReady)out+='<section class="baraj-lock-card"><b>ⓘ Zárolva</b><span>A baraj akkor nyílik, ha az összes playoff/playout meccsre tippeltél, vagy azok lezárultak.</span></section>';
  out+=barajPathCard({tone:'conference',badge:'ECL',title:'Konferencialiga-baraj',sub:'A play-out első két csapata elődöntőt játszik, a győztes a playoff 3. helyezettjével döntőzik.',note:'Győztes: Konferencialiga-selejtezős hely.',rows:conf});
  out+=barajPathCard({tone:'survival',badge:'BR1',title:'Bentmaradás-baraj · 1. párharc',sub:'Playout 13. helyezett vs Liga 2 rájátszás 3. helyezett.',note:'Oda-visszavágós párharc.',rows:rel1});
  out+=barajPathCard({tone:'survival',badge:'BR2',title:'Bentmaradás-baraj · 2. párharc',sub:'Playout 14. helyezett vs Liga 2 rájátszás 4. helyezett.',note:'Oda-visszavágós párharc.',rows:rel2});
  out+='<section class="baraj-relegated card"><div class="baraj-section-title"><h2>Közvetlen kiesés</h2><p>A playout utolsó két helyezettje Liga 2-be esik.</p></div><div class="baraj-relegated-grid">'+relegatedTile(pl15,15)+relegatedTile(pl16,16)+'</div></section>';
  out+='<section class="baraj-promotion card"><div class="baraj-section-title"><h2>Feljutás Liga 2-ből</h2><p>Az első két Liga 2-es közvetlenül feljut, a 3-4. helyezett bentmaradás-barajt játszik.</p></div></section>';
  m.innerHTML=out;activateCrests();bindMatchCardOpeners(m);
}
function renderStats(){let m=document.getElementById('main');m.className='main stats-main';let eff=tipEfficiency(),totalPct=eff.totalPlayed?+(eff.totalPts/eff.totalMax*100).toFixed(2):0,effHtml='<section class="card"><h2 class="card-title">Tippel&eacute;si hat&eacute;konys&aacute;g</h2><div class="eff-total"><div class="eff-total-left"><div class="eff-total-label">&Ouml;sszhat&eacute;konys&aacute;g</div><div class="eff-total-pts">'+totalPct+'%<span>'+fmtPts(eff.totalPts)+' / '+eff.totalMax+' pt</span></div><div class="eff-total-bar"><div class="eff-total-bar-fill" style="width:'+Math.min(100,totalPct)+'%"></div></div></div><div class="eff-total-right"><div class="eff-total-pct">'+fmtPts(eff.totalPts)+' pt</div></div></div><div class="eff-split">'+effSplitCard('Szezon',eff.grpExact,eff.grpDiff,eff.grpOutcome,eff.grpMiss,eff.grpPts,eff.grpMax,eff.grpPlayed,'#28d16c')+effSplitCard('Playoff / playout',eff.koExact,eff.koDiff,eff.koOutcome,eff.koMiss,eff.koPts,eff.koMax,eff.koPlayed2,'#6ec6ff')+'</div><div class="eff-legend"><span class="eff-legend-item exact">Pontos tipp: 1 pt</span><span class="eff-legend-item diff">G&oacute;lk&uuml;l&ouml;nbs&eacute;g: 0.5 pt</span><span class="eff-legend-item outcome">Kimenetel: 0.25 pt</span><span class="eff-legend-item miss">T&eacute;ves: 0 pt</span></div></section>';let groupTips=played(),postMs=buildPostseasonMatches(),barajMs=buildBarajMatches(),tipPlayedN=groupTips.length,phases=[statPhaseInfo('Alapszakasz',240,FX,false),statPhaseInfo('Playoff / playout',postMs.length,postMs,true),statPhaseInfo('Baraj',barajMs.length,barajMs,true)],res=phases.flatMap(p=>p.res),statN=res.length,goals=res.reduce((s,x)=>s+x.p.h+x.p.a,0),hw=res.filter(x=>x.p.h>x.p.a).length,dr=res.filter(x=>x.p.h===x.p.a).length,aw=res.filter(x=>x.p.a>x.p.h).length;m.innerHTML=effHtml+statsRoundEfficiencyHtml()+'<section class="card"><h2 class="card-title">&Ouml;sszes&iacute;tett statisztik&aacute;k</h2><div class="stat-kpi-row"><div class="stat-kpi"><div class="stat-kpi-val">'+tipPlayedN+'</div><div class="stat-kpi-lbl">Tippelt meccs</div></div><div class="stat-kpi"><div class="stat-kpi-val">'+goals+'</div><div class="stat-kpi-lbl">G&oacute;l</div></div><div class="stat-kpi"><div class="stat-kpi-val">'+(statN?goals/statN:0).toFixed(2)+'</div><div class="stat-kpi-lbl">G&oacute;l/meccs</div></div></div><div class="stat-section-title">Eredm&eacute;ny-megoszl&aacute;s</div><div class="stat-result-labels"><span>Els&#337; csapat gy&#337;zelme</span><span style="margin-left:auto">'+hw+' meccs</span></div>'+pctBar(hw,statN,'var(--green)')+'<div class="stat-result-labels"><span>D&ouml;ntetlen</span><span style="margin-left:auto">'+dr+' meccs</span></div>'+pctBar(dr,statN,'var(--muted)')+'<div class="stat-result-labels"><span>M&aacute;sodik csapat gy&#337;zelme</span><span style="margin-left:auto">'+aw+' meccs</span></div>'+pctBar(aw,statN,'var(--blue)')+'</section><section class="card"><h2 class="card-title">F&aacute;zis-bont&aacute;s</h2><div class="stat-phase-grid">'+phases.map(p=>'<div class="stat-phase-card"><div class="stat-phase-name">'+p.name+'</div><div class="stat-phase-row"><span>'+p.total+' tervezett meccs</span><span class="stat-phase-avg">'+p.avg.toFixed(2)+' g&oacute;l/meccs</span></div><div class="stat-mini-bars"><div class="stat-mini-bar" style="flex:'+(p.finished||0.01)+';background:var(--green)"></div><div class="stat-mini-bar" style="flex:'+(p.left||0.01)+';background:var(--muted)"></div></div><div class="stat-mini-legend"><span>Tippelve: '+p.tipped+' &middot; Lez&aacute;rva: '+p.finished+'</span><span>H&aacute;tra: '+p.left+'</span></div></div>').join('')+'</div></section>'+statsExportHtml();activateCrests();let ex=document.getElementById('exportBtn');if(ex)ex.onclick=exportSnapshotNav}

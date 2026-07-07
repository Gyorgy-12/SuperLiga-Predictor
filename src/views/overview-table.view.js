// Overview and regular-season table renderers

// Regular-season table renderers

function regularLiveMatches(){
  if(S.tblRound)return [];
  return FX.filter(m=>m.g==='SL'&&LIVE_RESULTS[m.id]&&LIVE_RESULTS[m.id].started&&!LIVE_RESULTS[m.id].finished&&validScore(LIVE_RESULTS[m.id].h)&&validScore(LIVE_RESULTS[m.id].a));
}
function calcRegularRowsForLiveOverlay(includeLive){
  let rows={};
  GROUPS[0].teams.forEach(n=>rows[n]=mk(n,GROUPS[0].key));
  FX.filter(m=>m.g==='SL'&&(!S.tblRound||m.r<=S.tblRound)).forEach(m=>{
    let lr=LIVE_RESULTS[m.id];
    let useReal=lr&&validScore(lr.h)&&validScore(lr.a)&&(lr.finished||(includeLive&&lr.started&&!lr.finished));
    let p=useReal?{h:+lr.h,a:+lr.a}:getPred(m.id);
    if(p)applyResult(rows,m,p);
  });
  return sortRowsForTable(Object.values(rows));
}
function liveDelta(nowPos,basePos){
  if(!basePos||!nowPos||nowPos===basePos)return '';
  let diff=basePos-nowPos;
  return '<em class="live-table-pos-delta '+(diff>0?'up':'down')+'">'+(diff>0?'▲'+diff:'▼'+Math.abs(diff))+'</em>';
}
function gdLabel(v){v=+v||0;return (v>0?'+':'')+v;}
function liveTableOverlayHtml(currentRows){
  let live=regularLiveMatches();
  if(!live.length)return '';
  let baseRows=calcRegularRowsForLiveOverlay(false);
  let cur={};currentRows.forEach((r,i)=>cur[r.name]={pos:i+1,row:r});
  let base={};baseRows.forEach((r,i)=>base[r.name]={pos:i+1,row:r});
  function teamLine(team){
    let c=cur[team]||{},b=base[team]||{},a=ast(c.row||mk(team,'SL'));
    return '<span class="live-table-team-meta"><b>'+esc(stn(team))+'</b><span>#'+esc(c.pos||'-')+liveDelta(c.pos,b.pos)+'</span><span>GK '+esc(gdLabel(a.diff))+'</span><span>'+esc(a.pts)+' pts</span></span>';
  }
  return '<div class="live-table-panel"><div class="live-table-panel-head"><span class="live-dot"></span><b>Élő tabella</b><small>az aktuális eredményekkel</small></div><div class="live-table-list">'+live.map(m=>{
    let r=LIVE_RESULTS[m.id],clock=liveClockLabel(r)||'Élő';
    return '<div class="live-table-game" data-mid="'+esc(m.id)+'" role="button" tabindex="0">'
      +'<div class="live-table-scoreline"><span>'+esc(clock)+'</span><strong>'+esc(teamNameFor(m.h,'match-card'))+' <b>'+esc(r.h)+'-'+esc(r.a)+'</b> '+esc(teamNameFor(m.a,'match-card'))+'</strong></div>'
      +'<div class="live-table-impact">'+teamLine(m.h)+teamLine(m.a)+'</div>'
    +'</div>';
  }).join('')+'</div></div>';
}


function renderTables(){
  syncTblRoundDrop();
  let m=document.getElementById('main'),out='';
  m.className='main';
  const st=sortRowsForTable(calcStandings());
  const livePanel=liveTableOverlayHtml(st);
  const lastR=Math.max(0,...FX.filter(x=>LIVE_RESULTS[x.id]?.finished).map(x=>x.r));
  const zones=[
    {rows:st.slice(0,6),clr:'var(--cyan)',lbl:'Top 6 → playoff'},
    {rows:st.slice(6,16),clr:'var(--muted)',lbl:'7-16 → playout'},
  ];
  const displayR=S.tblRound||lastR;
  out+='<section class="card"><div class="card-title">Tabella</div>'+livePanel+'<div class="standings">'+hdr();
  let p=1;zones.forEach(z=>{let r=sl_zone(z,p);out+=r.h;p=r.n;});
  out+='</div>';
  out+='</section>';
  m.innerHTML=out;
  activateCrests();
  if(typeof bindMatchCardOpeners==='function')bindMatchCardOpeners(m);
}
function renderOverview(){
  let m=document.getElementById('main');m.className='main overview-main';
  const pct=(function(){var s=new Date('2026-07-18').getTime(),e=new Date('2027-05-29').getTime(),n=Date.now();return Math.min(100,Math.max(0,Math.round((n-s)/(e-s)*1000)/10));})();
  const played=Object.values(LIVE_RESULTS).filter(r=>r&&r.finished).length;
  const tipped=Object.keys(PRED).length;
  const lastR=Math.max(0,...FX.filter(x=>LIVE_RESULTS[x.id]?.finished).map(x=>x.r));
  m.innerHTML=
  '<section class="ov-season-card">'+
    '<div class="ov-season-top">'+
      '<div class="ov-season-logo"><img src="https://www.superliga.ro/images/logo.png" alt="SuperLiga" onerror="this.style.display=\'none\'"></div>'+
      '<div class="ov-season-info">'+
        '<div class="ov-season-name">SuperLiga Rom&acirc;niei 2026/27</div>'+
        '<div class="ov-season-country">16 csapat &middot; 30 forduló &middot; Playoff + Playout</div>'+
      '</div>'+
    '</div>'+
    '<div class="ov-progress-bar"><div class="ov-progress-fill" style="width:'+pct+'%"></div></div>'+
    '<div class="ov-progress-dates"><span>2026. júl. 18.</span><span>2027. máj. 29.</span></div>'+
  '</section>'+
  '<section class="card"><h2 class="card-title">Szezonállás</h2>'+
    '<div class="wc-info-grid">'+
      '<div class="wc-info"><b>'+played+'</b><span>lejátszott meccs</span></div>'+
      '<div class="wc-info"><b>'+(FX.length-played)+'</b><span>hátralévő meccs</span></div>'+
      '<div class="wc-info"><b>'+tipped+'</b><span>tippelve</span></div>'+
      '<div class="wc-info"><b>'+lastR+'</b><span>utolsó forduló</span></div>'+
    '</div>'+
    '<div class="updated" style="margin-top:8px">Top 6 → playoff · 7-16 → playout · az alapszakasz után a pontok feleződnek</div>'+
  '</section>'+
  topScorersHtml()+topMatchesHtml()+topCardsHtml()+
  '<section class="card"><h2 class="card-title">Csapatok</h2>'+
    '<div class="wc-chip-grid">'+ALL.map(t=>'<div class="wc-team-chip">'+crest(t,'28px')+'<span>'+esc(teamNameFor(t,'match-card'))+'</span></div>').join('')+
    '</div>'+
  '</section>';
  activateCrests();
}

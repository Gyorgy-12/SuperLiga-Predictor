// Overview and regular-season table renderers

// Regular-season table renderers

function renderTables(){
  syncTblRoundDrop();
  let m=document.getElementById('main'),out='';
  m.className='main';
  const st=sortRowsForTable(calcStandings());
  const lastR=Math.max(0,...FX.filter(x=>LIVE_RESULTS[x.id]?.finished).map(x=>x.r));
  const zones=[
    {rows:st.slice(0,6),clr:'var(--cyan)',lbl:'Top 6 → playoff'},
    {rows:st.slice(6,16),clr:'var(--muted)',lbl:'7-16 → playout'},
  ];
  const displayR=S.tblRound||lastR;
  out+='<section class="card"><div class="card-title">Tabella</div><div class="standings">'+hdr();
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

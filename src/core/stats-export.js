// Prediction efficiency, statistics helpers and static export snapshot

function tipEfficiency(){
  // --- Szezon ---
  let grpMeccs=FX.map(m=>{let r=actualFor(m);if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return null;return gradeTip(getPred(m.id),r);}).filter(x=>x&&x.cat);
  let grpPts=grpMeccs.reduce((s,x)=>s+x.pts,0);
  let grpExact=grpMeccs.filter(x=>x.cat==='exact').length;
  let grpDiff=grpMeccs.filter(x=>x.cat==='diff').length;
  let grpOutcome=grpMeccs.filter(x=>x.cat==='outcome').length;
  let grpMiss=grpMeccs.filter(x=>x.cat==='miss').length;
  let grpPlayed=grpMeccs.length;
  let grpMax=grpPlayed;
  // --- Utószezon: playoff, playout, KL-baraj és bentmaradás-baraj ---
  let koMeccs=[];
  try{koMeccs=buildAllPostseasonMatches().map(m=>{let r=actualFor({id:m.id});if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return null;return gradeKoTip(KO_PRED[m.id],r);}).filter(x=>x&&x.cat)}catch(e){koMeccs=[]}
  let koPts=koMeccs.reduce((s,x)=>s+x.pts,0);
  let koExact=koMeccs.filter(x=>x.cat==='exact').length;
  let koDiff=koMeccs.filter(x=>x.cat==='diff'||x.cat==='draw').length;
  let koOutcome=koMeccs.filter(x=>x.cat==='outcome').length;
  let koMiss=koMeccs.filter(x=>x.cat==='miss').length;
  let koPlayed2=koMeccs.length;
  let koMax=koPlayed2;
  let totalPts=grpPts+koPts;
  let totalPlayed=grpPlayed+koPlayed2;
  let totalMax=totalPlayed;
  return{grpPts,grpMax,grpPlayed,grpExact,grpDiff,grpOutcome,grpMiss,koPts,koMax,koPlayed2,koExact,koDiff,koOutcome,koMiss,totalPts,totalMax,totalPlayed};
}function effSplitCard(label,exact,diff,outcome,miss,pts,max,played,color){let pct=max>0?+(pts/max*100).toFixed(2):0;let barColor=color||'#28d16c';let noData='<div class="eff-split-dots"><span class="eff-sdot" style="color:#3a4d5a">Még nincs élő vagy lezárt mérkőzés</span></div>';let dots=played?'<div class="eff-split-dots"><span class="eff-sdot exact">'+exact+' pontos</span><span class="eff-sdot diff">'+diff+' gólkül.</span><span class="eff-sdot outcome">'+outcome+' kimen.</span><span class="eff-sdot miss">'+miss+' téves</span></div>':noData;return'<div class="eff-split-card"><div class="eff-split-label">'+label+'</div><div class="eff-split-row"><div class="eff-split-pts">'+pct+'%<small> hatékonyság</small></div><div class="eff-split-pct">'+fmtPts(pts)+' / '+max+' pt</div></div><div class="eff-mini-bar"><div class="eff-mini-bar-fill" style="width:'+Math.min(100,pct)+'%;background:'+barColor+'"></div></div>'+dots+'</div>';}
function played(){return FX.map(m=>({m,p:getPred(m.id)})).filter(x=>x.p)}
function koPlayed(){return []}
function finishedActual(m){let r=actualFor({id:m.id});return r&&r.finished&&validScore(r.h)&&validScore(r.a)?{h:+r.h,a:+r.a}:null}
function statPredFor(m,ko){return ko?koPred(m.id):getPred(m.id)}
function statSourceFor(m,ko){let real=finishedActual(m);if(real)return{m,p:real,source:'Val&oacute;s'};let pred=statPredFor(m,ko);return pred?{m,p:pred,source:'Tipp'}:null}
function statMatchesFrom(matches,ko){return (matches||[]).map(m=>statSourceFor(m,ko)).filter(x=>x&&x.m&&x.m.h&&x.m.a)}
function actualFinishedCount(matches){return (matches||[]).filter(m=>finishedActual(m)).length}
function tipCountFor(matches,ko){return (matches||[]).filter(m=>m&&m.h&&m.a&&statPredFor(m,ko)).length}
function statPhaseInfo(name,total,matches,ko){let res=statMatchesFrom(matches,ko),finished=actualFinishedCount(matches),tipped=tipCountFor(matches,ko),goals=res.reduce((s,x)=>s+x.p.h+x.p.a,0),left=Math.max(0,total-finished);return{name,total,res,finished,tipped,goals,left,avg:res.length?goals/res.length:0}}
function matchStageLabel(m){
  if(!m)return'Alapszakasz';
  if(m.g||m.r)return'Alapszakasz';
  const raw=String(m.title||m.phase||m.stage||m.round||'').toLowerCase();
  if(raw.includes('playoff')||raw.includes('play-off')||raw.includes('felső'))return'Play-off';
  if(raw.includes('playout')||raw.includes('play-out')||raw.includes('alsó'))return'Play-out';
  if(raw.includes('baraj'))return'Baraj';
  const id=String(m.id||'');
  if(id.startsWith('PO-'))return'Play-off';
  if(id.startsWith('PL-'))return'Play-out';
  if(id.startsWith('BR-')||id.startsWith('CB-'))return'Baraj';
  return'Play-off / Play-out';
}
function matchStatRoundLabel(m){
  if(!m)return'';
  if(m.g||m.r)return (m.d?m.d+' · ':'')+(m.r?m.r+'. forduló':'Alapszakasz');
  let stage=matchStageLabel(m);
  return stage+(m.index!=null?' · #'+m.index:'');
}
function matchStatRow(i,x,labelVal){let p=x.p,gd=Math.abs(p.h-p.a),score=p.h+'-'+p.a,sub=matchStatRoundLabel(x.m);sub+=' · '+(x.source||'Tipp');if(labelVal==='diff')sub+=' · GK: '+gd;let hn=teamNameFor(x.m.h,'stat-match'),an=teamNameFor(x.m.a,'stat-match');return '<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name stat-game-name">'+crest(x.m.h,'16px')+'<span class="stat-game-text">'+esc(hn)+' - '+esc(an)+'</span>'+crest(x.m.a,'16px')+'</div><div class="wc-stat-sub">'+esc(sub)+'</div></div><div class="wc-stat-val">'+score+'</div></div>'}
function statsExportHtml(){if(FROZEN_MODE)return '';return '<section class="card export-card"><h2 class="card-title">Tipp-sorozat ment&eacute;se</h2><p class="export-copy">A gomb egy teljesen statikus HTML-pillanatk&eacute;pet k&eacute;sz&iacute;t a jelenlegi tippekkel. Az &uacute;j f&aacute;jlban m&aacute;r nincs tippel&eacute;s vagy m&oacute;dos&iacute;t&aacute;s, csak a befagyasztott eredm&eacute;nyek maradnak meg.</p><button class="export-btn" id="exportBtn" type="button">HTML gener&aacute;l&aacute;s</button><div class="export-hint">A let&ouml;lt&ouml;tt f&aacute;jl &ouml;n&aacute;ll&oacute;an megnyithat&oacute;.</div></section>'}
function exportPart(id,title,fn){let main=document.getElementById('main');fn();let clone=main.cloneNode(true),viewClass=(clone.className||'').split(/\s+/).filter(c=>c&&c!=='main').join(' ');clone.querySelectorAll('.export-card,.tip-overlay,.overlay,button,input').forEach(el=>el.remove());if(id==='merkozesek'){clone.querySelectorAll('.mr-tip,.mr-bell').forEach(el=>el.remove());clone.querySelectorAll('.match-row.predicted').forEach(el=>el.classList.remove('predicted'))}if(!READONLY_MODE){}return '<section class="export-block '+viewClass+'" id="'+id+'"><div class="export-view-head"><h1 class="export-block-title">'+title+'</h1></div>'+clone.innerHTML+'</section>'}
function exportSnapshotFrozenCloneDisabled(){let root=document.documentElement.cloneNode(true);root.querySelectorAll('.export-card,.tip-overlay,.overlay').forEach(el=>el.remove());let data=JSON.stringify({pred:PRED,ko:KO_PRED,results:LIVE_RESULTS,createdAt:new Date().toISOString()}),exportModalScript="function openExportModal(id,isKo){var fd=window.__SUPERLIGA_FROZEN_DATA__||{},pred=fd.pred||{},koPred=fd.ko||{},results=fd.results||{};var r=results[id]||null,p=isKo?koPred[id]:pred[id];var attr=isKo?\"data-ko-mid\":\"data-mid\";var cards=[].slice.call(document.querySelectorAll(\"[\"+attr+\"]\"));var card=cards.filter(function(el){return el.getAttribute(attr)===id;})[0];if(!card)return;var tn=card.querySelectorAll(\".mr-tname\"),h=tn[0]?tn[0].textContent:\"?\",a=tn[1]?tn[1].textContent:\"?\";var de=card.querySelector(\".mr-date\"),tl=de&&de.childNodes[0]?de.childNodes[0].textContent.trim():\"\";var re=de&&de.querySelector(\"span\"),rl=re?re.textContent:\"\";var sh=r&&r.h!=null?r.h:\"-\",sa=r&&r.a!=null?r.a:\"-\";var ph=p&&p.h!=null?p.h:\"-\",pa=p&&p.a!=null?p.a:\"-\";var st=r&&r.finished?\"V\u00e9geredm\u00e9ny\":r&&r.started?\"\u00c9l\u0151\":\"\";var ov=document.createElement(\"div\");ov.className=\"tip-overlay\";ov.style.cssText=\"position:fixed;inset:0;z-index:3000;background:rgba(3,8,16,.82);display:flex;align-items:center;justify-content:center;padding:16px\";var inner=document.createElement(\"div\");inner.style.cssText=\"width:min(480px,96vw);background:#0f1923;border:1px solid rgba(255,255,255,.1);border-radius:20px;overflow:hidden\";var hd=document.createElement(\"div\");hd.style.cssText=\"display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08)\";var lb=document.createElement(\"span\");lb.style.cssText=\"color:#8899a6;font-size:12px;font-weight:700\";lb.textContent=tl+\" \u00b7 \"+rl+(st?\" \u00b7 \"+st:\"\");var cb=document.createElement(\"button\");cb.id=\"exportModalClose\";cb.textContent=\"\u2715\";cb.style.cssText=\"background:rgba(255,255,255,.06);border:none;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer\";hd.appendChild(lb);hd.appendChild(cb);var bd=document.createElement(\"div\");bd.style.cssText=\"padding:20px 16px\";var gr=document.createElement(\"div\");gr.style.cssText=\"display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;text-align:center;margin-bottom:16px\";var ht=document.createElement(\"b\");ht.style.cssText=\"font-size:clamp(12px,3vw,15px);font-weight:800;color:#e8edf0\";ht.textContent=h;var sv=document.createElement(\"div\");sv.style.cssText=\"display:flex;gap:6px;align-items:center\";var sH=document.createElement(\"b\");sH.style.cssText=\"min-width:32px;text-align:center;font-size:clamp(20px,5vw,28px);color:#fff\";sH.textContent=sh;var dk=document.createElement(\"span\");dk.style.cssText=\"color:#445\";dk.textContent=\"-\";var sA=document.createElement(\"b\");sA.style.cssText=\"min-width:32px;text-align:center;font-size:clamp(20px,5vw,28px);color:#fff\";sA.textContent=sa;sv.appendChild(sH);sv.appendChild(dk);sv.appendChild(sA);var at=document.createElement(\"b\");at.style.cssText=\"font-size:clamp(12px,3vw,15px);font-weight:800;color:#e8edf0\";at.textContent=a;gr.appendChild(ht);gr.appendChild(sv);gr.appendChild(at);bd.appendChild(gr);if(p&&p.h!=null){var tb=document.createElement(\"div\");tb.style.cssText=\"background:rgba(255,255,255,.04);border-radius:12px;padding:12px;text-align:center\";var t2=document.createElement(\"div\");t2.style.cssText=\"font-size:11px;font-weight:800;color:#8899a6;margin-bottom:6px\";t2.textContent=\"A TE TIPPED\";var ts=document.createElement(\"b\");ts.style.cssText=\"font-size:clamp(18px,4vw,24px);color:#38f2a2\";ts.textContent=ph+\" - \"+pa;tb.appendChild(t2);tb.appendChild(ts);bd.appendChild(tb);}else{var no=document.createElement(\"p\");no.style.cssText=\"color:#8899a6;font-size:13px;text-align:center\";no.textContent=\"Nem tippelt\u00e9l erre a meccsre.\";bd.appendChild(no);}inner.appendChild(hd);inner.appendChild(bd);ov.appendChild(inner);document.body.appendChild(ov);ov.addEventListener(\"click\",function(e2){if(e2.target===ov||e2.target.id===\"exportModalClose\")ov.remove();});}document.addEventListener(\"click\",function(e){var mr=e.target.closest&&e.target.closest(\"[data-mid]\");if(mr){var mid=mr.getAttribute(\"data-mid\");if(mid)openExportModal(mid,false);return;}var kr=e.target.closest&&e.target.closest(\"[data-ko-mid]\");if(kr){var kid=kr.getAttribute(\"data-ko-mid\");if(kid)openExportModal(kid,true);return;}if(e.target.classList&&(e.target.classList.contains(\"tip-overlay\")||e.target.id===\"exportModalClose\")){var ov=document.querySelector(\".tip-overlay\");if(ov)ov.remove();}});".replace(/</g,'\\u003c'),freeze='<script id="superligaFreezeDataSource">window.__SUPERLIGA_FROZEN__=true;window.__SUPERLIGA_READONLY__=true;window.__SUPERLIGA_FROZEN_DATA__='+data+';</scr'+'ipt>',html='<!doctype html>\n'+root.outerHTML;html=html.replace(/<script id="superligaFreezeDataSource">[\s\S]*?<\/script>/,'');html=html.replace('<script>const D=',freeze+'<script>const D=');html=html.replace('<title>SuperLiga României 2026/27</title>','<title>SuperLiga României 2026/27 - befagyasztott tippek</title>');let blob=new Blob([html],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a'),d=new Date(),pad=n=>String(n).padStart(2,'0');a.href=url;a.download='superliga_2026_27_befagyasztott_tippek_'+d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'.html';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200)}
function exportControlsHtml(){
  return ''
  +'<div class="export-control" data-export-control="tabella"><div class="export-control-inner">'
  +'<button class="pill active" type="button" data-export-table-filter="all">&Ouml;sszes</button>'
  +'<button class="pill" type="button" data-export-table-filter="home">Hazai</button>'
  +'<button class="pill" type="button" data-export-table-filter="away">Idegen</button>'
  +'<div class="view-wrap"><button class="view-btn" type="button" data-export-view-toggle>'
  +'<span class="hbars"><i></i><b></b></span></button>'
  +'<div class="drop sel-drop" data-export-view-menu>'
  +'<button type="button" data-export-table-view="short" class="active">R&ouml;vid</button>'
  +'<button type="button" data-export-table-view="full">Teljes</button>'
  +'<button type="button" data-export-table-view="form">Forma</button>'
  +'</div></div>'
  +'</div></div>'
  +'<div class="export-control" data-export-control="merkozesek"><div class="export-control-inner">'
  +'<button class="pill active" type="button" data-export-match-filter="date">D&aacute;tum szerint</button>'
  +'<button class="pill" type="button" data-export-match-filter="round">K&ouml;r szerint</button>'
  +'<button class="pill" type="button" data-export-match-filter="team">Csapat szerint</button>'
  +'<div class="export-match-extra" data-export-match-extra="round">'
  +'<div class="view-wrap"><button class="sel-btn" type="button" data-export-round-toggle>'
  +'<span data-export-round-label>1. kör</span><span class="sel-chev">&#9662;</span></button>'
  +'<div class="drop sel-drop" data-export-round-menu>'
  +[1,2,3].map(n=>'<button type="button" data-export-round="'+n+'"'+(n===1?' class="active"':'')+'>'+n+'. kör</button>').join('')
  +'</div></div></div>'
  +'<div class="export-match-extra" data-export-match-extra="team">'
  +'<div class="view-wrap"><button class="sel-btn" type="button" data-export-team-toggle>'
  +'<span data-export-team-label>'+esc(ALL[0])+'</span><span class="sel-chev">&#9662;</span></button>'
  +'<div class="drop sel-drop" data-export-team-menu>'
  +ALL.map(t=>'<button type="button" data-export-team="'+esc(t)+'"'+(t===ALL[0]?' class="active"':'')+'>'+esc(t)+'</button>').join('')
  +'</div></div></div>'
  +'</div></div>'
  +'<div class="export-control export-ko-control" data-export-control="playoff-playout"><div class="export-control-inner">'
  +'<button class="sel-btn" type="button"><span class="sel-txt">SuperLiga României 2026/27 &ndash; playoff / playout</span><span class="sel-chev">&#9662;</span></button>'
  +'<button class="expand-btn" type="button">&#8599;</button>'
  +'</div></div>';
}
function exportSnapshotNav(){
  // Az egész oldal HTML-jét klónozzuk - ez már tartalmaz mindent
  let root=document.documentElement.cloneNode(true);

  // Frozen + readonly flagek injektálása
  let data=JSON.stringify({pred:PRED,ko:KO_PRED,results:LIVE_RESULTS,createdAt:new Date().toISOString()});
  let flagScript=document.createElement('script');
  flagScript.id='superligaFreezeData';
  flagScript.textContent='window.__SUPERLIGA_FROZEN__=true;window.__SUPERLIGA_READONLY__=true;window.__SUPERLIGA_FROZEN_DATA__='+data.replace(/</g,'\\u003c')+';window.__SUPERLIGA_LIVE_RESULTS__='+JSON.stringify(LIVE_RESULTS).replace(/</g,'\\u003c')+';';
  let existingFlag=root.querySelector('#superligaFreezeData');
  if(existingFlag)existingFlag.replaceWith(flagScript);
  else root.querySelector('head').appendChild(flagScript);

  // Overlay-ek és modal-ok eltávolítása
  root.querySelectorAll('.tip-overlay,.overlay,.export-card').forEach(el=>el.remove());
  root.querySelectorAll('.mr-bell').forEach(el=>el.remove());

  // Title frissítése
  let t=root.querySelector('title');
  if(t)t.textContent='SuperLiga României 2026/27 – tipp-pillanatkép';

  // Letöltés
  let html='<!doctype html>\n'+root.outerHTML;
  let blob=new Blob([html],{type:'text/html;charset=utf-8'});
  let url=URL.createObjectURL(blob);
  let a=document.createElement('a');
  let d=new Date(),pad=n=>String(n).padStart(2,'0');
  a.href=url;
  a.download='superliga_2026_27_tipp_snapshot_'+d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'.html';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1200);
}
function exportCleanClone(kind){let main=document.getElementById('main'),clone=main.cloneNode(true),viewClass=(clone.className||'').split(/\s+/).filter(c=>c&&c!=='main').join(' ');clone.querySelectorAll('.export-card,.tip-overlay,.overlay,button,input').forEach(el=>el.remove());if(kind==='matches'){clone.querySelectorAll('.mr-tip,.mr-bell').forEach(el=>el.remove());clone.querySelectorAll('.match-row.predicted').forEach(el=>el.classList.remove('predicted'))}if(!READONLY_MODE){}return{html:clone.innerHTML,viewClass}}
function exportSimplePart(id,title,fn,kind){fn();let c=exportCleanClone(kind||id);return '<section class="export-block '+c.viewClass+'" id="'+id+'"><div class="export-view-head"><h1 class="export-block-title">'+title+'</h1></div>'+c.html+'</section>'}
function exportTablePart(){let out='',filters=['all','home','away'],views=['short','full','form'];filters.forEach(f=>{views.forEach(v=>{S.filt=f;S.view=v;renderTables();let c=exportCleanClone('table');out+='<div class="export-subview '+(f==='all'&&v==='short'?'active':'')+'" data-export-table-f="'+f+'" data-export-table-v="'+v+'">'+c.html+'</div>'})});return '<section class="export-block" id="tabella"><div class="export-view-head"><h1 class="export-block-title">Tabella</h1></div>'+out+'</section>'}
function exportMatchesPart(){let out='',old={f:MS.filt,r:MS.round,t:MS.team};MS.filt='date';renderMatches();out+='<div class="export-subview active" data-export-match-f="date">'+exportCleanClone('matches').html+'</div>';[1,2,3].forEach(r=>{MS.filt='round';MS.round=r;renderMatches();out+='<div class="export-subview" data-export-match-f="round" data-export-match-round="'+r+'">'+exportCleanClone('matches').html+'</div>'});ALL.forEach(t=>{MS.filt='team';MS.team=t;renderMatches();out+='<div class="export-subview" data-export-match-f="team" data-export-match-team="'+esc(t)+'">'+exportCleanClone('matches').html+'</div>'});MS.filt=old.f;MS.round=old.r;MS.team=old.t;return '<section class="export-block matches-main" id="merkozesek"><div class="export-view-head"><h1 class="export-block-title">M&eacute;rk&#337;z&eacute;sek</h1></div>'+out+'</section>'}
function exportControlsHtml(){return '<div class="export-control" data-export-control="tabella"><div class="export-control-inner"><button class="pill active" type="button" data-export-table-filter="all">&Ouml;sszes</button><button class="pill" type="button" data-export-table-filter="home">Hazai</button><button class="pill" type="button" data-export-table-filter="away">Idegen</button><div class="view-wrap"><button class="view-btn" type="button" data-export-view-toggle><span class="hbars"><i></i><b></b></span></button><div class="drop" data-export-view-menu><button class="active" type="button" data-export-table-view="short">R&ouml;vid</button><button type="button" data-export-table-view="full">Teljes</button><button type="button" data-export-table-view="form">Forma</button></div></div></div></div><div class="export-control" data-export-control="merkozesek"><div class="export-control-inner"><button class="pill active" type="button" data-export-match-filter="date">D&aacute;tum szerint</button><button class="pill" type="button" data-export-match-filter="round">K&ouml;r szerint</button><button class="pill" type="button" data-export-match-filter="team">Csapat szerint</button></div><div class="export-control-inner export-match-extra" data-export-match-extra="round"><div class="view-wrap" style="margin-left:0"><button class="sel-btn" type="button" data-export-round-toggle><span class="sel-txt" data-export-round-label>1. kör</span><span class="sel-chev">&#9662;</span></button><div class="drop sel-drop" data-export-round-menu><button class="active" type="button" data-export-round="1">1. kör</button><button type="button" data-export-round="2">2. kör</button><button type="button" data-export-round="3">3. kör</button></div></div></div><div class="export-control-inner export-match-extra" data-export-match-extra="team"><div class="view-wrap" style="margin-left:0;flex:1"><button class="sel-btn" type="button" data-export-team-toggle><span class="sel-txt" data-export-team-label>'+esc(ALL[0])+'</span><span class="sel-chev">&#9662;</span></button><div class="drop sel-drop" data-export-team-menu>'+ALL.map((t,i)=>'<button '+(i?'':'class="active" ')+'type="button" data-export-team="'+esc(t)+'">'+esc(t)+'</button>').join('')+'</div></div></div></div><div class="export-control export-ko-control" data-export-control="playoff-playout"><div class="export-control-inner"><button class="sel-btn" type="button"><span class="sel-txt">SuperLiga României 2026/27 - playoff / playout</span><span class="sel-chev">&#9662;</span></button><button class="expand-btn" type="button">&#8599;</button></div></div>'}

let exportSnapshot=exportSnapshotNav;

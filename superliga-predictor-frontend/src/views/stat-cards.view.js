// Top scorers, cards and match statistic cards

function statRow(i,name,sub,val){return '<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name">'+name+'</div><div class="wc-stat-sub">'+sub+'</div></div><div class="wc-stat-val">'+val+'</div></div>'}
function topScorersList(){let counts={};FX.forEach(x=>{let r=LIVE_RESULTS[x.id];if(!r||!Array.isArray(r.scorers))return;r.scorers.forEach(s=>{if(!s.player||s.og)return;let team=s.team==='a'?x.a:x.h,key=s.player+'|'+team;if(!counts[key])counts[key]={player:s.player,team,goals:0};counts[key].goals++})});return Object.values(counts).sort((a,b)=>b.goals-a.goals||a.player.localeCompare(b.player)).slice(0,20)}
function goalScorerStatRow(i,s){return '<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name stat-game-name">'+crest(s.team,'16px')+'<span class="stat-game-text">'+esc(s.player)+'</span></div><div class="wc-stat-sub">'+esc(stn(s.team))+'</div></div><div class="wc-stat-val">'+s.goals+'</div></div>'}
function topCardsHtml(){
  const fp=calcFairPlay();
  const teams=ALL.filter(n=>fp[n]);
  const YC='<span style="display:inline-block;width:.5em;height:.72em;background:#f5c842;border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const RC='<span style="display:inline-block;width:.5em;height:.72em;background:#e03040;border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const YRC='<span style="display:inline-block;width:.8em;height:.72em;background:linear-gradient(90deg,#f5c842 50%,#e03040 50%);border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const byYellow=teams.filter(n=>fp[n].yellow>0)
    .sort((a,b)=>fp[b].yellow-fp[a].yellow||a.localeCompare(b)).slice(0,5);
  const byRed=teams.filter(n=>(fp[n].red+fp[n].yellowRed+fp[n].yellowPlusRed)>0)
    .sort((a,b)=>(fp[b].red+fp[b].yellowRed+fp[b].yellowPlusRed)-(fp[a].red+fp[a].yellowRed+fp[a].yellowPlusRed)||a.localeCompare(b)).slice(0,5);
  if(!byYellow.length&&!byRed.length)return'';
  // goalScorerStatRow-val AZONOS struktúra
  function cardStatRow(i,n,val,sub){
    return'<div class="wc-stat-row">'
      +'<div class="wc-stat-rank">'+i+'</div>'
      +'<div class="wc-stat-main">'
        +'<div class="wc-stat-name stat-game-name">'+crest(n)+'<span class="stat-game-text">'+esc(stn(n))+'</span></div>'
        +'<div class="wc-stat-sub">'+sub+'</div>'
      +'</div>'
      +'<div class="wc-stat-val">'+val+'</div>'
    +'</div>';
  }
  let out='';
  if(byYellow.length){
    out+='<section class="card"><h2 class="card-title">Legtöbb sárga lap &ndash; Top 5</h2>'
      +'<div class="wc-stat-list stat-match-list">'
      +byYellow.map((n,i)=>{
        const t=fp[n];
        return cardStatRow(i+1,n,YC+' '+t.yellow,t.yellow+' sárga lap');
      }).join('')
      +'</div></section>';
  }
  if(byRed.length){
    out+='<section class="card"><h2 class="card-title">Legtöbb piros lap &ndash; Top 5</h2>'
      +'<div class="wc-stat-list stat-match-list">'
      +byRed.map((n,i)=>{
        const t=fp[n];
        const total=t.red+t.yellowRed+t.yellowPlusRed;
        const parts=[];
        if(t.yellowRed)parts.push(YRC+' '+t.yellowRed+'&times; kettős sárga');
        if(t.red)parts.push(RC+' '+t.red+'&times; direkt piros');
        if(t.yellowPlusRed)parts.push(YRC+RC+' '+t.yellowPlusRed+'&times; sárga+piros');
        return cardStatRow(i+1,n,RC+' '+total,parts.join(' &middot; ')||total+' piros lap');
      }).join('')
      +'</div></section>';
  }
  return out;
}
function topScorersHtml(){let list=topScorersList();return '<section class="card"><h2 class="card-title">Legjobb g&oacute;ll&ouml;v&#337;k - Top 20</h2><div class="wc-stat-list stat-match-list">'+(list.length?list.map((s,i)=>goalScorerStatRow(i+1,s)).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs adat','A val&oacute;s g&oacute;lszerz&#337;k ut&aacute;n friss&uuml;l','0')).join(''))+'</div></section>'}
function topMatchesHtml(){let realRes=FX.map(x=>({m:x,p:actualFor(x),source:'Val&oacute;s'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a)&&(x.p.started||x.p.finished)),tipRes=FX.filter(x=>{let r=actualFor(x);return !(r&&validScore(r.h)&&validScore(r.a)&&(r.started||r.finished))}).map(x=>({m:x,p:PRED[x.id],source:'Tipp'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a)),koTipRes=(()=>{try{return buildAllPostseasonMatches().filter(m=>m&&m.h&&m.a&&!m.locked).map(m=>({m:{id:m.id,h:m.h,a:m.a,g:'',d:'',title:(m.title||postseasonCategory(m)||''),index:m.index,stage:m.stage,phase:m.phase},p:KO_PRED[m.id],source:'Tipp'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a))}catch(e){return []}})(),res=realRes.concat(tipRes).concat(koTipRes),goalMatches=res.slice().sort((a,b)=>(b.p.h+b.p.a)-(a.p.h+a.p.a)).slice(0,20),diffMatches=res.slice().sort((a,b)=>Math.abs(b.p.h-b.p.a)-Math.abs(a.p.h-a.p.a)||(b.p.h+b.p.a)-(a.p.h+a.p.a)).slice(0,20);return '<section class="card"><h2 class="card-title">Legg&oacute;losabb meccsek - Top 20</h2><div class="wc-stat-list stat-match-list">'+(goalMatches.length?goalMatches.map((x,i)=>matchStatRow(i+1,x,'score')).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs adat','A val&oacute;s eredm&eacute;nyek ut&aacute;n friss&uuml;l','0')).join(''))+'</div></section><section class="card"><h2 class="card-title">Legegyoldal&uacute;bb meccsek - Top 20</h2><div class="wc-stat-list stat-match-list">'+(diffMatches.length?diffMatches.map((x,i)=>matchStatRow(i+1,x,'diff')).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs lej&aacute;tszott m&eacute;rk&#337;z&eacute;s','G&oacute;lk&uuml;l&ouml;nbs&eacute;g: 0','0')).join(''))+'</div></section>'}

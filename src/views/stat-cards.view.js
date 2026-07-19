// Top scorers, cards and match statistic cards

const SUPERLIGA_STAT_PLAYER_EXACT = Object.freeze({
  'birligea d':'D. Birligea',
  'd birligea':'D. Birligea',
  'birligea daniel':'D. Birligea',
  'daniel birligea':'D. Birligea',
  'tanase f':'F. Tanase',
  'f tanase':'F. Tanase',
  'tanase florin':'F. Tanase',
  'florin tanase':'F. Tanase',
  'stefan baiaram':'S. Baiaram',
  's baiaram':'S. Baiaram',
  'andrei dumiter':'A. Dumiter',
  'george merloi':'G. Merloi'
});
const SUPERLIGA_STAT_SURNAME_DIACRITICS = Object.freeze({
  'birligea':'Birligea',
  'tanase':'Tanase',
  'mitrita':'Mitrita',
  'cicaldau':'Cicaldau',
  'baluta':'Baluta',
  'sut':'Sut',
  'vatajelu':'Vatajelu',
  'rata':'Rata',
  'matricardi':'Matricardi'
});
const SUPERLIGA_STAT_FAMILY_FIRST = new Set([
  'birligea','tanase','cordea','dumiter','merloi','lameira','baiaram','elisor','teles'
]);

function statDecodeHtmlText(value){
  let s=String(value??'');
  if(!s)return'';
  s=s.replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
     .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(parseInt(n,10)))
     .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
     .replace(/&apos;|&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
     .replace(/&aacute;/gi,'á').replace(/&eacute;/gi,'é').replace(/&iacute;/gi,'í')
     .replace(/&oacute;/gi,'ó').replace(/&ouml;/gi,'ö').replace(/&odblac;/gi,'ő')
     .replace(/&uacute;/gi,'ú').replace(/&uuml;/gi,'ü').replace(/&udblac;/gi,'ű');
  if(/[ÃÂÄÅ]/.test(s)&&typeof TextDecoder!=='undefined'){
    try{
      let bytes=Uint8Array.from(Array.from(s,ch=>ch.charCodeAt(0)&255));
      let decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(decoded&&!decoded.includes(' '))s=decoded;
    }catch(_e){}
  }
  return s.normalize('NFC').replace(/\s+/g,' ').trim();
}
function statPlayerAsciiKey(value){
  return statDecodeHtmlText(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[’'`´.-]/g,' ').replace(/[^a-z0-9\s-]/g,' ').replace(/\s+/g,' ').trim();
}
function statPlayerNoAccents(value){
  return statDecodeHtmlText(value)
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[łŁ]/g,m=>m==='Ł'?'L':'l')
    .replace(/[đĐ]/g,m=>m==='Đ'?'D':'d')
    .replace(/[øØ]/g,m=>m==='Ø'?'O':'o')
    .replace(/ß/g,'ss').replace(/Æ/g,'AE').replace(/æ/g,'ae').replace(/Œ/g,'OE').replace(/œ/g,'oe')
    .normalize('NFC');
}
function statPlayerInitial(token){
  let s=statDecodeHtmlText(token).replace(/[’'′]+$/g,'');
  return /^\p{L}\.?$/u.test(s)?s.charAt(0).toUpperCase()+'.':'';
}
function statPlayerSurname(tokens){
  return tokens.map(token=>SUPERLIGA_STAT_SURNAME_DIACRITICS[statPlayerAsciiKey(token)]||statDecodeHtmlText(token)).join(' ');
}
function statPlayerDisplayOrdered(event,result){
  let raw=typeof event==='string'?event:(event&&(event.player||event.playerName||event.fullName||event.displayName||event.name||event.person))||'';
  let s=statDecodeHtmlText(raw);
  if(!s)return'';
  let exact=SUPERLIGA_STAT_PLAYER_EXACT[statPlayerAsciiKey(s)];
  if(exact)return exact;

  let commaFamily='';
  if(s.includes(',')){
    let chunks=s.split(',').map(statDecodeHtmlText).filter(Boolean);
    if(chunks.length>=2){commaFamily=chunks[0];s=chunks.slice(1).join(' ')+' '+chunks[0];}
  }
  let parts=s.split(/\s+/).filter(Boolean);
  if(parts.length<2)return SUPERLIGA_STAT_SURNAME_DIACRITICS[statPlayerAsciiKey(s)]||s;

  let firstInitial=statPlayerInitial(parts[0]);
  let lastInitial=statPlayerInitial(parts[parts.length-1]);
  if(firstInitial)return firstInitial+' '+statPlayerSurname(parts.slice(1));
  if(lastInitial)return lastInitial+' '+statPlayerSurname(parts.slice(0,-1));

  let order=String(event?.playerNameOrder||event?.nameOrder||'').toLowerCase();
  let firstKey=statPlayerAsciiKey(commaFamily||parts[0]);
  let familyFirst=!!commaFamily||order.includes('family')||order.includes('surname')||SUPERLIGA_STAT_FAMILY_FIRST.has(firstKey);
  if(familyFirst){
    let surname=commaFamily||parts[0],given=commaFamily?parts.slice(0,-1):parts.slice(1);
    let initials=given.map(x=>statDecodeHtmlText(x).charAt(0).toUpperCase()+'.').join(' ');
    return (initials?initials+' ':'')+statPlayerSurname([surname]);
  }

  const particles=new Set(['da','de','del','della','di','do','dos','du','la','le','van','von']);
  let surnameStart=parts.length-1;
  while(surnameStart>0&&particles.has(statPlayerAsciiKey(parts[surnameStart-1])))surnameStart--;
  let given=parts.slice(0,surnameStart),surname=parts.slice(surnameStart);
  let initials=given.map(x=>statDecodeHtmlText(x).charAt(0).toUpperCase()+'.').join(' ');
  let display=(initials?initials+' ':'')+statPlayerSurname(surname);
  return SUPERLIGA_STAT_PLAYER_EXACT[statPlayerAsciiKey(display)]||display;
}
function statPlayerDisplay(event,result){return statPlayerNoAccents(statPlayerDisplayOrdered(event,result))}
function statPlayerCountKey(value){return statPlayerAsciiKey(value)}
function statOwnGoal(event){
  if(!event)return false;
  let text=String(event.type||event.kind||event.label||event.detail||event.reason||event.note||event.goalType||'').toLowerCase();
  let blob='';try{blob=JSON.stringify(event).toLowerCase()}catch(_e){}
  return !!(event.og===true||event.ownGoal===true||event.isOwnGoal===true||/own[ _-]?goal|autogol|öngól/.test(text+' '+blob));
}

function statRow(i,name,sub,val){return '<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name">'+name+'</div><div class="wc-stat-sub">'+sub+'</div></div><div class="wc-stat-val">'+val+'</div></div>'}
function topScorersList(){
  let counts={};
  FX.forEach(x=>{
    let r=LIVE_RESULTS[x.id];
    if(!r||!Array.isArray(r.scorers))return;
    r.scorers.forEach(s=>{
      if(!s||statOwnGoal(s))return;
      let player=statPlayerDisplay(s,r);
      if(!player)return;
      let team=s.team==='a'?x.a:x.h,key=statPlayerCountKey(player)+'|'+team;
      if(!counts[key])counts[key]={player,team,goals:0};
      counts[key].goals++;
    });
  });
  return Object.values(counts).sort((a,b)=>b.goals-a.goals||a.player.localeCompare(b.player,'ro')).slice(0,20);
}
function goalScorerStatRow(i,s){return '<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name stat-game-name">'+crest(s.team,'16px')+'<span class="stat-game-text">'+esc(s.player)+'</span></div><div class="wc-stat-sub">'+esc(stn(s.team))+'</div></div><div class="wc-stat-val">'+s.goals+'</div></div>'}
function topCardsHtml(){
  const fp=calcFairPlay();
  const teams=ALL.filter(n=>fp[n]);
  const YC='<span style="display:inline-block;width:.5em;height:.72em;background:#f5c842;border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const RC='<span style="display:inline-block;width:.5em;height:.72em;background:#e03040;border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const YRC='<span style="display:inline-block;width:.8em;height:.72em;background:linear-gradient(90deg,#f5c842 50%,#e03040 50%);border-radius:2px;vertical-align:middle;margin-right:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,.5)"></span>';
  const byYellow=teams.filter(n=>fp[n].yellow>0).sort((a,b)=>fp[b].yellow-fp[a].yellow||a.localeCompare(b)).slice(0,5);
  const byRed=teams.filter(n=>(fp[n].red+fp[n].yellowRed+fp[n].yellowPlusRed)>0).sort((a,b)=>(fp[b].red+fp[b].yellowRed+fp[b].yellowPlusRed)-(fp[a].red+fp[a].yellowRed+fp[a].yellowPlusRed)||a.localeCompare(b)).slice(0,5);
  if(!byYellow.length&&!byRed.length)return'';
  function cardStatRow(i,n,val,sub){return'<div class="wc-stat-row"><div class="wc-stat-rank">'+i+'</div><div class="wc-stat-main"><div class="wc-stat-name stat-game-name">'+crest(n)+'<span class="stat-game-text">'+esc(stn(n))+'</span></div><div class="wc-stat-sub">'+sub+'</div></div><div class="wc-stat-val">'+val+'</div></div>'}
  let out='';
  if(byYellow.length)out+='<section class="card"><h2 class="card-title">Legtöbb sárga lap &ndash; Top 5</h2><div class="wc-stat-list stat-match-list">'+byYellow.map((n,i)=>{const t=fp[n];return cardStatRow(i+1,n,YC+' '+t.yellow,t.yellow+' sárga lap')}).join('')+'</div></section>';
  if(byRed.length)out+='<section class="card"><h2 class="card-title">Legtöbb piros lap &ndash; Top 5</h2><div class="wc-stat-list stat-match-list">'+byRed.map((n,i)=>{const t=fp[n],total=t.red+t.yellowRed+t.yellowPlusRed,parts=[];if(t.yellowRed)parts.push(YRC+' '+t.yellowRed+'&times; kettős sárga');if(t.red)parts.push(RC+' '+t.red+'&times; direkt piros');if(t.yellowPlusRed)parts.push(YRC+RC+' '+t.yellowPlusRed+'&times; sárga+piros');return cardStatRow(i+1,n,RC+' '+total,parts.join(' &middot; ')||total+' piros lap')}).join('')+'</div></section>';
  return out;
}
function topScorersHtml(){let list=topScorersList();return '<section class="card"><h2 class="card-title">Legjobb g&oacute;ll&ouml;v&#337;k - Top 20</h2><div class="wc-stat-list stat-match-list">'+(list.length?list.map((s,i)=>goalScorerStatRow(i+1,s)).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs adat','A val&oacute;s g&oacute;lszerz&#337;k ut&aacute;n friss&uuml;l','0')).join(''))+'</div></section>'}
function topMatchesHtml(){let realRes=FX.map(x=>({m:x,p:actualFor(x),source:'Valós'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a)&&(x.p.started||x.p.finished)),tipRes=FX.filter(x=>{let r=actualFor(x);return !(r&&validScore(r.h)&&validScore(r.a)&&(r.started||r.finished))}).map(x=>({m:x,p:PRED[x.id],source:'Tipp'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a)),koTipRes=(()=>{try{return buildAllPostseasonMatches().filter(m=>m&&m.h&&m.a&&!m.locked).map(m=>({m:{id:m.id,h:m.h,a:m.a,g:'',d:'',title:(m.title||postseasonCategory(m)||''),index:m.index,stage:m.stage,phase:m.phase},p:KO_PRED[m.id],source:'Tipp'})).filter(x=>x.p&&validScore(x.p.h)&&validScore(x.p.a))}catch(e){return []}})(),res=realRes.concat(tipRes).concat(koTipRes),goalMatches=res.slice().sort((a,b)=>(b.p.h+b.p.a)-(a.p.h+a.p.a)).slice(0,20),diffMatches=res.slice().sort((a,b)=>Math.abs(b.p.h-b.p.a)-Math.abs(a.p.h-a.p.a)||(b.p.h+b.p.a)-(a.p.h+a.p.a)).slice(0,20);return '<section class="card"><h2 class="card-title">Legg&oacute;losabb meccsek - Top 20</h2><div class="wc-stat-list stat-match-list">'+(goalMatches.length?goalMatches.map((x,i)=>matchStatRow(i+1,x,'score')).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs adat','A val&oacute;s eredm&eacute;nyek ut&aacute;n friss&uuml;l','0')).join(''))+'</div></section><section class="card"><h2 class="card-title">Legegyoldal&uacute;bb meccsek - Top 20</h2><div class="wc-stat-list stat-match-list">'+(diffMatches.length?diffMatches.map((x,i)=>matchStatRow(i+1,x,'diff')).join(''):Array.from({length:20},(_,i)=>statRow(i+1,'M&eacute;g nincs lej&aacute;tszott m&eacute;rk&#337;z&eacute;s','G&oacute;lk&uuml;l&ouml;nbs&eacute;g: 0','0')).join(''))+'</div></section>'}

// Score validation, fair play, standings calculation and table row builders

function validOdds(v){return v!=null&&v!==''&&!isNaN(+v)&&+v>=1}
function getPred(id){let p=PRED[id];return p&&validScore(p.h)&&validScore(p.a)?{h:+p.h,a:+p.a}:null}
function sideAdd(s,gf,ga){s.P++;s.gf+=gf;s.ga+=ga;s.diff=s.gf-s.ga;if(gf>ga){s.w++;s.pts+=3}else if(gf===ga){s.d++;s.pts++}else s.l++}
function applyResult(rows,m,p){let h=rows[m.h],a=rows[m.a];if(!h||!a)return;sideAdd(h,p.h,p.a);sideAdd(a,p.a,p.h);sideAdd(h.home,p.h,p.a);sideAdd(a.away,p.a,p.h);let hf=p.h>p.a?'W':p.h===p.a?'D':'L',af=p.a>p.h?'W':p.a===p.h?'D':'L';h.form.unshift(hf);a.form.unshift(af);if(h.home.form)h.home.form.unshift(hf);if(a.away.form)a.away.form.unshift(af)}
function calcFairPlay(){
  // Fair play pontozás:
  // Sárga lap: -1
  // Kettős sárga (yellowRed): -3
  // Direkt piros: -4
  // Sárga + direkt piros ugyanabban a meccsben: -5
  const fp={};
  ALL.forEach(n=>fp[n]={yellow:0,yellowRed:0,red:0,yellowPlusRed:0,score:0});
  FX.forEach(m=>{
    const r=LIVE_RESULTS[m.id];
    if(!r||(!(r.started||r.finished)))return;
    const yellows=Array.isArray(r.yellowCards)?r.yellowCards:[];
    const reds=Array.isArray(r.redCards)?r.redCards:[];
    // Sárga lapok
    yellows.forEach(c=>{
      const team=c.team==='a'?m.a:m.h;
      if(fp[team])fp[team].yellow++;
    });
    // Piros lapok - megkülönböztetjük a típusokat
    reds.forEach(c=>{
      const team=c.team==='a'?m.a:m.h;
      if(!fp[team])return;
      if(c.yellowRed){
        fp[team].yellowRed++;
      } else {
        // Direkt piros - volt-e ugyanebben a meccsben sárga lap is ennél a játékosnál?
        // Ha igen, sárga+direkt piros = -5 (a sárga -1 + piros -4 = -5)
        // Egyszerűsítve: a redCards-ban yellowPlusRed flag-et nézünk
        if(c.yellowPlusRed){
          fp[team].yellowPlusRed++;
        } else {
          fp[team].red++;
        }
      }
    });
  });
  // Pontszám számítás fair play szabályok szerint
  Object.values(fp).forEach(t=>{
    t.score=-(t.yellow*1 + t.yellowRed*3 + t.red*4 + t.yellowPlusRed*5);
  });
  return fp;
}
function cmpTeam(a,b){
  // Fair play: MANUAL_FP (manuális override) + automatikus lap-számítás
  const fp=calcFairPlay();
  const fpA=(MANUAL_FP[a.name]||0)+(fp[a.name]?.score||0);
  const fpB=(MANUAL_FP[b.name]||0)+(fp[b.name]?.score||0);
  return b.pts-a.pts||b.diff-a.diff||b.gf-a.gf||a.ga-b.ga||(fpB-fpA)||((TEAM_RANKS[a.name]||999)-(TEAM_RANKS[b.name]||999))||a.name.localeCompare(b.name);
}
function cmpTeamH2H(a,b,h2h){let ka=a.name+'|'+b.name,kb=b.name+'|'+a.name,ha=h2h[ka],hb=h2h[kb];if(ha&&hb){let ap=ha.w*3+ha.d,bp=hb.w*3+hb.d;if(ap!==bp)return bp-ap;let agd=ha.gf-ha.ga,bgd=hb.gf-hb.ga;if(agd!==bgd)return bgd-agd;if(ha.gf!==hb.gf)return hb.gf-ha.gf;}return 0;}
function roundsWithData(){let has={};for(let i=1;i<=30;i++)has[i]=false;FX.forEach(m=>{let lr=LIVE_RESULTS[m.id],hasReal=lr&&lr.started&&validScore(lr.h)&&validScore(lr.a),hasPred=!!getPred(m.id);if(hasReal||hasPred)has[m.r]=true});return has}
function groupRows(g){let rows={};g.teams.forEach(n=>rows[n]=mk(n,g.key));let h2h={};FX.filter(m=>m.g===g.key&&(!S.tblRound||m.r<=S.tblRound)).forEach(m=>{let lr=LIVE_RESULTS[m.id],p=(lr&&(lr.started||lr.finished)&&validScore(lr.h)&&validScore(lr.a))?{h:+lr.h,a:+lr.a}:getPred(m.id);if(p){applyResult(rows,m,p);let kh=m.h+'|'+m.a,ka=m.a+'|'+m.h;if(!h2h[kh])h2h[kh]={w:0,d:0,l:0,gf:0,ga:0};if(!h2h[ka])h2h[ka]={w:0,d:0,l:0,gf:0,ga:0};if(p.h>p.a){h2h[kh].w++;h2h[ka].l++;}else if(p.h<p.a){h2h[kh].l++;h2h[ka].w++;}else{h2h[kh].d++;h2h[ka].d++;}h2h[kh].gf+=p.h;h2h[kh].ga+=p.a;h2h[ka].gf+=p.a;h2h[ka].ga+=p.h;}});let sorted=Object.values(rows).sort(cmpTeam);// Apply head-to-head within tied groups
let result=[];let i=0;while(i<sorted.length){let j=i+1;while(j<sorted.length&&sorted[j].pts===sorted[i].pts)j++;let group=sorted.slice(i,j);if(group.length>1)group.sort((a,b)=>cmpTeamH2H(a,b,h2h)||cmpTeam(a,b));result.push(...group);i=j;}return result;}
function isLiveTeam(name){return FX.some(m=>{let lr=LIVE_RESULTS[m.id];return lr&&lr.started&&!lr.finished&&(m.h===name||m.a===name)})}
const SHORT_NAMES={"Universitatea Craiova":"U. Craiova","Universitatea Cluj":"U. Cluj","CFR Cluj":"CFR Cluj","FCSB":"FCSB","Rapid București":"Rapid","FC Argeș":"Argeș","UTA Arad":"UTA Arad","Oțelul Galați":"Oțelul","FC Botoșani":"Botoșani","Csikszereda":"Csikszereda","Petrolul Ploiești":"Petrolul","Dinamo":"Dinamo","Farul Constanța":"Farul","FC Voluntari":"Voluntari","Corvinul Hunedoara":"Corvinul","Sepsi OSK":"Sepsi OSK"};
const LONG_NAMES={"Universitatea Craiova":"Universitatea Craiova","Universitatea Cluj":"Universitatea Cluj","CFR Cluj":"CFR Cluj","FCSB":"FCSB","Rapid București":"Rapid București","FC Argeș":"FC Argeș Pitești","UTA Arad":"UTA Arad","Oțelul Galați":"Oțelul Galați","FC Botoșani":"FC Botoșani","Csikszereda":"FK Csíkszereda","Petrolul Ploiești":"Petrolul Ploiești","Dinamo":"Dinamo București","Farul Constanța":"Farul Constanța","FC Voluntari":"FC Voluntari","Corvinul Hunedoara":"Corvinul Hunedoara","Sepsi OSK":"Sepsi OSK"};
function stn(n){return SHORT_NAMES[n]||n;}
function ltn(n){return LONG_NAMES[n]||n;}
function isDesktopNames(){return typeof window==='undefined'||!window.matchMedia||window.matchMedia('(min-width: 760px)').matches;}
function teamNameFor(name,context){
  if(!name)return name;
  if(context==='table-full')return ltn(name);
  if(context==='match-card'||context==='match-modal'||context==='stat-match'||context==='baraj-match')return isDesktopNames()?ltn(name):stn(name);
  return stn(name);
}
function postseasonStar(r){return r&&r.oddRegular?'*':'';}
function tableTeamName(r,longView){return (longView?teamNameFor(r.name,'table-full'):stn(r.name))+postseasonStar(r);}
function calcStandings(){return groupRows(GROUPS[0]);}
function buildTables(){return GROUPS.map(g=>{let rows=groupRows(g);return{key:g.key,title:compLabel(g.key),zones:[{lbl:'Tov&aacute;bbjut&aacute;s a playoffba',clr:'var(--green)',rows:rows.slice(0,6)},{lbl:'Playout mez&#337;ny',clr:'var(--blue)',rows:rows.slice(6,16)}]}})}
function thirdRows(){return GROUPS.map(g=>groupRows(g)[2]).sort(cmpTeam)}
function ast(r){return S.filt==='home'?r.home:S.filt==='away'?r.away:r}
function cmpFilteredRow(a,b){let aa=ast(a),bb=ast(b);return bb.pts-aa.pts||bb.diff-aa.diff||bb.gf-aa.gf||aa.ga-bb.ga||((TEAM_RANKS[a.name]||999)-(TEAM_RANKS[b.name]||999))||a.name.localeCompare(b.name)}
function sortRowsForTable(rows){return S.filt==='all'?rows:rows.slice().sort(cmpFilteredRow)}
function visibleFormForRow(r){return S.filt==='home'?(r.home.form||[]):S.filt==='away'?(r.away.form||[]):(r.form||[])}
function hdr(){if(S.view==='short')return'<div class="grid short thead"><div></div><div class="th-team"></div><div>M</div><div>GK</div><div>Pts</div></div>';if(S.view==='full')return'<div class="grid full thead"><div></div><div></div><div>M</div><div>Gy</div><div>D</div><div>V</div><div>Gól</div><div>Pts</div></div>';return'<div class="grid formv thead"><div></div><div class="th-team"></div><div>Pts</div><div style="text-align:left">Forma</div></div>';}
function row(r,p){let a=ast(r),gd=(a.diff>0?'+':'')+a.diff,lc=isLiveTeam(r.name)?' live-team':'';if(S.view==='short')return '<div class="grid short row'+lc+'"><div class="rank">'+p+'</div><div class="tc">'+crest(r.name)+'<span class="tname">'+esc(tableTeamName(r,false))+'</span></div><div class="num">'+a.P+'</div><div class="num">'+gd+'</div><div class="num">'+a.pts+'</div></div>';if(S.view==='full')return '<div class="grid full row'+lc+'"><div class="rank">'+p+'</div><div class="tname">'+esc(tableTeamName(r,true))+'</div><div class="num">'+a.P+'</div><div class="num">'+a.w+'</div><div class="num">'+a.d+'</div><div class="num">'+a.l+'</div><div class="num">'+a.gf+':'+a.ga+'</div><div class="num">'+a.pts+'</div></div>';return '<div class="grid formv row'+lc+'"><div class="rank">'+p+'</div><div class="tname">'+esc(tableTeamName(r,false))+'</div><div class="fstrip"><span class="stat-badge goals">#'+(TEAM_RANKS[r.name]||'-')+'</span></div><div class="num">'+a.pts+'</div></div>'}
function zone(z,p){let h='<div class="zone '+(z.clr?'zl':'')+'"'+(z.clr?' style="--zc:'+z.clr+'"':'')+'>';if(z.lbl)h+='<div class="zlabel">'+z.lbl+'</div>';z.rows.forEach((r,i)=>h+=row(r,p+i));return{h:h+'</div>',n:p+z.rows.length}}
function postseasonTableRoundOptions(){
  let opts=[['current','Aktuális'],['seed','Felezés után']];
  for(let n=1;n<=10;n++)opts.push(['R'+n,'Rájátszás '+n+'. ford. után']);
  return opts;
}
function regularTableRoundOptions(){
  let opts=[[0,'V&eacute;gleges / aktu&aacute;lis']];
  for(let n=1;n<=30;n++)opts.push([n,n+'. fordul&oacute; ut&aacute;n']);
  return opts;
}
function syncTblRoundDrop(){
  const wrap=tblRoundBtn&&tblRoundBtn.closest?tblRoundBtn.closest('.view-wrap'):tblRoundBtn.parentElement;
  if(wrap){wrap.classList.add('tbl-round-wrap');wrap.classList.toggle('postseason-round-wrap',S.tab==='knockout')}
  const isPost=S.tab==='knockout';
  let opts=isPost?postseasonTableRoundOptions():regularTableRoundOptions();
  let selected=isPost?(S.postRound||'current'):S.tblRound;
  if(!opts.some(o=>String(o[0])===String(selected))){selected=isPost?'current':0;if(isPost)S.postRound=selected;else S.tblRound=selected}
  tblRoundDrop.classList.toggle('postseason-round-drop',isPost);
  tblRoundDrop.innerHTML=opts.map(([v,lbl])=>'<button data-tr="'+esc(v)+'"'+(String(v)===String(selected)?' class="active"':'')+'>'+lbl+'</button>').join('');
  let active=opts.find(o=>String(o[0])===String(selected));
  tblRoundTxt.innerHTML=active?active[1]:(isPost?'Aktuális':'V&eacute;gleges / aktu&aacute;lis');
  tblRoundBtn.parentElement.style.display='';
}
function formStrip(form){return(form||[]).slice(0,5).map(f=>'<span class="fb '+f+'">'+f+'</span>').join('');}
function sl_row(r,p){let a=ast(r),gd=(a.diff>0?'+':'')+a.diff,lc=isLiveTeam(r.name)?' live-team':'';if(S.view==='short')return'<div class="grid short row'+lc+'"><div class="rank">'+p+'</div><div class="tc">'+crest(r.name)+'<span class="tname">'+esc(tableTeamName(r,false))+'</span></div><div class="num">'+a.P+'</div><div class="num">'+gd+'</div><div class="num pts">'+a.pts+'</div></div>';if(S.view==='full')return'<div class="grid full row'+lc+'"><div class="rank">'+p+'</div><div class="tname">'+esc(tableTeamName(r,true))+'</div><div class="num">'+a.P+'</div><div class="num">'+a.w+'</div><div class="num">'+a.d+'</div><div class="num">'+a.l+'</div><div class="num">'+a.gf+':'+a.ga+'</div><div class="num pts">'+a.pts+'</div></div>';return'<div class="grid formv row'+lc+'"><div class="rank">'+p+'</div><div class="tc">'+crest(r.name)+'<span class="tname">'+esc(tableTeamName(r,false))+'</span></div><div class="num pts">'+a.pts+'</div><div class="fstrip">'+formStrip(visibleFormForRow(r))+'</div></div>';}
function sl_zone(z,p){let h='<div class="zone '+(z.clr?'zl':'')+(z.lbl?' lbl':'')+'"'+(z.clr?' style="--zc:'+z.clr+'"':'')+'>'+( z.lbl?'<div class="zlabel">'+z.lbl+'</div>':'');z.rows.forEach((r,i)=>h+=sl_row(r,p+i));return{h:h+'</div>',n:p+z.rows.length};}
let SUPERLIGA_MODAL_SCROLL_Y=0;
let SUPERLIGA_MODAL_LOCKED=false;
function syncModalOpenClass(){
  const open=!!document.querySelector('.tip-overlay,.community-preview');

  if(open&&!SUPERLIGA_MODAL_LOCKED){
    SUPERLIGA_MODAL_SCROLL_Y=Math.max(0,window.scrollY||document.documentElement.scrollTop||0);
    SUPERLIGA_MODAL_LOCKED=true;

    document.body.style.removeProperty('top');
    document.documentElement.style.setProperty('--modal-scroll-y',SUPERLIGA_MODAL_SCROLL_Y+'px');
    document.body.classList.add('modal-open');
    document.documentElement.classList.add('modal-open');
    return;
  }

  if(!open&&SUPERLIGA_MODAL_LOCKED){
    const y=SUPERLIGA_MODAL_SCROLL_Y;
    SUPERLIGA_MODAL_LOCKED=false;

    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');
    document.body.style.removeProperty('top');
    document.body.style.removeProperty('left');
    document.body.style.removeProperty('right');
    document.body.style.removeProperty('width');
    document.body.style.removeProperty('height');
    document.body.style.removeProperty('position');
    document.documentElement.style.removeProperty('--modal-scroll-y');

    if(Math.abs((window.scrollY||0)-y)>1){
      requestAnimationFrame(()=>window.scrollTo({top:y,left:0,behavior:'instant'}));
    }
  }
}
function closeAllModals(){document.querySelectorAll('.tip-overlay,.community-preview').forEach(x=>x.remove());syncModalOpenClass()}
function tableHtml(tbl){let out='<div class="standings">'+hdr(),p=1;(tbl.zones||[]).forEach(z=>{let r=sl_zone(z,p);out+=r.h;p=r.n});return out+'</div>'}

// Escaping, labels, club crest rendering, basic row model

function validScore(v){return v!==''&&v!=null&&!isNaN(+v)&&+v>=0&&+v<=99&&Math.floor(+v)===+v}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ini(n){return n.split(/\s+/).map(w=>w[0]).join('').replace(/[^A-Z]/gi,'').slice(0,3).toUpperCase()}
function compLabel(g){return g==='SL'?'SuperLiga':g==='PO'?'Playoff':g==='PL'?'Playout':g==='BR'?'Baraj':g+' csoport'}
function logo(n){let id=TEAM_IDS[n];return id?['https://images.fotmob.com/image_resources/logo/teamlogo/'+id+'.png','https://images.fotmob.com/image_resources/logo/teamlogo/'+id+'_xsmall.png','https://images.fotmob.com/image_resources/logo/teamlogo/'+id+'.svg']:[]}
function crest(n,s){let u=logo(n),st=s?' style="--cs:'+s+'"':'';return '<span class="crest" data-n="'+esc(n)+'" data-i="0" data-u="'+encodeURIComponent(JSON.stringify(u))+'"'+st+'><img alt="'+esc(n)+'" src="'+(u[0]||'')+'" loading="eager" decoding="async"><span class="svg-fb"></span><span class="ini-fb">'+ini(n)+'</span></span>'}
let cache={};try{cache=JSON.parse(sessionStorage.getItem('superliga_fotmob_logos_v2')||'{}')}catch(e){}function save(){try{sessionStorage.setItem('superliga_fotmob_logos_v2',JSON.stringify(cache))}catch(e){}}
function activateCrests(){document.querySelectorAll('.crest').forEach(el=>{let n=el.dataset.n,img=el.querySelector('img');if(!img)return;if(cache[n])img.src=cache[n];img.onerror=()=>{let u=JSON.parse(decodeURIComponent(el.dataset.u||'%5B%5D')),i=(+el.dataset.i||0)+1;el.dataset.i=i;if(i<u.length)img.src=u[i];else el.classList.add('show-ini')};img.onload=()=>{el.classList.remove('show-ini','show-svg');if(!cache[n]){cache[n]=img.src;save()}};if(img.complete&&img.naturalWidth>0)img.onload();else if(img.complete)img.onerror()})}
function playerCard(p){return '<div class="ov-player"><div class="ov-player-wrap"><img class="ov-player-img" src="'+p.img+'" alt="'+esc(p.short)+'" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'" loading="lazy"><div class="ov-player-img no-img" style="display:none">&#128100;</div><div class="ov-crest-badge">'+crest(p.club)+'</div></div><div class="ov-rating-badge">'+p.rating.toFixed(2)+'</div><div class="ov-player-name">'+p.short+'</div></div>'}
function mkSide(){return{P:0,w:0,d:0,l:0,gf:0,ga:0,diff:0,pts:0,form:[]}}
function mk(n,g){return{name:n,grp:g,P:0,w:0,d:0,l:0,gf:0,ga:0,diff:0,pts:0,home:mkSide(),away:mkSide(),form:[]}}

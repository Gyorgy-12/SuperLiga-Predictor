// Optional Firebase/community leaderboard service with lazy SDK loading and deduped writes.

let superligaDb=null;
let superligaAuth=null;
let superligaUser=null;
let superligaBackendReady=false;
let superligaBackendError='';
let superligaCommunityItems=[];
let superligaAutosaveTimer=null;
let superligaCommunityUnsub=null;
let superligaFirebaseLoadPromise=null;
let superligaAuthBound=false;
let superligaCommunityActive=false;
let superligaOwnTipsLoaded=false;
let superligaOwnTipsLoadFailed=false;
let superligaRemoteDocExists=false;
let superligaLastCommunityFetch=0;
let superligaLastPublishedHash='';
let superligaLastProfileHash='';

function superligaFirebaseConfigured(){return !!(SUPERLIGA_FIREBASE_CONFIG.apiKey&&SUPERLIGA_FIREBASE_CONFIG.projectId&&SUPERLIGA_FIREBASE_CONFIG.appId)}
function superligaFirebaseRuntimeOk(){try{return /^(http:|https:|chrome-extension:)$/i.test(location.protocol)&&!!window.localStorage}catch(e){return false}}
function superligaLoadScript(src){return new Promise((res,rej)=>{let old=document.querySelector('script[src="'+src+'"]');if(old){res();return}let s=document.createElement('script');s.src=src;s.onload=res;s.onerror=()=>rej(new Error('Nem sikerült betölteni: '+src));document.head.appendChild(s)})}
function superligaStableJson(v){if(v==null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return'['+v.map(superligaStableJson).join(',')+']';return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+superligaStableJson(v[k])).join(',')+'}'}
function superligaTipsPayload(){return{pred:superligaCleanTips(PRED),ko:superligaCleanTips(KO_PRED)}}
function superligaTipsHash(){return superligaStableJson(superligaTipsPayload())}
function superligaProfileHash(u){return superligaStableJson({uid:u?.uid||'',displayName:u?.displayName||'',email:u?.email||'',photoURL:u?.photoURL||''})}

async function loadSuperligaFirebase(opts={}){
  if(FROZEN_MODE||!superligaFirebaseConfigured())return false;
  if(!superligaFirebaseRuntimeOk()){
    superligaBackendError='A Firebase bejelentkezés és közösségi szinkron csak http/https alatt működik. Nyisd meg localhostról vagy GitHub Pages-ről, ne közvetlen file:// fájlként.';
    return false;
  }
  if(superligaBackendReady){if(opts.community)setCommunityActive(true);return true}
  if(superligaFirebaseLoadPromise)return superligaFirebaseLoadPromise.then(ok=>{if(ok&&opts.community)setCommunityActive(true);return ok});
  superligaFirebaseLoadPromise=(async()=>{
    try{
      let v=SUPERLIGA_FIREBASE_SDK_VERSION;
      if(!window.firebase||!firebase.initializeApp)await superligaLoadScript('https://www.gstatic.com/firebasejs/'+v+'/firebase-app-compat.js');
      if(!firebase.auth)await superligaLoadScript('https://www.gstatic.com/firebasejs/'+v+'/firebase-auth-compat.js');
      if(!firebase.firestore)await superligaLoadScript('https://www.gstatic.com/firebasejs/'+v+'/firebase-firestore-compat.js');
      initSuperligaFirebase();
      return true;
    }catch(e){superligaBackendError=e.message||String(e);if(S.tab==='community')renderCommunity();return false}
  })();
  return superligaFirebaseLoadPromise.then(ok=>{if(ok&&opts.community)setCommunityActive(true);return ok});
}
function initSuperligaFirebase(){
  if(superligaBackendReady)return;
  let app=(firebase.apps||[]).find(a=>a.name===SUPERLIGA_FIREBASE_APP_NAME)||firebase.initializeApp(SUPERLIGA_FIREBASE_CONFIG,SUPERLIGA_FIREBASE_APP_NAME);
  superligaAuth=app.auth();
  superligaDb=app.firestore();
  superligaBackendReady=true;
  if(!superligaAuthBound){
    superligaAuthBound=true;
    superligaAuth.onAuthStateChanged(handleSuperligaAuthState);
  }
}
async function handleSuperligaAuthState(u){
  superligaUser=u||null;
  superligaOwnTipsLoaded=false;
  superligaOwnTipsLoadFailed=false;
  superligaRemoteDocExists=false;
  try{
    if(u){
      await saveSuperligaUserProfile(u);
      await loadOwnTipsFromFirebase();
    }else{
      let local=superligaReadLocalPreds();
      PRED=superligaCleanTips(local.pred);KO_PRED=superligaCleanTips(local.ko);
      superligaOwnTipsLoaded=true;
      superligaLastPublishedHash='';
      superligaRequestRender('auth-local');
    }
    if(superligaCommunityActive)await loadCommunityTips({force:true});
    if(S.tab==='community')renderCommunity();
  }catch(e){superligaBackendError=e.message||String(e);if(S.tab==='community')renderCommunity()}
}
async function saveSuperligaUserProfile(u){
  if(!superligaDb||!u)return false;
  let hash=superligaProfileHash(u);if(hash===superligaLastProfileHash)return false;
  superligaLastProfileHash=hash;
  await superligaDb.collection(SUPERLIGA_COLLECTIONS.users).doc(u.uid).set({uid:u.uid,displayName:u.displayName||'',email:u.email||'',photoURL:u.photoURL||'',updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
  return true;
}
async function loadOwnTipsFromFirebase(){
  if(!superligaDb||!superligaUser)return false;
  superligaOwnTipsLoaded=false;superligaOwnTipsLoadFailed=false;
  try{
    let doc=await superligaDb.collection(SUPERLIGA_COLLECTIONS.community).doc(superligaUser.uid).get();
    superligaRemoteDocExists=doc.exists;
    if(doc.exists){
      let d=doc.data()||{},remotePred=superligaPickObj(d,['pred','predictions','tips','groupPred','groupPredictions','PRED']),remoteKo=superligaPickObj(d,['ko','knockout','knockoutPredictions','koPred','KO_PRED']);
      PRED=superligaCleanTips(remotePred);KO_PRED=superligaCleanTips(remoteKo);superligaClearLocalPreds();superligaLastPublishedHash=superligaTipsHash();superligaOwnTipsLoaded=true;superligaRequestRender('own-tips');return true;
    }
    superligaOwnTipsLoaded=true;
    if(superligaHasTips(PRED)||superligaHasTips(KO_PRED))await publishCommunityTips(true,{force:true,allowEmpty:false});
    return false;
  }catch(e){superligaOwnTipsLoadFailed=true;superligaBackendError=e.message||String(e);return false}
}
function queueCommunityAutosave(){
  if(!superligaDb||!superligaUser||FROZEN_MODE||READONLY_MODE)return;
  clearTimeout(superligaAutosaveTimer);
  superligaAutosaveTimer=setTimeout(()=>publishCommunityTips(true,{allowEmpty:true}),SUPERLIGA_AUTOSAVE_MS);
}
async function publishCommunityTips(silent,opts={}){
  if(!superligaDb||!superligaUser||FROZEN_MODE||READONLY_MODE)return false;
  if(superligaOwnTipsLoadFailed&&!opts.force){superligaBackendError='Nem sikerült betölteni a Firebase-ben lévő saját tippeket, ezért nem írok rá vakon az adatbázisra.';if(S.tab==='community')renderCommunity();return false}
  if(!superligaOwnTipsLoaded&&!opts.force){await loadOwnTipsFromFirebase();if(superligaOwnTipsLoadFailed)return false}
  if(opts.allowEmpty===false&&!superligaHasTips(PRED)&&!superligaHasTips(KO_PRED))return false;
  let hash=superligaTipsHash();if(!opts.force&&hash===superligaLastPublishedHash)return false;
  let payload=superligaTipsPayload();
  let data={uid:superligaUser.uid,displayName:superligaUser.displayName||superligaUser.email||'Játékos',photoURL:superligaUser.photoURL||'',...payload,summary:communitySummary(payload.pred,payload.ko),updatedAt:firebase.firestore.FieldValue.serverTimestamp(),version:4,storage:'firebase-deduped'};
  await superligaDb.collection(SUPERLIGA_COLLECTIONS.community).doc(superligaUser.uid).set(data,{merge:true});
  superligaRemoteDocExists=true;superligaLastPublishedHash=hash;
  if(!silent&&superligaCommunityActive)await loadCommunityTips({force:true});
  if(!silent&&S.tab==='community')renderCommunity();
  return true;
}
async function loadCommunityTips(opts={}){
  if(!superligaDb){superligaCommunityItems=[];return false}
  let now=Date.now();if(!opts.force&&now-superligaLastCommunityFetch<SUPERLIGA_COMMUNITY_TTL_MS)return false;
  try{let snap=await superligaDb.collection(SUPERLIGA_COLLECTIONS.community).orderBy('updatedAt','desc').limit(80).get();superligaCommunityItems=snap.docs.map(d=>({id:d.id,...d.data()}));superligaLastCommunityFetch=now;return true}catch(e){superligaBackendError=e.message||String(e);return false}
}
function listenCommunityTips(){
  if(!superligaDb||superligaCommunityUnsub)return;
  try{superligaCommunityUnsub=superligaDb.collection(SUPERLIGA_COLLECTIONS.community).orderBy('updatedAt','desc').limit(80).onSnapshot(snap=>{superligaCommunityItems=snap.docs.map(d=>({id:d.id,...d.data()}));superligaLastCommunityFetch=Date.now();if(S.tab==='community')renderCommunity();refreshCommunityPreviews();},e=>{superligaBackendError=e.message||String(e);if(S.tab==='community')renderCommunity()})}catch(e){superligaBackendError=e.message||String(e)}
}
function stopCommunityTips(){if(superligaCommunityUnsub){try{superligaCommunityUnsub()}catch(e){}superligaCommunityUnsub=null}}
function setCommunityActive(active){
  superligaCommunityActive=!!active;
  if(!active){stopCommunityTips();return}
  loadSuperligaFirebase().then(ok=>{if(!ok)return;loadCommunityTips().then(changed=>{if(changed&&S.tab==='community')renderCommunity()});listenCommunityTips()});
}
async function superligaSignIn(){let ok=await loadSuperligaFirebase({community:true});if(!ok){renderCommunity();return}await superligaAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider())}
async function superligaSignOut(){if(superligaAuth)await superligaAuth.signOut()}
async function superligaRenameProfile(){if(!superligaUser||!superligaDb)return;let current=superligaUser.displayName||superligaUser.email||'Játékos',name=prompt('Új közösségi név',current);if(!name)return;name=name.trim().slice(0,42);if(!name)return;try{if(superligaUser.updateProfile)await superligaUser.updateProfile({displayName:name});await saveSuperligaUserProfile({uid:superligaUser.uid,email:superligaUser.email||'',photoURL:superligaUser.photoURL||'',displayName:name});await publishCommunityTips(false,{force:true})}catch(e){superligaBackendError=e.message||String(e);renderCommunity()}}

function communityGoalSum(obj){return Object.values(obj||{}).reduce((n,p)=>n+(validScore(p&&p.h)?+p.h:0)+(validScore(p&&p.a)?+p.a:0),0)}
function gradeTip(p,r){if(!p||!r||!validScore(r.h)||!validScore(r.a))return{cat:'miss',pts:0,label:'Nincs tipp'};let ph=+p.h,pa=+p.a,rh=+r.h,ra=+r.a;if(ph===rh&&pa===ra)return{cat:'exact',pts:1,label:'Pontos'};if(ph-pa===rh-ra)return{cat:'diff',pts:.5,label:'Gólkülönbség'};if(Math.sign(ph-pa)===Math.sign(rh-ra))return{cat:'outcome',pts:.25,label:'Kimenetel'};return{cat:'miss',pts:0,label:'Téves'}}
function communityWithTips(pred,ko,fn){let oldP=PRED,oldK=KO_PRED;try{PRED=pred||{};KO_PRED=ko||{};return fn()}finally{PRED=oldP;KO_PRED=oldK}}
function communityKoMatches(pred,ko){return communityWithTips(pred,ko,()=>groupsComplete()?buildAllPostseasonMatches():[])}
function communityEfficiency(pred=PRED,ko=KO_PRED){let out={pts:0,max:0,pct:0,exact:0,diff:0,outcome:0,miss:0,played:0,groupPlayed:0,koPlayed:0};FX.forEach(m=>{let r=actualFor(m);if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return;out.max++;out.groupPlayed++;let g=gradeTip((pred||{})[m.id],r);out.pts+=g.pts;out[g.cat]++});communityKoMatches(pred,ko).forEach(m=>{let r=actualFor({id:m.id});if(!r||!(r.started||r.finished)||!validScore(r.h)||!validScore(r.a))return;out.max++;out.koPlayed++;let g=gradeKoTip((ko||{})[m.id],r);out.pts+=g.pts;out[g.cat]=(out[g.cat]||0)+1});out.played=out.max;out.pct=out.max?+(out.pts/out.max*100).toFixed(2):0;return out}
function communitySummary(pred=PRED,ko=KO_PRED){let groupCount=Object.keys(pred||{}).length,koCount=Object.keys(ko||{}).length,eff=communityEfficiency(pred,ko),koTotal=0;try{koTotal=groupsComplete()?buildAllPostseasonMatches().length:0}catch(e){}return{groupCount,koCount,total:groupCount+koCount,goals:communityGoalSum(pred)+communityGoalSum(ko),completedGroup:groupCount>=FX.length,completedKo:koTotal?koCount>=koTotal:false,eff}}
function communityDate(v){try{if(v&&v.toDate)v=v.toDate();if(!v)return'';return new Date(v).toLocaleString('hu-HU',{timeZone:SUPERLIGA_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}catch(e){return''}}
function communityPredGradeClass(g){return g&&g.cat?' grade-'+g.cat:''}
function communityPredScoreHtml(p,r,g){let tip=p&&validScore(p.h)&&validScore(p.a)?p.h+' - '+p.a:'-',real=r&&validScore(r.h)&&validScore(r.a)?r.h+' - '+r.a:'-',clock=liveClockLabel(r),isIntCom=r&&!r.finished&&String(r.status||'').toUpperCase().includes('INT'),clockPill=(clock?'<span class="tip-live-clock community-live-clock">'+clock+'</span>':'')+(isIntCom?'<span class="tip-live-clock community-live-clock int-modal-badge">INT.</span>':'');return'<div class="community-result"><div><span>Val&oacute;s</span><b class="community-real-score">'+clockPill+'<span class="community-real-value">'+esc(real)+'</span></b></div><div><span>Tipp</span><b>'+esc(tip)+'</b></div><small>'+esc(g?.label||'Várakozik')+'</small></div>'}
function communityMatchRow(x,p){let r=actualFor(x),g=r&&(r.finished||r.started)&&validScore(r.h)&&validScore(r.a)?gradeTip(p,r):{cat:'pending',pts:0,label:'Várakozik'};return'<div class="community-pred'+communityPredGradeClass(g)+'"><div class="community-teams"><div class="community-match-line"><div class="community-team">'+crest(x.h,'24px')+'<span>'+esc(ltn(x.h))+'</span></div><span class="community-vs">-</span><div class="community-team">'+crest(x.a,'24px')+'<span>'+esc(ltn(x.a))+'</span></div></div><small>'+localMatchDate(x)+' · '+esc(compLabel(x.g))+' · '+x.r+'. forduló</small></div>'+communityPredScoreHtml(p,r,g)+'</div>'}
function communityMatchRows(item,round){let wanted=Array.isArray(round)?round:null;let rows=FX.filter(x=>!round||(wanted?wanted.includes(x.r):x.r===round)).map(x=>communityMatchRow(x,(item.pred||{})[x.id])).join('');return rows||'<div class="community-empty">Nincs megjeleníthető alapszakasz-tipp.</div>'}
function communityKoAll(item){return communityKoMatches(item.pred||{},item.ko||{})}
function communityKoRows(item,rounds){rounds=Array.isArray(rounds)?rounds:[rounds];let ms=communityKoAll(item).filter(m=>!rounds[0]||rounds.includes(m.title)||rounds.includes(m.round));let rows=ms.map(m=>{let p=(item.ko||{})[m.id],r=actualFor({id:m.id}),g=r&&(r.finished||r.started)&&validScore(r.h)&&validScore(r.a)?gradeKoTip(p,r):{cat:'pending',pts:0,label:'Várakozik'},home=m.h?ltn(m.h):m.hs,away=m.a?ltn(m.a):m.as;return'<div class="community-pred'+communityPredGradeClass(g)+'"><div class="community-teams"><div class="community-match-line"><div class="community-team">'+(m.h?crest(m.h,'24px'):'')+'<span>'+esc(home||'')+'</span></div><span class="community-vs">-</span><div class="community-team">'+(m.a?crest(m.a,'24px'):'')+'<span>'+esc(away||'')+'</span></div></div><small>'+esc(m.title||m.round||'Forduló')+'</small></div>'+communityPredScoreHtml(p,r,g)+'</div>'}).join('');return rows||'<div class="community-empty">Még nincs ilyen körhöz megjeleníthető tipp.</div>'}
function fmtCommunityPts(n){let x=Math.round((+n||0)*100)/100;return x.toLocaleString('hu-HU',{minimumFractionDigits:Number.isInteger(x)?0:2,maximumFractionDigits:2})}
function communityStatsHtml(s){let e=s.eff||communityEfficiency();return'<div class="community-grid community-grid-wide"><div class="community-stat highlight"><b>'+e.pct+'%</b><span>aktuális pontosság</span></div><div class="community-stat"><b>'+fmtCommunityPts(e.pts)+'/'+e.max+'</b><span>pont / élő vagy lezárt meccs</span></div><div class="community-stat"><b>'+s.groupCount+'</b><span>alapszakasz-tipp</span></div><div class="community-stat"><b>'+s.koCount+'</b><span>playoff / playout tipp</span></div><div class="community-stat"><b>'+s.goals+'</b><span>tippelt gól</span></div><div class="community-stat"><b>'+e.exact+'/'+e.diff+'/'+e.outcome+'</b><span>pontos · gólkül. · kimen.</span></div></div>'}
function communityRankMeta(e){return e.max?fmtCommunityPts(e.pts)+' pont / '+e.max+' élő vagy lezárt meccs':'Nincs élő vagy lezárt meccs'}
function communityTabHtml(tabs){return'<div class="community-tabs">'+tabs.map((t,i)=>'<button class="'+(i?'':'active')+'" data-community-tab="'+t.id+'">'+t.label+'</button>').join('')+'</div>'+tabs.map((t,i)=>'<div class="community-tab-panel '+(i?'':'active')+'" data-community-panel="'+t.id+'">'+t.html+'</div>').join('')}
function openCommunityTips(id){let item=superligaCommunityItems.find(x=>x.id===id||x.uid===id);if(!item)return;let s=communitySummary(item.pred||{},item.ko||{}),poTitles=Array.from({length:10},(_,i)=>'Playoff '+(i+1)+'. forduló'),plTitles=Array.from({length:9},(_,i)=>'Playout '+(i+1)+'. forduló'),tabs=[{id:'r1_10',label:'1-10. forduló',html:'<div class="community-list">'+communityMatchRows(item,[1,2,3,4,5,6,7,8,9,10])+'</div>'},{id:'r11_20',label:'11-20. forduló',html:'<div class="community-list">'+communityMatchRows(item,[11,12,13,14,15,16,17,18,19,20])+'</div>'},{id:'r21_30',label:'21-30. forduló',html:'<div class="community-list">'+communityMatchRows(item,[21,22,23,24,25,26,27,28,29,30])+'</div>'},{id:'playoff',label:'Playoff',html:'<div class="community-list">'+communityKoRows(item,poTitles)+'</div>'},{id:'playout',label:'Playout',html:'<div class="community-list">'+communityKoRows(item,plTitles)+'</div>'},{id:'confbaraj',label:'KL-baraj',html:'<div class="community-list">'+communityKoRows(item,['Konferencialiga-baraj elődöntő','Konferencialiga-baraj döntő','CB1','CB2'])+'</div>'},{id:'baraj',label:'Bentmaradás-baraj',html:'<div class="community-list">'+communityKoRows(item,['Bentmaradás-baraj 1. párharc - 1. mérkőzés','Bentmaradás-baraj 1. párharc - visszavágó','Bentmaradás-baraj 2. párharc - 1. mérkőzés','Bentmaradás-baraj 2. párharc - visszavágó','BR1','BR2'])+'</div>'}],ov=document.createElement('div');ov.className='community-preview';ov.dataset.communityViewId=id;ov.innerHTML='<div class="community-modal"><div class="community-modal-head"><div><h2 class="community-title" style="margin:0">'+esc(item.displayName||'Játékos')+'</h2><p class="community-lead">'+communityRankMeta(s.eff)+' · frissítve: '+esc(communityDate(item.updatedAt))+'</p></div><button class="community-close" type="button">Bezárás</button></div>'+communityStatsHtml(s)+communityTabHtml(tabs)+'</div>';document.body.appendChild(ov);syncModalOpenClass();activateCrests();ov.onclick=e=>{if(e.target===ov||e.target.closest('.community-close')){ov.remove();syncModalOpenClass()}let b=e.target.closest('[data-community-tab]');if(b){let root=ov.querySelector('.community-modal');root.querySelectorAll('[data-community-tab]').forEach(x=>x.classList.toggle('active',x===b));root.querySelectorAll('[data-community-panel]').forEach(x=>x.classList.toggle('active',x.dataset.communityPanel===b.dataset.communityTab))}}}
function refreshCommunityPreviews(){document.querySelectorAll('.community-preview[data-community-view-id]').forEach(ov=>{let id=ov.dataset.communityViewId,active=ov.querySelector('[data-community-tab].active')?.dataset.communityTab;ov.remove();openCommunityTips(id);let fresh=[...document.querySelectorAll('.community-preview[data-community-view-id]')].pop();if(active&&fresh){let b=fresh.querySelector('[data-community-tab="'+active+'"]');if(b)b.click()}})}
function renderCommunity(){setCommunityActive(true);let m=document.getElementById('main');m.className='main community-main';let mine=communitySummary(),configured=superligaFirebaseConfigured(),setupHtml='',rows=superligaCommunityItems.slice().sort((a,b)=>{let ea=communitySummary(a.pred||{},a.ko||{}).eff,eb=communitySummary(b.pred||{},b.ko||{}).eff;return eb.pct-ea.pct||eb.exact-ea.exact||eb.diff-ea.diff||String(a.displayName||'').localeCompare(String(b.displayName||''))});if(!configured)setupHtml='<section class="card community-card"><h1 class="community-title">Külön SuperLiga Firebase backend</h1><p class="community-lead">Illeszd be a SuperLiga Firebase projekt adatait a konfigurációs blokkba. A közösségi tippek külön Firestore gyűjteménybe mennek: <b>'+SUPERLIGA_COLLECTIONS.community+'</b>.</p></section>';let errorHtml=superligaBackendError?'<div class="community-empty" style="margin:12px 0;border-color:rgba(255,91,110,.35);color:#ffb7c0">Firebase állapot: '+esc(superligaBackendError)+'</div>':'';let authHtml=superligaUser?'<div class="community-user"><img class="community-avatar" src="'+esc(superligaUser.photoURL||'')+'" alt=""><div><div class="community-name">'+esc(superligaUser.displayName||superligaUser.email||'Játékos')+'</div><div class="community-meta">Bejelentkezve · saját tippjeid takarékosan, csak változáskor mentődnek</div></div></div><div class="community-actions"><button class="community-btn" id="superligaRenameBtn">Név módosítása</button><button class="community-btn" id="superligaLogoutBtn">Kilépés</button></div>':'<div class="community-actions"><button class="community-btn primary" id="superligaLoginBtn" '+(!configured?'disabled':'')+'>Belépés Google-lel</button></div>';let listHtml=rows.length?rows.map((item,i)=>{let s=communitySummary(item.pred||{},item.ko||{}),e=s.eff;return'<div class="community-row"><div class="community-rank">'+(i+1)+'.</div><div class="community-user"><img class="community-avatar" src="'+esc(item.photoURL||'')+'" alt=""><div><div class="community-name">'+esc(item.displayName||'Játékos')+'</div><div class="community-meta">'+communityRankMeta(e)+' · frissítve: '+esc(communityDate(item.updatedAt))+'</div></div></div><div><div class="community-score">'+(e.max?e.pct+'%':'-')+'</div><button class="community-btn" data-community-view="'+esc(item.id||item.uid)+'">Megnézés</button></div></div>'}).join(''):'<div class="community-empty">Még nincs publikus SuperLiga-tipp a backendben.</div>';m.innerHTML=setupHtml+'<section class="card community-card community-top-card"><h1 class="community-title">Közösség</h1>'+authHtml+errorHtml+communityStatsHtml(mine)+'</section><section class="card community-card"><h2 class="community-section-title" style="margin-top:0">Rangsor pontosság szerint</h2>'+listHtml+'</section>';m.querySelector('#superligaLoginBtn')?.addEventListener('click',superligaSignIn);m.querySelector('#superligaLogoutBtn')?.addEventListener('click',superligaSignOut);m.querySelector('#superligaRenameBtn')?.addEventListener('click',superligaRenameProfile);m.querySelectorAll('[data-community-view]').forEach(b=>b.addEventListener('click',()=>openCommunityTips(b.dataset.communityView)));activateCrests();syncSpacer()}

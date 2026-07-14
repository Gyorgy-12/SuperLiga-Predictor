// Prediction persistence, frozen/read-only snapshots and stale postseason cleanup.

const STORE_KEY=SUPERLIGA_CACHE_KEYS.predictions;
const KO_STORE_KEY=SUPERLIGA_CACHE_KEYS.postseason;
const FROZEN_MODE=!!window.__SUPERLIGA_FROZEN__;
const READONLY_MODE=!!window.__SUPERLIGA_READONLY__;
const FROZEN_DATA=window.__SUPERLIGA_FROZEN_DATA__||{};
if(FROZEN_MODE)document.documentElement.classList.add('frozen-mode');

function superligaSafeJson(v,fallback){try{return JSON.parse(v||'')||fallback}catch(e){return fallback}}
function superligaCloneObj(o){try{return JSON.parse(JSON.stringify(o||{}))}catch(e){return {}}}
function superligaCleanTips(o){let out={};if(!o||typeof o!=='object')return out;Object.entries(o).forEach(([id,p])=>{if(p&&typeof p==='object'&&validScore(p.h)&&validScore(p.a))out[id]={...p,h:+p.h,a:+p.a}});return out}
function superligaHasTips(o){return !!(o&&typeof o==='object'&&Object.keys(o).length)}
function superligaPickObj(d,keys){for(let k of keys){if(d&&d[k]&&typeof d[k]==='object')return d[k]}return {}}
function superligaReadStorage(primary,legacy){let val=localStorage.getItem(primary);if(val!=null)return superligaSafeJson(val,{});return superligaSafeJson(localStorage.getItem(legacy),{})}
function superligaReadLocalPreds(){
  if(FROZEN_MODE)return{pred:superligaCloneObj(FROZEN_DATA.pred),ko:superligaCloneObj(FROZEN_DATA.ko)};
  return{
    pred:superligaReadStorage(STORE_KEY,SUPERLIGA_CACHE_KEYS.legacyPredictions),
    ko:superligaReadStorage(KO_STORE_KEY,SUPERLIGA_CACHE_KEYS.legacyPostseason)
  };
}
function superligaClearLocalPreds(){try{[STORE_KEY,KO_STORE_KEY,SUPERLIGA_CACHE_KEYS.legacyPredictions,SUPERLIGA_CACHE_KEYS.legacyPostseason].forEach(k=>localStorage.removeItem(k))}catch(e){}}
function superligaWriteLocalPreds(){try{localStorage.setItem(STORE_KEY,JSON.stringify(PRED));localStorage.setItem(KO_STORE_KEY,JSON.stringify(KO_PRED))}catch(e){}}

let superligaInitialLocalTips=superligaReadLocalPreds();
let PRED=superligaCleanTips(superligaInitialLocalTips.pred);
let KO_PRED=superligaCleanTips(superligaInitialLocalTips.ko);

function savePred(){
  if(FROZEN_MODE||READONLY_MODE)return;
  if(typeof superligaUser!=='undefined'&&superligaUser){
    superligaClearLocalPreds();
    if(typeof queueCommunityAutosave==='function')queueCommunityAutosave();
    return;
  }
  superligaWriteLocalPreds();
}
async function superligaPersistTipsNow(){
  savePred();
  if(typeof superligaDb!=='undefined'&&superligaDb&&typeof superligaUser!=='undefined'&&superligaUser){
    if(typeof superligaAutosaveTimer!=='undefined')clearTimeout(superligaAutosaveTimer);
    try{await publishCommunityTips(true,{allowEmpty:true,force:true})}catch(e){superligaBackendError=e.message||String(e)}
  }
}
async function superligaDeleteGroupTip(id){delete PRED[id];await superligaPersistTipsNow()}
async function superligaDeleteKoTip(id){delete KO_PRED[id];await superligaPersistTipsNow()}
function superligaPostseasonSeedSignature(){
  try{
    let sp=splitPostseason();
    return JSON.stringify({
      po:(sp.po||[]).map(x=>x&&x.name||''),
      pl:(sp.pl||[]).map(x=>x&&x.name||'')
    });
  }catch(e){return''}
}
function superligaKoStoredSeedSignature(){
  let vals=Object.values(KO_PRED||{}).map(p=>p&&p.seedSignature).filter(Boolean);
  return vals.length?vals[0]:'';
}
function superligaStampKoSeedSignature(){
  let sig=superligaPostseasonSeedSignature(),changed=false;
  if(!sig)return false;
  Object.values(KO_PRED||{}).forEach(p=>{if(p&&p.seedSignature!==sig){p.seedSignature=sig;changed=true}});
  if(changed)savePred();
  return changed;
}
function superligaResetAllPostseasonTips(reason){
  if(FROZEN_MODE||!KO_PRED||!Object.keys(KO_PRED).length)return false;
  KO_PRED={};
  savePred();
  try{sessionStorage.setItem('superliga_last_postseason_reset_v1',JSON.stringify({reason:reason||'seed_changed',at:new Date().toISOString()}))}catch(e){}
  Promise.resolve(superligaPersistTipsNow()).catch(e=>{try{superligaBackendError=e&&e.message?e.message:String(e)}catch(_e){}});
  return true;
}
function superligaResetPostseasonTipsIfSeedChanged(){
  if(FROZEN_MODE||!KO_PRED||!Object.keys(KO_PRED).length)return false;
  let current=superligaPostseasonSeedSignature();
  let stored=superligaKoStoredSeedSignature();
  if(!current)return false;
  if(!stored)return superligaResetAllPostseasonTips('legacy_postseason_tips_after_finished_match');
  if(stored!==current)return superligaResetAllPostseasonTips('postseason_seed_changed_after_finished_match');
  return false;
}
function pruneStaleKoPred(){return superligaResetPostseasonTipsIfSeedChanged()}

// SuperLiga Predictor F2 — eager Firebase auth, reliable dual Firestore save,
// cached one-shot community preload and deduplicated realtime refresh.
//
// Load this classic script immediately AFTER community-firebase.js.

(function superligaFirestoreFastSyncF2(){
  'use strict';

  const VERSION='f2-firestore-fast-sync';
  const COMMUNITY_CACHE_KEY='superliga_community_cache_f2';
  const COMMUNITY_CACHE_TTL_MS=Math.max(
    Number(typeof SUPERLIGA_COMMUNITY_TTL_MS!=='undefined'?SUPERLIGA_COMMUNITY_TTL_MS:0)||0,
    2*60*1000
  );
  const COMMUNITY_LIMIT=80;
  const AUTOSAVE_DELAY_MS=Math.min(
    Number(typeof SUPERLIGA_AUTOSAVE_MS!=='undefined'?SUPERLIGA_AUTOSAVE_MS:800)||800,
    800
  );

  let authResolved=false;
  let authResolve=null;
  let authReadyPromise=new Promise(resolve=>{authResolve=resolve});
  let ownLoadPromise=null;
  let publishInFlight=null;
  let publishDirty=false;
  let communityLoadInFlight=null;
  let communityListenTimer=null;
  let hydratingOwnTips=false;
  let localEditVersion=0;
  let savedEditVersion=0;
  let communityDataHash='';
  let communityCacheRestored=false;

  const debug=window.SUPERLIGA_FIRESTORE_SYNC_DEBUG={
    version:VERSION,
    firebaseWarmupStarted:false,
    firebaseReady:false,
    authResolved:false,
    uid:null,
    hydratingOwnTips:false,
    ownTipsLoaded:false,
    ownTipsLoadFailed:false,
    privateReadSource:null,
    lastWriteAt:null,
    lastWriteHash:null,
    privateWriteOk:null,
    communityWriteOk:null,
    privateWriteError:null,
    communityWriteError:null,
    communityCacheRestored:false,
    communityCacheAgeMs:null,
    communityCount:0,
    communitySource:null,
    communityListener:false,
    error:null
  };

  function errText(error){
    return error&&error.message?error.message:String(error||'unknown_error');
  }

  function updateDebug(extra){
    Object.assign(debug,extra||{});
    debug.firebaseReady=!!superligaBackendReady;
    debug.authResolved=authResolved;
    debug.uid=superligaUser&&superligaUser.uid?superligaUser.uid:null;
    debug.hydratingOwnTips=hydratingOwnTips;
    debug.ownTipsLoaded=!!superligaOwnTipsLoaded;
    debug.ownTipsLoadFailed=!!superligaOwnTipsLoadFailed;
    debug.communityCount=Array.isArray(superligaCommunityItems)?superligaCommunityItems.length:0;
    debug.communityListener=!!superligaCommunityUnsub;
  }

  function safeRenderCommunity(){
    try{
      if(typeof S!=='undefined'&&S.tab==='community'&&typeof renderCommunity==='function'){
        renderCommunity();
      }
    }catch(_e){}
  }

  function safeRequestRender(reason){
    try{
      if(typeof superligaRequestRender==='function')superligaRequestRender(reason||VERSION);
    }catch(_e){}
  }

  function cleanPayloadFromDoc(data){
    const raw=(data&&data.payload&&typeof data.payload==='object')?data.payload:(data||{});
    const pred=superligaPickObj(raw,['pred','predictions','tips','groupPred','groupPredictions','PRED']);
    const ko=superligaPickObj(raw,['ko','knockout','knockoutPredictions','koPred','KO_PRED']);
    return {
      pred:superligaCleanTips(pred),
      ko:superligaCleanTips(ko)
    };
  }

  function mergeTips(remote,local){
    return {
      pred:{...(remote&&remote.pred||{}),...(local&&local.pred||{})},
      ko:{...(remote&&remote.ko||{}),...(local&&local.ko||{})}
    };
  }

  function timestampMs(value){
    try{
      if(value&&typeof value.toMillis==='function')return value.toMillis();
      if(value&&typeof value.toDate==='function')return value.toDate().getTime();
      if(value&&typeof value.seconds==='number')return value.seconds*1000+Math.floor((value.nanoseconds||0)/1e6);
      const n=typeof value==='number'?value:Date.parse(value);
      return Number.isFinite(n)?n:null;
    }catch(_e){return null}
  }

  function cacheSafeItem(item){
    const out={...(item||{})};
    const ms=timestampMs(out.updatedAt);
    if(ms!=null)out.updatedAt=ms;
    return out;
  }

  function communityItemsHash(items){
    const rows=(items||[]).map(item=>({
      id:item&&item.id||'',
      uid:item&&item.uid||'',
      displayName:item&&item.displayName||'',
      photoURL:item&&item.photoURL||'',
      updatedAt:timestampMs(item&&item.updatedAt)||0,
      summary:item&&item.summary||null,
      pred:item&&item.pred||null,
      ko:item&&item.ko||null
    }));
    return superligaStableJson(rows);
  }

  function saveCommunityCache(items){
    try{
      const record={
        version:2,
        savedAt:Date.now(),
        items:(items||[]).map(cacheSafeItem)
      };
      localStorage.setItem(COMMUNITY_CACHE_KEY,JSON.stringify(record));
    }catch(_e){}
  }

  function restoreCommunityCache(){
    if(communityCacheRestored)return false;
    communityCacheRestored=true;
    try{
      const raw=localStorage.getItem(COMMUNITY_CACHE_KEY);
      if(!raw)return false;
      const record=JSON.parse(raw);
      if(!record||!Array.isArray(record.items))return false;
      const age=Math.max(0,Date.now()-Number(record.savedAt||0));
      superligaCommunityItems=record.items.map(item=>({...item}));
      superligaLastCommunityFetch=Number(record.savedAt||0);
      communityDataHash=communityItemsHash(superligaCommunityItems);
      updateDebug({
        communityCacheRestored:true,
        communityCacheAgeMs:age,
        communitySource:'local-cache'
      });
      return true;
    }catch(_e){return false}
  }

  function applyCommunityItems(items,opts={}){
    const next=(items||[]).map(item=>({...item}));
    const nextHash=communityItemsHash(next);
    const changed=nextHash!==communityDataHash;
    superligaCommunityItems=next;
    superligaLastCommunityFetch=Date.now();
    communityDataHash=nextHash;
    saveCommunityCache(next);
    updateDebug({
      communitySource:opts.source||'firestore',
      communityCacheAgeMs:0,
      communityCount:next.length
    });
    if(changed&&opts.render!==false)safeRenderCommunity();
    try{
      if(changed&&typeof refreshCommunityPreviews==='function')refreshCommunityPreviews();
    }catch(_e){}
    return changed;
  }

  function upsertOwnCommunityItem(publicData){
    if(!superligaUser)return;
    const id=superligaUser.uid;
    const item={id,...publicData,updatedAt:Date.now()};
    const rest=(superligaCommunityItems||[]).filter(row=>(row&&row.id)!==id);
    applyCommunityItems([item,...rest].slice(0,COMMUNITY_LIMIT),{
      source:'local-own-write',
      render:true
    });
  }

  async function waitForAuth(timeoutMs=6000){
    if(authResolved)return true;
    let timer;
    await Promise.race([
      authReadyPromise,
      new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs)})
    ]);
    clearTimeout(timer);
    return authResolved;
  }

  async function ensureFirebaseUser(){
    const ok=await loadSuperligaFirebase();
    if(!ok)return false;
    await waitForAuth();
    return !!(superligaDb&&superligaUser);
  }

  // Faster SDK startup: app first, then auth + Firestore in parallel.
  loadSuperligaFirebase=async function loadSuperligaFirebaseF2(opts={}){
    if(FROZEN_MODE||!superligaFirebaseConfigured())return false;
    if(!superligaFirebaseRuntimeOk()){
      superligaBackendError='A Firebase bejelentkezés és közösségi szinkron csak http/https alatt működik.';
      updateDebug({error:superligaBackendError});
      return false;
    }
    if(superligaBackendReady){
      if(opts.community)setCommunityActive(true);
      updateDebug({firebaseReady:true});
      return true;
    }
    if(!superligaFirebaseLoadPromise){
      superligaFirebaseLoadPromise=(async()=>{
        try{
          const v=SUPERLIGA_FIREBASE_SDK_VERSION;
          const base='https://www.gstatic.com/firebasejs/'+v+'/';
          await superligaLoadScript(base+'firebase-app-compat.js');
          await Promise.all([
            firebase.auth?Promise.resolve():superligaLoadScript(base+'firebase-auth-compat.js'),
            firebase.firestore?Promise.resolve():superligaLoadScript(base+'firebase-firestore-compat.js')
          ]);
          initSuperligaFirebase();
          updateDebug({firebaseReady:true,error:null});
          return true;
        }catch(error){
          superligaBackendError=errText(error);
          updateDebug({error:superligaBackendError});
          safeRenderCommunity();
          return false;
        }
      })();
    }
    const ok=await superligaFirebaseLoadPromise;
    if(ok&&opts.community)setCommunityActive(true);
    return ok;
  };

  loadOwnTipsFromFirebase=async function loadOwnTipsFromFirebaseF2(){
    if(!superligaDb||!superligaUser)return false;
    if(ownLoadPromise)return ownLoadPromise;

    ownLoadPromise=(async()=>{
      hydratingOwnTips=true;
      superligaOwnTipsLoaded=false;
      superligaOwnTipsLoadFailed=false;
      updateDebug({hydratingOwnTips:true,error:null});

      const editsBeforeLoad=localEditVersion;
      const inMemory={
        pred:superligaCleanTips(PRED),
        ko:superligaCleanTips(KO_PRED)
      };

      try{
        const uid=superligaUser.uid;
        const privateRef=superligaDb.collection(SUPERLIGA_COLLECTIONS.privatePredictions).doc(uid);
        const communityRef=superligaDb.collection(SUPERLIGA_COLLECTIONS.community).doc(uid);

        let doc=await privateRef.get();
        let source='private';
        if(!doc.exists){
          doc=await communityRef.get();
          source=doc.exists?'community-legacy':'none';
        }

        let remote={pred:{},ko:{}};
        if(doc.exists)remote=cleanPayloadFromDoc(doc.data()||{});

        const editedWhileAuthPending=editsBeforeLoad>0;
        const next=editedWhileAuthPending?mergeTips(remote,inMemory):remote;

        PRED=superligaCleanTips(next.pred);
        KO_PRED=superligaCleanTips(next.ko);
        superligaClearLocalPreds();

        superligaRemoteDocExists=doc.exists;
        superligaOwnTipsLoaded=true;
        superligaOwnTipsLoadFailed=false;
        superligaLastPublishedHash=editedWhileAuthPending?'':superligaTipsHash();

        updateDebug({
          privateReadSource:source,
          ownTipsLoaded:true,
          ownTipsLoadFailed:false,
          error:null
        });
        safeRequestRender('own-tips-f2');

        // Migrate the old community-only document to the private collection,
        // or persist tips entered while auth was resolving.
        if(source==='community-legacy'||editedWhileAuthPending){
          queueCommunityAutosave();
        }
        return doc.exists;
      }catch(error){
        superligaOwnTipsLoadFailed=true;
        superligaBackendError=errText(error);
        updateDebug({
          ownTipsLoadFailed:true,
          error:superligaBackendError
        });
        return false;
      }finally{
        hydratingOwnTips=false;
        ownLoadPromise=null;
        updateDebug({hydratingOwnTips:false});
      }
    })();

    return ownLoadPromise;
  };

  handleSuperligaAuthState=async function handleSuperligaAuthStateF2(user){
    superligaUser=user||null;
    superligaOwnTipsLoaded=false;
    superligaOwnTipsLoadFailed=false;
    superligaRemoteDocExists=false;
    authResolved=true;
    if(authResolve){
      authResolve(superligaUser);
      authResolve=null;
    }
    updateDebug({authResolved:true,uid:superligaUser&&superligaUser.uid||null});

    try{
      if(superligaUser){
        superligaClearLocalPreds();
        await Promise.allSettled([
          saveSuperligaUserProfile(superligaUser),
          loadOwnTipsFromFirebase()
        ]);
        if(localEditVersion>savedEditVersion)queueCommunityAutosave();
      }else{
        const local=superligaReadLocalPreds();
        PRED=superligaCleanTips(local.pred);
        KO_PRED=superligaCleanTips(local.ko);
        superligaOwnTipsLoaded=true;
        superligaLastPublishedHash='';
        safeRequestRender('auth-guest-f2');
      }

      if(superligaCommunityActive){
        listenCommunityTips();
      }else{
        const run=()=>loadCommunityTips({render:false}).catch(()=>false);
        if('requestIdleCallback'in window){
          requestIdleCallback(run,{timeout:1800});
        }else{
          setTimeout(run,700);
        }
      }
      safeRenderCommunity();
    }catch(error){
      superligaBackendError=errText(error);
      updateDebug({error:superligaBackendError});
      safeRenderCommunity();
    }
  };

  const originalSavePred=typeof savePred==='function'?savePred:null;
  if(originalSavePred){
    savePred=function savePredF2(){
      if(FROZEN_MODE)return;
      localEditVersion++;

      const firebaseExpected=superligaFirebaseConfigured()&&superligaFirebaseRuntimeOk();
      if(firebaseExpected&&(!authResolved||superligaUser)){
        if(superligaUser)superligaClearLocalPreds();
        queueCommunityAutosave();
        return;
      }
      return originalSavePred.apply(this,arguments);
    };
  }

  queueCommunityAutosave=function queueCommunityAutosaveF2(){
    if(FROZEN_MODE||READONLY_MODE)return;
    publishDirty=true;
    clearTimeout(superligaAutosaveTimer);

    // Start Firebase/auth immediately even when the user has not opened Community.
    loadSuperligaFirebase().catch(()=>false);

    superligaAutosaveTimer=setTimeout(()=>{
      publishCommunityTips(true,{allowEmpty:true}).catch(error=>{
        superligaBackendError=errText(error);
        updateDebug({error:superligaBackendError});
      });
    },AUTOSAVE_DELAY_MS);
  };

  publishCommunityTips=async function publishCommunityTipsF2(silent,opts={}){
    if(FROZEN_MODE||READONLY_MODE)return false;
    if(!(await ensureFirebaseUser()))return false;

    if(hydratingOwnTips&&ownLoadPromise)await ownLoadPromise;
    if(superligaOwnTipsLoadFailed&&!opts.force){
      superligaBackendError='Nem sikerült betölteni a Firestore-ban lévő saját tippeket, ezért nem írok rá vakon.';
      updateDebug({error:superligaBackendError});
      safeRenderCommunity();
      return false;
    }
    if(!superligaOwnTipsLoaded&&!opts.force){
      await loadOwnTipsFromFirebase();
      if(superligaOwnTipsLoadFailed)return false;
    }
    if(opts.allowEmpty===false&&!superligaHasTips(PRED)&&!superligaHasTips(KO_PRED))return false;

    const hash=superligaTipsHash();
    if(!opts.force&&hash===superligaLastPublishedHash){
      publishDirty=false;
      return false;
    }

    if(publishInFlight){
      publishDirty=true;
      return publishInFlight;
    }

    const editVersionAtStart=localEditVersion;
    publishDirty=false;

    publishInFlight=(async()=>{
      const payload=superligaTipsPayload();
      const serverTime=firebase.firestore.FieldValue.serverTimestamp();
      const uid=superligaUser.uid;

      const privateData={
        uid,
        pred:payload.pred,
        ko:payload.ko,
        updatedAt:serverTime,
        version:5,
        storage:'firebase-private-f2'
      };
      const communityData={
        uid,
        displayName:superligaUser.displayName||superligaUser.email||'Játékos',
        photoURL:superligaUser.photoURL||'',
        pred:payload.pred,
        ko:payload.ko,
        summary:communitySummary(payload.pred,payload.ko),
        updatedAt:serverTime,
        version:5,
        storage:'firebase-community-f2'
      };

      const [privateWrite,communityWrite]=await Promise.allSettled([
        superligaDb.collection(SUPERLIGA_COLLECTIONS.privatePredictions).doc(uid).set(privateData,{merge:true}),
        superligaDb.collection(SUPERLIGA_COLLECTIONS.community).doc(uid).set(communityData,{merge:true})
      ]);

      const privateOk=privateWrite.status==='fulfilled';
      const communityOk=communityWrite.status==='fulfilled';

      updateDebug({
        lastWriteAt:new Date().toISOString(),
        lastWriteHash:hash,
        privateWriteOk:privateOk,
        communityWriteOk:communityOk,
        privateWriteError:privateOk?null:errText(privateWrite.reason),
        communityWriteError:communityOk?null:errText(communityWrite.reason)
      });

      if(!privateOk&&!communityOk){
        const message='Firestore write failed. private: '+errText(privateWrite.reason)+'; community: '+errText(communityWrite.reason);
        superligaBackendError=message;
        updateDebug({error:message});
        throw new Error(message);
      }

      if(!privateOk||!communityOk){
        superligaBackendError=
          (!privateOk?'Private prediction write: '+errText(privateWrite.reason):'')+
          (!privateOk&&!communityOk?' | ':'')+
          (!communityOk?'Community write: '+errText(communityWrite.reason):'');
        updateDebug({error:superligaBackendError});
      }else{
        superligaBackendError='';
        updateDebug({error:null});
      }

      superligaRemoteDocExists=communityOk||superligaRemoteDocExists;
      superligaOwnTipsLoaded=true;
      superligaLastPublishedHash=hash;
      savedEditVersion=Math.max(savedEditVersion,editVersionAtStart);

      if(communityOk)upsertOwnCommunityItem({
        ...communityData,
        updatedAt:Date.now()
      });

      if(!silent)safeRenderCommunity();
      return true;
    })().finally(()=>{
      publishInFlight=null;
      const changedAgain=localEditVersion>savedEditVersion||superligaTipsHash()!==superligaLastPublishedHash;
      if(publishDirty||changedAgain){
        clearTimeout(superligaAutosaveTimer);
        superligaAutosaveTimer=setTimeout(()=>{
          publishCommunityTips(true,{allowEmpty:true}).catch(()=>false);
        },120);
      }
    });

    return publishInFlight;
  };

  loadCommunityTips=async function loadCommunityTipsF2(opts={}){
    if(!superligaDb){
      restoreCommunityCache();
      return false;
    }

    restoreCommunityCache();
    const age=Date.now()-Number(superligaLastCommunityFetch||0);
    if(!opts.force&&superligaCommunityItems.length&&age<COMMUNITY_CACHE_TTL_MS){
      updateDebug({
        communitySource:'memory-cache',
        communityCacheAgeMs:age
      });
      return true;
    }

    if(communityLoadInFlight)return communityLoadInFlight;

    communityLoadInFlight=(async()=>{
      try{
        const snap=await superligaDb
          .collection(SUPERLIGA_COLLECTIONS.community)
          .orderBy('updatedAt','desc')
          .limit(COMMUNITY_LIMIT)
          .get();

        const items=snap.docs.map(doc=>({id:doc.id,...doc.data()}));
        applyCommunityItems(items,{
          source:'firestore-one-shot',
          render:opts.render!==false
        });
        return true;
      }catch(error){
        superligaBackendError=errText(error);
        updateDebug({error:superligaBackendError});
        return false;
      }finally{
        communityLoadInFlight=null;
      }
    })();

    return communityLoadInFlight;
  };

  listenCommunityTips=function listenCommunityTipsF2(){
    if(!superligaDb||superligaCommunityUnsub)return;
    clearTimeout(communityListenTimer);

    try{
      superligaCommunityUnsub=superligaDb
        .collection(SUPERLIGA_COLLECTIONS.community)
        .orderBy('updatedAt','desc')
        .limit(COMMUNITY_LIMIT)
        .onSnapshot(snap=>{
          const items=snap.docs.map(doc=>({id:doc.id,...doc.data()}));
          applyCommunityItems(items,{
            source:'firestore-listener',
            render:true
          });
          updateDebug({communityListener:true,error:null});
        },error=>{
          superligaBackendError=errText(error);
          updateDebug({error:superligaBackendError,communityListener:false});
          safeRenderCommunity();
        });
      updateDebug({communityListener:true});
    }catch(error){
      superligaBackendError=errText(error);
      updateDebug({error:superligaBackendError,communityListener:false});
    }
  };

  const originalStopCommunityTips=stopCommunityTips;
  stopCommunityTips=function stopCommunityTipsF2(){
    clearTimeout(communityListenTimer);
    communityListenTimer=null;
    originalStopCommunityTips();
    updateDebug({communityListener:false});
  };

  setCommunityActive=function setCommunityActiveF2(active){
    superligaCommunityActive=!!active;
    restoreCommunityCache();

    if(!superligaCommunityActive){
      stopCommunityTips();
      return;
    }

    loadSuperligaFirebase().then(ok=>{
      if(!ok)return;

      const age=Date.now()-Number(superligaLastCommunityFetch||0);
      if(superligaCommunityItems.length&&age<COMMUNITY_CACHE_TTL_MS){
        // Cached full list paints instantly. Delay realtime attach so we do not
        // immediately duplicate a just-finished preload query.
        communityListenTimer=setTimeout(()=>{
          if(superligaCommunityActive)listenCommunityTips();
        },2500);
      }else{
        // One listener only: its first snapshot is the complete initial load.
        listenCommunityTips();
      }
    }).catch(error=>{
      superligaBackendError=errText(error);
      updateDebug({error:superligaBackendError});
    });
  };

  // Flush on tab/app backgrounding and after reconnecting.
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden'&&superligaUser&&localEditVersion>savedEditVersion){
      publishCommunityTips(true,{allowEmpty:true}).catch(()=>false);
    }
  });
  window.addEventListener('online',()=>{
    if(superligaUser&&localEditVersion>savedEditVersion)queueCommunityAutosave();
  });

  restoreCommunityCache();

  function startWarmup(){
    if(debug.firebaseWarmupStarted)return;
    debug.firebaseWarmupStarted=true;
    loadSuperligaFirebase().catch(error=>{
      superligaBackendError=errText(error);
      updateDebug({error:superligaBackendError});
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',startWarmup,{once:true});
  }else{
    startWarmup();
  }

  updateDebug();
})();

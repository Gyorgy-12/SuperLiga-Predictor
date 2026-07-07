// League constants, team ids, service config and app-level state defaults

const SUPERLIGA_APP_ID='superliga_2026_27';
const SUPERLIGA_TIMEZONE='Europe/Bucharest';
const SUPERLIGA_STORE_PREFIX='superliga_2026_27';
const SUPERLIGA_FIREBASE_APP_NAME='superliga-backend';
const SUPERLIGA_FIREBASE_SDK_VERSION='10.12.2';
const SUPERLIGA_FIREBASE_CONFIG={
  apiKey:'AIzaSyDrq7tIR6TUc645EX7bazv0ggvIlxmoq3A',
  authDomain:'wc-2026-guesses.firebaseapp.com',
  projectId:'wc-2026-guesses',
  storageBucket:'wc-2026-guesses.firebasestorage.app',
  messagingSenderId:'436476011719',
  appId:'1:436476011719:web:3bfb35e7bc9a342454cae2',
  measurementId:'G-5TZH7BM8GB'
};
const SUPERLIGA_COLLECTIONS={
  community:'superliga_community_predictions_v1',
  users:'superliga_users_v1',
  results:'superliga_match_results_v1'
};
const SUPERLIGA_WORKER_URL=String(window.SUPERLIGA_WORKER_URL||'').replace(/\/$/,'');
const SUPERLIGA_RESULTS_READ_URL=window.SUPERLIGA_RESULTS_READ_URL||(SUPERLIGA_WORKER_URL?SUPERLIGA_WORKER_URL+'/results':'');
const SUPERLIGA_RESULTS_SYNC_URL=window.SUPERLIGA_RESULTS_SYNC_URL||(SUPERLIGA_WORKER_URL?SUPERLIGA_WORKER_URL+'/live-results':'');
const SUPERLIGA_BOOTSTRAP_LIGHT_URL=window.SUPERLIGA_BOOTSTRAP_LIGHT_URL||(SUPERLIGA_WORKER_URL?SUPERLIGA_WORKER_URL+'/bootstrap-light':(SUPERLIGA_RESULTS_READ_URL?String(SUPERLIGA_RESULTS_READ_URL).replace(/\/results(?:\?.*)?$/,'')+'/bootstrap-light':''));
const SUPERLIGA_SYNC_BEFORE_MS=5*60*1000;
const SUPERLIGA_SYNC_AFTER_MS=140*60*1000;
const SUPERLIGA_SYNC_LIVE_MS=60*1000;
const SUPERLIGA_SYNC_IDLE_MS=30*60*1000;
const SUPERLIGA_COMMUNITY_TTL_MS=60*1000;
const SUPERLIGA_AUTOSAVE_MS=1200;
const SUPERLIGA_CACHE_KEYS={
  predictions:'superliga_predictions_v2',
  postseason:'superliga_postseason_predictions_v2',
  legacyPredictions:'superliga_predictions_v1',
  legacyPostseason:'superliga_postseason_predictions_v1',
  liveSnapshot:'superliga_live_results_v1',
  lastWorkerSync:'superliga_worker_sync_last_at',
  postseasonSeed:'superliga_postseason_seed_v1'
};

const D={"groups":[["SL","Universitatea Craiova","Universitatea Cluj","CFR Cluj","FCSB","Rapid București","FC Argeș","UTA Arad","Oțelul Galați","FC Botoșani","Csikszereda","Petrolul Ploiești","Dinamo","Farul Constanța","FC Voluntari","Corvinul Hunedoara","Sepsi OSK"]],"ids":{"Universitatea Craiova":480286,"Universitatea Cluj":89022,"CFR Cluj":9731,"FCSB":9723,"Rapid București":9738,"FC Argeș":9732,"UTA Arad":584663,"Oțelul Galați":9736,"FC Botoșani":188191,"Csikszereda":583690,"Petrolul Ploiești":188187,"Dinamo":10271,"Farul Constanța":210132,"FC Voluntari":405332,"Corvinul Hunedoara":1515102,"Sepsi OSK":583706}};
const GROUPS=D.groups.map(g=>({key:g[0],teams:g.slice(1)})),TEAM_IDS=D.ids,ALL=GROUPS.flatMap(g=>g.teams);
const SUPERLIGA_LOGO='https://www.superliga.ro/images/logo.png';
const VALID_TABS=new Set(['overview','table','matches','knockout','baraj','stats','community']);
let savedTab='overview';try{let t=sessionStorage.getItem('superliga_active_tab');if(VALID_TABS.has(t))savedTab=t}catch(e){}
let S={tab:savedTab,filt:'all',view:'short',tblRound:0,postRound:'current'},MS={filt:'date',round:1,team:ALL[0]},KO_SCROLL=0;
const TEAM_RANKS={
  'FCSB':1,'CFR Cluj':2,'Universitatea Craiova':3,'Rapid București':4,
  'Farul Constanța':5,'Universitatea Cluj':6,'Sepsi OSK':7,'Dinamo':8,
  'Oțelul Galați':9,'Petrolul Ploiești':10,'UTA Arad':11,'FC Botoșani':12,
  'FC Voluntari':13,'FC Argeș':14,'Csikszereda':15,'Corvinul Hunedoara':16
};
const MANUAL_FP={};
const TEAM_ELO={
  'FCSB':1610,'CFR Cluj':1585,'Universitatea Craiova':1570,'Rapid București':1560,
  'Farul Constanța':1535,'Universitatea Cluj':1515,'Sepsi OSK':1490,'Dinamo':1500,
  'Oțelul Galați':1480,'Petrolul Ploiești':1475,'UTA Arad':1460,'FC Botoșani':1450,
  'FC Voluntari':1455,'FC Argeș':1435,'Csikszereda':1420,'Corvinul Hunedoara':1410
};
const SUPERLIGA_ODDS={};
const TEAM_MARKET={
  'FCSB':48,'CFR Cluj':30,'Universitatea Craiova':38,'Rapid București':35,
  'Farul Constanța':25,'Universitatea Cluj':22,'Sepsi OSK':18,'Dinamo':17,
  'Oțelul Galați':15,'Petrolul Ploiești':13,'UTA Arad':13,'FC Botoșani':11,
  'FC Voluntari':11,'FC Argeș':9,'Csikszereda':8,'Corvinul Hunedoara':7
};
const HOST_TEAMS=new Set();
const POTY={short:'–',club:'–',rating:0,goals:0,assists:0,apps:0,img:''};
const TOTS={fwd:[],mid:[],def:[],gk:[]};
const STAR_LIST=[];

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const args=process.argv.slice(2);
const apply=args.includes('--apply');
const base=(process.env.SUPERLIGA_WORKER_URL||'https://superliga-predictor-worker.wc26-guesses.workers.dev').replace(/\/$/,'');
const reportPath=new URL('../.tmp/match-events-refresh-20261020.json',import.meta.url);
const version='cards-v2-second-yellow';

async function get(path){
  for(let attempt=0;attempt<4;attempt++){
    const response=await fetch(base+path,{signal:AbortSignal.timeout(60000),headers:{'cache-control':'no-cache'}});
    if(!response.ok){
      if([429,500,502,503,504].includes(response.status)&&attempt<3){
        await response.body?.cancel();
        console.log(JSON.stringify({retry:attempt+1,status:response.status}));
        await new Promise(resolve=>setTimeout(resolve,(attempt+1)*1500));
        continue;
      }
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    const data=await response.json();
    if(data.ok===false)throw new Error(data.error||'Worker request failed');
    return data;
  }
}
const current=(await get('/results?fresh=1&t='+Date.now())).results;
let report;
try{report=JSON.parse(await readFile(reportPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
if(!report){
  report={startedAt:new Date().toISOString(),base,before:current,batches:[]};
  await mkdir(new URL('../.tmp/',import.meta.url),{recursive:true});
  await writeFile(reportPath,JSON.stringify(report,null,2));
}
const requested=args.find(arg=>arg.startsWith('--ids='))?.slice(6).split(',');
const ids=Object.entries(report.before).filter(([id,row])=>row.finished&&(!requested||requested.includes(id))).map(([id])=>id);
const pending=ids.filter(id=>current[id]?.incidentsVersion!==version);
console.log(JSON.stringify({apply,total:ids.length,pending:pending.length,report:reportPath.pathname}));

if(apply){
  const health=await get('/live-results?fast=1&liveOnly=1&t='+Date.now());
  if(health.pipelineVersion!=='b54-live-first-second-yellow')throw new Error('Deploy the corrected Worker before refreshing historical events');
  for(let i=0;i<pending.length;i++){
    const batch=pending.slice(i,i+1);
    const response=await get('/live-results?fresh=1&force=1&scheduled=1&ids='+batch.join(',')+'&t='+Date.now());
    const writes=response.sync?.finalWrites||[];
    const rows=Object.fromEntries(batch.map(id=>[id,response.results?.[id]]));
    const errors=batch.filter(id=>rows[id]?.incidentsVersion!==version);
    report.batches.push({ids:batch,writes,missing:errors,at:new Date().toISOString()});
    await writeFile(reportPath,JSON.stringify(report,null,2));
    console.log(JSON.stringify({ids:batch,written:writes.filter(row=>row.written).length,secondYellows:batch.flatMap(id=>(rows[id]?.doubleYellowCards||[]).map(card=>({id,minute:card.minute,player:card.player}))),missing:errors}));
    if(writes.some(row=>row.error))throw new Error('Final-result write failed; see the refresh report');
  }
  const after=(await get('/results?fresh=1&t='+Date.now())).results;
  const missing=ids.filter(id=>after[id]?.incidentsVersion!==version);
  const ratingsChanged=ids.filter(id=>!isDeepStrictEqual(after[id]?.ratingsSnapshot,report.before[id]?.ratingsSnapshot));
  const scoresChanged=ids.filter(id=>after[id]?.h!==report.before[id]?.h||after[id]?.a!==report.before[id]?.a);
  report.verification={at:new Date().toISOString(),count:ids.length,missing,ratingsChanged,scoresChanged,secondYellowCount:ids.reduce((sum,id)=>sum+(after[id]?.doubleYellowCards||[]).length,0)};
  await writeFile(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.verification));
  if(missing.length||ratingsChanged.length||scoresChanged.length)process.exitCode=1;
}

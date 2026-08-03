import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import vm from 'node:vm';

const args=process.argv.slice(2);
const orderIndex=args.indexOf('--order');
const orderFile=orderIndex>=0?args[orderIndex+1]:null;
const roots=(orderIndex>=0?args.slice(0,orderIndex):args).filter(Boolean);
const files=[];

async function collect(path){
  const entries=await readdir(path,{withFileTypes:true});
  for(const entry of entries){
    if(entry.name==='node_modules')continue;
    const child=resolve(path,entry.name);
    if(entry.isDirectory())await collect(child);
    else if(/\.[cm]?js$/i.test(entry.name))files.push(child);
  }
}

for(const root of roots.length?roots:['src'])await collect(resolve(root));

let failed=false;
for(const file of files.sort()){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0){
    failed=true;
    process.stderr.write(result.stderr||result.stdout||`Syntax error: ${file}\n`);
  }
}

if(orderFile){
  const ordered=(await readFile(resolve(orderFile),'utf8')).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const source=(await Promise.all(ordered.map(file=>readFile(resolve(file),'utf8')))).join('\n;\n');
  try{new vm.Script(source,{filename:orderFile})}catch(error){failed=true;console.error(error)}
}

if(failed)process.exit(1);
console.log(`Syntax OK: ${files.length} files${orderFile?' + ordered browser bundle':''}`);

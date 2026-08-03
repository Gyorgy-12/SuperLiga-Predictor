import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root=resolve(process.cwd());
const port=Number(process.env.PORT||process.argv[2]||5173);
const types={
  '.css':'text/css; charset=utf-8',
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.png':'image/png',
  '.svg':'image/svg+xml',
  '.webp':'image/webp'
};

createServer(async(request,response)=>{
  try{
    const url=new URL(request.url||'/',`http://${request.headers.host||'localhost'}`);
    const relative=decodeURIComponent(url.pathname).replace(/^[/\\]+/,'')||'index.html';
    let file=resolve(root,relative);
    if(file!==root&&!file.startsWith(root+sep))throw new Error('invalid_path');
    if((await stat(file)).isDirectory())file=resolve(file,'index.html');
    const body=await readFile(file);
    response.writeHead(200,{
      'cache-control':'no-store',
      'content-type':types[extname(file).toLowerCase()]||'application/octet-stream'
    });
    response.end(request.method==='HEAD'?undefined:body);
  }catch(_error){
    response.writeHead(404,{'content-type':'text/plain; charset=utf-8'});
    response.end('Not found');
  }
}).listen(port,'127.0.0.1',()=>{
  console.log(`SuperLiga Predictor: http://localhost:${port}`);
});

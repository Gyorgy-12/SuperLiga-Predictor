/* SuperLiga Predictor — complete single-file read-only HTML export
   Load AFTER src/app/bootstrap.js.

   Source app:
   - adds a ⇩ export button
   - does not change normal prediction behavior

   Generated HTML:
   - contains all linked CSS, including recursively resolved @imports
   - contains all classic external JS files inline
   - removes the Community tab
   - bakes the current in-memory PRED / KO_PRED state into frozen data
   - preserves match-card/modal click behavior
   - disables every prediction input and hides save/delete actions
*/
(function superligaStandaloneExportPenaltySafeV5(){
'use strict';

if(window.__SUPERLIGA_STANDALONE_EXPORT_PENALTY_SAFE_V5__)return;
window.__SUPERLIGA_STANDALONE_EXPORT_PENALTY_SAFE_V5__=true;

const VERSION='v5-penalty-safe-existing-export-button';

function clone(value,fallback){
  try{
    if(value===undefined)return fallback;
    return JSON.parse(JSON.stringify(value));
  }catch(_error){
    return fallback;
  }
}

function readLexical(name,fallback){
  const allowed=new Set([
    'PRED','KO_PRED','LIVE_RESULTS','FIXTURES','ALL_MATCHES','KO_SCHEDULE',
    'TEAM_ELO','TEAM_ELO_POINTS','TEAM_RATINGS','TEAM_MARKET_VALUES',
    'MARKET_VALUES','S'
  ]);
  if(!allowed.has(name))return fallback;
  try{
    // Direct eval can see classic-script global lexical bindings such as `let PRED`.
    const value=eval('typeof '+name+'!=="undefined"?'+name+':undefined');
    return clone(value,fallback);
  }catch(_error){
    return fallback;
  }
}

function currentSnapshot(){
  return {
    version:VERSION,
    createdAt:new Date().toISOString(),
    pred:readLexical('PRED',{}),
    ko:readLexical('KO_PRED',{}),
    liveResults:readLexical('LIVE_RESULTS',{}),
    fixtures:readLexical('FIXTURES',null),
    allMatches:readLexical('ALL_MATCHES',null),
    koSchedule:readLexical('KO_SCHEDULE',null),
    teamElo:readLexical('TEAM_ELO',null),
    teamEloPoints:readLexical('TEAM_ELO_POINTS',null),
    teamRatings:readLexical('TEAM_RATINGS',null),
    teamMarketValues:readLexical('TEAM_MARKET_VALUES',null),
    marketValues:readLexical('MARKET_VALUES',null),
    state:readLexical('S',null)
  };
}


function absoluteUrl(value,base){
  try{return new URL(value,base).href}catch(_error){return value}
}

function escapeScriptEnd(text){
  return String(text||'').replace(/<\/script/gi,'<\\/script');
}

async function fetchText(url){
  const response=await fetch(url,{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('HTTP '+response.status+': '+url);
  return response.text();
}

function rewriteCssUrls(css,sourceUrl){
  return String(css||'').replace(
    /url\(\s*(['"]?)(?!data:|blob:|https?:|\/\/|#)([^'")]+)\1\s*\)/gi,
    (_match,_quote,value)=>{
      const absolute=absoluteUrl(String(value).trim(),sourceUrl).replace(/"/g,'%22');
      return 'url("'+absolute+'")';
    }
  );
}

async function inlineCssFile(url,cache,stack){
  if(cache.has(url))return cache.get(url);
  if(stack.has(url))return '/* circular CSS import skipped: '+url+' */';

  stack.add(url);
  let css=await fetchText(url);

  const importPattern=/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);/gi;
  const matches=Array.from(css.matchAll(importPattern));

  for(const match of matches){
    const full=match[0];
    const childUrl=absoluteUrl(match[2],url);
    const media=String(match[3]||'').trim();
    const childCss=await inlineCssFile(childUrl,cache,stack);
    const replacement=media
      ? '@media '+media+'{\n'+childCss+'\n}'
      : childCss;
    css=css.replace(full,replacement);
  }

  css=rewriteCssUrls(css,url);
  stack.delete(url);
  cache.set(url,css);
  return css;
}

function convertDomAssetUrls(doc,pageUrl){
  const attrs=[
    ['img','src'],['source','src'],['video','poster'],['audio','src'],
    ['link[rel="icon"]','href'],['a[data-asset]','href']
  ];

  attrs.forEach(([selector,attribute])=>{
    doc.querySelectorAll(selector+'['+attribute+']').forEach(element=>{
      const value=element.getAttribute(attribute);
      if(value&&!/^(?:data:|blob:|https?:|\/\/|#)/i.test(value)){
        element.setAttribute(attribute,absoluteUrl(value,pageUrl));
      }
    });
  });

  doc.querySelectorAll('[srcset]').forEach(element=>{
    const value=element.getAttribute('srcset')||'';
    const rewritten=value.split(',').map(part=>{
      const bits=part.trim().split(/\s+/);
      if(bits[0]&&!/^(?:data:|blob:|https?:|\/\/)/i.test(bits[0])){
        bits[0]=absoluteUrl(bits[0],pageUrl);
      }
      return bits.join(' ');
    }).join(', ');
    element.setAttribute('srcset',rewritten);
  });
}

function safeJsonForScript(value){
  return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}

function exportPrelude(snapshot){
  return [
    'window.__SUPERLIGA_STANDALONE_EXPORT__=true;',
    'window.__SUPERLIGA_FROZEN__=true;',
    'window.__SUPERLIGA_READONLY__=true;',
    'window.__SUPERLIGA_DISABLE_COMMUNITY__=true;',
    'window.__SUPERLIGA_EXPORT_SNAPSHOT__='+safeJsonForScript(snapshot)+';',
    'window.__SUPERLIGA_FROZEN_DATA__={pred:window.__SUPERLIGA_EXPORT_SNAPSHOT__.pred||{},ko:window.__SUPERLIGA_EXPORT_SNAPSHOT__.ko||{}};'
  ].join('');
}

function exportPostlude(){
  return `(function(){
'use strict';
var snapshot=window.__SUPERLIGA_EXPORT_SNAPSHOT__||{};

function clone(value){
 try{return JSON.parse(JSON.stringify(value))}catch(_error){return value}
}

function restoreBinding(name,key){
 var source=snapshot[key];
 if(source==null)return;
 try{
  var target=eval('typeof '+name+'!=="undefined"?'+name+':undefined');
  if(Array.isArray(target)&&Array.isArray(source)){
   target.splice.apply(target,[0,target.length].concat(clone(source)));
   return;
  }
  if(target&&typeof target==='object'&&source&&typeof source==='object'){
   Object.keys(target).forEach(function(k){try{delete target[k]}catch(_error){}});
   Object.assign(target,clone(source));
   return;
  }
  eval(name+'=clone(source)');
 }catch(_error){}
}

[
 ['LIVE_RESULTS','liveResults'],
 ['FIXTURES','fixtures'],
 ['ALL_MATCHES','allMatches'],
 ['KO_SCHEDULE','koSchedule'],
 ['TEAM_ELO','teamElo'],
 ['TEAM_ELO_POINTS','teamEloPoints'],
 ['TEAM_RATINGS','teamRatings'],
 ['TEAM_MARKET_VALUES','teamMarketValues'],
 ['MARKET_VALUES','marketValues'],
 ['S','state']
].forEach(function(pair){restoreBinding(pair[0],pair[1])});

document.querySelectorAll('[data-tab="community"]').forEach(function(element){element.remove()});
document.querySelectorAll('#exportBtn').forEach(function(element){element.remove()});

function textOf(el){
 return String(el&&el.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
}

function makeReadonly(root){
 var scope=root&&root.querySelectorAll?root:document;
 scope.querySelectorAll('.tip-overlay').forEach(function(modal){
  modal.classList.add('standalone-readonly-modal');
  modal.querySelectorAll('input,select,textarea').forEach(function(input){
   input.disabled=true;
   input.readOnly=true;
   input.tabIndex=-1;
   input.setAttribute('aria-disabled','true');
  });
  modal.querySelectorAll('button').forEach(function(button){
   if(/^(mentés|tipp mentése|tipp törlése|save|save prediction|delete prediction|clear prediction)$/.test(textOf(button))){
    button.hidden=true;
    button.disabled=true;
   }
  });
  modal.querySelectorAll('[data-save-tip],[data-delete-tip],[data-clear-tip],.tip-save,.tip-delete,.tip-actions .primary')
   .forEach(function(element){element.hidden=true;if('disabled'in element)element.disabled=true});
  if(!modal.querySelector('.standalone-readonly-note')){
   var note=document.createElement('div');
   note.className='standalone-readonly-note';
   note.textContent='Exportált, csak olvasható tipp. A meccskártya és a modal működik, de az eredmény itt már nem módosítható.';
   var sheet=modal.querySelector('.sheet,.tip-sheet')||modal;
   sheet.appendChild(note);
  }
 });
}

new MutationObserver(function(records){
 records.forEach(function(record){
  record.addedNodes.forEach(function(node){
   if(node.nodeType===1)makeReadonly(node);
  });
 });
}).observe(document.documentElement,{childList:true,subtree:true});

try{
 if(typeof render==='function')render();
 else if(typeof superligaRequestRender==='function')superligaRequestRender('standalone-export-restore');
}catch(_error){}

makeReadonly(document);
})();`;
}

function removeBootstrapPrefetch(doc){
  doc.querySelectorAll('script:not([src])').forEach(script=>{
    if(String(script.textContent||'').includes('__SUPERLIGA_BOOTSTRAP_LIGHT_PREFETCH__')){
      script.remove();
    }
  });
  doc.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"]').forEach(link=>link.remove());
}

async function generateStandaloneHtml(){
  const button=document.querySelector('#exportBtn');
  const oldText=button?button.textContent:'';

  try{
    if(button){
      button.disabled=true;
      button.textContent='…';
    }

    const pageUrl=location.href.split('#')[0];
    const sourceHtml=await fetchText(pageUrl);
    const doc=new DOMParser().parseFromString(sourceHtml,'text/html');
    const snapshot=currentSnapshot();

    doc.documentElement.setAttribute('data-superliga-standalone-export',VERSION);
    doc.querySelectorAll('[data-tab="community"]').forEach(element=>element.remove());
    doc.querySelectorAll('[data-generate-standalone-html]').forEach(element=>element.remove());
    removeBootstrapPrefetch(doc);
    convertDomAssetUrls(doc,pageUrl);

    const prelude=doc.createElement('script');
    prelude.setAttribute('data-superliga-export-prelude',VERSION);
    prelude.textContent=exportPrelude(snapshot);
    doc.head.insertBefore(prelude,doc.head.firstChild);

    const cssCache=new Map();
    for(const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))){
      const url=absoluteUrl(link.getAttribute('href'),pageUrl);
      const style=doc.createElement('style');
      style.setAttribute('data-inlined-from',url);
      style.textContent=await inlineCssFile(url,cssCache,new Set());
      link.replaceWith(style);
    }

    for(const script of Array.from(doc.querySelectorAll('script[src]'))){
      const src=script.getAttribute('src')||'';
      const url=absoluteUrl(src,pageUrl);

      // The generated document must not contain another generator button.
      if(/standalone-export/i.test(src)){
        script.remove();
        continue;
      }

      const inline=doc.createElement('script');
      inline.setAttribute('data-inlined-from',url);
      if(script.type)inline.type=script.type;
      inline.textContent=escapeScriptEnd(await fetchText(url));
      script.replaceWith(inline);
    }

    const readonlyStyle=doc.createElement('style');
    readonlyStyle.setAttribute('data-superliga-export-style',VERSION);
    readonlyStyle.textContent=[
      '[data-tab="community"],#exportBtn{display:none!important}',
      '.standalone-readonly-note{margin:14px 18px 18px;padding:11px 13px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#111a20;color:#9eacb5;font-size:12px;font-weight:700;line-height:1.45;text-align:center}',
      '.standalone-readonly-modal input:disabled{opacity:1!important;color:inherit!important;-webkit-text-fill-color:currentColor!important}',
      '.standalone-readonly-modal [data-save-tip],.standalone-readonly-modal [data-delete-tip],.standalone-readonly-modal [data-clear-tip]{display:none!important}'
    ].join('');
    doc.head.appendChild(readonlyStyle);

    const postlude=doc.createElement('script');
    postlude.setAttribute('data-superliga-export-postlude',VERSION);
    postlude.textContent=exportPostlude();
    doc.body.appendChild(postlude);

    const output='<!doctype html>\n'+doc.documentElement.outerHTML;
    const blob=new Blob([output],{type:'text/html;charset=utf-8'});
    const objectUrl=URL.createObjectURL(blob);
    const anchor=document.createElement('a');
    anchor.href=objectUrl;
    anchor.download='superliga-2026-27-readonly-'+new Date().toISOString().slice(0,10)+'.html';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),2000);
  }catch(error){
    console.error('[superliga-standalone-export]',error);
    alert('A teljes HTML export nem sikerült: '+(error&&error.message?error.message:String(error)));
  }finally{
    if(button){
      button.disabled=false;
      button.textContent=oldText||'⇩';
    }
  }
}

document.addEventListener('click',event=>{
  const button=event.target.closest&&event.target.closest('#exportBtn');
  if(!button)return;
  event.preventDefault();
  generateStandaloneHtml();
},{capture:true});
})();

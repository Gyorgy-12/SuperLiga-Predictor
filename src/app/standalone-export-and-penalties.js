/* SuperLiga Predictor — baraj-only penalties + standalone read-only HTML export
   Load AFTER src/app/bootstrap.js. */
(function(){
'use strict';
if(window.__SL_EXPORT_PEN_V2__)return;
window.__SL_EXPORT_PEN_V2__=1;
const EXPORT_MODE=!!window.__SUPERLIGA_STANDALONE_EXPORT__;

function valid(v){return v!==''&&v!=null&&Number.isFinite(Number(v));}
function txt(el){return String(el&&el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();}
function isTipAction(btn){return /^(mentés|tipp törlése|tipp mentése|save|delete prediction)$/.test(txt(btn));}

function isBarajModal(modal){
  if(!modal)return false;

  const explicit=[
    modal.dataset.tipStage,
    modal.dataset.stage,
    modal.dataset.round,
    modal.dataset.competition,
    modal.dataset.matchType
  ].filter(Boolean).join(' ');

  const visibleText=[
    explicit,
    txt(modal.querySelector('.tip-meta')),
    txt(modal.querySelector('.tip-subtitle')),
    txt(modal.querySelector('.sheet-subtitle')),
    txt(modal.querySelector('.tip-date')),
    txt(modal.querySelector('.tip-title')),
    txt(modal.querySelector('.sheet-title'))
  ].join(' ');

  return /\bbaraj\b/i.test(visibleText);
}

function syncPenalty(modal){
  const h=modal.querySelector('#tipH'),a=modal.querySelector('#tipA'),box=modal.querySelector('.penalty-box');
  if(!h||!a||!box)return;

  const allowed=isBarajModal(modal);
  const tied=allowed&&valid(h.value)&&valid(a.value)&&Number(h.value)===Number(a.value);

  box.classList.toggle('hidden',!tied);
  box.hidden=!tied;
  box.setAttribute('aria-hidden',tied?'false':'true');

  box.querySelectorAll('input').forEach(i=>{
    i.disabled=EXPORT_MODE||!tied;
    if(!allowed&&!EXPORT_MODE)i.value='';
  });
}

function readonly(modal){
  if(!EXPORT_MODE||!modal)return;
  modal.classList.add('standalone-readonly-modal');
  modal.querySelectorAll('input,select,textarea').forEach(el=>{
    el.disabled=true;el.setAttribute('aria-disabled','true');el.tabIndex=-1;
  });
  modal.querySelectorAll('button').forEach(btn=>{
    if(isTipAction(btn)){btn.hidden=true;btn.disabled=true;}
  });
  modal.querySelectorAll('[data-save-tip],[data-delete-tip],[data-clear-tip],.tip-save,.tip-delete')
    .forEach(el=>el.hidden=true);
  if(!modal.querySelector('.standalone-readonly-note')){
    const note=document.createElement('div');
    note.className='standalone-readonly-note';
    note.textContent='Ez egy exportált, csak olvasható nézet. A tippek itt nem módosíthatók.';
    const sheet=modal.querySelector('.sheet,.tip-sheet');
    if(sheet)sheet.appendChild(note);
  }
}

function wire(modal){
  if(!modal||modal.dataset.slPenWired==='1')return;
  modal.dataset.slPenWired='1';
  const h=modal.querySelector('#tipH'),a=modal.querySelector('#tipA');
  const update=()=>{syncPenalty(modal);readonly(modal);};
  if(h&&a){
    ['input','change'].forEach(ev=>{h.addEventListener(ev,update);a.addEventListener(ev,update);});
    requestAnimationFrame(update);setTimeout(update,0);setTimeout(update,80);
  }
  readonly(modal);
}

function scan(root){
  const s=root&&root.querySelectorAll?root:document;
  if(s.matches&&s.matches('.tip-overlay'))wire(s);
  s.querySelectorAll('.tip-overlay').forEach(wire);
}

function storageDump(){
  const out={};
  try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k!=null)out[k]=localStorage.getItem(k);}}catch(e){}
  return out;
}
function abs(v,b){try{return new URL(v,b).href}catch(e){return v}}
function escScript(s){return String(s||'').replace(/<\/script/gi,'<\\/script');}
function cssUrls(css,url){
  return String(css||'').replace(/url\(\s*(['"]?)(?!data:|blob:|https?:|\/\/|#)([^'")]+)\1\s*\)/gi,
    (_m,_q,v)=>'url("'+abs(v.trim(),url).replace(/"/g,'%22')+'")');
}
async function getText(url){
  const r=await fetch(url,{cache:'no-store',credentials:'same-origin'});
  if(!r.ok)throw new Error('HTTP '+r.status+': '+url);
  return r.text();
}
function prelude(store){
  const data=JSON.stringify(store).replace(/</g,'\\u003c');
  return 'window.__SUPERLIGA_STANDALONE_EXPORT__=true;window.__SUPERLIGA_EXPORT_STORAGE__='+data+
  ';try{Object.keys(window.__SUPERLIGA_EXPORT_STORAGE__).forEach(function(k){localStorage.setItem(k,window.__SUPERLIGA_EXPORT_STORAGE__[k]);});}catch(e){}';
}
function postlude(){
return `(function(){
function t(e){return String(e&&e.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase()}
function ro(root){
 var s=root&&root.querySelectorAll?root:document;
 s.querySelectorAll('.tip-overlay').forEach(function(m){
  m.querySelectorAll('input,select,textarea').forEach(function(x){x.disabled=true;x.tabIndex=-1});
  m.querySelectorAll('button').forEach(function(b){if(/^(mentés|tipp törlése|tipp mentése|save|delete prediction)$/.test(t(b))){b.hidden=true;b.disabled=true}});
  if(!m.querySelector('.standalone-readonly-note')){
   var n=document.createElement('div');n.className='standalone-readonly-note';
   n.textContent='Ez egy exportált, csak olvasható nézet. A tippek itt nem módosíthatók.';
   var sh=m.querySelector('.sheet,.tip-sheet');if(sh)sh.appendChild(n);
  }
 });
}
document.querySelectorAll('[data-tab="community"]').forEach(function(e){e.remove()});
new MutationObserver(function(rs){rs.forEach(function(r){r.addedNodes.forEach(function(n){if(n.nodeType===1)ro(n)})})})
.observe(document.documentElement,{childList:true,subtree:true});
ro(document);
})();`;
}

async function generate(){
  const btn=document.querySelector('[data-generate-standalone-html]');
  const old=btn?btn.textContent:'';
  try{
    if(btn){btn.disabled=true;btn.textContent='…';}
    const page=location.href.split('#')[0];
    const html=await getText(page);
    const doc=new DOMParser().parseFromString(html,'text/html');
    doc.querySelectorAll('[data-tab="community"]').forEach(e=>e.remove());

    const p=doc.createElement('script');
    p.textContent=prelude(storageDump());
    doc.head.insertBefore(p,doc.head.firstChild);

    for(const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))){
      const u=abs(link.getAttribute('href'),page);
      const st=doc.createElement('style');
      st.setAttribute('data-inlined-from',u);
      st.textContent=cssUrls(await getText(u),u);
      link.replaceWith(st);
    }
    for(const script of Array.from(doc.querySelectorAll('script[src]'))){
      const u=abs(script.getAttribute('src'),page);
      const inline=doc.createElement('script');
      inline.setAttribute('data-inlined-from',u);
      if(script.type)inline.type=script.type;
      inline.textContent=escScript(await getText(u));
      script.replaceWith(inline);
    }

    const st=doc.createElement('style');
    st.textContent='[data-tab="community"]{display:none!important}.standalone-readonly-note{margin:14px 18px 18px;padding:11px 13px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#111a20;color:#9eacb5;font-size:12px;font-weight:700;text-align:center}';
    doc.head.appendChild(st);

    const tail=doc.createElement('script');tail.textContent=postlude();doc.body.appendChild(tail);
    const blob=new Blob(['<!doctype html>\n'+doc.documentElement.outerHTML],{type:'text/html;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='superliga-2026-27-export-'+new Date().toISOString().slice(0,10)+'.html';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  }catch(e){
    console.error('[standalone-export]',e);
    alert('A HTML-generálás nem sikerült: '+(e&&e.message?e.message:e));
  }finally{
    if(btn){btn.disabled=false;btn.textContent=old||'⇩';}
  }
}

function button(){
  if(EXPORT_MODE||document.querySelector('[data-generate-standalone-html]'))return;
  const host=document.querySelector('.hdr-acts');if(!host)return;
  const b=document.createElement('button');
  b.type='button';b.className='hdr-icon standalone-export-button';b.dataset.generateStandaloneHtml='1';
  b.textContent='⇩';b.title='Működő, egyfájlos HTML generálása';b.setAttribute('aria-label',b.title);
  b.addEventListener('click',generate);host.insertBefore(b,host.firstChild);
}
function boot(){
  const st=document.createElement('style');
  st.textContent='.standalone-export-button{border:0;background:transparent;font:inherit;cursor:pointer}.standalone-export-button:disabled{opacity:.45;cursor:wait}.standalone-readonly-note{margin:14px 18px 18px;padding:11px 13px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#111a20;color:#9eacb5;font-size:12px;font-weight:700;text-align:center}';
  document.head.appendChild(st);
  button();scan(document);
  new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(n=>{if(n.nodeType===1)scan(n)})))
    .observe(document.body,{childList:true,subtree:true});
  if(EXPORT_MODE)document.querySelectorAll('[data-tab="community"]').forEach(e=>e.remove());
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',boot,{once:true}):boot();
})();
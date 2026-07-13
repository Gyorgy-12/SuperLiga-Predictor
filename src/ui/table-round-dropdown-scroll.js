// SuperLiga UI F6 — table round dropdown owns scrolling while open.
// Load after the table controls exist in index.html; this file initializes on DOMContentLoaded.

(function superligaTableRoundDropdownScrollF6(){
  'use strict';

  const ROOT_CLASS='tbl-round-drop-open';
  let drop=null;
  let button=null;
  let observer=null;
  let touchY=null;
  let raf=0;

  function isOpen(){
    return !!(drop&&drop.classList.contains('open'));
  }

  function setPriorityStyle(el,name,value){
    if(el)el.style.setProperty(name,value,'important');
  }

  function clearPlacement(){
    if(!drop)return;
    ['top','left','right','width','min-width','max-width','max-height'].forEach(name=>{
      drop.style.removeProperty(name);
    });
  }

  function placeDrop(){
    if(!isOpen()||!button)return;

    const gap=5;
    const edge=8;
    const rect=button.getBoundingClientRect();
    const mobile=window.matchMedia('(max-width:560px)').matches;
    const desiredWidth=mobile
      ? Math.min(260,Math.max(212,window.innerWidth-18))
      : Math.max(rect.width,Math.min(384,window.innerWidth-edge*2));

    const width=Math.min(desiredWidth,window.innerWidth-edge*2);
    const left=Math.min(
      Math.max(edge,rect.right-width),
      window.innerWidth-width-edge
    );
    const top=Math.max(edge,rect.bottom+gap);
    const maxHeight=Math.max(120,window.innerHeight-top-edge);

    setPriorityStyle(drop,'position','fixed');
    setPriorityStyle(drop,'top',top+'px');
    setPriorityStyle(drop,'left',left+'px');
    setPriorityStyle(drop,'right','auto');
    setPriorityStyle(drop,'width',width+'px');
    setPriorityStyle(drop,'min-width',width+'px');
    setPriorityStyle(drop,'max-width',width+'px');
    setPriorityStyle(drop,'max-height',maxHeight+'px');

    const active=drop.querySelector('button.active');
    if(active){
      requestAnimationFrame(()=>{
        try{active.scrollIntoView({block:'nearest'});}catch(_e){}
      });
    }
  }

  function syncOpenState(){
    const open=isOpen();
    document.documentElement.classList.toggle(ROOT_CLASS,open);
    document.body.classList.toggle(ROOT_CLASS,open);

    if(open){
      cancelAnimationFrame(raf);
      raf=requestAnimationFrame(placeDrop);
    }else{
      touchY=null;
      clearPlacement();
    }
  }

  function routeWheel(event){
    if(!isOpen())return;
    event.preventDefault();
    event.stopPropagation();
    drop.scrollTop+=event.deltaY;
  }

  function onTouchStart(event){
    if(!isOpen()||!event.touches||!event.touches.length)return;
    touchY=event.touches[0].clientY;
  }

  function routeTouchMove(event){
    if(!isOpen()||touchY==null||!event.touches||!event.touches.length)return;
    const nextY=event.touches[0].clientY;
    const delta=touchY-nextY;
    touchY=nextY;
    drop.scrollTop+=delta;
    event.preventDefault();
    event.stopPropagation();
  }

  function routeKeys(event){
    if(!isOpen())return;

    const page=Math.max(80,drop.clientHeight*.82);
    let delta=0;

    if(event.key==='ArrowDown')delta=44;
    else if(event.key==='ArrowUp')delta=-44;
    else if(event.key==='PageDown')delta=page;
    else if(event.key==='PageUp')delta=-page;
    else if(event.key==='Home'){
      drop.scrollTop=0;
      event.preventDefault();
      return;
    }else if(event.key==='End'){
      drop.scrollTop=drop.scrollHeight;
      event.preventDefault();
      return;
    }else if(event.key==='Escape'){
      drop.classList.remove('open');
      syncOpenState();
      try{button.focus({preventScroll:true});}catch(_e){}
      return;
    }else{
      return;
    }

    drop.scrollTop+=delta;
    event.preventDefault();
    event.stopPropagation();
  }

  function init(){
    drop=document.getElementById('tblRoundDrop');
    button=document.getElementById('tblRoundBtn');
    if(!drop||!button)return;

    drop.setAttribute('role','menu');
    drop.setAttribute('aria-label','Tabella forduló kiválasztása');

    observer=new MutationObserver(syncOpenState);
    observer.observe(drop,{attributes:true,attributeFilter:['class']});

    document.addEventListener('wheel',routeWheel,{capture:true,passive:false});
    document.addEventListener('touchstart',onTouchStart,{capture:true,passive:true});
    document.addEventListener('touchmove',routeTouchMove,{capture:true,passive:false});
    document.addEventListener('keydown',routeKeys,{capture:true});

    window.addEventListener('resize',()=>{
      if(isOpen())placeDrop();
    },{passive:true});

    window.addEventListener('orientationchange',()=>{
      if(isOpen())setTimeout(placeDrop,80);
    },{passive:true});

    syncOpenState();

    window.SUPERLIGA_TABLE_DROPDOWN_F6={
      version:'f6-dropdown-own-scroll',
      placeDrop,
      isOpen
    };
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init,{once:true});
  }else{
    init();
  }
})();

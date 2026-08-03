// Prediction efficiency, statistics helpers and standalone-export controls.

function scoredEfficiency(matches,predictionFor,grader){
  const scores=(matches||[]).map(match=>{
    const result=actualFor({id:match.id});
    if(!result||!(result.started||result.finished)||!validScore(result.h)||!validScore(result.a))return null;
    return grader(predictionFor(match),result);
  }).filter(score=>score&&score.cat);

  return{
    pts:scores.reduce((sum,score)=>sum+score.pts,0),
    max:scores.length,
    played:scores.length,
    exact:scores.filter(score=>score.cat==='exact').length,
    diff:scores.filter(score=>score.cat==='diff'||score.cat==='draw').length,
    outcome:scores.filter(score=>score.cat==='outcome').length,
    miss:scores.filter(score=>score.cat==='miss').length
  };
}

function tipEfficiency(){
  const regular=scoredEfficiency(FX,match=>getPred(match.id),gradeTip);
  let postseason={pts:0,max:0,played:0,exact:0,diff:0,outcome:0,miss:0};
  try{
    postseason=scoredEfficiency(buildAllPostseasonMatches(),match=>KO_PRED[match.id],gradeKoTip);
  }catch(_error){}

  return{
    grpPts:regular.pts,
    grpMax:regular.max,
    grpPlayed:regular.played,
    grpExact:regular.exact,
    grpDiff:regular.diff,
    grpOutcome:regular.outcome,
    grpMiss:regular.miss,
    koPts:postseason.pts,
    koMax:postseason.max,
    koPlayed2:postseason.played,
    koExact:postseason.exact,
    koDiff:postseason.diff,
    koOutcome:postseason.outcome,
    koMiss:postseason.miss,
    totalPts:regular.pts+postseason.pts,
    totalMax:regular.max+postseason.max,
    totalPlayed:regular.played+postseason.played
  };
}

function effSplitCard(label,exact,diff,outcome,miss,pts,max,played,color){
  const efficiency=max>0?+(pts/max*100).toFixed(2):0;
  const empty='<div class="eff-split-dots"><span class="eff-sdot" style="color:#3a4d5a">Még nincs élő vagy lezárt mérkőzés</span></div>';
  const summary=played
    ?'<div class="eff-split-dots"><span class="eff-sdot exact">'+exact+' pontos</span><span class="eff-sdot diff">'+diff+' gólkül.</span><span class="eff-sdot outcome">'+outcome+' kimen.</span><span class="eff-sdot miss">'+miss+' téves</span></div>'
    :empty;
  return '<div class="eff-split-card"><div class="eff-split-label">'+label+'</div><div class="eff-split-row"><div class="eff-split-pts">'+efficiency+'%<small> hatékonyság</small></div><div class="eff-split-pct">'+fmtPts(pts)+' / '+max+' pt</div></div><div class="eff-mini-bar"><div class="eff-mini-bar-fill" style="width:'+Math.min(100,efficiency)+'%;background:'+(color||'#28d16c')+'"></div></div>'+summary+'</div>';
}

function played(){return FX.map(match=>({m:match,p:getPred(match.id)})).filter(row=>row.p)}
function finishedActual(match){
  const result=actualFor({id:match.id});
  return result&&result.finished&&validScore(result.h)&&validScore(result.a)?{h:+result.h,a:+result.a}:null;
}
function statPredFor(match,isPostseason){return isPostseason?koPred(match.id):getPred(match.id)}
function statSourceFor(match,isPostseason){
  const result=finishedActual(match);
  if(result)return{m:match,p:result,source:'Valós'};
  const prediction=statPredFor(match,isPostseason);
  return prediction?{m:match,p:prediction,source:'Tipp'}:null;
}
function statMatchesFrom(matches,isPostseason){return(matches||[]).map(match=>statSourceFor(match,isPostseason)).filter(row=>row&&row.m&&row.m.h&&row.m.a)}
function actualFinishedCount(matches){return(matches||[]).filter(match=>finishedActual(match)).length}
function tipCountFor(matches,isPostseason){return(matches||[]).filter(match=>match&&match.h&&match.a&&statPredFor(match,isPostseason)).length}
function statPhaseInfo(name,total,matches,isPostseason){
  const res=statMatchesFrom(matches,isPostseason);
  const finished=actualFinishedCount(matches);
  const tipped=tipCountFor(matches,isPostseason);
  const goals=res.reduce((sum,row)=>sum+row.p.h+row.p.a,0);
  return{name,total,res,finished,tipped,goals,left:Math.max(0,total-finished),avg:res.length?goals/res.length:0};
}

function matchStageLabel(match){
  if(!match||match.g==='SL'||/^\d+$/.test(String(match.r||'')))return'Alapszakasz';
  if(match.g==='PO')return'Play-off';
  if(match.g==='PL')return'Play-out';
  if(match.g==='BR'||match.g==='CB')return'Baraj';

  const raw=String(match.title||match.phase||match.stage||match.round||'').toLowerCase();
  if(raw.includes('playoff')||raw.includes('play-off')||raw.includes('felső'))return'Play-off';
  if(raw.includes('playout')||raw.includes('play-out')||raw.includes('alsó'))return'Play-out';
  if(raw.includes('baraj'))return'Baraj';

  const id=String(match.id||'');
  if(id.startsWith('PO-'))return'Play-off';
  if(id.startsWith('PL-'))return'Play-out';
  if(id.startsWith('BR-')||id.startsWith('CB-'))return'Baraj';
  return'Play-off / Play-out';
}

function matchStatRoundLabel(match){
  if(!match)return'';
  if(matchStageLabel(match)==='Alapszakasz')return(match.d?match.d+' · ':'')+(match.r?match.r+'. forduló':'Alapszakasz');
  const label=typeof matchStageText==='function'?matchStageText(match,true):matchStageLabel(match);
  return(match.d?match.d+' · ':'')+label;
}

function matchStatRow(index,row,labelType){
  const prediction=row.p;
  const goalDifference=Math.abs(prediction.h-prediction.a);
  let sub=matchStatRoundLabel(row.m)+' · '+(row.source||'Tipp');
  if(labelType==='diff')sub+=' · GK: '+goalDifference;
  const home=teamNameFor(row.m.h,'stat-match');
  const away=teamNameFor(row.m.a,'stat-match');
  return '<div class="wc-stat-row"><div class="wc-stat-rank">'+index+'</div><div class="wc-stat-main"><div class="wc-stat-name stat-game-name">'+crest(row.m.h,'16px')+'<span class="stat-game-text">'+esc(home)+' - '+esc(away)+'</span>'+crest(row.m.a,'16px')+'</div><div class="wc-stat-sub">'+esc(sub)+'</div></div><div class="wc-stat-val">'+prediction.h+'-'+prediction.a+'</div></div>';
}

function statsExportHtml(){
  if(FROZEN_MODE)return'';
  return '<section class="card export-card"><h2 class="card-title">Tipp-sorozat ment&eacute;se</h2><p class="export-copy">A gomb egy teljesen statikus HTML-pillanatk&eacute;pet k&eacute;sz&iacute;t a jelenlegi tippekkel. Az &uacute;j f&aacute;jlban m&aacute;r nincs tippel&eacute;s vagy m&oacute;dos&iacute;t&aacute;s, csak a befagyasztott eredm&eacute;nyek maradnak meg.</p><button class="export-btn" id="exportBtn" type="button">HTML gener&aacute;l&aacute;s</button><div class="export-hint">A let&ouml;lt&ouml;tt f&aacute;jl &ouml;n&aacute;ll&oacute;an megnyithat&oacute;.</div></section>';
}

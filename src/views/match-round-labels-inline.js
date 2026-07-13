// SuperLiga UI F5 — compact, single-line match round labels.
// Load after matches-postseason-stats.view.js and before bootstrap.js.

(function superligaCompactMatchRoundLabelsF5(){
  function text(value){
    return String(value == null ? '' : value).trim();
  }

  function numberFrom(value, prefix){
    const match=text(value).match(new RegExp('^'+prefix+'(\\d+)$','i'));
    return match ? Number(match[1]) : null;
  }

  function compactBarajLabel(match){
    const round=text(match&&match.r);
    const title=text(match&&(match.title||match.d));
    const pairMatch=round.match(/^BR(\d+)$/i);
    const pair=pairMatch ? Number(pairMatch[1]) : null;

    const isReturnLeg=
      Number(match&&match.index)===2 ||
      /visszavágó|vissz\.|2\.\s*mérkőzés|második mérkőzés/i.test(title);

    if(pair){
      return 'Baraj '+pair+'. · '+(isReturnLeg?'vissz.':'1. meccs');
    }

    return isReturnLeg?'Baraj · vissz.':'Baraj · 1. meccs';
  }

  function compactStageLabel(match,isKo){
    if(!isKo){
      const round=Number(match&&match.r);
      return Number.isFinite(round) ? round+'. forduló' : 'Alapszakasz';
    }

    const group=text(match&&match.g).toUpperCase();
    const round=text(match&&match.r).toUpperCase();
    const title=text(match&&(match.title||match.d));

    const playoffRound=numberFrom(round,'PO');
    if(group==='PO'||playoffRound!=null){
      const value=playoffRound!=null?playoffRound:Number(text(match&&match.r).replace(/\D+/g,''));
      return 'PO '+(Number.isFinite(value)?value:'')+'. ford.';
    }

    const playoutRound=numberFrom(round,'PL');
    if(group==='PL'||playoutRound!=null){
      const value=playoutRound!=null?playoutRound:Number(text(match&&match.r).replace(/\D+/g,''));
      return 'PL '+(Number.isFinite(value)?value:'')+'. ford.';
    }

    if(group==='CB'||/^CB\d+$/i.test(round)){
      if(round==='CB1'||/elődöntő/i.test(title))return 'ECL-előd.';
      return 'ECL-döntő';
    }

    if(group==='BR'||/^BR\d+$/i.test(round)||/bentmaradás-baraj/i.test(title)){
      return compactBarajLabel(match);
    }

    return title
      .replace(/Konferencialiga-baraj/gi,'ECL-baraj')
      .replace(/Bentmaradás-baraj/gi,'Baraj')
      .replace(/\bplayoff\b/gi,'PO')
      .replace(/\bplayout\b/gi,'PL')
      .replace(/forduló/gi,'ford.')
      .replace(/elődöntő/gi,'előd.')
      .replace(/visszavágó/gi,'vissz.')
      .replace(/\s*-\s*/g,' · ')
      .replace(/\s+/g,' ')
      .trim() || 'Rájátszás';
  }

  // matchRow resolves this global function when each row is rendered.
  matchStageText=function matchStageTextF5(match,isKo){
    return compactStageLabel(match,!!isKo);
  };

  // Keep the round selector and section title compact too.
  postseasonRoundOptions=function postseasonRoundOptionsF5(){
    const options=[];
    for(let i=1;i<=10;i++)options.push({key:'PO'+i,label:'PO '+i+'. ford.'});
    for(let i=1;i<=9;i++)options.push({key:'PL'+i,label:'PL '+i+'. ford.'});
    options.push(
      {key:'CB1',label:'ECL-előd.'},
      {key:'CB2',label:'ECL-döntő'},
      {key:'BR1',label:'Baraj 1.'},
      {key:'BR2',label:'Baraj 2.'}
    );
    return options;
  };

  window.SUPERLIGA_MATCH_ROUND_LABELS_F5={
    version:'f5-single-line-round-labels',
    compactStageLabel
  };
})();

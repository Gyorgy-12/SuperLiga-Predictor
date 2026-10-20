// Shared by the classic browser scripts and the Worker event normalizer.
(function(root){
  function minute(row){return String(row.minute??row.matchMinute??row.elapsed??row.time??'').replace(/[’'′]/g,'').trim()}
  function side(row){return ['a','away','2'].includes(String(row.team||row.side||row.teamSide||row.sideRaw||'').toLowerCase())?'a':'h'}
  function player(row){return String(row.player?.name||row.player||row.playerName||row.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'')}
  function samePlayer(a,b){return side(a)===side(b)&&((a.playerId&&b.playerId)?a.playerId===b.playerId:!!player(a)&&player(a)===player(b))}
  function sameMoment(a,b){return samePlayer(a,b)&&minute(a)===minute(b)}
  function order(row){let m=minute(row).match(/^(\d+)(?:\+(\d+))?$/);return m?Number(m[1])+Number(m[2]||0)/100:Infinity}
  function kind(row,fallback){
    let text=[row.type,row.card,row.eventType,row.kind,row.label].filter(Boolean).join(' ').toLowerCase();
    if(row.yellowRed||row.secondYellow||/second[ _-]*yellow|2nd[ _-]*yellow|double[ _-]*yellow|yellow[ _/-]*red/.test(text))return 'yellowRed';
    if(row.red||row.isRed||row.redCard||Number(row.code)===2||/red[ _-]*card|\brc\b/.test(text))return 'red';
    if(row.yellow||Number(row.code)===1||/yellow|\byc\b/.test(text))return 'yellow';
    return fallback;
  }
  function unique(rows){
    let out=[];
    for(let row of rows){
      let previous=out.find(other=>sameMoment(row,other)||(row.eventId&&row.eventId===other.eventId&&side(row)===side(other)&&minute(row)===minute(other)&&!player(row)&&!player(other)));
      if(previous)Object.assign(previous,row);else out.push({...row});
    }
    return out.sort((a,b)=>order(a)-order(b));
  }
  function normalize(data={}){
    let buckets={yellow:[],red:[],yellowRed:[]};
    for(let [field,fallback] of [['yellowCards','yellow'],['redCards','red'],['doubleYellowCards','yellowRed'],['cards',null],['events',null]]){
      for(let row of Array.isArray(data[field])?data[field]:[]){
        if(!row||typeof row!=='object')continue;
        let type=kind(row,fallback);if(!type)continue;
        buckets[type].push({...row,minute:minute(row)});
      }
    }
    let yellowCards=unique(buckets.yellow).map(row=>({...row,type:'yellow_card',yellow:true,red:false,yellowRed:false}));
    let reds=unique([...buckets.red,...buckets.yellowRed]);
    let redCards=reds.map(row=>{
      let caution=yellowCards.find(yellow=>sameMoment(row,yellow));
      // Flashscore encodes a second-yellow dismissal as IE=1 then IE=2
      // inside one incident. Legacy rows may lack IDs; require two cautions
      // for that player before inferring the dismissal in those rows.
      let paired=!!caution&&((row.eventId&&row.eventId===caution.eventId)||yellowCards.filter(yellow=>samePlayer(row,yellow)&&order(yellow)<=order(row)).length>=2);
      let second=kind(row)==='yellowRed'||paired;
      return {...row,type:second?'second_yellow':'red_card',red:true,yellow:false,yellowRed:second};
    });
    for(let red of redCards){
      if(red.yellowRed&&!yellowCards.some(yellow=>sameMoment(red,yellow))){
        yellowCards.push({...red,type:'yellow_card',label:'Yellow Card',code:1,red:false,yellow:true,yellowRed:false,secondYellow:false,dismissalCaution:true});
      }
    }
    return {yellowCards:unique(yellowCards),redCards,doubleYellowCards:redCards.filter(row=>row.yellowRed)};
  }
  root.SuperligaCardEvents=Object.freeze({normalize});
})(globalThis);

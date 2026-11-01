// Romania-local fixture times, shared by the browser and the Worker.
(function(root){
  const formatters=new Map();
  function validTime(value){return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(String(value||''))}
  function fromLocal(date,time,zone='Europe/Bucharest'){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||''))||!validTime(time))return NaN;
    const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);
    const desired=Date.UTC(year,month-1,day,hour,minute);
    if(new Date(desired).toISOString().slice(0,10)!==date)return NaN;
    if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-CA',{
      timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }));
    let guess=desired;
    for(let i=0;i<4;i++){
      const parts=Object.fromEntries(formatters.get(zone).formatToParts(new Date(guess)).map(part=>[part.type,part.value]));
      const actual=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
      const difference=desired-actual;
      guess+=difference;
      if(!difference)break;
    }
    return guess;
  }
  function isoLocal(date,time,zone='Europe/Bucharest'){
    const epoch=fromLocal(date,time,zone);
    if(!Number.isFinite(epoch))return null;
    const [hour,minute]=time.split(':').map(Number),[year,month,day]=date.split('-').map(Number);
    const offset=Math.round((Date.UTC(year,month-1,day,hour,minute)-epoch)/60000);
    const pad=value=>String(value).padStart(2,'0');
    return `${date}T${pad(hour)}:${pad(minute)}:00${offset<0?'-':'+'}${pad(Math.floor(Math.abs(offset)/60))}:${pad(Math.abs(offset)%60)}`;
  }
  function kickoff(fixture,zone='Europe/Bucharest'){
    const exact=Date.parse(String(fixture?.kickoffAt||''));
    if(Number.isFinite(exact))return exact;
    const time=fixture?.t||fixture?.time||'';
    return fromLocal(fixture?.date,validTime(time)?time:'12:00',zone);
  }
  root.SuperligaFixtureTime=Object.freeze({fromLocal,isoLocal,kickoff,validTime});
})(globalThis);

import React, {useEffect, useMemo, useState} from 'react';
import {CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Database, RefreshCw, AlertTriangle, CircleCheck, X} from 'lucide-react';
import Digitization from './Digitization';
import './digitizationCached.css';
import {getDigitizationPeriod} from './digitization-period.mjs';

const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'—';
const parseIso=value=>{
 const [year,month,day]=String(value||'').split('-').map(Number);
 return new Date(year,month-1,day);
};
const isoDate=date=>[
 date.getFullYear(),
 String(date.getMonth()+1).padStart(2,'0'),
 String(date.getDate()).padStart(2,'0')
].join('-');
const monthStart=date=>new Date(date.getFullYear(),date.getMonth(),1);
const addMonths=(date,count)=>new Date(date.getFullYear(),date.getMonth()+count,1);
const monthEnd=date=>new Date(date.getFullYear(),date.getMonth()+1,0);
const monthLabel=date=>date.toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
const displayDate=value=>value?parseIso(value).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}):'';
const weekdayLabels=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function emptyPeriod(first,last){
 return {
  available:false,at:null,since:first,to:last,effective_to:null,metrics:null,components:{},
  operation_types:[],products:[],warnings:[],methodology:'Локальных дневных данных для этого периода пока недостаточно.'
 };
}

function MonthCalendar({month,missingDays,rangeFrom,rangeTo,rangePreview,maxDate,onSelectDay,onHoverDay}){
 const first=monthStart(month);
 const offset=(first.getDay()+6)%7;
 const dayCount=monthEnd(month).getDate();
 const cellCount=Math.ceil((offset+dayCount)/7)*7;
 const cells=Array.from({length:cellCount},(_,index)=>new Date(first.getFullYear(),first.getMonth(),index-offset+1));
 return <div className="digitization-month">
  <div className="digitization-month-title">{monthLabel(month)}</div>
  <div className="digitization-weekdays">{weekdayLabels.map(day=><span key={day}>{day}</span>)}</div>
  <div className="digitization-month-days">
   {cells.map(day=>{
    const iso=isoDate(day);
    const outside=day.getMonth()!==month.getMonth();
    const disabled=outside||iso>maxDate;
    const missing=missingDays.has(iso);
    const start=iso===rangeFrom;
    const end=Boolean(rangeTo)&&iso===rangeTo;
    const previewActive=Boolean(rangePreview?.from&&rangePreview?.to&&rangePreview.from!==rangePreview.to);
    const activeFrom=previewActive?rangePreview.from:rangeFrom;
    const activeTo=previewActive?rangePreview.to:rangeTo;
    const inRange=Boolean(activeFrom&&activeTo&&iso>activeFrom&&iso<activeTo);
    const previewEdge=previewActive&&(iso===rangePreview.from||iso===rangePreview.to);
    const classes=['digitization-day'];
    if(outside)classes.push('outside');
    if(missing)classes.push('missing');
    if(inRange)classes.push('in-range');
    if(start||end||previewEdge)classes.push('range-edge');
    return <button
     type="button"
     key={iso}
     className={classes.join(' ')}
     disabled={disabled}
     aria-label={displayDate(iso)+(missing?' — нет данных':'')}
     aria-pressed={start||end||inRange}
     title={missing?'Нет локальных данных за этот день':'Есть локальные данные за этот день'}
     onMouseEnter={()=>onHoverDay(disabled?null:iso)}
     onMouseLeave={()=>onHoverDay(null)}
     onClick={()=>onSelectDay(iso)}
    >{day.getDate()}</button>;
   })}
  </div>
 </div>;
}

export default function DigitizationCached({state,digi,act}){
 const defaults=useMemo(()=>getDigitizationPeriod(30),[]);
 const maxClosedDay=useMemo(()=>getDigitizationPeriod(1).to,[]);
 const [dateFrom,setDateFrom]=useState(defaults.from);
 const [dateTo,setDateTo]=useState(defaults.to);
 const [selectedPreset,setSelectedPreset]=useState(30);
 const [calendarOpen,setCalendarOpen]=useState(false);
 const [calendarMonth,setCalendarMonth]=useState(()=>monthStart(parseIso(defaults.from)));
 const [rangeDraft,setRangeDraft]=useState(null);
 const [hoveredCalendarDay,setHoveredCalendarDay]=useState(null);
 const [calendarMissing,setCalendarMissing]=useState(new Set());
 const [calendarCoverageLoading,setCalendarCoverageLoading]=useState(false);

 const choosePreset=preset=>{
  const range=preset==='month'
   ? {from:isoDate(new Date(parseIso(maxClosedDay).getFullYear(),parseIso(maxClosedDay).getMonth(),1)),to:maxClosedDay}
   : getDigitizationPeriod(preset==='yesterday'?1:preset);
  setDateFrom(range.from);
  setDateTo(range.to);
  setSelectedPreset(preset);
  setCalendarMonth(monthStart(parseIso(range.from)));
  setRangeDraft(null);
  setHoveredCalendarDay(null);
  setCalendarOpen(false);
 };

 const [periodDigi,setPeriodDigi]=useState(null);
 const [cacheState,setCacheState]=useState({
  loading:true,hit:false,daily:false,updatedAt:null,error:'',coverage:{}
 });
 const invalid=Boolean(dateFrom&&dateTo&&dateFrom>dateTo);

 useEffect(()=>{
  if(!state||!dateFrom||!dateTo||invalid)return;
  let live=true;
  const timer=setTimeout(async()=>{
   setCacheState(s=>({...s,loading:true,error:''}));
   try{
    const q=new URLSearchParams({date_from:dateFrom,date_to:dateTo});
    const response=await fetch('/api/digitization?'+q,{credentials:'same-origin'});
    const data=await response.json();
    if(!response.ok)throw new Error(data.detail||'Не удалось открыть локальные данные периода.');
    if(!live)return;
    const coverage=data.cache||{};
    const daily=coverage.source==='sqlite-daily';
    if(data.available){
     setPeriodDigi(data);
     setCacheState({
      loading:false,hit:true,daily,updatedAt:coverage.updated_at||data.at||null,
      error:'',coverage
     });
    }else{
     setPeriodDigi(null);
     setCacheState({loading:false,hit:false,daily:false,updatedAt:coverage.updated_at||null,error:'',coverage});
    }
   }catch(error){
    if(live){
     setPeriodDigi(null);
     setCacheState({loading:false,hit:false,daily:false,updatedAt:null,error:error.message||'Ошибка локальной базы.',coverage:{}});
    }
   }
  },120);
  return()=>{live=false;clearTimeout(timer)};
 },[state?.client_id,dateFrom,dateTo,invalid,digi?.at]);

 // Read local coverage for both visible calendar months. This endpoint only
 // inspects SQLite; it does not request anything from Ozon.
 useEffect(()=>{
  if(!calendarOpen||!state?.client_id)return;
  let live=true;
  const from=isoDate(monthStart(calendarMonth));
  const visibleEnd=isoDate(monthEnd(addMonths(calendarMonth,1)));
  const to=visibleEnd>maxClosedDay?maxClosedDay:visibleEnd;
  if(to<from){
   setCalendarMissing(new Set());
   setCalendarCoverageLoading(false);
   return;
  }
  setCalendarCoverageLoading(true);
  const q=new URLSearchParams({date_from:from,date_to:to});
  fetch('/api/digitization?'+q,{credentials:'same-origin'})
   .then(async response=>{
    const data=await response.json();
    if(!response.ok)throw new Error(data.detail||'Не удалось проверить локальные дни.');
    return data.cache?.missing_days||[];
   })
   .then(days=>{if(live)setCalendarMissing(new Set(days));})
   .catch(()=>{if(live)setCalendarMissing(new Set());})
   .finally(()=>{if(live)setCalendarCoverageLoading(false);});
  return()=>{live=false};
 },[calendarOpen,state?.client_id,calendarMonth,maxClosedDay]);

 const active=periodDigi||emptyPeriod(dateFrom,dateTo);
 const missing=cacheState.coverage?.missing_days||[];
 const requested=Number(cacheState.coverage?.requested_days||0);
 const available=Number(cacheState.coverage?.available_days||0);
 const legacy=cacheState.coverage?.source==='legacy-period';

 const refresh=()=>{
  if(!state||state.job.running||invalid||!dateFrom||!dateTo)return;
  // Missing period: download only absent closed days. Fully local period: an
  // explicit click refreshes selected days because the user asked Ozon for it.
  act('/digitization/sync',{date_from:dateFrom,date_to:dateTo,refresh:cacheState.daily||legacy});
 };

 const selectCalendarDay=day=>{
  if(!rangeDraft){
   setRangeDraft({from:day,to:null});
   setSelectedPreset(null);
   return;
  }
  let from=rangeDraft.from;
  let to=day;
  if(to<from){const swap=from;from=to;to=swap;}
  setDateFrom(from);
  setDateTo(to);
  setSelectedPreset(null);
  setRangeDraft(null);
  setHoveredCalendarDay(null);
  setCalendarOpen(false);
 };

 const rangeFrom=rangeDraft?.from||dateFrom;
 const rangeTo=rangeDraft?rangeDraft.to:dateTo;
 const rangePreview=rangeDraft?.from&&hoveredCalendarDay
  ? {from:hoveredCalendarDay<rangeDraft.from?hoveredCalendarDay:rangeDraft.from,to:hoveredCalendarDay<rangeDraft.from?rangeDraft.from:hoveredCalendarDay}
  : null;
 const presetItems=[
  {id:'yesterday',label:'Вчера'},
  {id:7,label:'7 дней'},
  {id:30,label:'30 дней'},
  {id:'month',label:'Текущий месяц'},
  {id:90,label:'90 дней'}
 ];

 let statusText='Локальных данных выбранного периода пока нет';
 if(cacheState.loading)statusText='Собираем период из локальной SQLite-базы…';
 else if(legacy)statusText='Старый снимок периода · обновите один раз для дневной базы';
 else if(cacheState.daily)statusText='Локально: '+available+' из '+requested+' закрытых дней';
 else if(available>0)statusText='Локально: '+available+' из '+requested+' дней · не хватает '+missing.length;

 let buttonText='Загрузить из Ozon';
 if(state?.job.running)buttonText='Обновляем…';
 else if(legacy)buttonText='Разложить по дням';
 else if(cacheState.daily)buttonText='Обновить период';
 else if(missing.length)buttonText='Догрузить '+missing.length+' дн.';

 return <div className="digitization-cache-page">
  <div className="digitization-cache-header">
   <div className="digitization-cache-title"><h1>Оцифровка</h1></div>
   <section className="digitization-period-card" aria-label="Период отчёта">
    <div className="digitization-period-caption"><CalendarDays size={16}/><span>Период отчёта</span></div>
    <div className="digitization-period-controls">
     <div className="digitization-range-control">
      <button
       type="button"
       className="digitization-range-trigger"
       aria-expanded={calendarOpen}
       aria-haspopup="dialog"
       onClick={()=>{
        if(!calendarOpen){
         setCalendarMonth(monthStart(parseIso(dateFrom)));
         setRangeDraft(null);
         setHoveredCalendarDay(null);
        }
        setCalendarOpen(!calendarOpen);
       }}
      >
       <CalendarDays size={17}/>
       <span>{rangeDraft?displayDate(rangeDraft.from)+' — выберите конец':displayDate(dateFrom)+' — '+displayDate(dateTo)}</span>
       <ChevronDown size={16}/>
      </button>
      {calendarOpen&&<div className="digitization-range-popover" role="dialog" aria-label="Выбор периода">
       <div className="digitization-calendar-area">
        <div className="digitization-calendar-topbar">
         <button type="button" aria-label="Предыдущий месяц" onClick={()=>setCalendarMonth(month=>addMonths(month,-1))}><ChevronLeft size={17}/></button>
         <strong>{monthLabel(calendarMonth)} — {monthLabel(addMonths(calendarMonth,1))}</strong>
         <button type="button" aria-label="Следующий месяц" disabled={monthStart(addMonths(calendarMonth,1))>monthStart(parseIso(maxClosedDay))} onClick={()=>setCalendarMonth(month=>addMonths(month,1))}><ChevronRight size={17}/></button>
        </div>
        <div className="digitization-months">
         <MonthCalendar month={calendarMonth} missingDays={calendarMissing} rangeFrom={rangeFrom} rangeTo={rangeTo} rangePreview={rangePreview} maxDate={maxClosedDay} onSelectDay={selectCalendarDay} onHoverDay={setHoveredCalendarDay}/>
         <MonthCalendar month={addMonths(calendarMonth,1)} missingDays={calendarMissing} rangeFrom={rangeFrom} rangeTo={rangeTo} rangePreview={rangePreview} maxDate={maxClosedDay} onSelectDay={selectCalendarDay} onHoverDay={setHoveredCalendarDay}/>
        </div>
        <div className="digitization-calendar-legend">
         <span className="digitization-missing-key"/><span>Нет данных</span>
         {calendarCoverageLoading&&<small>Проверяем локальную базу…</small>}
        </div>
       </div>
       <aside className="digitization-calendar-presets">
        <strong>Быстрый выбор</strong>
        {presetItems.map(item=><button
         type="button"
         key={item.id}
         className={selectedPreset===item.id?'active':''}
         onClick={()=>choosePreset(item.id)}
        >{item.label}</button>)}
        <button type="button" className="digitization-calendar-close" onClick={()=>{setCalendarOpen(false);setRangeDraft(null);setHoveredCalendarDay(null)}}><X size={14}/> Закрыть</button>
       </aside>
      </div>}
     </div>
     <button className="primary digitization-refresh" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={refresh}>
      <RefreshCw size={15} className={state?.job.running?'animate-spin':''}/>{buttonText}
     </button>
    </div>
    <div className={'digitization-cache-status '+(cacheState.daily?'hit':cacheState.loading?'loading':legacy?'legacy':'miss')}>
     {cacheState.daily?<CircleCheck size={15}/>:cacheState.loading?<RefreshCw size={15} className="animate-spin"/>:<Database size={15}/>}
     <span>{statusText}</span>
     {cacheState.updatedAt&&<small>обновлено {dateTime(cacheState.updatedAt)}</small>}
    </div>
   </section>
  </div>

  {invalid&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {cacheState.error&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>{cacheState.error}</div>}
  {!invalid&&!cacheState.loading&&!cacheState.hit&&<section className="panel digitization-cache-empty">
   <Database size={28}/><div><h3>Не хватает локальных дней</h3><p>{missing.length?'В SQLite уже есть '+available+' из '+requested+' дней. Нажмите «'+buttonText+'» — ИСК запросит у Ozon только отсутствующие дни.':'Загрузите диапазон один раз. После этого любые интервалы внутри него будут считаться мгновенно из SQLite.'}</p></div>
  </section>}

  {!invalid&&cacheState.hit&&<div className="digitization-content"><Digitization state={state} digi={active} act={act}/></div>}
 </div>;
}

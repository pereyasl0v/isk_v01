import React, {useEffect, useMemo, useState} from 'react';
import {CalendarDays, Database, RefreshCw, AlertTriangle, CircleCheck} from 'lucide-react';
import Digitization from './Digitization';
import './digitizationCached.css';

const iso=d=>{const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)};
const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'—';

function emptyPeriod(first,last){
 return {
  available:false,at:null,since:first,to:last,effective_to:null,metrics:null,components:{},
  operation_types:[],products:[],warnings:[],methodology:'Локальных дневных данных для этого периода пока недостаточно.'
 };
}

export default function DigitizationCached({state,digi,act}){
 const defaults=useMemo(()=>{
  const end=new Date();
  const start=new Date(end);
  start.setDate(start.getDate()-29);
  return {from:digi?.since||iso(start),to:digi?.to||iso(end)};
 },[]);
 const [dateFrom,setDateFrom]=useState(defaults.from);
 const [dateTo,setDateTo]=useState(defaults.to);
 const [periodDigi,setPeriodDigi]=useState(digi?.metrics?digi:null);
 const [cacheState,setCacheState]=useState({
  loading:false,hit:Boolean(digi?.metrics),daily:false,updatedAt:digi?.at||null,error:'',coverage:{}
 });
 const invalid=Boolean(dateFrom&&dateTo&&dateFrom>dateTo);

 useEffect(()=>{
  if(!state||!dateFrom||!dateTo||invalid)return;
  let live=true;
  const timer=setTimeout(async()=>{
   setCacheState(s=>({...s,loading:true,error:''}));
   try{
    const q=new URLSearchParams({date_from:dateFrom,date_to:dateTo});
    const response=await fetch(`/api/digitization?${q}`,{credentials:'same-origin'});
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

 const active=periodDigi||emptyPeriod(dateFrom,dateTo);
 const totalLocalDays=Number(state?.digitization_days?.days||0);
 const firstLocalDay=state?.digitization_days?.first_day;
 const lastLocalDay=state?.digitization_days?.last_day;
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

 let statusText='Локальных данных выбранного периода пока нет';
 if(cacheState.loading)statusText='Собираем период из локальной SQLite-базы…';
 else if(legacy)statusText='Старый снимок периода · обновите один раз для дневной базы';
 else if(cacheState.daily)statusText=`Локально: ${available} из ${requested} закрытых дней`;
 else if(available>0)statusText=`Локально: ${available} из ${requested} дней · не хватает ${missing.length}`;

 let buttonText='Загрузить из Ozon';
 if(state?.job.running)buttonText='Обновляем…';
 else if(legacy)buttonText='Разложить по дням';
 else if(cacheState.daily)buttonText='Обновить период';
 else if(missing.length)buttonText=`Догрузить ${missing.length} дн.`;

 return <div className="digitization-cache-page">
  <div className="digitization-cache-header">
   <div className="digitization-cache-title">
    <h1>Оцифровка</h1>
    <p>Выберите любой интервал внутри уже загруженных дней — показатели пересчитаются локально, без обращения к Ozon.</p>
    {totalLocalDays>0&&<div className="digitization-local-range"><Database size={15}/><span>Локальная база: <b>{firstLocalDay}</b> — <b>{lastLocalDay}</b></span><small>{totalLocalDays} дн.</small></div>}
   </div>
   <section className="digitization-period-card" aria-label="Период отчёта">
    <div className="digitization-period-caption"><CalendarDays size={16}/><span>Период отчёта</span></div>
    <div className="digitization-period-row">
     <label><span>С</span><input aria-label="Дата начала" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
     <span className="digitization-period-arrow">→</span>
     <label><span>По</span><input aria-label="Дата окончания" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
     <button className="primary digitization-refresh" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={refresh}>
      <RefreshCw size={15} className={state?.job.running?'animate-spin':''}/>{buttonText}
     </button>
    </div>
    <div className={`digitization-cache-status ${cacheState.daily?'hit':cacheState.loading?'loading':legacy?'legacy':'miss'}`}>
     {cacheState.daily?<CircleCheck size={15}/>:cacheState.loading?<RefreshCw size={15} className="animate-spin"/>:<Database size={15}/>} 
     <span>{statusText}</span>
     {cacheState.updatedAt&&<small>обновлено {dateTime(cacheState.updatedAt)}</small>}
    </div>
    <p className="digitization-period-help">Смена дат читает только SQLite. Ozon вызывается только по кнопке: для нового диапазона догружаются отсутствующие дни, а для уже сохранённого диапазона выполняется явное обновление.</p>
   </section>
  </div>

  {invalid&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {cacheState.error&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>{cacheState.error}</div>}
  {!invalid&&!cacheState.loading&&!cacheState.hit&&<section className="panel digitization-cache-empty">
   <Database size={28}/><div><h3>Не хватает локальных дней</h3><p>{missing.length?`В SQLite уже есть ${available} из ${requested} дней. Нажмите «${buttonText}» — ИСК запросит у Ozon только отсутствующие дни.`:'Загрузите диапазон один раз. После этого любые интервалы внутри него будут считаться мгновенно из SQLite.'}</p></div>
  </section>}

  {!invalid&&cacheState.hit&&<div className="digitization-content"><Digitization state={state} digi={active} act={act}/></div>}
 </div>
}

import React, {useEffect, useMemo, useState} from 'react';
import {CalendarDays, Database, RefreshCw, AlertTriangle, CircleCheck} from 'lucide-react';
import Digitization from './Digitization';
import './digitizationCached.css';

const iso=d=>{const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)};
const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'—';

function emptyPeriod(first,last){
 return {
  available:false,at:null,since:first,to:last,effective_to:null,metrics:null,components:{},
  operation_types:[],products:[],warnings:[],methodology:'Локальной копии этого периода пока нет.'
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
 const [cacheState,setCacheState]=useState({loading:false,hit:Boolean(digi?.metrics),updatedAt:digi?.at||null,error:''});
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
    if(!response.ok)throw new Error(data.detail||'Не удалось открыть локальную копию периода.');
    if(!live)return;
    if(data.available){
     setPeriodDigi(data);
     setCacheState({loading:false,hit:true,updatedAt:data.cache?.updated_at||data.at||null,error:''});
    }else{
     setPeriodDigi(null);
     setCacheState({loading:false,hit:false,updatedAt:null,error:''});
    }
   }catch(error){
    if(live){
     setPeriodDigi(null);
     setCacheState({loading:false,hit:false,updatedAt:null,error:error.message||'Ошибка локальной базы.'});
    }
   }
  },140);
  return()=>{live=false;clearTimeout(timer)};
 },[state?.client_id,dateFrom,dateTo,invalid,digi?.at]);

 const active=periodDigi||emptyPeriod(dateFrom,dateTo);
 const periodCount=Number(state?.digitization_periods||0);
 const refresh=()=>{
  if(!state||state.job.running||invalid||!dateFrom||!dateTo)return;
  act('/digitization/sync',{date_from:dateFrom,date_to:dateTo});
 };

 return <div className="digitization-cache-page">
  <div className="digitization-cache-header">
   <div className="digitization-cache-title">
    <h1>Оцифровка</h1>
    <p>Метрики и формулы TrueStats · расчёты строятся из локальной копии данных.</p>
   </div>
   <section className="digitization-period-card" aria-label="Период отчёта">
    <div className="digitization-period-caption"><CalendarDays size={16}/><span>Период отчёта</span></div>
    <div className="digitization-period-row">
     <label><span>С</span><input aria-label="Дата начала" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
     <span className="digitization-period-arrow">→</span>
     <label><span>По</span><input aria-label="Дата окончания" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
     <button className="primary digitization-refresh" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={refresh}>
      <RefreshCw size={15} className={state?.job.running?'animate-spin':''}/>{state?.job.running?'Обновляем…':'Обновить из Ozon'}
     </button>
    </div>
    <div className={`digitization-cache-status ${cacheState.hit?'hit':cacheState.loading?'loading':'miss'}`}>
     {cacheState.hit?<CircleCheck size={15}/>:cacheState.loading?<RefreshCw size={15} className="animate-spin"/>:<Database size={15}/>} 
     <span>{cacheState.loading?'Проверяем локальную базу…':cacheState.hit?`Локальная копия · ${dateTime(cacheState.updatedAt)}`:'Локальной копии этого периода нет'}</span>
     {periodCount>0&&<small>{periodCount} сохранённых периодов</small>}
    </div>
    <p className="digitization-period-help">Смена дат не делает запросов в Ozon. Если период уже сохранён в SQLite, показатели меняются сразу. Кнопка выше загружает только выбранный период и обновляет локальную копию.</p>
   </section>
  </div>

  {invalid&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {cacheState.error&&<div className="notice warning digitization-cache-notice"><AlertTriangle size={18}/>{cacheState.error}</div>}
  {!invalid&&!cacheState.loading&&!cacheState.hit&&<section className="panel digitization-cache-empty">
   <Database size={28}/><div><h3>Период ещё не сохранён локально</h3><p>Нажмите «Обновить из Ozon». После первой загрузки этот же период будет открываться из SQLite без повторного запроса к Ozon.</p></div>
  </section>}

  {!invalid&&cacheState.hit&&<div className="digitization-content"><Digitization state={state} digi={active} act={act}/></div>}
 </div>
}

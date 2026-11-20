import React, {useEffect, useState, createContext, useContext, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, NavLink, Routes, Route, Navigate, useNavigate} from 'react-router-dom';
import {Boxes, LayoutDashboard, Package, Warehouse, Truck, Calculator, Plug, ListChecks, RefreshCw, ArrowUpRight, Search, Download, CircleCheck, AlertCircle, ArrowRight, LogOut, BarChart3, Plus, Users, ShieldCheck, Barcode} from 'lucide-react';
import './style.css';
import Replenishment from './Replenishment';
import MarketPage from './market';
import DigitizationCached from './DigitizationCached';
import ProductDetails from './ProductDetails';
import BarcodeGenerator from './BarcodeGenerator';
import {statusLabel,roleLabel,groupStocks} from './presentation';
import {salesChartWindow,salesRangeTotals,salesTickIndexes} from './sales-chart-range.mjs';
import {getDigitizationPeriod} from './digitization-period.mjs';

const Context=createContext(null);
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const num=v=>v===null||v===undefined?'—':nf.format(v);
const date=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
function moscowDate(daysAgo=0){const value=new Date(Date.now()+3*60*60*1000);value.setUTCDate(value.getUTCDate()-daysAgo);return value.toISOString().slice(0,10)}
async function api(path,body){
 const r=await fetch('/api'+path,{credentials:'same-origin',method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Local-App':'fbo'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json(); if(!r.ok){const e=new Error(data.detail||'Запрос не выполнен');e.status=r.status;throw e;}return data;
}
function useApp(){return useContext(Context)}
function Notice({children}){return <div className="notice"><AlertCircle size={18}/><span>{children}</span></div>}
function Empty({text='Пока нет данных',help='Подключите кабинет и выполните загрузку.'}){return <div className="empty"><Boxes size={34}/><h3>{text}</h3><p>{help}</p></div>}
function Table({columns,rows,empty='Нет строк для отображения',onRowClick,pageSize=30}){
 const [page,setPage]=useState(0);const pages=Math.ceil(rows.length/pageSize);const safe=Math.min(page,Math.max(pages-1,0));
 return <><div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.slice(safe*pageSize,safe*pageSize+pageSize).map((r,i)=><tr key={i} {...(onRowClick?{className:"product-clickable-row",role:"button",tabIndex:0,onClick:()=>onRowClick(r),onKeyDown:e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onRowClick(r)}}}:{})}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>{!rows.length?<Empty text={empty} help="Проверьте загрузку и выбранные фильтры."/>:<div className="pagination"><span>{num(rows.length)} строк · страница {safe+1} из {pages}</span><div><button disabled={safe===0} onClick={()=>setPage(safe-1)}>Назад</button><button disabled={safe>=pages-1} onClick={()=>setPage(safe+1)}>Далее</button></div></div>}</>
}
function Filter({value,set,placeholder='Поиск по названию, артикулу или SKU'}){return <label className="search"><Search size={17}/><input aria-label="Поиск" value={value} onChange={e=>set(e.target.value)} placeholder={placeholder}/></label>}
function Card({label,value,note,icon:Icon=Package}){return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{num(value)}</strong><small>{note}</small></div>}
function Overview(){
 const {inv,state,act,sales,me}=useApp();const s=inv?.summary;const salesSyncStarted=useRef(false);
 useEffect(()=>{salesSyncStarted.current=false},[me?.active_account_id]);
 useEffect(()=>{
  if(!state||state.job.running||salesSyncStarted.current)return;
  const twoWeeks=getDigitizationPeriod(14);
  if(sales?.date_to===moscowDate(0)&&sales?.date_from<=twoWeeks.from&&(sales?.rows?.length||0)>=15)return;
  salesSyncStarted.current=true;
  act('/sales/sync',{days:14});
 },[sales?.at,sales?.error,state?.job.running]);
 return <><div className="overview-heading"><div><h1>Обзор кабинета</h1><p className="muted mt-2">Продажи и остатки Ozon · остатки обновлены: {date(inv?.at)}</p></div><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/sync',{})}>Обновить остатки <RefreshCw size={16}/></button></div>
 <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6"><Card label="Доступно к продаже FBO" value={s?.available} note="Единиц" icon={Boxes}/><Card label="Готовится к продаже" value={s?.preparing} note="Единиц"/><Card label="В пути на Ozon" value={s?.transit} note="Единиц" icon={Truck}/><Card label="Товары" value={s?.products} note="Карточек"/></div>
 <SalesHistoryChart data={sales} state={state} act={act} inv={inv}/>
 {inv?.warning&&<Notice>{inv.warning}</Notice>}
 <div className="mt-5"><ProductCatalog/></div></>
}
function SalesHistoryChart({data,state,act,inv}){
 const [period,setPeriod]=useState(14);
 const [hovered,setHovered]=useState(null);
 const [sku,setSku]=useState('all');
 const [selectedRange,setSelectedRange]=useState(null);
 const selectionStart=useRef(null);
 const pendingPeriodSync=useRef(null);
 // Use the same N completed Moscow dates as Digitization, plus today.
 // Filtering by dates (not the last N rows) also detects incomplete old caches.
 const allPoints=salesChartWindow(data?.rows,period).points;
 const needsSalesSync=days=>{
  const window=salesChartWindow(data?.rows,days);
  return !window.complete||data?.date_to!==window.to||!data?.date_from||data.date_from>window.from;
 };
 // If another job was running when the period was selected, load it once idle.
 useEffect(()=>{
  if(state?.job?.running||pendingPeriodSync.current===null)return;
  const days=pendingPeriodSync.current;
  pendingPeriodSync.current=null;
  if(needsSalesSync(days))act('/sales/sync',{days});
 },[state?.job?.running,data?.at,period]);
 const skuNames=new Map((inv?.products||[]).filter(p=>p.sku).map(p=>[String(p.sku),p.name||String(p.sku)]));
 const skuRows=data?.by_sku||[];
 const skuOptions=[...new Set([...skuNames.keys(),...skuRows.map(row=>String(row.sku))])].sort((a,b)=>(skuNames.get(a)||a).localeCompare(skuNames.get(b)||b,'ru'));
 const selectedDays=new Map(skuRows.filter(row=>String(row.sku)===sku).map(row=>[row.date,row]));
 const points=sku==='all'?allPoints:allPoints.map(day=>{
  const selected=selectedDays.get(day.date);
  return {date:day.date,ordered_units:selected?.ordered_units??0,
   ordered_revenue:selected?.ordered_revenue??0,
   delivered_units:day.delivered_units===null||(day.delivery_partial&&selected?.delivered_units==null)?null:(selected?.delivered_units??0),
   delivery_partial:Boolean(day.delivery_partial)};
 });
 const values=points.flatMap(p=>[Number(p.ordered_units||0),...(data?.delivered_available&&p.delivered_units!==null?[Number(p.delivered_units)]:[])]);
 const max=Math.max(5,Math.ceil(Math.max(1,...values)/5)*5);
 const min=Math.min(0,Math.floor(Math.min(0,...values)/5)*5);
 const width=960,height=235,left=14,right=37,top=24,bottom=38,plotWidth=width-left-right,plotHeight=height-top-bottom;
 const x=index=>left+(points.length<=1?plotWidth/2:index*plotWidth/(points.length-1));
 const y=value=>top+plotHeight-((Number(value||0)-min)/(max-min))*plotHeight;
 const smoothPath=items=>{
  if(!items.length)return '';
  const coords=items.map(({index,value})=>({x:x(index),y:y(value)}));
  let result='M '+coords[0].x+' '+coords[0].y;
  for(let i=0;i<coords.length-1;i++){
   const prev=coords[Math.max(0,i-1)],a=coords[i],b=coords[i+1],next=coords[Math.min(coords.length-1,i+2)];
   const c1x=a.x+(b.x-prev.x)/6,c1y=a.y+(b.y-prev.y)/6;
   const c2x=b.x-(next.x-a.x)/6,c2y=b.y-(next.y-a.y)/6;
   result+=' C '+c1x+' '+c1y+' '+c2x+' '+c2y+' '+b.x+' '+b.y;
  }
  return result;
 };
 const orderedPath=smoothPath(points.map((point,index)=>({index,value:point.ordered_units})));
 const deliveredSegments=[];let continuous=[];
 points.forEach((point,index)=>{
  if(point.delivered_units===null||point.delivered_units===undefined){
   if(continuous.length)deliveredSegments.push(continuous);
   continuous=[];
  }else continuous.push({index,value:point.delivered_units});
 });
 if(continuous.length)deliveredSegments.push(continuous);
 const deliveredPaths=deliveredSegments.map(segment=>{
  const line=smoothPath(segment),a=x(segment[0].index),b=x(segment[segment.length-1].index);
  return {line,area:line+' L '+b+' '+y(0)+' L '+a+' '+y(0)+' Z'};
 });
 const tickIndexes=salesTickIndexes(points.length);
 const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
 const fmtDay=value=>value?Number(value.slice(8,10))+' '+months[Number(value.slice(5,7))-1]:'—';
 const fmtTick=value=>value?value.slice(8,10):'—';
 const fmtWeekday=value=>{const day=new Date(value+'T12:00:00Z').getUTCDay();return day===6?'сб':day===0?'вс':''};
 const hoveredPoint=hovered===null?null:points[hovered];
 const selectionIndexes=selectedRange?.map(day=>points.findIndex(point=>point.date===day))||[];
 const selectedTotal=selectionIndexes.length===2&&selectionIndexes.every(index=>index>=0)
  ?salesRangeTotals(points,selectionIndexes[0],selectionIndexes[1]):null;
 const rangeBandStep=plotWidth/Math.max(1,points.length-1);
 const rangeBandLeft=selectedTotal?Math.max(left,x(selectedTotal.startIndex)-rangeBandStep/2):0;
 const rangeBandRight=selectedTotal?Math.min(width-right,x(selectedTotal.endIndex)+rangeBandStep/2):0;
 const fmtRangeDate=value=>value?.split('-').reverse().join('.')||'—';
 const pointerIndex=event=>{
  const bounds=event.currentTarget.getBoundingClientRect();
  if(!bounds.width)return 0;
  const px=(event.clientX-bounds.left)/bounds.width*width;
  return Math.max(0,Math.min(points.length-1,Math.round((px-left)/plotWidth*(points.length-1))));
 };
 const startSelection=event=>{
  if(!points.length||(event.pointerType==='mouse'&&event.button!==0))return;
  const bounds=event.currentTarget.getBoundingClientRect();
  if(!bounds.height)return;
  const py=(event.clientY-bounds.top)/bounds.height*height;
  if(py<top-8||py>top+plotHeight+12)return;
  const index=pointerIndex(event);
  selectionStart.current=index;
  setSelectedRange([points[index].date,points[index].date]);
  event.currentTarget.setPointerCapture?.(event.pointerId);
 };
 const moveSelection=event=>{
  if(selectionStart.current===null)return;
  const index=pointerIndex(event);
  const start=points[selectionStart.current]?.date;
  if(start)setSelectedRange([start,points[index].date]);
  setHovered(index);
 };
 const finishSelection=event=>{
  if(selectionStart.current===null)return;
  const index=pointerIndex(event);
  const start=points[selectionStart.current]?.date;
  if(start)setSelectedRange([start,points[index].date]);
  selectionStart.current=null;
  setHovered(null);
  if(event.currentTarget.hasPointerCapture?.(event.pointerId)){
   event.currentTarget.releasePointerCapture(event.pointerId);
  }
 };
 const busy=Boolean(state?.job?.running);
 return <section className="panel sales-chart">
  <div className="panel-title"><div><h3>Заказано товаров</h3></div>
   <div className="sales-chart-controls"><select aria-label="Товар для графика" value={sku} onChange={e=>{setSku(e.target.value);setHovered(null);setSelectedRange(null)}}><option value="all">Все товары</option>{skuOptions.map(value=><option key={value} value={value}>{skuNames.get(value)||('SKU '+value)}</option>)}</select><div className="segmented">{[7,14,30,90].map(value=><button key={value} className={period===value?'selected':''} onClick={()=>{setPeriod(value);setHovered(null);setSelectedRange(null);if(needsSalesSync(value)){if(busy)pendingPeriodSync.current=value;else act('/sales/sync',{days:value})}else pendingPeriodSync.current=null}}>{value} дн.</button>)}</div>
    <button disabled={busy||!state} onClick={()=>act('/sales/sync',{days:Math.min(90,Math.max(period,(data?.rows||[]).length-1,14))})}>{busy?'Загружаем…':'Обновить'}</button>
   </div>
  </div>
  {data?.error&&<Notice>{data.error}</Notice>}
  {!points.length?<Empty text="Дневная статистика пока не загружена" help="ИСК получает заказы и историю доставок из Ozon Seller API и Ozon Push."/>:<>
    <div className="sales-chart-legend"><span><i className="ordered"/>Заказано</span>{data?.delivered_available&&<span><i className="delivered"/>{data.delivery_label||'Доставлено'}</span>}<span className="sales-range-hint">Выделите период на графике для подсчёта итогов</span></div>
   <div className="sales-chart-wrap">
    {hoveredPoint&&<div className="sales-chart-tooltip" style={{left:`${Math.max(16,Math.min(84,x(hovered)/width*100))}%`}}>
     <strong>{fmtDay(hoveredPoint.date)}</strong>
     <div><span><i className="ordered"/>Заказано</span><b>{num(hoveredPoint.ordered_units)} шт. · {num(hoveredPoint.ordered_revenue)} ₽</b></div>
     {data?.delivered_available&&<div><span><i className="delivered"/>{data.delivery_label||'Доставлено'}</span><b>{hoveredPoint.delivered_units===null?'Нет данных':num(hoveredPoint.delivered_units)+' шт.'}{hoveredPoint.delivery_partial?' · неполные данные':''}</b></div>}
    </div>}
    <svg className="sales-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img"
     aria-label="График заказов по дням: проведите по графику для выбора диапазона"
     onPointerDown={startSelection} onPointerMove={moveSelection}
     onPointerUp={finishSelection} onPointerCancel={()=>{selectionStart.current=null;setHovered(null)}}>
     {[min,(min+max)/2,max].map(value=><g key={value}><line x1={left} x2={width-right} y1={y(value)} y2={y(value)} stroke="#d8e2ed" strokeDasharray="2 5" strokeWidth="1"/>{(value!==0||min<0)&&<text x={width-right+8} y={y(value)+4} textAnchor="start" fontSize="12" fill="#8192a4">{Math.round(value)}</text>}</g>)}
     {selectedTotal&&<rect x={rangeBandLeft} y={top} width={Math.max(2,rangeBandRight-rangeBandLeft)} height={plotHeight} rx="4" fill="#168cf0" fillOpacity=".1" stroke="#168cf0" strokeOpacity=".45" strokeDasharray="4 4" pointerEvents="none"/>}
     <defs><linearGradient id="ozon-delivery-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9bd7ff" stopOpacity=".52"/><stop offset="100%" stopColor="#cceaff" stopOpacity=".20"/></linearGradient></defs>
     {data?.delivered_available&&deliveredPaths.map((segment,index)=><g key={index}><path d={segment.area} fill="url(#ozon-delivery-fill)"/><path d={segment.line} fill="none" stroke="#a2d8ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></g>)}
     <path d={orderedPath} fill="none" stroke="#168cf0" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
     {points.map((p,i)=><g key={p.date} onMouseEnter={()=>setHovered(i)} onMouseLeave={()=>setHovered(null)} onFocus={()=>setHovered(i)} onBlur={()=>setHovered(null)}
       onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelectedRange(old=>old&&old[0]===old[1]?[old[0],p.date]:[p.date,p.date]);}}}
       tabIndex={0} role="button" aria-label={`${fmtDay(p.date)}: заказано ${p.ordered_units}, доставлено ${p.delivered_units??'нет данных'}. Нажмите Enter для выбора даты или окончания диапазона.`}>
      <rect x={x(i)-plotWidth/Math.max(1,points.length-1)/2} y={top} width={plotWidth/Math.max(1,points.length-1)} height={plotHeight+12} fill="transparent"/>
      {hovered===i&&<line x1={x(i)} x2={x(i)} y1={top} y2={top+plotHeight} stroke="#abc8df" strokeDasharray="3 4"/>}
      <circle cx={x(i)} cy={y(p.ordered_units)} r={hovered===i?5:4} fill="#fff" stroke="#168cf0" strokeWidth="2.5"/>
      {p.delivered_units!==null&&p.delivered_units!==undefined&&<circle cx={x(i)} cy={y(p.delivered_units)} r={hovered===i?4:2.5} fill="#a2d8ff" stroke="#fff" strokeWidth="1.5"/>}
     </g>)}
     {tickIndexes.map(i=><g key={i}><text x={x(i)} y={height-17} textAnchor={i===0?'start':i===points.length-1?'end':'middle'} fontSize="11" fill="#53667d">{fmtTick(points[i]?.date)}</text>{fmtWeekday(points[i].date)&&<text x={x(i)} y={height-3} textAnchor="middle" fontSize="9" fill="#9daabb">{fmtWeekday(points[i].date)}</text>}</g>)}
    </svg>
   </div>
    {selectedTotal&&<div className="sales-range-summary" role="status" aria-live="polite">
     <span className="sales-range-dates">{fmtRangeDate(selectedTotal.from)} — {fmtRangeDate(selectedTotal.to)} · {selectedTotal.days} дн.</span>
     <span>Заказано: <strong>{num(selectedTotal.orderedUnits)} шт.</strong></span>
     <span>На сумму: <strong>{num(selectedTotal.orderedAmount)} ₽</strong></span>
     {selectedTotal.deliveredKnownDays>0&&<span>Доставлено: <strong>{num(selectedTotal.deliveredUnits)} шт.</strong>{!selectedTotal.deliveryComplete&&<small> (неполные данные)</small>}</span>}
     <button type="button" onClick={()=>setSelectedRange(null)}>Сбросить выделение</button>
    </div>}
  </>}
 </section>
}
function InventoryHistoryChart({data,inv}){
 const [period,setPeriod]=useState(30);const [sku,setSku]=useState('all');
 const days=(data?.days||[]).slice(-period);
 const skuNames=new Map((inv?.products||[]).map(p=>[String(p.sku),p.name||String(p.sku)]));
 const skuValues=[...new Set((data?.days||[]).flatMap(day=>(day.aggregated||[]).map(row=>String(row.sku))))].sort();
 const points=days.map(day=>{
  const row=sku==='all'?day.summary:(day.aggregated||[]).find(item=>String(item.sku)===sku);
  return {date:day.date,available:row?.available??null,preparing:row?.preparing??null,transit:row?.transit??null};
 });
 const series=[{key:'available',label:'Доступно к продаже',stroke:'#287b58'},{key:'preparing',label:'Готовится к продаже',stroke:'#d49a32'},{key:'transit',label:'В пути на Ozon',stroke:'#4284c5'}];
 const max=Math.max(1,...points.flatMap(point=>series.map(item=>point[item.key]).filter(value=>typeof value==='number'&&Number.isFinite(value))));
 const width=960,height=290,left=58,right=22,top=18,bottom=42,plotWidth=width-left-right,plotHeight=height-top-bottom;
 const x=index=>left+(points.length<=1?plotWidth/2:index*plotWidth/(points.length-1));
 const y=value=>top+plotHeight-(value/max)*plotHeight;
 const dayGap=(first,last)=>(Date.parse(last+'T00:00:00Z')-Date.parse(first+'T00:00:00Z'))/86400000;
 const segments=key=>{
  const output=[];let current=[];let previousDate=null;
  for(let index=0;index<points.length;index++){
   const point=points[index],value=point[key];
   if(value===null||value===undefined||!Number.isFinite(value)){
    if(current.length)output.push(current);current=[];previousDate=point.date;continue;
   }
   if(previousDate&&dayGap(previousDate,point.date)>1){if(current.length)output.push(current);current=[];}
   current.push({x:x(index),y:y(value),value,date:point.date,index});
   previousDate=point.date;
  }
  if(current.length)output.push(current);
  return output;
 };
 const hasValues=points.some(point=>series.some(item=>typeof point[item.key]==='number'&&Number.isFinite(point[item.key])));
 const tickIndexes=[...new Set([0,Math.floor((points.length-1)/2),points.length-1])].filter(index=>index>=0);
 return <section className="panel stock-history-chart">
  <div className="panel-title"><div><h3>Динамика остатков FBO</h3><p className="muted mt-2">История фактических снимков из Ozon Seller API</p></div>
   <div className="flex gap-2"><select aria-label="Товар для графика" value={sku} onChange={e=>setSku(e.target.value)}><option value="all">Все товары</option>{skuValues.map(value=><option key={value} value={value}>{skuNames.get(value)||('SKU '+value)}</option>)}</select><select aria-label="Период графика" value={period} onChange={e=>setPeriod(Number(e.target.value))}><option value={7}>7 дней</option><option value={30}>30 дней</option><option value={90}>90 дней</option></select></div>
  </div>
  {!hasValues?<Empty text="Истории остатков пока недостаточно" help="График появится после успешных обновлений остатков. Система не дорисовывает значения за дни без снимков."/>:<>
   <div className="stock-history-legend">{series.map(item=><span key={item.key}><i style={{background:item.stroke}}/>{item.label}</span>)}</div>
   <div className="stock-history-svg-wrap"><svg className="stock-history-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="История остатков по выбранному товару">
    {[0,.25,.5,.75,1].map(fraction=><g key={fraction}><line x1={left} x2={width-right} y1={top+plotHeight*(1-fraction)} y2={top+plotHeight*(1-fraction)} stroke="#e8eeea" strokeWidth="1"/><text x={left-10} y={top+plotHeight*(1-fraction)+4} textAnchor="end" fontSize="11" fill="#829087">{Math.round(max*fraction).toLocaleString('ru-RU')}</text></g>)}
    {series.map(item=>segments(item.key).map((segment,index)=><polyline key={item.key+'-'+index} fill="none" stroke={item.stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={segment.map(point=>point.x+','+point.y).join(' ')}/>))}
    {points.map((point,index)=>series.map(item=>{const value=point[item.key];return typeof value==='number'&&Number.isFinite(value)?<circle key={item.key+'-'+point.date} cx={x(index)} cy={y(value)} r="4" fill={item.stroke} stroke="#fff" strokeWidth="2"><title>{point.date} · {item.label}: {num(value)}</title></circle>:null;}))}
    {tickIndexes.map(index=><text key={index} x={x(index)} y={height-12} textAnchor={index===0?'start':index===points.length-1?'end':'middle'} fontSize="11" fill="#829087">{points[index]?.date?.slice(5).split('-').reverse().join('.')}</text>)}
   </svg></div>
  </>}
  <p className="muted mt-3">Точка — последнее успешное обновление за календарный день по Москве. Если обновлений не было, на графике остаётся разрыв: значения не интерполируются.</p>
 </section>
}
function ProductCatalog(){
 const {inv,me}=useApp();
 const [q,setQ]=useState('');
 const [selected,setSelected]=useState(null);
 useEffect(()=>setSelected(null),[me?.active_account_id]);
 // SKU остаётся скрытым в интерфейсе, но используется как идентификатор карточки в URL Ozon.
 const rows=(inv?.products||[]).filter(p=>[p.name,p.offer_id,p.id].join(' ').toLowerCase().includes(q.toLowerCase()));
 return <><section className="panel">
  <div className="panel-title"><h3>Каталог товаров</h3><span className="badge">{rows.length} карточек</span></div>
  <Filter value={q} set={setQ} placeholder="Поиск по названию, артикулу или коду товара"/>
  <Table rows={rows} onRowClick={setSelected} columns={[
   ["name","Название"],
   ["id","Артикул",(value,row)=>row.sku
    ? <a href={`https://www.ozon.ru/product/${encodeURIComponent(String(row.sku))}/`}
         target="_blank" rel="noopener noreferrer"
         className="font-medium text-emerald-800 hover:underline"
         onClick={event=>event.stopPropagation()}
         title="Открыть карточку товара на Ozon">{value||'—'}</a>
    : (value||'—')]
  ]}/>
 </section>
 {selected&&<ProductDetails key={selected.id} product={selected} onClose={()=>setSelected(null)}/>}
 </>;
}
function Stocks(){
 const {inv,stockHistory}=useApp();const [q,setQ]=useState('');const [raw,setRaw]=useState(false);const [only,setOnly]=useState(true);
 const warehouseNames=new Map((inv?.analytics||[]).map(r=>[String(r.warehouse_id),r.warehouse_name]));
 const source=raw?(inv?.stocks||[]).map(r=>({...r,warehouse_name:warehouseNames.get(String(r.warehouse_id))})):(inv?.analytics||[]);
 const groups=groupStocks(inv?.products||[],source,raw);
 const shown=groups.map(g=>({...g,visible:g.rows.filter(r=>!only||(raw?r.present>0||r.reserved>0:r.available_stock_count>0))}))
  .filter(g=>g.visible.length&&[g.name,g.offer,...g.skus,...g.visible.map(r=>`${r.warehouse_name||''} ${r.warehouse_id}`)].join(' ').toLowerCase().includes(q.toLowerCase()));
 const productNames=new Map((inv?.products||[]).map(p=>[String(p.sku),p.name]));
 const fbsRows=(inv?.fbs_stocks||[]).map(row=>({...row,product_name:productNames.get(String(row.sku))||row.name||'Товар'}));
 return <div className="flex flex-col gap-5"><section className="panel"><div className="panel-title"><h3>Остатки FBO</h3><div className="segmented"><button className={!raw?'selected':''} onClick={()=>setRaw(false)}>Доступные остатки</button><button className={raw?'selected':''} onClick={()=>setRaw(true)}>Учёт и резервы</button></div></div>
 <div className="filters"><Filter value={q} set={setQ}/><label className="check"><input type="checkbox" checked={only} onChange={e=>setOnly(e.target.checked)}/> Только склады с остатком</label></div>
 {!raw&&inv?.analytics===null?<Empty text="Остатки пока недоступны" help="Обновите данные. Если загрузка не удаётся, проверьте разрешение на чтение аналитики у ключа Ozon."/>:!shown.length?<Empty text="Карточки не найдены" help="Проверьте загрузку, поиск и фильтр остатков."/>:<div className="fbo-stock-list">{shown.map(g=><details className="stock-card" key={g.key}><summary><div className="stock-title"><strong>{g.name}</strong><span className="sku">SKU {g.skus.join(', ')}</span><small>Артикул: {g.offer}</small></div><div className="stock-total"><strong>{num(g.total)} <small>ед.</small></strong><span>{raw?'На складах':'Доступно к продаже'}</span></div><span className="expand-arrow">⌄</span></summary><div className="stock-details">{raw&&<p className="muted mb-4">Учётное количество и резерв показаны раздельно. Доступное к продаже количество находится на вкладке «Доступные остатки».</p>}<Table rows={g.visible} columns={raw?[["warehouse_name","Склад",(v,r)=><span>{v||'Склад Ozon'} <small>· ID {r.warehouse_id}</small></span>],["present","На складе, ед.",num],["reserved","В резерве, ед.",num]]:[["warehouse_name","Склад",(v,r)=><span>{v||'Склад Ozon'} <small>· ID {r.warehouse_id}</small></span>],["available_stock_count","Доступно, ед.",num],["valid_stock_count","Готовится к продаже, ед.",num],["transit_stock_count","В пути на Ozon, ед.",num],["requested_stock_count","В заявках, ед.",num],["inbound_replenishment","В перемещении, ед.",num],["stock_not_being_sold","Снято с продажи, ед.",num]]}/></div></details>)}</div>}
 </section>
 <section className="panel">
  <div className="panel-title"><h3>Остатки FBS</h3><span className="badge">{inv?.fbs_stock_quantity===null||inv?.fbs_stock_quantity===undefined?'Не загружены':num(inv.fbs_stock_quantity)+' свободных ед.'}</span></div>
  {inv?.fbs_stock_error&&<Notice>Не удалось получить FBS-остатки: {inv.fbs_stock_error}</Notice>}
  {fbsRows.length?<Table rows={fbsRows} columns={[["product_name","Товар"],["offer_id","Артикул"],["sku","SKU"],["warehouse_name","Склад",(v)=><span>{v||'Склад продавца'}</span>],["free_stock","Свободно, ед.",num],["present","На складе, ед.",num],["reserved","В резерве, ед.",num]]}/>:<Empty text={inv?.fbs_stock_quantity===0?'Свободных остатков FBS нет':'Остатки FBS пока не загружены'} help="FBS-остатки запрашиваются отдельно от FBO при обновлении данных кабинета."/>}
 </section>
 <InventoryHistoryChart data={stockHistory} inv={inv}/>
 <History/></div>
}
function History(){
 const {hist,state,act}=useApp();
 const [days,setDays]=useState(90);const [q,setQ]=useState('');const [status,setStatus]=useState('');const [scheme,setScheme]=useState('all');
 const postings=hist?.postings||[];
 const scoped=postings.filter(p=>scheme==='all'||String(p.scheme||'FBO').toUpperCase()===scheme);
 const rows=scoped.filter(p=>String(p.number||'').includes(q)&&(!status||p.status===status)).map(p=>({
  ...p,scheme:p.scheme||'FBO',event_date:p.created_at||p.in_process_at,
  units:(p.products||[]).reduce((n,r)=>n+Number(r.quantity||0),0),
  items:(p.products||[]).map(r=>`${r.offer_id||r.sku} × ${r.quantity}`).join('; ')
 }));
 const counts=hist?.counts||{
  fbo:postings.filter(p=>(p.scheme||'FBO')==='FBO').length,
  fbs:postings.filter(p=>p.scheme==='FBS').length
 };
 const statuses=[...new Set(scoped.map(p=>p.status).filter(Boolean))].sort();
 return <section className="panel">
  <div className="panel-title"><div><h3>История отправлений Ozon</h3><p className="muted mt-2">FBO: {num(counts.fbo)} · FBS: {num(counts.fbs)}</p></div>
   <div className="flex gap-2"><select aria-label="Период загрузки" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={30}>30 дней</option><option value={90}>90 дней</option><option value={180}>180 дней</option><option value={365}>365 дней</option></select><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/history/sync',{days})}>Обновить историю</button></div>
  </div>
  <p className="muted mb-4">Последняя проверка: {date(hist?.at)}{hist?.since&&` · охват ${date(hist.since)} — ${date(hist.to)}`}</p>
  {hist?.errors?.length>0&&<Notice>Не все данные удалось обновить: {hist.errors.join('; ')}. Ранее сохранённая история оставлена.</Notice>}
  <div className="filters">
   <Filter value={q} set={setQ} placeholder="Номер отправления"/>
   <select aria-label="Схема отправления" value={scheme} onChange={e=>{setScheme(e.target.value);setStatus('');}}><option value="all">FBO и FBS</option><option value="FBO">Только FBO</option><option value="FBS">Только FBS</option></select>
   <select aria-label="Статус" value={status} onChange={e=>setStatus(e.target.value)}><option value="">Все статусы</option>{statuses.map(value=><option key={value} value={value}>{statusLabel(value)}</option>)}</select>
  </div>
  <div className="fbo-history-table"><Table rows={rows} pageSize={8} columns={[["scheme","Схема",v=>v],["number","Отправление"],["event_date","Создано / обработка",v=>date(v)],["status","Статус",statusLabel],["substatus","Подстатус",v=>v||'—'],["warehouse_name","Склад",v=>v||'—'],["items","Состав"],["units","Единиц",num]]}/></div>
 </section>
}
function LoginScreen({onSuccess}){
 const [username,setUsername]=useState('');const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [initialized,setInitialized]=useState(null);
 useEffect(()=>{api('/auth/status').then(x=>setInitialized(x.initialized)).catch(()=>setInitialized(null))},[]);
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{username:username.trim(),password});setPassword('');await onSuccess()}catch(err){setError(err.message)}finally{setBusy(false)}}
 return <div className="auth-screen"><form className="auth-card" onSubmit={submit}>
  <div className="auth-logo"><div className="brand-icon"><Boxes size={26}/></div><div><strong>ИСК</strong><span>Интеллектуальная система контроля</span></div></div>
  <h1>Вход в систему</h1><p className="muted">Введите учётные данные, выданные администратором.</p>
  {error&&<div className="notice" role="alert">{error}</div>}
  <label className="field">Логин<input autoComplete="username" required minLength={3} maxLength={32} value={username} onChange={e=>setUsername(e.target.value)}/></label>
  <label className="field mt-4">Пароль<input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={e=>setPassword(e.target.value)}/></label>
  <button className="primary mt-5 w-full" disabled={busy}>{busy?'Входим…':'Войти'}<ArrowRight size={16}/></button>
  {initialized===false&&<div className="notice mt-4">Первый администратор ещё не создан. На сервере выполните: <code>docker compose exec isk python -m backend.admin create-admin --username admin</code></div>}
  <p className="auth-foot">Регистрация открыта только администраторам. Сессия действует 30 дней.</p>
 </form></div>
}
function Connection(){
 const {state,me,reload,setError}=useApp();const [client,setClient]=useState('');const [key,setKey]=useState('');
 const [busy,setBusy]=useState(false);const navigate=useNavigate();const accounts=me?.accounts||[];
 async function connect(e){e.preventDefault();setBusy(true);setError('');try{await api('/connect',{client_id:client.trim(),api_key:key.trim()});setKey('');await reload();navigate('/')}catch(err){setError(err.message)}finally{setBusy(false)}}
 async function select(id){setBusy(true);try{await api('/accounts/select',{account_id:id});await reload();navigate('/')}catch(err){setError(err.message)}finally{setBusy(false)}}
 async function disconnect(){setBusy(true);try{await api('/disconnect',{});await reload()}catch(err){setError(err.message)}finally{setBusy(false)}}
 const active=accounts.find(a=>a.id===me?.active_account_id);
 return <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
  <section className="panel"><div className="panel-title"><h3>Мои кабинеты Ozon</h3><Plug size={20}/></div>
   {!accounts.length&&<p className="muted">Пока нет подключённых кабинетов. Добавьте первый кабинет — ключ сохранится в зашифрованном виде и не потеряется после перезапуска сервера.</p>}
   <div className="account-list">{accounts.map(a=><div className="account-row" key={a.id}>
    <div><strong>Кабинет {a.client_id}</strong><span className={a.connected?'connected-label':'disconnected-label'}>{a.connected?'Подключён':'Ключ удалён'}</span><small>{a.roles?.join(', ')||'Роли не сохранены'}</small></div>
    <div className="account-actions">{a.connected&&<button className={me.active_account_id===a.id?'primary':''} disabled={busy||me.active_account_id===a.id} onClick={()=>select(a.id)}>{me.active_account_id===a.id?'Выбран':'Выбрать'}</button>}</div>
   </div>)}</div>
   {active&&state&&<><div className="connected mt-4"><CircleCheck size={22}/><strong>Активный кабинет {state.client_id}</strong></div><p className="muted mt-2">Срок ключа Ozon: {date(state.expires_at)}</p><button className="mt-4" disabled={busy||state.job.running} onClick={disconnect}><LogOut size={16}/> Удалить сохранённый ключ</button></>}
  </section>
  <section className="panel"><div className="panel-title"><h3>Добавить / обновить кабинет</h3><Plus size={20}/></div>
   <form onSubmit={connect}><label className="field">Идентификатор кабинета<input autoComplete="off" inputMode="numeric" pattern="[0-9]+" required value={client} onChange={e=>setClient(e.target.value)}/></label>
    <label className="field mt-4">Ключ API<input autoComplete="new-password" type="password" required minLength={10} value={key} onChange={e=>setKey(e.target.value)}/></label>
    <button className="primary mt-5" disabled={busy}>{busy?'Проверяем доступ…':'Сохранить подключение'}<ArrowRight size={16}/></button>
   </form>
   
  </section>
 </div>
}
function Logs(){const {state}=useApp();return <section className="panel"><div className="panel-title"><h3>Журнал текущего подключения</h3><span className="badge">Текущее подключение</span></div><Table rows={[...(state?.logs||[])].reverse()} columns={[["at","Время"],["message","Событие"]]}/></section>}
function AdminUsers(){
 const [users,setUsers]=useState([]);const [username,setUsername]=useState('');const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 async function load(){try{const data=await api('/admin/users');setUsers(data.users||[])}catch(e){setError(e.message)}}
 useEffect(()=>{load()},[]);
 async function create(e){e.preventDefault();setBusy(true);setError('');setMessage('');try{await api('/admin/users',{username:username.trim(),password});setUsername('');setPassword('');setMessage('Пользователь создан. Передайте ему логин и пароль безопасным способом.');await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function toggle(user){setBusy(true);setError('');try{await api('/admin/users/'+user.id+'/status',{active:!user.is_active});await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
  <section className="panel"><div className="panel-title"><h3>Создать пользователя</h3><Users size={20}/></div>
   <form onSubmit={create}><label className="field">Логин<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" value={username} onChange={e=>setUsername(e.target.value)}/></label>
    <label className="field mt-4">Временный пароль (от 12 символов)<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label>
    <button className="primary mt-5" disabled={busy}>{busy?'Создаём…':'Создать пользователя'}<Plus size={16}/></button>
   </form>
   {error&&<div className="notice mt-4">{error}</div>}{message&&<div className="success-note mt-4">{message}</div>}
   <p className="muted mt-4">Новые пользователи получают обычные права. Администратор создаётся только через серверную команду.</p>
  </section>
  <section className="panel"><div className="panel-title"><h3>Пользователи ИСК</h3><ShieldCheck size={20}/></div>
   <div className="admin-user-list">{users.map(u=><div className="admin-user-row" key={u.id}><div><strong>{u.username}</strong><small>{u.role==='admin'?'Администратор':'Пользователь'} · {u.is_active?'Активен':'Отключён'}</small></div>{u.role!=='admin'&&<button disabled={busy} onClick={()=>toggle(u)}>{u.is_active?'Отключить':'Включить'}</button>}</div>)}</div>
  </section>
 </div>
}
const nav=[['/','Обзор',LayoutDashboard],['/digitization','Оцифровка',BarChart3],['/barcodes','Штрихкоды',Barcode],['/market-calculator','Калькулятор WB / Ozon',Calculator],['/stocks','Остатки и история Ozon',Warehouse],['/replenishment','Прогноз пополнения',Calculator],['/connection','Мои кабинеты',Plug]];
function RequireAccount({children}){const {me}=useApp();return me?.active_account_id?children:<Navigate to="/connection" replace/>}
function App(){
 const [me,setMe]=useState(null);const [state,setState]=useState(null);const [inv,setInv]=useState(null);const [hist,setHist]=useState(null);const [digi,setDigi]=useState(null);const [stockHistory,setStockHistory]=useState(null);const [sales,setSales]=useState(null);
 const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [authChecked,setAuthChecked]=useState(false);const wasRunning=useRef(false);
 async function loadData(){const first=moscowDate(89),last=moscowDate(0);const [i,h,d,sh,sa]=await Promise.all([api('/inventory'),api('/history'),api('/digitization'),api('/inventory/history?date_from='+first+'&date_to='+last),api('/sales')]);setInv(i);setHist(h);setDigi(d);setStockHistory(sh);setSales(sa)}
 function clearData(){setState(null);setInv(null);setHist(null);setDigi(null);setStockHistory(null);setSales(null)}
 async function reload(){
  try{const auth=await api('/auth/me');setMe(auth);
   if(auth.active_account_id){const first=moscowDate(89),last=moscowDate(0);const [s,i,h,d,sh,sa]=await Promise.all([api('/state'),api('/inventory'),api('/history'),api('/digitization'),api('/inventory/history?date_from='+first+'&date_to='+last),api('/sales')]);setState(s);setInv(i);setHist(h);setDigi(d);setStockHistory(sh);setSales(sa)}
   else clearData();
  }catch(e){if(e.status===401){setMe(null);clearData()}else if(e.status!==409)setError(e.message)}
  finally{setAuthChecked(true);setLoading(false)}
 }
 useEffect(()=>{reload()},[]);
 useEffect(()=>{
  if(!me?.active_account_id)return;
  const timer=setInterval(async()=>{try{const s=await api('/state');setState(s);if(wasRunning.current&&!s.job.running)await loadData();wasRunning.current=s.job.running}
   catch(e){if(e.status===401){setMe(null);clearData()}else if(e.status===409)await reload();else setError(e.message)}},1500);
  return()=>clearInterval(timer);
 },[me?.active_account_id]);
 async function act(path,body){setError('');try{await api(path,body);wasRunning.current=true;setState(s=>({...s,job:{...s.job,running:true,message:'Запускаем загрузку…',error:null}}))}catch(e){setError(e.message)}}
 async function logout(){try{await api('/auth/logout',{})}finally{setMe(null);clearData()}}
 if(!authChecked||loading)return <div className="auth-screen"><div className="auth-card">Загружаем ИСК…</div></div>;
 if(!me)return <LoginScreen onSuccess={reload}/>;
 const navItems=me.user.role==='admin'?[...nav,['/admin/users','Пользователи',Users]]:nav;
 return <Context.Provider value={{me,state,setState,inv,hist,digi,stockHistory,sales,reload,act,setError}}>
  <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-icon"><Boxes size={25}/></div><div className="isk-brand">ИСК</div></div>
   <nav>{navItems.map(([path,label,Icon])=><NavLink key={path} to={path} end={path==='/'} className={({isActive})=>'nav-item '+(isActive?'active':'')}><Icon size={19}/>{label}</NavLink>)}</nav>
   <div className="sidebar-footer"><span className="status-dot"/>{me.user.username}</div>
  </aside><main><header><div className="header-actions" style={{marginLeft:"auto"}}><NavLink to="/connection" className="account"><span className={'status-dot '+(!state?'offline':'')}/>{state?('Кабинет '+state.client_id):'Выбрать кабинет'}</NavLink><button className="logout-button" onClick={logout}><LogOut size={16}/> Выйти</button></div></header>
   <div className="workspace">
    {error&&<div role="alert"><Notice>{error}<button className="ml-3" onClick={()=>setError('')}>Закрыть</button></Notice></div>}
    {state?.job.running&&<div className="progress"><RefreshCw size={17} className="animate-spin"/>{state.job.message}</div>}{state?.job.error&&<Notice>{state.job.error}</Notice>}
    <Routes>
     <Route path="/connection" element={<Connection/>}/>
     <Route path="/admin/users" element={me.user.role==='admin'?<AdminUsers/>:<Navigate to="/" replace/>}/>
     <Route path="/" element={<RequireAccount><Overview/></RequireAccount>}/>
     <Route path="/digitization" element={<RequireAccount><DigitizationCached state={state} digi={digi} act={act}/></RequireAccount>}/>
     <Route path="/barcodes" element={<BarcodeGenerator/>}/>
     <Route path="/market-calculator" element={<RequireAccount><MarketPage userId={me.user.id} isAdmin={me.user.role==='admin'}/></RequireAccount>}/>
     <Route path="/products" element={<Navigate to="/" replace/>}/>
     <Route path="/stocks" element={<RequireAccount><Stocks/></RequireAccount>}/>
     <Route path="/history" element={<Navigate to="/stocks" replace/>}/>
     <Route path="/replenishment" element={<RequireAccount><Replenishment inv={inv} hist={hist} api={api}/></RequireAccount>}/>
     <Route path="/plan" element={<Navigate to="/replenishment" replace/>}/><Route path="/forecast" element={<Navigate to="/replenishment" replace/>}/>
     <Route path="/logs" element={<RequireAccount><Logs/></RequireAccount>}/><Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes>
   </div></main>
  </div>
 </Context.Provider>
}
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);

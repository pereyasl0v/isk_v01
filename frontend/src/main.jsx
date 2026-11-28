import ScrollTable from "./ScrollTable";
import React, {useEffect, useState, createContext, useContext, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, NavLink, Routes, Route, Navigate, useLocation, useNavigate} from 'react-router-dom';
import {Boxes, LayoutDashboard, Package, Warehouse, Truck, Calculator, Plug, ListChecks, RefreshCw, ArrowUpRight, Search, Download, CircleCheck, AlertCircle, ArrowRight, LogOut, BarChart3, Plus, Users, ShieldCheck, Barcode, Menu, X, Clock3, ChevronDown} from 'lucide-react';
import './style.css';
import Replenishment from './Replenishment';
import MarketPage from './market';
import PurchaseShipments from './market/PurchaseShipments';
import DigitizationCached from './DigitizationCached';
import ProductDetails from './ProductDetails';
import BarcodeGenerator from './BarcodeGenerator';
import {statusLabel,roleLabel,groupStocks} from './presentation';
import {salesChartWindow,salesRangeTotals,salesTickIndexes,salesSelectionWindow,postingsForSalesSelection} from './sales-chart-range.mjs';
import {shipmentStatusSummary} from './shipment-status-summary.mjs';
import OzonRetryStatus from './OzonRetryStatus';
import {isOzonRetryWaiting} from './ozon-retry-status.mjs';
import {statePollDelay,keepUnchangedState} from './state-polling.mjs';
import './accountMarketplace.css';
import './mobile.css';

const Context=createContext(null);
const SALES_REFRESH_INTERVAL=10*60*1000;
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const num=v=>v===null||v===undefined?'—':nf.format(v);
const date=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
async function api(path,body){
 const r=await fetch('/api'+path,{credentials:'same-origin',method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Local-App':'fbo'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json(); if(!r.ok){const e=new Error(data.detail||'Запрос не выполнен');e.status=r.status;throw e;}return data;
}
function useApp(){return useContext(Context)}
function Notice({children}){return <div className="notice"><AlertCircle size={18}/><span>{children}</span></div>}
function Empty({text='Пока нет данных',help='Подключите кабинет и выполните загрузку.'}){return <div className="empty"><Boxes size={34}/><h3>{text}</h3><p>{help}</p></div>}
function Table({columns,rows,empty='Нет строк для отображения',onRowClick,pageSize=30,label="Таблица",showPaginationSummary=true}){
 const [page,setPage]=useState(0);const pages=Math.ceil(rows.length/pageSize);const safe=Math.min(page,Math.max(pages-1,0));
 return <><ScrollTable label={label} stickyColumn={columns.length > 4}><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.slice(safe*pageSize,safe*pageSize+pageSize).map((r,i)=><tr key={i} {...(onRowClick?{className:"product-clickable-row",role:"button",tabIndex:0,onClick:()=>onRowClick(r),onKeyDown:e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onRowClick(r)}}}:{})}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></ScrollTable>{!rows.length?<Empty text={empty} help="Проверьте загрузку и выбранные фильтры."/>:<div className="pagination">{showPaginationSummary==='pages'?<span aria-live="polite">Страница {safe+1} из {pages}</span>:showPaginationSummary&&<span>{num(rows.length)} строк · страница {safe+1} из {pages}</span>}<div><button disabled={safe===0} onClick={()=>setPage(safe-1)}>Назад</button><button disabled={safe>=pages-1} onClick={()=>setPage(safe+1)}>Далее</button></div></div>}</>
}
function Filter({value,set,placeholder='Поиск по названию, артикулу или SKU'}){return <label className="search"><Search size={17}/><input aria-label="Поиск" value={value} onChange={e=>set(e.target.value)} placeholder={placeholder}/></label>}
function Card({label,value,note,icon:Icon=Package,to}){
 const contents=<><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{num(value)}</strong><small>{note}</small></>;
 return to
  ? <NavLink to={to} className="metric metric-link" aria-label={`Открыть каталог товаров (${num(value)} карточек)`}>{contents}</NavLink>
  : <div className="metric">{contents}</div>;
}
function Overview(){
 const {inv,state,act,sales}=useApp();const s=inv?.summary;
 const [period,setPeriod]=useState(14);
 const [sku,setSku]=useState('all');
 const [selectedRange,setSelectedRange]=useState(null);
 const chartWindow=salesChartWindow(sales?.rows,period);
 const historyWindow=salesSelectionWindow(chartWindow,selectedRange);
 return <><div className="overview-heading"><div><h1>Обзор кабинета</h1><p className="muted mt-2">Продажи и остатки Ozon</p></div></div>
 <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6 overview-metrics"><Card label="Доступно к продаже FBO" value={s?.available} note="Единиц" icon={Boxes}/><Card label="Готовится к продаже" value={s?.preparing} note="Единиц"/><Card label="В пути на Ozon" value={s?.transit} note="Единиц" icon={Truck}/><Card label="Товары" value={s?.products} note="Карточек" to="/products"/></div>
 <SalesHistoryChart data={sales} state={state} act={act} inv={inv} period={period} setPeriod={setPeriod} chartWindow={chartWindow}
  sku={sku} setSku={setSku} selectedRange={selectedRange} setSelectedRange={setSelectedRange}/>
 {inv?.warning&&<Notice>{inv.warning}</Notice>}
 <div className="mt-5"><History chartWindow={historyWindow} sku={sku} inv={inv}/></div></>
}
function SalesHistoryChart({data,state,act,inv,period,setPeriod,chartWindow,sku,setSku,selectedRange,setSelectedRange}){
 const [hovered,setHovered]=useState(null);
 const selectionStart=useRef(null);
 const [chartWidth,setChartWidth]=useState(960);
 const chartRef=useRef(null);
 const pendingPeriodSync=useRef(null);
 const refreshSales=useRef(null);
 const allPoints=chartWindow.points;
 refreshSales.current=backfill=>{
  if(document.hidden)return;
  backfill=backfill&&!chartWindow.complete;
  if(state?.job?.running){
   pendingPeriodSync.current=backfill||Boolean(pendingPeriodSync.current);
   return;
  }
  pendingPeriodSync.current=null;
  act('/sales/sync',{days:period,backfill});
 };
 useEffect(()=>{
  pendingPeriodSync.current=null;
  refreshSales.current(true);
 },[period]);
 useEffect(()=>{
  const checkMissingDays=()=>refreshSales.current(true);
  const timer=setInterval(()=>refreshSales.current(false),SALES_REFRESH_INTERVAL);
  document.addEventListener('visibilitychange',checkMissingDays);
  return ()=>{
   clearInterval(timer);
   document.removeEventListener('visibilitychange',checkMissingDays);
  };
 },[]);
 useEffect(()=>{
  if(!state?.job?.running&&pendingPeriodSync.current!==null)refreshSales.current(pendingPeriodSync.current);
 },[state?.job?.running]);
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
 const hasPoints=points.length>0;
 useEffect(()=>{
  if(!hasPoints)return;
  const chart=chartRef.current;
  const observer=new ResizeObserver(([entry])=>setChartWidth(Math.round(entry.contentRect.width)||960));
  observer.observe(chart);
  return()=>observer.disconnect();
 },[hasPoints]);
 const values=points.flatMap(p=>[Number(p.ordered_units||0),...(data?.delivered_available&&p.delivered_units!==null?[Number(p.delivered_units)]:[])]);
 const max=Math.max(5,Math.ceil(Math.max(1,...values)/5)*5);
 const min=Math.min(0,Math.floor(Math.min(0,...values)/5)*5);
 const compactChart=chartWidth<710;
 const width=compactChart?chartWidth:960;
 const height=compactChart?206:235,left=14,right=37,top=24,bottom=38,plotWidth=width-left-right,plotHeight=height-top-bottom;
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
 const tickIndexes=salesTickIndexes(points.length,compactChart?Math.max(2,Math.floor(plotWidth/42)):14);
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
  if(!points.length||!event.isPrimary||(event.pointerType==='mouse'&&event.button!==0))return;
  const bounds=event.currentTarget.getBoundingClientRect();
  if(!bounds.height)return;
  const py=(event.clientY-bounds.top)/bounds.height*height;
  if(py<top-8||py>top+plotHeight+12)return;
  const index=pointerIndex(event);
  selectionStart.current={index,pointerId:event.pointerId,previousRange:selectedRange};
  setSelectedRange([points[index].date,points[index].date]);
  event.currentTarget.setPointerCapture?.(event.pointerId);
 };
 const moveSelection=event=>{
  if(selectionStart.current?.pointerId!==event.pointerId)return;
  const index=pointerIndex(event);
  const start=points[selectionStart.current.index]?.date;
  if(start)setSelectedRange([start,points[index].date]);
  setHovered(index);
 };
 const finishSelection=event=>{
  if(selectionStart.current?.pointerId!==event.pointerId)return;
  const index=pointerIndex(event);
  const start=points[selectionStart.current.index]?.date;
  if(start)setSelectedRange([start,points[index].date]);
  selectionStart.current=null;
  setHovered(null);
  if(event.currentTarget.hasPointerCapture?.(event.pointerId)){
   event.currentTarget.releasePointerCapture(event.pointerId);
  }
 };
 return <section className="panel sales-chart">
  <div className="panel-title"><div><h3>Заказано товаров</h3></div>
   <div className="sales-chart-controls"><select aria-label="Товар для графика" value={sku} onChange={e=>{setSku(e.target.value);setHovered(null)}}><option value="all">Все товары</option>{skuOptions.map(value=><option key={value} value={value}>{skuNames.get(value)||('SKU '+value)}</option>)}</select><div className="segmented">{[7,14,30,90].map(value=><button key={value} className={period===value?'selected':''} onClick={()=>{setPeriod(value);setHovered(null);setSelectedRange(null);}}>{value} дн.</button>)}</div>
   </div>
  </div>
  {state?.job.running&&state.job.kind==='sales'&&<p role="status" className="muted">{state.job.message}</p>}
  {data?.error&&<Notice>{data.error}</Notice>}
  {!points.length?<Empty text="Дневная статистика пока не загружена" help="ИСК получает заказы и историю доставок из Ozon Seller API и Ozon Push."/>:<>
    <div className="sales-chart-legend"><span><i className="ordered"/>Заказано</span>{data?.delivered_available&&<span><i className="delivered"/>{data.delivery_label||'Доставлено'}</span>}<span className="sales-range-hint">Выделите период на графике для подсчёта итогов</span></div>
   <div className="sales-chart-wrap" ref={chartRef}>
    {hoveredPoint&&<div className="sales-chart-tooltip" style={{left:compactChart?"50%":`${Math.max(16,Math.min(84,x(hovered)/width*100))}%`}}>
     <strong>{fmtDay(hoveredPoint.date)}</strong>
     <div><span><i className="ordered"/>Заказано</span><b>{num(hoveredPoint.ordered_units)} шт. · {num(hoveredPoint.ordered_revenue)} ₽</b></div>
     {data?.delivered_available&&<div><span><i className="delivered"/>{data.delivery_label||'Доставлено'}</span><b>{hoveredPoint.delivered_units===null?'Нет данных':num(hoveredPoint.delivered_units)+' шт.'}{hoveredPoint.delivery_partial?' · неполные данные':''}</b></div>}
    </div>}
    <svg className="sales-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img"
     aria-label="График заказов по дням: проведите по графику для выбора диапазона"
     onPointerDown={startSelection} onPointerMove={moveSelection}
     onPointerUp={finishSelection} onPointerCancel={event=>{
      if(selectionStart.current?.pointerId!==event.pointerId)return;
      setSelectedRange(selectionStart.current.previousRange);
      selectionStart.current=null;
      setHovered(null);
     }}>
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
     <button type="button" className="sales-range-reset" onClick={()=>setSelectedRange(null)}>Сбросить интервал</button>
    </div>}
  </>}
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
  <Table label="Каталог товаров" rows={rows} onRowClick={setSelected} columns={[
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
const stockAvailableColumns=[["available_stock_count","Доступно, ед."]];
const stockRawColumns=[["present","На складе, ед."],["reserved","В резерве, ед."]];

function StockWarehouseList({rows,raw}){
 const [showAll,setShowAll]=useState(false);
 const columns=raw?stockRawColumns:stockAvailableColumns;
 const ordered=[...rows].sort((a,b)=>
  (Number(b[columns[0][0]])||0)-(Number(a[columns[0][0]])||0)||
  (a.warehouse_name||'').localeCompare(b.warehouse_name||'','ru'));
 const visible=showAll?ordered:ordered.slice(0,6);
 return <div className="stock-warehouse-list">
  <div className="stock-warehouse-heading">
   <strong>Остатки по складам</strong>
  </div>
  {raw&&<p className="stock-raw-note">Учётное количество и резерв показаны отдельно от доступного к продаже остатка.</p>}
  <ScrollTable label="Остатки по складам" stickyColumn={columns.length>3}>
   <table className={'stock-warehouse-table'+(columns.length>3?' stock-warehouse-wide':'')}>
    <thead><tr><th scope="col">Склад</th>{columns.map(([key,label])=><th scope="col" key={key}>{label}</th>)}</tr></thead>
    <tbody>{visible.map((r,i)=><tr key={String(r.warehouse_id)+':'+String(r.sku)+':'+i}>
     <td title={'ID '+r.warehouse_id}>{r.warehouse_name||('Склад Ozon · '+r.warehouse_id)}</td>
     {columns.map(([key])=><td key={key}>{num(r[key])}</td>)}
    </tr>)}</tbody>
   </table>
  </ScrollTable>
  {ordered.length>6&&<button type="button" className="stock-quiet-button stock-show-all" aria-expanded={showAll} onClick={()=>setShowAll(v=>!v)}>{showAll?'Свернуть список':'Показать все ('+num(ordered.length)+')'} <ChevronDown size={14} aria-hidden="true"/></button>}
 </div>;
}
function Stocks(){
 const {inv}=useApp();const [q,setQ]=useState('');const [raw,setRaw]=useState(false);const [only,setOnly]=useState(true);
 const products=inv?.products||[];
 const catalogById=new Map(products.filter(p=>p.id??p.product_id).map(p=>[String(p.id??p.product_id),p]));
 const warehouseNames=new Map((inv?.analytics||[]).map(r=>[String(r.warehouse_id),r.warehouse_name]));
 const source=raw?(inv?.stocks||[]).map(r=>({...r,warehouse_name:warehouseNames.get(String(r.warehouse_id))||r.warehouse_name})):(inv?.analytics||[]);
 const groups=groupStocks(products,source,raw);
 const query=q.trim().toLowerCase();
 const shown=groups.map(g=>{
  const product=catalogById.get(g.key);
  const rowIds=[...new Set(g.rows.map(r=>r.product_id).filter(v=>v!==null&&v!==undefined&&String(v)!=='0'&&String(v)!=='').map(String))];
  const article=product?.id??product?.product_id??(rowIds.length===1?rowIds[0]:null);
  return {...g,article,visible:g.rows.filter(r=>!only||(raw?r.present>0||r.reserved>0:r.available_stock_count>0))};
 }).filter(g=>g.visible.length&&[g.name,g.offer,g.article,...g.skus,...g.visible.map(r=>(r.warehouse_name||'')+' '+r.warehouse_id)].join(' ').toLowerCase().includes(query));
 return <section className="panel stock-panel">
  <div className="stock-page-heading">
   <div><h3>Остатки FBO</h3></div>
   <div className="stock-mode" role="group" aria-label="Вид остатков">
    <button type="button" aria-pressed={!raw} className={!raw?'selected':''} onClick={()=>setRaw(false)}>Доступные остатки</button>
    <button type="button" aria-pressed={raw} className={raw?'selected':''} onClick={()=>setRaw(true)}>Учёт и резервы</button>
   </div>
  </div>
  <div className="stock-page-controls">
   <Filter value={q} set={setQ} placeholder="Название, артикул или склад"/>
   <label className="check"><input type="checkbox" checked={only} onChange={e=>setOnly(e.target.checked)}/> {raw?'Только склады с остатком или резервом':'Только склады с доступным остатком'}</label>
  </div>
  {!raw&&inv?.analytics===null?<Empty text="Остатки пока недоступны" help="Обновите данные. Если загрузка не удаётся, проверьте разрешение на чтение аналитики у ключа Ozon."/>:!shown.length?<Empty text="Карточки не найдены" help="Проверьте загрузку, поиск и фильтр остатков."/>:
   <div className="fbo-stock-list">{shown.map(g=><details className="stock-product-card" key={g.key}>
    <summary className="stock-product-summary">
     <div className="stock-product-name"><strong>{g.name}</strong><span>Артикул: {g.article??'—'}</span></div>
     <div className="stock-product-total"><strong>{num(g.total)} <small>ед.</small></strong><span>{raw?'На складах':'Доступно к продаже'}</span></div>
     <div className="stock-product-warehouses"><strong>{num(new Set(g.visible.map(r=>String(r.warehouse_id))).size)}</strong><span>складов в списке</span></div>
     <ChevronDown className="stock-product-chevron" size={17} aria-hidden="true"/>
    </summary>
    <div className="stock-product-details"><StockWarehouseList key={String(raw)} rows={g.visible} raw={raw}/></div>
   </details>)}</div>}
 </section>
}
function History({chartWindow,sku,inv}){
 const {hist}=useApp();
 const [q,setQ]=useState('');const [status,setStatus]=useState('');const [scheme,setScheme]=useState('all');
 const [expandedStatuses,setExpandedStatuses]=useState(false);
 useEffect(()=>{
  setQ('');
  setStatus('');
  setScheme('all');
 },[chartWindow.from,chartWindow.to,sku]);
 const postings=postingsForSalesSelection(hist?.postings||[],chartWindow,sku,inv?.products||[]);
 const scoped=postings.filter(p=>scheme==='all'||String(p.scheme||'FBO').toUpperCase()===scheme);
 const rows=scoped.filter(p=>String(p.number||'').includes(q)&&(!status||p.status===status)).map(p=>({
  ...p,scheme:p.scheme||'FBO',event_date:p.created_at||p.in_process_at,
  units:(p.products||[]).reduce((n,r)=>n+Number(r.quantity||0),0),
  items:(p.products||[]).map(r=>`${r.offer_id||r.sku} × ${r.quantity}`).join('; ')
 }));
 const summary=shipmentStatusSummary(scoped);
 const statuses=[...new Set(scoped.map(p=>p.status).filter(Boolean))].sort();
 return <section className="panel">
  <div className="history-overview-header">
   <div className="history-overview-title">
    <h3>История отправлений Ozon</h3>
   </div>
   <aside className="history-status-preview" aria-label="Статусы отправлений за выбранный период">
    <div className="history-status-figures">
     {summary.preview.map(item=><div className="history-status-figure" key={item.key}>
      <span><i aria-hidden="true" style={{backgroundColor:item.color}}/>{item.label}</span>
      <strong>{num(item.count)}</strong>
     </div>)}
    </div>
    <button type="button" className="history-status-toggle"
     onClick={()=>setExpandedStatuses(value=>!value)}
     aria-expanded={expandedStatuses} aria-controls="history-status-expanded"
     title={expandedStatuses?'Свернуть диаграмму':'Развернуть диаграмму статусов'}>
     <span className="history-status-ring" style={{background:summary.gradient}} aria-hidden="true"><span>{num(summary.total)}</span></span>
     <span className="history-status-toggle-label">{expandedStatuses?'Свернуть':'Отправления'} <BarChart3 size={14}/></span>
    </button>
   </aside>
  </div>
  {expandedStatuses&&<section className="history-status-expanded" id="history-status-expanded" aria-label="Подробная диаграмма статусов">
   <div className="history-status-expanded-heading">
    <div><strong>Распределение статусов</strong></div>
    <span>Всего: {num(summary.total)}</span>
   </div>
   <div className="history-status-bars">
    {summary.items.map(item=><div className="history-status-bar-row" key={item.key}>
     <span className="history-status-bar-label"><i aria-hidden="true" style={{backgroundColor:item.color}}/>{item.label}</span>
     <div className="history-status-bar-track" aria-hidden="true"><div style={{width:item.percentage+'%',backgroundColor:item.color}}/></div>
     <span className="history-status-bar-value">{num(item.count)} <small>({item.percentage.toFixed(1)}%)</small></span>
    </div>)}
   </div>
   <p className="history-status-footnote">Диаграмма считает отправления, а не единицы товара. Отменённые отправления также включены. «Другие статусы» — ожидающие упаковки, отгрузки и прочие состояния.</p>
  </section>}
  {hist?.errors?.length>0&&<Notice>Не все данные удалось обновить: {hist.errors.join('; ')}. Ранее сохранённая история оставлена.</Notice>}
  <div className="filters">
   <Filter value={q} set={setQ} placeholder="Номер отправления"/>
   <select aria-label="Схема отправления" value={scheme} onChange={e=>{setScheme(e.target.value);setStatus('');}}><option value="all">FBO и FBS</option><option value="FBO">Только FBO</option><option value="FBS">Только FBS</option></select>
   <select aria-label="Статус" value={status} onChange={e=>setStatus(e.target.value)}><option value="">Все статусы</option>{statuses.map(value=><option key={value} value={value}>{statusLabel(value)}</option>)}</select>
  </div>
  <div className="fbo-history-table"><Table key={chartWindow.from+':'+chartWindow.to+':'+sku} label="История отправлений Ozon" rows={rows} pageSize={8} showPaginationSummary="pages" columns={[["scheme","Схема",v=>v],["number","Отправление"],["event_date","Создано / обработка",v=>date(v)],["status","Статус",statusLabel],["substatus","Подстатус",v=>v||'—'],["warehouse_name","Склад",v=>v||'—'],["items","Состав"],["units","Единиц",num]]}/></div>
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
 const {state,me,reload,setError}=useApp();
 const navigate=useNavigate();
 const accounts=me?.accounts||[];
 const active=accounts.find(a=>a.id===me?.active_account_id);
 const [client,setClient]=useState('');
 const [key,setKey]=useState('');
 const [busy,setBusy]=useState(false);
 const [formError,setFormError]=useState('');
 const [addMenuOpen,setAddMenuOpen]=useState(false);
 const [addMode,setAddMode]=useState(null);
 const addMenuRef=useRef(null);
 const addButtonRef=useRef(null);
 const addFirstOptionRef=useRef(null);

 useEffect(()=>{
  if(!addMenuOpen)return;
  addFirstOptionRef.current?.focus();
  const closeOnOutside=event=>{
   if(addMenuRef.current&&!addMenuRef.current.contains(event.target))setAddMenuOpen(false);
  };
  const closeOnEscape=event=>{
   if(event.key==='Escape'){
    setAddMenuOpen(false);
    addButtonRef.current?.focus();
   }
  };
  document.addEventListener('pointerdown',closeOnOutside);
  document.addEventListener('keydown',closeOnEscape);
  return()=>{
   document.removeEventListener('pointerdown',closeOnOutside);
   document.removeEventListener('keydown',closeOnEscape);
  };
 },[addMenuOpen]);

 function chooseMarketplace(marketplace){
  setAddMenuOpen(false);
  setAddMode(marketplace);
  setClient('');
  setKey('');
  setFormError('');
 }
 function renewOzon(clientId){
  setClient(clientId);
  setKey('');
  setFormError('');
  setAddMode('ozon');
  setAddMenuOpen(false);
 }
 function closeAdd(){
  setAddMode(null);
  setClient('');
  setKey('');
  setFormError('');
 }
 async function connect(event){
  event.preventDefault();
  setBusy(true);
  setFormError('');
  try{
   await api('/connect',{client_id:client.trim(),api_key:key.trim()});
   closeAdd();
   await reload();
   navigate('/');
  }catch(err){setFormError(err.message)}
  finally{setBusy(false)}
 }
 async function select(id){
  setBusy(true);
  setError('');
  try{
   await api('/accounts/select',{account_id:id});
   await reload();
   navigate('/');
  }catch(err){setError(err.message)}
  finally{setBusy(false)}
 }
 async function disconnect(){
  setBusy(true);
  setError('');
  try{await api('/disconnect',{});await reload()}
  catch(err){setError(err.message)}
  finally{setBusy(false)}
 }

 return <div className="marketplace-accounts-page">
  <div className="marketplace-accounts-header">
   <div>
    <h1>Мои кабинеты</h1>
    <p>Все подключения к маркетплейсам в одном месте.</p>
   </div>
   <div className="marketplace-add-menu-wrap" ref={addMenuRef}>
    <button type="button" className="marketplace-add-trigger" ref={addButtonRef}
     aria-expanded={addMenuOpen} aria-controls="marketplace-add-menu"
     aria-haspopup="true" disabled={busy}
     onClick={()=>setAddMenuOpen(open=>!open)}>
     <Plus size={16}/> Добавить кабинет <ChevronDown size={15} className={addMenuOpen?'marketplace-chevron-open':''}/>
    </button>
    {addMenuOpen&&<div id="marketplace-add-menu" className="marketplace-add-menu"
     role="group" aria-label="Выберите маркетплейс">
     <button type="button" ref={addFirstOptionRef} className="marketplace-add-option" onClick={()=>chooseMarketplace('ozon')}>
      <span className="marketplace-symbol marketplace-symbol-ozon" aria-hidden="true"><span className="marketplace-symbol-text">oz</span></span>
      <span className="marketplace-add-option-text"><strong>Добавить кабинет Ozon</strong><small>Подключение через Seller API</small></span>
      <ArrowRight size={15}/>
     </button>
     <button type="button" className="marketplace-add-option" onClick={()=>chooseMarketplace('wb')}>
      <span className="marketplace-symbol marketplace-symbol-wb" aria-hidden="true">wb</span>
      <span className="marketplace-add-option-text"><strong>Добавить кабинет WB</strong><small>Скоро · Wildberries</small></span>
      <ArrowRight size={15}/>
     </button>
    </div>}
   </div>
  </div>

  <section className="panel marketplace-accounts-panel">
   <div className="marketplace-panel-title">
    <h3>Список кабинетов</h3>
    <span className="marketplace-account-total">{accounts.length} {accounts.length===1?'кабинет':accounts.length%10>=2&&accounts.length%10<=4&&(accounts.length%100<12||accounts.length%100>14)?'кабинета':'кабинетов'}</span>
   </div>
   {!accounts.length&&<div className="marketplace-accounts-empty">
    <Plug size={24}/>
    <strong>Пока нет кабинетов</strong>
    <p>Нажмите «Добавить кабинет» и выберите маркетплейс. Ozon уже доступен.</p>
   </div>}
   <div className="account-list marketplace-account-list">
    {accounts.map(account=>{
     const isOzon=(account.marketplace||'ozon')==='ozon';
     const selected=me?.active_account_id===account.id;
     return <div className="account-row marketplace-account-row" key={account.id}>
      {selected&&<span className="marketplace-account-indicator" role="img"
       aria-label="Выбранный кабинет" title="Выбранный кабинет"/>}
      <div className="marketplace-account-identity">
       <span className={'marketplace-symbol '+(isOzon?'marketplace-symbol-ozon':'marketplace-symbol-wb')} aria-hidden="true">{isOzon?<span className="marketplace-symbol-text">oz</span>:'wb'}</span>
       <div className="marketplace-account-info">
        <div className="marketplace-account-title">
         <strong>Кабинет {account.client_id}</strong>
         <span className={'marketplace-account-platform '+(isOzon?'platform-ozon':'platform-wb')}>{isOzon?'Ozon':'Wildberries'}</span>
        </div>
        {!account.connected&&<span className="disconnected-label">Ключ удалён</span>}
        {isOzon&&<small>Права: {account.roles?.join(', ')||'нет данных'}</small>}
        {isOzon&&account.connected&&<small>Срок действия ключа: {date(account.expires_at)}</small>}
       </div>
      </div>
      <div className="account-actions marketplace-account-actions">
       {account.connected&&isOzon&&!selected&&<button type="button" className="marketplace-select-button"
        disabled={busy} onClick={()=>select(account.id)}>Выбрать</button>}
       {!account.connected&&isOzon&&<button type="button" className="marketplace-select-button" disabled={busy}
        onClick={()=>renewOzon(account.client_id)}>Обновить ключ</button>}
      </div>
     </div>;
    })}
   </div>
   {active&&state&&<div className="marketplace-account-footer">
    <button type="button" disabled={busy||state.job.running} onClick={disconnect}>
     <LogOut size={15}/> Удалить сохранённый ключ
    </button>
   </div>}
  </section>

  {addMode==='ozon'&&<section className="panel marketplace-add-panel" aria-labelledby="marketplace-ozon-form-title">
   <div className="marketplace-add-panel-heading">
    <div className="marketplace-add-panel-title">
     <span className="marketplace-symbol marketplace-symbol-ozon" aria-hidden="true"><span className="marketplace-symbol-text">oz</span></span>
     <div><h3 id="marketplace-ozon-form-title">{accounts.some(a=>a.client_id===client)?'Обновить кабинет Ozon':'Добавить кабинет Ozon'}</h3>
      <p>Подключите кабинет по Client ID и API-ключу Ozon.</p></div>
    </div>
    <button className="marketplace-close-panel" type="button" onClick={closeAdd} disabled={busy} aria-label="Закрыть форму"><X size={18}/></button>
   </div>
   {formError&&<div className="notice marketplace-form-error" role="alert">{formError}</div>}
   <form className="marketplace-ozon-form" onSubmit={connect}>
    <label className="field">Client ID кабинета Ozon
     <input autoComplete="off" inputMode="numeric" pattern="[0-9]+" required value={client} onChange={event=>setClient(event.target.value)} placeholder="Например, 123456"/>
    </label>
    <label className="field">API-ключ Ozon
     <input autoComplete="new-password" type="password" required minLength={10} value={key} onChange={event=>setKey(event.target.value)} placeholder="Введите ключ с доступом на чтение"/>
    </label>
    <div className="marketplace-form-actions">
     <button className="primary" type="submit" disabled={busy}>{busy?'Проверяем доступ…':'Сохранить подключение'}<ArrowRight size={16}/></button>
     <button type="button" onClick={closeAdd} disabled={busy}>Отмена</button>
    </div>
   </form>
  </section>}

  {addMode==='wb'&&<section className="panel marketplace-add-panel marketplace-wb-placeholder" aria-labelledby="marketplace-wb-placeholder-title">
   <div className="marketplace-add-panel-heading">
    <div className="marketplace-add-panel-title">
     <span className="marketplace-symbol marketplace-symbol-wb" aria-hidden="true">wb</span>
     <div><h3 id="marketplace-wb-placeholder-title">Wildberries</h3><p>Подключение кабинета WB</p></div>
    </div>
    <button className="marketplace-close-panel" type="button" onClick={closeAdd} aria-label="Закрыть"><X size={18}/></button>
   </div>
   <div className="marketplace-wb-message">
    <span className="marketplace-wb-coming">Скоро в ИСК</span>
    <p>Подключение кабинетов Wildberries находится в разработке. Пока эта функция неактивна: кабинет WB не создаётся, данные не загружаются и вводить API-ключ не нужно.</p>
   </div>
   <button type="button" onClick={closeAdd}>Понятно</button>
  </section>}
 </div>;
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
  </section>
  <section className="panel"><div className="panel-title"><h3>Пользователи ИСК</h3><ShieldCheck size={20}/></div>
   <div className="admin-user-list">{users.map(u=><div className="admin-user-row" key={u.id}><div><strong>{u.username}</strong><small>{u.role==='admin'?'Администратор':'Пользователь'} · {u.is_active?'Активен':'Отключён'}</small></div>{u.role!=='admin'&&<button disabled={busy} onClick={()=>toggle(u)}>{u.is_active?'Отключить':'Включить'}</button>}</div>)}</div>
  </section>
 </div>
}
const nav=[['/','Обзор',LayoutDashboard],['/digitization','Оцифровка',BarChart3],['/barcodes','Штрихкоды',Barcode],['/market-calculator','Расчёты',Calculator],['/purchase-shipments','Поставки',Truck],['/stocks','Остатки Ozon',Warehouse],['/replenishment','Прогноз пополнения',Calculator],['/connection','Мои кабинеты',Plug]];
function AppNavigation({items,username,onLogout}){
 const dialog=useRef(null);
 const trigger=useRef(null);
 const location=useLocation();
 const [open,setOpen]=useState(false);
 useEffect(()=>{dialog.current?.close()},[location.key]);
 useEffect(()=>{
  const mobile=window.matchMedia('(max-width: 760px)');
  const closeOnDesktop=event=>{if(!event.matches)dialog.current?.close()};
  mobile.addEventListener('change',closeOnDesktop);
  return()=>mobile.removeEventListener('change',closeOnDesktop);
 },[]);
 const renderLinks=onSelect=>items.map(([path,label,Icon])=><NavLink
  key={path} to={path} end={path==='/'} onClick={onSelect}
  className={({isActive})=>'nav-item '+(isActive?'active':'')}><Icon size={19} aria-hidden="true"/>{label}</NavLink>);
 return <>
  <aside className="sidebar">
   <div className="brand"><div className="brand-icon"><Boxes size={25}/></div><div className="isk-brand">ИСК</div></div>
   <nav aria-label="Разделы ИСК">{renderLinks()}</nav>
   <div className="sidebar-footer"><span className="status-dot"/>{username}</div>
  </aside>
  <div className="mobile-app-bar">
   <button type="button" ref={trigger} className="mobile-menu-button" aria-haspopup="dialog" aria-controls="mobile-navigation"
    aria-expanded={open} onClick={()=>{dialog.current.showModal();setOpen(true)}}><Menu size={21}/> Меню</button>
   <div className="mobile-brand"><Boxes size={19} aria-hidden="true"/> ИСК</div>
  </div>
  <dialog id="mobile-navigation" className="mobile-navigation" ref={dialog} aria-labelledby="mobile-navigation-title"
   onClick={event=>{if(event.target===event.currentTarget)dialog.current.close()}}
   onClose={()=>{setOpen(false);trigger.current?.focus({preventScroll:true})}}>
   <div className="mobile-navigation-content">
    <div className="mobile-navigation-heading">
     <h2 id="mobile-navigation-title">Разделы ИСК</h2>
     <button type="button" autoFocus aria-label="Закрыть меню" onClick={()=>dialog.current.close()}><X size={21}/></button>
    </div>
    <nav aria-label="Разделы ИСК">{renderLinks(()=>dialog.current.close())}</nav>
    <div className="mobile-navigation-footer">
     <span>{username}</span>
     <button type="button" className="logout-button" onClick={()=>{dialog.current.close();onLogout()}}><LogOut size={16}/> Выйти</button>
    </div>
   </div>
  </dialog>
 </>;
}
function RequireAccount({children}){const {me}=useApp();return me?.active_account_id?children:<Navigate to="/connection" replace/>}
function App(){
 const location=useLocation();
 const [me,setMe]=useState(null);const [state,setState]=useState(null);const [inv,setInv]=useState(null);const [hist,setHist]=useState(null);const [digi,setDigi]=useState(null);const [sales,setSales]=useState(null);
 const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [authChecked,setAuthChecked]=useState(false);const runningJob=useRef(null);
 async function loadData(){const [i,h,d,sa]=await Promise.all([api('/inventory'),api('/history'),api('/digitization'),api('/sales')]);setInv(i);setHist(h);setDigi(d);setSales(sa)}
 function clearData(){runningJob.current=null;setState(null);setInv(null);setHist(null);setDigi(null);setSales(null)}
 async function reload(){
  try{const auth=await api('/auth/me');setMe(auth);
   if(auth.active_account_id){const [s,i,h,d,sa]=await Promise.all([api('/state'),api('/inventory'),api('/history'),api('/digitization'),api('/sales')]);setState(s);setInv(i);setHist(h);setDigi(d);setSales(sa)}
   else clearData();
  }catch(e){if(e.status===401){setMe(null);clearData()}else if(e.status!==409)setError(e.message)}
  finally{setAuthChecked(true);setLoading(false)}
 }
 useEffect(()=>{reload()},[]);
 useEffect(()=>{
  if(!me?.active_account_id)return;
  let active=true;
  let timer=null;
  let inFlight=false;
  let jobRunning=Boolean(state?.job?.running);
  const schedule=delay=>{
   clearTimeout(timer);
   timer=setTimeout(checkState,delay);
  };
  const checkState=async()=>{
   if(!active||inFlight)return;
   inFlight=true;
   try{
    const s=await api('/state');
    if(!active)return;
    jobRunning=Boolean(s.job.running);
    const finished=!s.job.running&&runningJob.current;
    runningJob.current=s.job.running?s.job:null;
    setState(prev=>keepUnchangedState(prev,s));
    if(finished?.kind==='sales'){
      // Sales and shipment history are refreshed in one backend job.
      // Commit both on screen together so their totals aren't out of sync.
      const [nextSales,nextHistory]=await Promise.all([api('/sales'),api('/history')]);
      if(active){setSales(nextSales);setHist(nextHistory)}
    }else if(finished)await loadData();
   }catch(e){
    if(!active)return;
    if(e.status===401){setMe(null);clearData()}
    else if(e.status===409)await reload();
    else setError(e.message);
   }finally{
    inFlight=false;
    if(active)schedule(statePollDelay(jobRunning,!document.hidden));
   }
  };
  const onVisibilityChange=()=>{
   if(!document.hidden&&!inFlight)schedule(0);
  };
  schedule(statePollDelay(jobRunning,!document.hidden));
  document.addEventListener('visibilitychange',onVisibilityChange);
  return()=>{
   active=false;
   clearTimeout(timer);
   document.removeEventListener('visibilitychange',onVisibilityChange);
  };
 },[me?.active_account_id,state?.job?.running]);
 async function act(path,body){
  const chart=path==='/sales/sync';
  if(!chart)setError('');
  try{
   const result=await api(path,body);
   if(result.started===false){
    if(chart){
      const [nextSales,nextHistory]=await Promise.all([api('/sales'),api('/history')]);
      setSales(nextSales);
      setHist(nextHistory);
    }
    return result;
   }
   const job={kind:chart?'sales':null,running:true,message:'Запускаем загрузку…',error:null};
   runningJob.current=job;
   setState(s=>({...s,job}));
   return result;
  }catch(e){
   if(!chart||e.status!==409)setError(e.message);
   return {started:false,status:e.status,error:e.message};
  }
 }
 async function logout(){try{await api('/auth/logout',{})}finally{setMe(null);clearData()}}
 if(!authChecked||loading)return <div className="auth-screen"><div className="auth-card">Загружаем ИСК…</div></div>;
 if(!me)return <LoginScreen onSuccess={reload}/>;
 const navItems=me.user.role==='admin'?[...nav,['/admin/users','Пользователи',Users]]:nav;
 return <Context.Provider value={{me,state,setState,inv,hist,digi,sales,reload,act,setError}}>
  <div className="shell"><AppNavigation items={navItems} username={me.user.username} onLogout={logout}/>
  <main>
   <header className="app-header">
    {state&&<div className="header-refresh">
     <div className="account-update-status">
      <span>{inv?.at?'Состояние обновлено':'Данные ещё не загружены'}</span>
      {inv?.at&&<time dateTime={inv.at}>{new Date(inv.at).toLocaleString('ru-RU',{
       timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'medium',
      }).replace(',',' ·')}</time>}
     </div>
     <button className="primary" disabled={state.job.running} onClick={()=>act('/account/sync',{})}>
      <RefreshCw size={16} className={state.job.running&&state.job.kind!=='sales'?'animate-spin':''}/>
      {isOzonRetryWaiting(state.job)?'Ожидаем Ozon…':state.job.running&&state.job.kind!=='sales'?'Обновляем…':'Обновить'}
     </button>
    </div>}
    <div className="header-actions ml-auto">
     <NavLink to="/connection" className="account"><span className={'status-dot '+(!state?'offline':'')}/>{state?('Ozon · Кабинет '+state.client_id):'Выбрать кабинет'}</NavLink>
     <button className="logout-button" onClick={logout}><LogOut size={16}/> Выйти</button>
    </div>
   </header>
   <div className="workspace">
    {error&&<div role="alert"><Notice>{error}<button className="ml-3" onClick={()=>setError('')}>Закрыть</button></Notice></div>}
    {state?.job.running&&state.job.kind!=='sales'&&(
      isOzonRetryWaiting(state.job)
       ? location.pathname!=='/digitization'&&<div className="progress ozon-retry-banner" role="status">
          <Clock3 size={18}/><OzonRetryStatus retryAt={state.job.retry_at}/>
         </div>
       : <div className="progress"><RefreshCw size={17} className="animate-spin"/>{state.job.message}</div>
     )}{state?.job.error&&<Notice>{state.job.error}</Notice>}
    <Routes>
     <Route path="/connection" element={<Connection/>}/>
     <Route path="/admin/users" element={me.user.role==='admin'?<AdminUsers/>:<Navigate to="/" replace/>}/>
     <Route path="/" element={<RequireAccount><Overview key={me.active_account_id}/></RequireAccount>}/>
     <Route path="/digitization" element={<RequireAccount><DigitizationCached key={me.active_account_id} state={state?.account_id===me.active_account_id?state:null} digi={digi} act={act}/></RequireAccount>}/>
     <Route path="/barcodes" element={<BarcodeGenerator/>}/>
     <Route path="/market-calculator" element={<MarketPage/>}/>
     <Route path="/purchase-shipments" element={<PurchaseShipments/>}/>
     <Route path="/purchase-shipments/:shipmentId" element={<PurchaseShipments/>}/>
     <Route path="/purchase-shipments/:shipmentId/edit" element={<PurchaseShipments editing/>}/>
     <Route path="/products" element={<RequireAccount><ProductCatalog/></RequireAccount>}/>
     <Route path="/stocks" element={<RequireAccount><Stocks/></RequireAccount>}/>
     <Route path="/history" element={<Navigate to="/" replace/>}/>
     <Route path="/replenishment" element={<RequireAccount><Replenishment inv={inv} hist={hist} api={api}/></RequireAccount>}/>
     <Route path="/plan" element={<Navigate to="/replenishment" replace/>}/><Route path="/forecast" element={<Navigate to="/replenishment" replace/>}/>
     <Route path="/logs" element={<RequireAccount><Logs/></RequireAccount>}/><Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes>
   </div></main>
  </div>
 </Context.Provider>
}
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);

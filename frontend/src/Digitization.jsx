import ScrollTable from "./ScrollTable";
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {BarChart3, RefreshCw, WalletCards, ReceiptText, Truck, Boxes, AlertTriangle, Calculator, ArrowUpRight, ArrowDownRight, Minus} from 'lucide-react';
import {useProductCosts} from './digitization-product-costs';
import {currentInventoryMetrics} from './inventory-capitalization.mjs';
import {previousPeriodRange, compareMetric, comparisonTone, calculateDigitizationPeriodMetrics} from './digitization-comparison.mjs';
import {shouldAutoLoadDigitization} from './digitization-period.mjs';

const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const intf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const money=v=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':`${nf.format(Number(v))} ₽`;
const count=v=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':`${intf.format(Number(v))} шт`;
const pct=v=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':`${nf.format(Number(v))}%`;
const daysFmt=v=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':`${nf.format(Number(v))} дн.`;
const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
const iso=d=>{const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)};
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
const divide=(a,b)=>n(b)?n(a)/n(b):null;
const percent=(a,b)=>n(b)?n(a)/n(b)*100:null;
const round=(v,d=2)=>v===null||v===undefined?null:Number(n(v).toFixed(d));

const ComparisonVisibilityContext=React.createContext(true);

function Metric({label,value,note,icon:Icon=WalletCards,format=money,comparison,direction='higher'}){
 const showComparison=React.useContext(ComparisonVisibilityContext);
 const tone=comparisonTone(comparison,direction);
 return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{format(value)}</strong>{note!==undefined&&note!==null&&note!==''&&<small>{note}</small>}
  {showComparison&&comparison&&<div className={'metric-comparison '+tone}>
   <div className="metric-comparison-top">
    <span className="metric-comparison-previous">ПРЕДЫДУЩИЙ ПЕРИОД</span>
    <strong>{format(comparison.previous)}</strong>
   </div>
   <div className="metric-comparison-change">
    <strong className="metric-comparison-delta">{comparison.delta>0?'+':''}{format(comparison.delta)}</strong>
    <span className="metric-comparison-percent">{comparison.changePercent===null?(comparison.fromZero?'с нуля':'без базы'):`${comparison.changePercent>0?'+':''}${nf.format(comparison.changePercent)}%`}</span>
    <span className="metric-comparison-arrow">{comparison.trend==='up'?<ArrowUpRight size={19}/>:comparison.trend==='down'?<ArrowDownRight size={19}/>:<Minus size={18}/>}</span>
   </div>
  </div>}
 </div>
}

function SimpleTable({rows,columns,empty}){
 if(!rows.length)return <div className="empty"><BarChart3 size={34}/><h3>{empty}</h3><p>Загрузите данные за выбранный период.</p></div>;
 return <ScrollTable label="Начисления Ozon по типам операций"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.sku||i}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></ScrollTable>
}

function localRead(key,fallback){
 try{const value=localStorage.getItem(key);return value?JSON.parse(value):fallback}catch{return fallback}
}
function periodDays(first,last){
 if(!first||!last)return null;
 const a=new Date(`${first}T00:00:00Z`),b=new Date(`${last}T00:00:00Z`);
 const result=Math.floor((b-a)/86400000)+1;
 return result>0?result:null;
}

export default function Digitization({state,digi,act,autoLoadComparisons=false}){
 const defaults=useMemo(()=>{const end=new Date();const start=new Date(end);start.setDate(start.getDate()-29);return {from:iso(start),to:iso(end)}},[]);
 const client=state?.client_id||'local';
 const comparisonVisibilityKey=`isk-digitization-show-comparisons-${client}`;
 const [showComparisons,setShowComparisons]=useState(()=>{
  try{const saved=localStorage.getItem(comparisonVisibilityKey);return saved===null?true:saved==='true'}catch{return true}
 });
 const [dateFrom,setDateFrom]=useState(defaults.from);
 const [dateTo,setDateTo]=useState(defaults.to);
 const [inventory,setInventory]=useState(null);
 const [inventoryHistory,setInventoryHistory]=useState([]);
 const [comparisonDigi,setComparisonDigi]=useState(null);
 const [comparisonInventoryHistory,setComparisonInventoryHistory]=useState([]);
 const [comparisonState,setComparisonState]=useState({loading:true,available:false,error:'',coverage:{}});
 const attemptedComparisonSync=useRef(new Set());
 const pendingComparisonSync=useRef(new Set());
 const settingsKey=`isk-digitization-settings-${client}`;
 const productCosts=useProductCosts(state.account_id,client);
 const {costs}=productCosts;
 const [settings,setSettings]=useState({taxRate:6,vatRate:0,operationalExpenses:0,operationalIncome:0});
 const periodEnd=digi?.effective_to||digi?.to;
 const comparisonRange=useMemo(()=>previousPeriodRange(digi?.since,periodEnd),[digi?.since,periodEnd]);
 const selectedPeriodDays=periodDays(digi?.since,periodEnd);

 useEffect(()=>{
  try{const saved=localStorage.getItem(comparisonVisibilityKey);setShowComparisons(saved===null?true:saved==='true')}catch{setShowComparisons(true)}
 },[comparisonVisibilityKey]);

 const handleComparisonVisibilityChange=event=>{
  const checked=event.target.checked;
  setShowComparisons(checked);
  try{localStorage.setItem(comparisonVisibilityKey,String(checked))}catch{}
 };

 useEffect(()=>{
  setSettings({...{taxRate:6,vatRate:0,operationalExpenses:0,operationalIncome:0},...localRead(settingsKey,{})});
 },[settingsKey]);

 useEffect(()=>{
  if(!state)return;
  let live=true;
  fetch('/api/inventory',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(data=>{if(live&&data)setInventory(data)}).catch(()=>{});
  return()=>{live=false};
 },[state?.account_id,state?.job?.running,digi?.at]);

 useEffect(()=>{
  const first=digi?.since, last=digi?.effective_to||digi?.to;
  if(!state||!first||!last){setInventoryHistory([]);return}
  let live=true;
  const q=new URLSearchParams({date_from:first,date_to:last});
  fetch(`/api/inventory/history?${q}`,{credentials:'same-origin'})
   .then(r=>r.ok?r.json():null).then(data=>{if(live)setInventoryHistory(data?.days||[])})
   .catch(()=>{if(live)setInventoryHistory([])});
  return()=>{live=false};
 },[state?.account_id,state?.job?.running,digi?.since,digi?.effective_to,digi?.to,digi?.at]);

 // Read the preceding period from SQLite before requesting any Ozon data.
 // When comparisons are enabled, missing days are filled once automatically.
 useEffect(()=>{
  if(!showComparisons){
   setComparisonDigi(null);
   setComparisonInventoryHistory([]);
   setComparisonState({loading:false,available:false,error:'',coverage:{}});
   return;
  }
  if(!state){
   setComparisonDigi(null);
   setComparisonInventoryHistory([]);
   setComparisonState({loading:false,available:false,error:'',coverage:{}});
   return;
  }
  if(!comparisonRange){
   setComparisonDigi(null);
   setComparisonInventoryHistory([]);
   setComparisonState({loading:false,available:false,error:'',coverage:{}});
   return;
  }
  // This request reads SQLite only, so cached comparisons remain accessible
  // even when a background Ozon job is waiting for its rate limit to reset.
  let live=true;
  setComparisonDigi(null);
  setComparisonInventoryHistory([]);
  setComparisonState({loading:true,available:false,error:'',coverage:{}});
  const q=new URLSearchParams({date_from:comparisonRange.from,date_to:comparisonRange.to});
  fetch('/api/digitization?'+q,{credentials:'same-origin'})
   .then(async response=>{
    const data=await response.json();
    if(!response.ok)throw new Error(data.detail||'Не удалось получить предыдущий период.');
    if(!live)return;
    const comparisonKey=[state.account_id,comparisonRange.from,comparisonRange.to].join('|');
    if(autoLoadComparisons&&!state?.job?.running&&shouldAutoLoadDigitization(data.cache)&&
       !attemptedComparisonSync.current.has(comparisonKey)&&
       !pendingComparisonSync.current.has(comparisonKey)){
     pendingComparisonSync.current.add(comparisonKey);
     act('/digitization/sync',{date_from:comparisonRange.from,date_to:comparisonRange.to})
      .then(result=>{
       pendingComparisonSync.current.delete(comparisonKey);
       if(result?.started===true||result?.status!==409)attemptedComparisonSync.current.add(comparisonKey);
      })
      .catch(()=>{pendingComparisonSync.current.delete(comparisonKey);attemptedComparisonSync.current.add(comparisonKey);});
    }
    if(!data.available){
     setComparisonDigi(null);
     setComparisonInventoryHistory([]);
     setComparisonState({loading:false,available:false,error:'',coverage:data.cache||{}});
     return;
    }
    let history=[];
    try{
     const historyQuery=new URLSearchParams({date_from:comparisonRange.from,date_to:comparisonRange.to});
     const historyResponse=await fetch('/api/inventory/history?'+historyQuery,{credentials:'same-origin'});
     if(historyResponse.ok){
      const historyData=await historyResponse.json();
      history=historyData?.days||[];
     }
    }catch{}
    if(!live)return;
    setComparisonDigi(data);
    setComparisonInventoryHistory(history);
    setComparisonState({loading:false,available:true,error:'',coverage:data.cache||{}});
   })
   .catch(error=>{
    if(live){
     setComparisonDigi(null);
     setComparisonInventoryHistory([]);
     setComparisonState({loading:false,available:false,error:error.message||'Ошибка сравнения.',coverage:{}});
    }
   });
  return()=>{live=false};
 },[state?.client_id,state?.job?.running,comparisonRange?.from,comparisonRange?.to,digi?.at,showComparisons,autoLoadComparisons]);

 const saveSetting=(field,value)=>{
  setSettings(prev=>{const next={...prev,[field]:n(value)};localStorage.setItem(settingsKey,JSON.stringify(next));return next});
 };

 const m=digi?.metrics||{};
 const c=digi?.components||{};
 const previousMetrics=useMemo(()=>calculateDigitizationPeriodMetrics(comparisonDigi,costs,settings),[comparisonDigi,costs,settings]);
 const invalid=dateFrom&&dateTo&&dateFrom>dateTo;
 const comparisonCutoff=digi?.effective_to&&digi?.to&&digi.effective_to!==digi.to;
 const discount=n(m.discount_points);
 const realization=n(m.realization);
 const sales=digi?.metrics?round(n(m.sales_amount)||realization-discount):null;
 const salesQty=m.sales_quantity??null;
 const orders=n(m.orders_amount);
 const ordersQty=m.orders_quantity??null;
 const returns=n(m.returns_amount);
 const logistics=n(m.logistics);
 const commission=n(m.nominal_commission);
 const acquiring=n(m.acquiring);
 const advertising=n(m.advertising);
 const storage=n(m.storage);
 const paidAcceptance=n(m.paid_acceptance);
 const penalties=n(m.penalties);
 const other=n(m.other_deductions);
 const compensationWithoutPoints=n(m.compensations);
 const compensationWithPoints=discount;
 const foreignCommission=n(c.marketplace_buyout_commission);

 const soldRows=(digi?.products||[]).filter(r=>n(r.sales_quantity)!==0);
 const hasCost=sku=>costs[String(sku)]?.cost!=null;
 const costCoverage=soldRows.filter(r=>hasCost(r.sku)).length;
 const allSoldCosts=soldRows.length>0&&costCoverage===soldRows.length;
 const saleUnitCost=sku=>n(costs[String(sku)]?.cost)+n(costs[String(sku)]?.fulfillment);
 const stockUnitCost=sku=>saleUnitCost(sku)+n(costs[String(sku)]?.vat);
 const cogs=allSoldCosts?round(soldRows.reduce((sum,row)=>sum+n(row.sales_quantity)*saleUnitCost(row.sku),0)):null;
 const averageCogs=cogs!==null&&n(salesQty)>0?round(cogs/n(salesQty)):null;

 const taxIncome=sales===null?null:round(sales+compensationWithoutPoints-foreignCommission+n(settings.operationalIncome));
 const outgoingVat=taxIncome===null?null:round(taxIncome*n(settings.vatRate)/(100+n(settings.vatRate)));
 const taxBase=taxIncome===null?null:round(taxIncome-n(outgoingVat));
 const taxes=taxBase===null?null:round(n(outgoingVat)+taxBase*n(settings.taxRate)/100);

 const cleanWithoutOps=cogs===null||sales===null||taxes===null?null:round(
  sales-logistics-advertising-storage-paidAcceptance-other-cogs-taxes-commission-acquiring-penalties+compensationWithPoints+compensationWithoutPoints
 );
 const cleanProfit=cleanWithoutOps===null?null:round(cleanWithoutOps-n(settings.operationalExpenses));
 const margin=cleanProfit===null?null:round(percent(cleanProfit,realization));
 const marginWithoutOps=cleanWithoutOps===null?null:round(percent(cleanWithoutOps,realization));
 const roi=cleanProfit===null||!n(cogs)?null:round(percent(cleanProfit,cogs));
 const averageProfit=cleanProfit===null||!n(salesQty)?null:round(cleanProfit/n(salesQty));
 const drr=round(percent(advertising,realization));
 const drrOrders=round(percent(advertising,orders));
 const priceBefore=round(divide(realization,salesQty));
 const averageSale=round(divide(sales,salesQty));
 const avgLogistics=round(divide(logistics,salesQty));

 // Current capitalization always uses the latest successful Ozon inventory sync.
 // The selected digitization period is used only for average capitalization.
 const currentStock=currentInventoryMetrics(inventory,costs);
 const stockQty=currentStock.stockQty;
 const fbsStockQty=currentStock.fbsStockQty;
 const capitalizationCost=currentStock.capitalizationCost===null?null:round(currentStock.capitalizationCost);
 const capitalizationNote=!currentStock.sourceAt
  ?'Сначала обновите актуальные остатки Ozon'
  :currentStock.warning
   ?'Остатки Ozon загружены не полностью — капитализация не рассчитана'
   :!currentStock.outboundFieldsAvailable
    ?'Ozon не вернул статусы доставки и возвратов — обновите остатки'
    :currentStock.missingCostSkus.length
     ?'Заполните себестоимость для '+currentStock.missingCostSkus.length+' SKU с остатком'
     :'Актуальные остатки Ozon, включая доставку и возвраты, на '+dateTime(currentStock.sourceAt);
 const ownStockQty=Object.entries(costs).reduce((sum,[,v])=>sum+n(v?.own_stock),0);
 const ownCapitalization=round(Object.entries(costs).reduce((sum,[sku,v])=>sum+n(v?.own_stock)*stockUnitCost(sku),0));

 const capitalizationValues=history=>history.map(day=>{
  if(day.summary?.outbound_fields_available!==true)return null;
  const rows=day.aggregated||[];
  if(rows.some(row=>row.capitalization_quantity===null||row.capitalization_quantity===undefined))return null;
  const active=rows.filter(row=>n(row.capitalization_quantity)>0);
  if(active.some(r=>!hasCost(r.sku)))return null;
  const mp=active.reduce((sum,row)=>sum+n(row.capitalization_quantity)*stockUnitCost(row.sku),0);
  return mp+ownCapitalization;
 }).filter(v=>v!==null);
 const dailyCaps=capitalizationValues(inventoryHistory);
 const averageCapitalization=dailyCaps.length?round(dailyCaps.reduce((a,b)=>a+b,0)/dailyCaps.length):null;
 const comparisonDailyCaps=capitalizationValues(comparisonInventoryHistory);
 const comparisonAverageCapitalization=comparisonDailyCaps.length?round(comparisonDailyCaps.reduce((a,b)=>a+b,0)/comparisonDailyCaps.length):null;
 const days=periodDays(digi?.since,digi?.effective_to||digi?.to);
 const gmroi=cleanProfit!==null&&n(averageCapitalization)>0?round(percent(cleanProfit,averageCapitalization)):null;
 const annualGmroi=gmroi!==null&&days?round(gmroi*365/days):null;
 const turnoverSales=stockQty!==null&&days&&n(salesQty)>0?round(n(stockQty)/(n(salesQty)/days)):null;
 const turnoverOrders=stockQty!==null&&days&&n(ordersQty)>0?round(n(stockQty)/(n(ordersQty)/days)):null;
 const comparisonGmroi=previousMetrics?.cleanProfit!==null&&previousMetrics?.cleanProfit!==undefined&&n(comparisonAverageCapitalization)>0?round(percent(previousMetrics.cleanProfit,comparisonAverageCapitalization)):null;
 const comparisonAnnualGmroi=comparisonGmroi!==null&&comparisonRange?.days?round(comparisonGmroi*365/comparisonRange.days):null;
 const comparisonTurnoverSales=stockQty!==null&&comparisonRange?.days&&n(previousMetrics?.salesQuantity)>0?round(n(stockQty)/(n(previousMetrics.salesQuantity)/comparisonRange.days)):null;
 const comparisonTurnoverOrders=stockQty!==null&&comparisonRange?.days&&n(previousMetrics?.ordersQuantity)>0?round(n(stockQty)/(n(previousMetrics.ordersQuantity)/comparisonRange.days)):null;
 const dateLabel=value=>value?new Date(value+'T00:00:00Z').toLocaleDateString('ru-RU',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'}):'—';

 const catalogBySku=new Map((inventory?.products||[]).filter(p=>p.sku).map(p=>[String(p.sku),p]));
 const salesBySku=new Map((digi?.products||[]).filter(row=>row.sku).map(row=>[String(row.sku),row]));
 const productRows=[...new Set([...catalogBySku.keys(),...salesBySku.keys()])]
  .map(sku=>{
   const product=catalogBySku.get(sku);
   return {sku,name:product?.name||product?.offer_id||'Товар',article:product?.id??'—',sales:salesBySku.get(sku)};
  }).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
 const missingProfitCosts=soldRows.length-costCoverage;
 const operations=digi?.operation_types||[];

 return <ComparisonVisibilityContext.Provider value={showComparisons}>
  <div className="overview-heading"><div><h1>Оцифровка</h1><p className="muted mt-2">Метрики и формулы TrueStats · данные периода: {dateTime(digi?.at)} · остатки Ozon: {dateTime(currentStock.sourceAt)}</p></div><div className="flex gap-2 flex-wrap items-center"><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/sync',{})}>Обновить актуальные остатки <RefreshCw size={16}/></button><input aria-label="Дата начала" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><span className="muted">—</span><input aria-label="Дата окончания" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/><button className="primary" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={()=>act('/digitization/sync',{date_from:dateFrom,date_to:dateTo})}>Обновить период <RefreshCw size={16}/></button></div></div>
  {invalid&&<div className="notice warning mt-4"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {digi?.since&&<p className="muted mt-4">Выбранный период: {digi.since} — {digi.to}{digi?.effective_to?` · в расчёт включены данные Ozon по ${digi.effective_to} включительно`:''}</p>}
  {comparisonCutoff&&<div className="notice warning mt-4"><AlertTriangle size={18}/>Текущий день исключён только для сравнения с вашим снимком TrueStats; в нём последняя дневная колонка — 10.10.</div>}
  {(comparisonRange||selectedPeriodDays>31)&&<div className="digitization-comparison-toolbar">
   <label className="digitization-comparison-toggle">
    <input type="checkbox" checked={showComparisons} onChange={handleComparisonVisibilityChange}/>
    <span>Показывать сравнение с предыдущим периодом</span>
   </label>
   {showComparisons&&comparisonRange&&comparisonState.available&&<span className="digitization-comparison-period">Сравнение: {dateLabel(comparisonRange.from)} — {dateLabel(comparisonRange.to)}</span>}
  </div>}
  {showComparisons&&comparisonRange&&comparisonState.loading&&<div className="digitization-comparison-status loading"><RefreshCw size={15} className="animate-spin"/><span>Проверяем сохранённые данные предыдущего периода…</span></div>}
  {showComparisons&&comparisonRange&&!comparisonState.available&&!comparisonState.loading&&<div className="digitization-comparison-status missing">
   <span>{comparisonState.error||('Для сравнения нужны данные за '+dateLabel(comparisonRange.from)+' — '+dateLabel(comparisonRange.to)+'. '+(comparisonState.coverage?.missing_days?.length?'Недостающие дни будут загружены из Ozon автоматически, когда это станет возможно.':''))}</span>
  </div>}
  {showComparisons&&!comparisonRange&&selectedPeriodDays>31&&<div className="digitization-comparison-status limited"><span>Сравнение доступно для периодов до одного месяца (31 дня). Выбрано: {selectedPeriodDays} дн.</span></div>}

  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6">
   <Metric label="Чистая прибыль/Марж-сть" value={cleanProfit} note={pct(margin)} icon={Boxes} comparison={compareMetric(cleanProfit,previousMetrics?.cleanProfit)} direction="higher"/>
   <Metric label="Прибыль без опер. расх./Марж. без опер." value={cleanWithoutOps} note={pct(marginWithoutOps)} icon={Boxes} comparison={compareMetric(cleanWithoutOps,previousMetrics?.cleanWithoutOps)} direction="higher"/>
   <Metric label="Продажи" value={sales} note={count(salesQty)} comparison={compareMetric(sales,previousMetrics?.sales)} direction="higher"/>
   <Metric label="Реализация" value={realization} comparison={compareMetric(realization,previousMetrics?.realization)} direction="higher"/>
   <Metric label="Заказы" value={orders} note={count(ordersQty)} comparison={compareMetric(orders,previousMetrics?.orders)} direction="higher"/>
   <Metric label="Процент выкупа" value={m.buyout_percent} format={pct} note={m.refusals_returns_quantity!==null&&m.refusals_returns_quantity!==undefined?`Отказы + возвраты: ${count(m.refusals_returns_quantity)}`:'—'} comparison={compareMetric(m.buyout_percent,previousMetrics?.buyoutPercent)} direction="higher"/>
   <Metric label="Логистика" value={logistics} note={pct(percent(logistics,realization))} icon={Truck} comparison={compareMetric(logistics,previousMetrics?.logistics)} direction="lower"/>
   <Metric label="Реклама/ДРР" value={advertising} note={pct(drr)} icon={BarChart3} comparison={compareMetric(advertising,previousMetrics?.advertising)} direction="lower"/>
   <Metric label="Хранение" value={storage} note={pct(percent(storage,realization))} icon={Boxes} comparison={compareMetric(storage,previousMetrics?.storage)} direction="lower"/>
   <Metric label="Плат. приемка" value={paidAcceptance} note={pct(percent(paidAcceptance,realization))} comparison={compareMetric(paidAcceptance,previousMetrics?.paidAcceptance)} direction="lower"/>
   <Metric label="Прочие удержания" value={other} note={pct(percent(other,realization))} comparison={compareMetric(other,previousMetrics?.other)} direction="lower"/>
   <Metric label="Себестоимость продаж" value={cogs} note={cogs===null?`Заполните СС для ${missingProfitCosts} SKU`:pct(percent(cogs,realization))} icon={Calculator} comparison={compareMetric(cogs,previousMetrics?.cogs)} direction="lower"/>
   <Metric label="Операционные расходы" value={settings.operationalExpenses} note={pct(percent(settings.operationalExpenses,realization))} comparison={compareMetric(settings.operationalExpenses,previousMetrics?.operationalExpenses)} direction="lower"/>
   <Metric label="Налоги" value={taxes} note={pct(percent(taxes,realization))} icon={ReceiptText} comparison={compareMetric(taxes,previousMetrics?.taxes)} direction="lower"/>
   <Metric label="Налоговая База" value={taxBase} comparison={compareMetric(taxBase,previousMetrics?.taxBase)} direction="higher"/>
   <Metric label="Номинальная комиссия" value={commission} note={pct(percent(commission,realization))} icon={ReceiptText} comparison={compareMetric(commission,previousMetrics?.commission)} direction="lower"/>
   <Metric label="Эквайринг" value={acquiring} note={pct(percent(acquiring,realization))} comparison={compareMetric(acquiring,previousMetrics?.acquiring)} direction="lower"/>
   <Metric label="ROI" value={roi} format={pct} icon={BarChart3} comparison={compareMetric(roi,previousMetrics?.roi)} direction="higher"/>
   <Metric label="Средняя себестоимость" value={averageCogs} comparison={compareMetric(averageCogs,previousMetrics?.averageCogs)} direction="lower"/>
   <Metric label="Цена до СПП" value={priceBefore} comparison={compareMetric(priceBefore,previousMetrics?.priceBefore)} direction="higher"/>
   <Metric label="Сред. цена продажи" value={averageSale} comparison={compareMetric(averageSale,previousMetrics?.averageSale)} direction="higher"/>
   <Metric label="Реклама/ДРРз" value={advertising} note={pct(drrOrders)} icon={BarChart3} comparison={compareMetric(advertising,previousMetrics?.advertising)} direction="lower"/>
   <Metric label="Средняя прибыль на 1 шт." value={averageProfit} comparison={compareMetric(averageProfit,previousMetrics?.averageProfit)} direction="higher"/>
   <Metric label="Ср. стоимость логистики на 1 шт." value={avgLogistics} comparison={compareMetric(avgLogistics,previousMetrics?.averageLogistics)} direction="lower"/>
   <Metric label="Остатки" value={stockQty} format={count} note={currentStock.sourceAt&&currentStock.outboundFieldsAvailable?'Включая товары в пути · на '+dateTime(currentStock.sourceAt):currentStock.sourceAt?'Нет статусов доставки/возвратов':'Обновите остатки Ozon'}/>
   <Metric label="Оборачиваемость по прод." value={turnoverSales} format={daysFmt} comparison={compareMetric(turnoverSales,comparisonTurnoverSales)} direction="lower"/>
   <Metric label="Оборачиваемость по зак." value={turnoverOrders} format={daysFmt} comparison={compareMetric(turnoverOrders,comparisonTurnoverOrders)} direction="lower"/>
   <Metric label="Капитализация по себес." value={capitalizationCost} note={capitalizationNote}/>
   <Metric label="Средняя капитализация" value={averageCapitalization} note={inventoryHistory.length?`Снимков остатков: ${inventoryHistory.length}`:'Нужна история снимков остатков'} comparison={compareMetric(averageCapitalization,comparisonAverageCapitalization)} direction="higher"/>
   <Metric label="Капитализация по розн." value={null} note="Нужна цена прошлой полной недели"/>
   <Metric label="Капитализ. на моих складах" value={ownCapitalization}/>
   <Metric label="Остатки на моих складах" value={ownStockQty} format={count}/>
   <Metric label="FBS-остатки, шт" value={fbsStockQty} format={count} note={inventory?.fbs_stock_error||undefined}/>
   <Metric label="GMROI" value={gmroi} format={pct} comparison={compareMetric(gmroi,comparisonGmroi)} direction="higher"/>
   <Metric label="Годовой GMROI" value={annualGmroi} format={pct} comparison={compareMetric(annualGmroi,comparisonAnnualGmroi)} direction="higher"/>
   <Metric label="Штрафы" value={penalties} note={pct(percent(penalties,realization))} comparison={compareMetric(penalties,previousMetrics?.penalties)} direction="lower"/>
   <Metric label="Скидка МП" value={discount} note={pct(percent(discount,realization))} comparison={compareMetric(discount,previousMetrics?.discount)} direction="higher"/>
   <Metric label="Компенсация с баллами" value={compensationWithPoints} note={pct(percent(compensationWithPoints,realization))} comparison={compareMetric(compensationWithPoints,previousMetrics?.compensationWithPoints)} direction="higher"/>
   <Metric label="Компенсация без баллов" value={compensationWithoutPoints} note={pct(percent(compensationWithoutPoints,realization))} comparison={compareMetric(compensationWithoutPoints,previousMetrics?.compensationWithoutPoints)} direction="higher"/>
   <Metric label="Самовыкупы, шт." value={0} format={count}/>
   <Metric label="Самовыкупы, ₽" value={0}/>
   <Metric label="Затраты на самовыкупы (кешбэк)" value={0}/>
  </div>

  <section className="panel mb-5">
   <div className="panel-title">
    <h3>Продажи и себестоимость по артикулам</h3>
    {productCosts.legacy&&productCosts.loaded&&<button type="button" disabled={productCosts.importing||productCosts.saving||Object.keys(productCosts.drafts).length>0} onClick={productCosts.importLegacy}>
     {productCosts.importing?'Переносим…':'Перенести себестоимость из браузера'}
    </button>}
   </div>
   {(productCosts.loading||productCosts.saving)&&<p className="muted mb-3" role="status">{productCosts.loading?'Загружаем себестоимость…':'Сохраняем себестоимость…'}</p>}
   {productCosts.error&&<div className="notice" role="alert"><span>{productCosts.error}</span>
    {!productCosts.loaded&&!productCosts.loading&&<button type="button" onClick={productCosts.retryLoad}>Повторить загрузку</button>}
   </div>}
   {productRows.length>0?<ScrollTable label="Продажи и себестоимость по артикулам" stickyColumn><table className="digitization-sales-table"><thead><tr>
    <th>Товар</th><th>Артикул</th><th>Себестоимость, ₽</th><th>Себестоимость (капитализация) / 1 шт.</th>
    <th>Продажи, шт.</th><th>Реализация</th><th>Продажи</th><th>Доля в общей выручке</th><th>Себестоимость продаж</th>
   </tr></thead><tbody>
    {productRows.map(({sku,name,article,sales})=>{
     const unitCost=hasCost(sku)?money(saleUnitCost(sku)):null;
     const capitalization=unitCost===null?null:money(stockUnitCost(sku));
     return <tr key={sku}>
      <td>{name}</td><td>{article}</td>
      <td><input aria-label={`Себестоимость, ₽ — ${name}`} style={{width:120}} type="number" min="0" step="0.01" max="1000000000" value={productCosts.drafts[sku]??costs[sku]?.cost??''} placeholder="—"
       disabled={!productCosts.loaded||productCosts.importing||productCosts.pending[sku]}
       onChange={e=>productCosts.edit(sku,e.currentTarget.value)}
       onBlur={e=>productCosts.save(sku,e.currentTarget.value,e.currentTarget.validity.badInput)}
       onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/></td>
      <td>{unitCost??'—'}{capitalization!==unitCost&&<> ({capitalization})</>}</td>
      <td>{count(sales?.sales_quantity)}</td><td>{money(sales?.realization)}</td><td>{money(sales?.sales_amount)}</td>
      <td>{sales&&realization?pct(round(n(sales.realization)/realization*100)):'—'}</td>
      <td>{sales&&unitCost!==null?money(round(n(sales.sales_quantity)*saleUnitCost(sku))):'—'}</td>
     </tr>;
    })}
   </tbody></table></ScrollTable>:<div className="empty"><Calculator size={34}/><h3>Нет товаров</h3><p>Сначала обновите товары и оцифровку.</p></div>}
  </section>

  <section className="panel mb-5">
   <div className="panel-title"><h3>Налоги и операционные расходы</h3></div>
   <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
    <label className="field">УСН, %<input type="number" min="0" step="0.01" value={settings.taxRate} onChange={e=>saveSetting('taxRate',e.target.value)}/></label>
    <label className="field">НДС, %<input type="number" min="0" step="0.01" value={settings.vatRate} onChange={e=>saveSetting('vatRate',e.target.value)}/></label>
    <label className="field">Операционные расходы, ₽<input type="number" min="0" step="0.01" value={settings.operationalExpenses} onChange={e=>saveSetting('operationalExpenses',e.target.value)}/></label>
    <label className="field">Официальные опер. доходы, ₽<input type="number" min="0" step="0.01" value={settings.operationalIncome} onChange={e=>saveSetting('operationalIncome',e.target.value)}/></label>
   </div>
  </section>

  <section className="panel"><div className="panel-title"><h3>Начисления Ozon по типам операций</h3></div><SimpleTable rows={operations} empty="Нет начислений" columns={[["name","Официальное название операции"],["count","Строк"],["amount","Сумма итого",money]]}/></section>
 </ComparisonVisibilityContext.Provider>
}

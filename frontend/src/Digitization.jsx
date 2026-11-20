import React, {useEffect, useMemo, useState} from 'react';
import {BarChart3, RefreshCw, WalletCards, ReceiptText, Truck, Boxes, AlertTriangle, Calculator, ArrowUpRight, ArrowDownRight, Minus} from 'lucide-react';
import {currentInventoryMetrics} from './inventory-capitalization.mjs';
import {previousPeriodRange, compareMetric, comparisonTone, calculateDigitizationPeriodMetrics} from './digitization-comparison.mjs';

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
 return <div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.sku||i}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>
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

export default function Digitization({state,digi,act}){
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
 const costKey=`isk-digitization-costs-${client}`;
 const settingsKey=`isk-digitization-settings-${client}`;
 const [costs,setCosts]=useState({});
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
  setCosts(localRead(costKey,{}));
  setSettings({...{taxRate:6,vatRate:0,operationalExpenses:0,operationalIncome:0},...localRead(settingsKey,{})});
 },[costKey,settingsKey]);

 useEffect(()=>{
  if(!state)return;
  let live=true;
  fetch('/api/inventory',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(data=>{if(live&&data)setInventory(data)}).catch(()=>{});
  return()=>{live=false};
 },[state,digi?.at]);

 useEffect(()=>{
  const first=digi?.since, last=digi?.effective_to||digi?.to;
  if(!state||!first||!last){setInventoryHistory([]);return}
  let live=true;
  const q=new URLSearchParams({date_from:first,date_to:last});
  fetch(`/api/inventory/history?${q}`,{credentials:'same-origin'})
   .then(r=>r.ok?r.json():null).then(data=>{if(live)setInventoryHistory(data?.days||[])})
   .catch(()=>{if(live)setInventoryHistory([])});
  return()=>{live=false};
 },[state,digi?.since,digi?.effective_to,digi?.to,digi?.at]);

 // Read the immediately preceding equal-length period from SQLite. No Ozon
 // requests are made automatically; missing days can be loaded on demand.
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
  if(state?.job?.running)return;
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
 },[state?.client_id,state?.job?.running,comparisonRange?.from,comparisonRange?.to,digi?.at,showComparisons]);

 const saveCost=(sku,field,value)=>{
  setCosts(prev=>{
   const old=prev[sku]||{};
   const next={...prev,[sku]:{cost:n(old.cost),fulfillment:n(old.fulfillment),vat:n(old.vat),own_stock:n(old.own_stock),[field]:n(value)}};
   localStorage.setItem(costKey,JSON.stringify(next));
   return next;
  });
 };
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
 const hasCost=sku=>Object.prototype.hasOwnProperty.call(costs,String(sku));
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

 const catalogBySku=new Map((inventory?.products||[]).map(p=>[String(p.sku),p]));
 const costRows=[...new Map([
  ...(inventory?.products||[]).filter(p=>p.sku).map(p=>[String(p.sku),{sku:String(p.sku),name:p.name||'',offer_id:p.offer_id||''}]),
  ...soldRows.map(r=>[String(r.sku),{sku:String(r.sku),name:catalogBySku.get(String(r.sku))?.name||'',offer_id:catalogBySku.get(String(r.sku))?.offer_id||''}])
 ]).values()].sort((a,b)=>(a.name||a.sku).localeCompare(b.name||b.sku,'ru'));

 const productRows=(digi?.products||[]).map(row=>({
  ...row,
  name:catalogBySku.get(String(row.sku))?.name||'',
  share:realization?round(n(row.realization)/realization*100):null,
  unit_cost:hasCost(row.sku)?round(saleUnitCost(row.sku)):null,
  cogs:hasCost(row.sku)?round(n(row.sales_quantity)*saleUnitCost(row.sku)):null,
 }));
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
  {showComparisons&&comparisonRange&&(comparisonState.loading||state?.job?.running)&&<div className="digitization-comparison-status loading"><RefreshCw size={15} className="animate-spin"/><span>{state?.job?.running?'Ожидаем завершения загрузки…':'Проверяем данные предыдущего периода…'}</span></div>}
  {showComparisons&&comparisonRange&&!comparisonState.available&&!comparisonState.loading&&!state?.job?.running&&<div className="digitization-comparison-status missing">
   <span>{comparisonState.error||('Для сравнения нужны данные за '+dateLabel(comparisonRange.from)+' — '+dateLabel(comparisonRange.to)+'. '+(comparisonState.coverage?.missing_days?.length?'Не хватает дней: '+comparisonState.coverage.missing_days.length+'.':''))}</span>
   <button type="button" disabled={!state||state.job.running} onClick={()=>act('/digitization/sync',{date_from:comparisonRange.from,date_to:comparisonRange.to})}>Загрузить предыдущий период</button>
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
   <div className="panel-title"><div><h3>Себестоимость товаров</h3><p className="muted mt-2">Себестоимость продаж считается по формуле TrueStats: количество продаж × (СС + ФФ). НДС используется для капитализации остатков: (СС + ФФ + НДС) × остаток.</p></div><span className="badge">{costCoverage}/{soldRows.length} проданных SKU заполнено</span></div>
   <div className="table-scroll"><table><thead><tr><th>Товар</th><th>SKU</th><th>Себестоимость, ₽</th><th>Фулфилмент, ₽</th><th>НДС, ₽</th><th>Мои склады, шт</th><th>СС продаж / 1 шт.</th><th>Капитализация / 1 шт.</th></tr></thead><tbody>
    {costRows.map(row=><tr key={row.sku}><td>{row.name||row.offer_id||'Товар'}</td><td>{row.sku}</td>
     {['cost','fulfillment','vat','own_stock'].map(field=><td key={field}><input style={{width:120}} type="number" min="0" step={field==='own_stock'?'1':'0.01'} value={costs[row.sku]?.[field]??''} placeholder="0" onChange={e=>saveCost(row.sku,field,e.target.value)}/></td>)}
     <td>{hasCost(row.sku)?money(saleUnitCost(row.sku)):'—'}</td><td>{hasCost(row.sku)?money(stockUnitCost(row.sku)):'—'}</td></tr>)}
   </tbody></table></div>
   {!costRows.length&&<div className="empty"><Calculator size={34}/><h3>Нет товаров</h3><p>Сначала обновите товары и оцифровку.</p></div>}
  </section>

  <section className="panel mb-5">
   <div className="panel-title"><div><h3>Налоги и операционные расходы</h3><p className="muted mt-2">Для текущего примера используется УСН «Доходы»: налоговая база строится из продаж и официальных компенсаций с учётом комиссии зарубежных выкупов.</p></div><span className="badge">Настройки сохраняются локально</span></div>
   <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
    <label className="field">УСН, %<input type="number" min="0" step="0.01" value={settings.taxRate} onChange={e=>saveSetting('taxRate',e.target.value)}/></label>
    <label className="field">НДС, %<input type="number" min="0" step="0.01" value={settings.vatRate} onChange={e=>saveSetting('vatRate',e.target.value)}/></label>
    <label className="field">Операционные расходы, ₽<input type="number" min="0" step="0.01" value={settings.operationalExpenses} onChange={e=>saveSetting('operationalExpenses',e.target.value)}/></label>
    <label className="field">Официальные опер. доходы, ₽<input type="number" min="0" step="0.01" value={settings.operationalIncome} onChange={e=>saveSetting('operationalIncome',e.target.value)}/></label>
   </div>
  </section>

  

  

  <section className="panel mb-5"><div className="panel-title"><h3>По SKU</h3><span className="badge">Продажи + себестоимость</span></div><SimpleTable rows={productRows.slice(0,200)} empty="Нет товарных строк" columns={[
   ['name','Товар'],['sku','SKU'],['sales_quantity','Продажи, шт',count],['realization','Реализация',money],['sales_amount','Продажи',money],['share','Доля в общей выручке',pct],['unit_cost','СС+ФФ / шт',money],['cogs','Себестоимость продаж',money],
  ]}/></section>



  <section className="panel"><div className="panel-title"><h3>Начисления Ozon по типам операций</h3></div><SimpleTable rows={operations} empty="Нет начислений" columns={[["name","Официальное название операции"],["count","Строк"],["amount","Сумма итого",money]]}/></section>
 </ComparisonVisibilityContext.Provider>
}

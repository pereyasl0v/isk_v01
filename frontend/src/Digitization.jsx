import React, {useMemo, useState} from 'react';
import {BarChart3, RefreshCw, WalletCards, ReceiptText, Truck, Boxes, AlertTriangle} from 'lucide-react';

const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const intf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const money=v=>v===null||v===undefined?'—':`${nf.format(v)} ₽`;
const count=v=>v===null||v===undefined?'—':`${intf.format(v)} шт`;
const pct=v=>v===null||v===undefined?'—':`${nf.format(v)}%`;
const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
const iso=d=>{const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)};

function Metric({label,value,note,icon:Icon=WalletCards,format=money}){
 return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{format(value)}</strong>{note&&<small>{note}</small>}</div>
}

function SimpleTable({rows,columns,empty}){
 if(!rows.length)return <div className="empty"><BarChart3 size={34}/><h3>{empty}</h3><p>Загрузите данные за выбранный период.</p></div>;
 return <div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>
}

function SummaryTable({summary}){
 const rows=[
  ['Цена до СПП',summary?.price_before_spp],
  ['Средн. цена продажи',summary?.average_sale_price],
  ['Реализация (сумма продаж до СПП)',summary?.realization],
  ['Продажи',summary?.sales],
  ['К перечислению',summary?.to_transfer],
  ['Возвраты',summary?.returns],
 ];
 return <div className="table-scroll"><table><thead><tr><th>Метрика</th><th>За период</th></tr></thead><tbody>{rows.map(([label,value])=><tr key={label}><td>{label}</td><td>{money(value)}</td></tr>)}</tbody></table></div>
}

export default function Digitization({state,digi,act}){
 const defaults=useMemo(()=>{const end=new Date();const start=new Date(end);start.setDate(start.getDate()-29);return {from:iso(start),to:iso(end)}},[]);
 const [dateFrom,setDateFrom]=useState(defaults.from);
 const [dateTo,setDateTo]=useState(defaults.to);
 const m=digi?.metrics;
 const c=digi?.components||{};
 const invalid=dateFrom&&dateTo&&dateFrom>dateTo;
 const comparisonCutoff=digi?.effective_to&&digi?.to&&digi.effective_to!==digi.to;
 return <>
  <div className="overview-heading"><div><h1>Оцифровка</h1><p className="muted mt-2">Метрики и названия как в TrueStats · снимок: {dateTime(digi?.at)}</p></div><div className="flex gap-2 flex-wrap items-center"><input aria-label="Дата начала" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><span className="muted">—</span><input aria-label="Дата окончания" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/><button className="primary" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={()=>act('/digitization/sync',{date_from:dateFrom,date_to:dateTo})}>Обновить <RefreshCw size={16}/></button></div></div>
  {invalid&&<div className="notice warning mt-4"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {digi?.since&&<p className="muted mt-4">Выбранный период: {digi.since} — {digi.to}{digi?.effective_to?` · в расчёт включены данные Ozon по ${digi.effective_to} включительно`:''}</p>}
  {comparisonCutoff&&<div className="notice warning mt-4"><AlertTriangle size={18}/>Текущий день исключён только для сравнения с показанным вами отчётом TrueStats: там последняя дневная колонка — 10.10.</div>}

  <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-3 gap-4 my-6">
   <Metric label="Заказы" value={m?.orders_amount} note={count(m?.orders_quantity)}/>
   <Metric label="Продажи" value={m?.sales_amount} note={count(m?.sales_quantity)}/>
   <Metric label="Чистая прибыль" value={m?.clean_profit} note={pct(m?.margin)} icon={Boxes}/>
   <Metric label="Возвраты" value={m?.returns_amount} note={count(m?.returns_quantity)} icon={ReceiptText}/>
   <Metric label="Логистика" value={m?.logistics} note={pct(m?.logistics_share)} icon={Truck}/>
   <Metric label="Номинальная комиссия" value={m?.nominal_commission} note={pct(m?.nominal_commission_share)} icon={ReceiptText}/>
   <Metric label="ROI" value={m?.roi} format={pct} icon={BarChart3}/>
   <Metric label="Средняя прибыль на 1 шт" value={m?.average_profit}/>
   <Metric label="Налоги" value={m?.taxes} note={pct(m?.taxes_share)} icon={ReceiptText}/>
  </div>

  <section className="panel mb-5"><div className="panel-title"><h3>Сводный отчёт</h3><span className="badge">{digi?.since||'—'} — {digi?.effective_to||digi?.to||'—'}</span></div><SummaryTable summary={digi?.summary}/></section>

  {(digi?.warnings||[]).length>0&&<section className="panel mb-5"><div className="panel-title"><h3>Что нужно для полного совпадения</h3></div>{digi.warnings.map((w,i)=><p className="muted mt-2" key={i}><AlertTriangle size={15}/> {w}</p>)}</section>}

  <section className="panel mb-5"><div className="panel-title"><h3>Сверка TrueStats → Ozon</h3><span className="badge">Контроль расчёта</span></div><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-4">
   <Metric label="Реализация" value={m?.realization}/>
   <Metric label="Сумма хранения" value={m?.storage} icon={Boxes}/>
   <Metric label="Эквайринг" value={m?.acquiring}/>
   <Metric label="Реклама" value={m?.advertising} note="Оплата за заказ из Seller API" icon={BarChart3}/>
   <Metric label="Баллы за скидки" value={m?.discount_points}/>
   <Metric label="Компенсации" value={m?.compensations}/>
   <Metric label="Прочие удержания" value={m?.other_deductions}/>
   <Metric label="Выкупы маркетплейсом" value={c.marketplace_buyout_realization}/>
  </div></section>

  <section className="panel mb-5"><div className="panel-title"><h3>Типы начислений Ozon</h3><span className="badge">Диагностика</span></div><SimpleTable rows={digi?.operation_types||[]} empty="Нет начислений" columns={[["name","Тип начисления"],["truestats_metric","Метрика TrueStats"],["count","Строк"],["amount","Сумма итого",money]]}/></section>
  <section className="panel"><div className="panel-title"><h3>По SKU</h3><span className="badge">Продажи и выкупы</span></div><SimpleTable rows={(digi?.products||[]).slice(0,200)} empty="Нет товарных строк" columns={[["sku","SKU"],["sales_quantity","Количество",count],["realization","Реализация",money],["sales_amount","Продажи",money]]}/></section>
 </>
}

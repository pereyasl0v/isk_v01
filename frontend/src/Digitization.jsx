import React, {useMemo, useState} from 'react';
import {BarChart3, RefreshCw, WalletCards, ReceiptText, Truck, Boxes, AlertTriangle} from 'lucide-react';

const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const intf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const money=v=>v===null||v===undefined?'—':`${nf.format(v)} ₽`;
const count=v=>v===null||v===undefined?'—':`${intf.format(v)} шт.`;
const dateTime=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
const iso=d=>{const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,10)};

function Metric({label,value,note,icon:Icon=WalletCards,format=money}){
 return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{format(value)}</strong>{note&&<small>{note}</small>}</div>
}

function SimpleTable({rows,columns,empty}){
 if(!rows.length)return <div className="empty"><BarChart3 size={34}/><h3>{empty}</h3><p>Загрузите данные за выбранный период.</p></div>;
 return <div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>
}

export default function Digitization({state,digi,act}){
 const defaults=useMemo(()=>{const end=new Date();const start=new Date(end);start.setDate(start.getDate()-29);return {from:iso(start),to:iso(end)}},[]);
 const [dateFrom,setDateFrom]=useState(defaults.from);
 const [dateTo,setDateTo]=useState(defaults.to);
 const m=digi?.metrics;
 const c=digi?.components||{};
 const invalid=dateFrom&&dateTo&&dateFrom>dateTo;
 return <>
  <div className="overview-heading"><div><h1>Оцифровка</h1><p className="muted mt-2">Сверка по методике TrueStats · снимок: {dateTime(digi?.at)}</p></div><div className="flex gap-2 flex-wrap items-center"><input aria-label="Дата начала" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><span className="muted">—</span><input aria-label="Дата окончания" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/><button className="primary" disabled={!state||state.job.running||invalid||!dateFrom||!dateTo} onClick={()=>act('/digitization/sync',{date_from:dateFrom,date_to:dateTo})}>Сверить с Ozon <RefreshCw size={16}/></button></div></div>
  {invalid&&<div className="notice warning mt-4"><AlertTriangle size={18}/>Дата окончания не может быть раньше даты начала.</div>}
  {digi?.since&&<p className="muted mt-4">Период данных: {digi.since} — {digi.to}</p>}
  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6">
   <Metric label="Реализация" value={m?.realization} note={`РФ + выкупы маркетплейсом ${money(c.marketplace_buyout_realization||0)}`}/>
   <Metric label="Сумма логистики" value={m?.logistics} note="Типы начислений из инструкции TrueStats" icon={Truck}/>
   <Metric label="Сумма хранения" value={m?.storage} note="Начисленная стоимость размещения" icon={Boxes}/>
   <Metric label="Номинальная комиссия" value={m?.nominal_commission} note={`Комиссия выкупов ${money(c.marketplace_buyout_commission||0)}`} icon={ReceiptText}/>
   <Metric label="Эквайринг" value={m?.acquiring} note="Тип начисления «Эквайринг»" icon={ReceiptText}/>
   <Metric label="Реклама" value={m?.advertising} note="Нужен Promotion/Performance API" icon={BarChart3}/>
   <Metric label="Количество продаж" value={m?.sales_quantity} note={`Выкупы: ${count(c.marketplace_buyout_quantity||0)}`} format={count}/>
   <Metric label="Сумма продаж" value={m?.sales_amount} note="Выручка − возврат + программы партнеров + выкупы"/>
   <Metric label="Сверка заказов" value={m?.orders_amount} note={`Количество: ${count(m?.orders_quantity)}`}/>
   <Metric label="Баллы за скидки" value={m?.discount_points} note="Данные начислений Ozon"/>
   <Metric label="Компенсации" value={m?.compensations} note="Компенсации и декомпенсации"/>
   <Metric label="Прочие удержания" value={m?.other_deductions} note="Остальные отрицательные начисления"/>
  </div>
  {(digi?.warnings||[]).length>0&&<section className="panel mb-5"><div className="panel-title"><h3>Что ещё нужно для полного совпадения</h3></div>{digi.warnings.map((w,i)=><p className="muted mt-2" key={i}><AlertTriangle size={15}/> {w}</p>)}</section>}
  <section className="panel mb-5"><div className="panel-title"><h3>Контроль расчёта</h3><span className="badge">TrueStats → Ozon</span></div><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-4"><Metric label="Выручка" value={c.revenue}/><Metric label="Возврат выручки" value={Math.abs(c.return_revenue||0)}/><Metric label="Программы партнеров" value={c.partner_programs}/><Metric label="Выкупы маркетплейсом" value={c.marketplace_buyout_realization}/></div></section>
  <section className="panel mb-5"><div className="panel-title"><h3>Типы начислений Ozon</h3><span className="badge">Диагностика</span></div><SimpleTable rows={digi?.operation_types||[]} empty="Нет начислений" columns={[["name","Тип начисления"],["truestats_metric","Метрика TrueStats"],["count","Строк"],["amount","Сумма итого",money]]}/></section>
  <section className="panel"><div className="panel-title"><h3>По SKU</h3><span className="badge">Продажи и выкупы</span></div><SimpleTable rows={(digi?.products||[]).slice(0,200)} empty="Нет товарных строк" columns={[["sku","SKU"],["sales_quantity","Количество",count],["realization","Реализация",money],["sales_amount","Сумма продаж",money]]}/></section>
 </>
}

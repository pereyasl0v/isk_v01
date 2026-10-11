import React, {useState} from 'react';
import {BarChart3, RefreshCw, WalletCards, ReceiptText, Truck, Boxes} from 'lucide-react';

const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const money=v=>v===null||v===undefined?'—':`${nf.format(v)} ₽`;
const date=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';

function Metric({label,value,note,icon:Icon=WalletCards}){
 return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{money(value)}</strong><small>{note}</small></div>
}

function SimpleTable({rows,columns,empty}){
 if(!rows.length)return <div className="empty"><BarChart3 size={34}/><h3>{empty}</h3><p>Загрузите финансовые операции или измените период.</p></div>;
 return <div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>
}

export default function Digitization({state,digi,act}){
 const [days,setDays]=useState(30);const t=digi?.totals;
 return <>
  <div className="overview-heading"><div><h1>Оцифровка</h1><p className="muted mt-2">Финансовые операции Ozon · снимок: {date(digi?.at)}</p></div><div className="flex gap-2"><select aria-label="Период оцифровки" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>7 дней</option><option value={14}>14 дней</option><option value={30}>30 дней</option><option value={31}>31 день</option></select><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/digitization/sync',{days})}>Загрузить финансы <RefreshCw size={16}/></button></div></div>
  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6">
   <Metric label="Продажи" value={t?.gross_sales} note="Начисления за продажу" icon={WalletCards}/>
   <Metric label="Комиссия Ozon" value={t?.commission} note="Фактическая комиссия" icon={ReceiptText}/>
   <Metric label="Логистика" value={t?.logistics} note="Услуги доставки и возвратов" icon={Truck}/>
   <Metric label="Чистое начисление Ozon" value={t?.net_accrual} note="До себестоимости, налогов и рекламы" icon={Boxes}/>
  </div>
  <section className="panel mb-5"><div className="panel-title"><h3>Состав расходов Ozon</h3><span className="badge">{t?.operations||0} операций</span></div><div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-4"><Metric label="Хранение" value={t?.storage} note="Определено по услугам"/><Metric label="Прочие услуги" value={t?.other_services} note="Не отнесены к логистике/хранению"/><Metric label="Расходы Ozon" value={t?.ozon_expenses} note="Комиссия + услуги"/><Metric label="Начислено после Ozon" value={t?.profit_before_cogs_tax_ads} note="Не является чистой прибылью"/></div>{digi?.note&&<p className="muted">{digi.note}</p>}</section>
  <section className="panel mb-5"><div className="panel-title"><h3>По товарам</h3><span className="badge">{digi?.products?.length||0} SKU</span></div><SimpleTable rows={(digi?.products||[]).slice(0,100)} empty="Нет SKU-аналитики" columns={[["sku","SKU"],["name","Товар"],["gross_sales","Продажи",money],["commission","Комиссия",money],["services","Услуги",money],["net_accrual","Начисление",money]]}/>{digi?.unallocated_product_operations>0&&<p className="muted mt-4">Не распределено по одному SKU: {digi.unallocated_product_operations} операций с несколькими товарами.</p>}</section>
  <section className="panel"><div className="panel-title"><h3>Типы финансовых операций</h3><span className="badge">Ozon Seller API</span></div><SimpleTable rows={(digi?.operation_types||[]).slice(0,100)} empty="Нет финансовых операций" columns={[["name","Операция"],["count","Количество"],["amount","Сумма",money]]}/></section>
 </>
}

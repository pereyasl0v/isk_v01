import React,{useEffect,useMemo,useState} from 'react';

const n=v=>v===null||v===undefined?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v);
const rateFormat=v=>v===null||v===undefined?'—':new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:3}).format(v);
const moscow={timeZone:'Europe/Moscow'};
const date=v=>v?new Date(v).toLocaleDateString('ru-RU',moscow):'—';

function Days({value}){
  const className='coverage '+(
    value.state==='empty'?'danger':
    value.days_left!==null&&value.days_left<7?'attention':''
  );
  const label=value.state==='estimated'?n(value.days_left)+' дн.':
    value.state==='empty'?'Нет в наличии':
    value.state==='no_orders'?'Нет продаж':'—';
  return <span className={className}>{label}</span>;
}

function dateOnly(value){
  return value?String(value).slice(0,10):'';
}
function shiftDate(value,days){
  if(!value)return '';
  const [year,month,day]=dateOnly(value).split('-').map(Number);
  if(!year||!month||!day)return '';
  return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);
}
function daysBetween(start,end){
  if(!start||!end)return 0;
  const [sy,sm,sd]=start.split('-').map(Number);
  const [ey,em,ed]=end.split('-').map(Number);
  if(!sy||!sm||!sd||!ey||!em||!ed)return 0;
  return Math.max(0,Math.round((Date.UTC(ey,em-1,ed)-Date.UTC(sy,sm-1,sd))/86400000));
}
function planWarehouses(warehouses=[],days=0){
  const rows=warehouses.map(w=>{
    const known=Number.isFinite(w.available)&&Number.isFinite(w.rate);
    const required=known?Math.max(0,Math.ceil(w.rate*days-w.available-1e-9)):null;
    return {...w,replenishment_quantity:required};
  });
  const unknown=rows.filter(w=>w.replenishment_quantity===null).length;
  return {rows,total:rows.reduce((sum,w)=>sum+(w.replenishment_quantity??0),0),unknown};
}
function combinedRate(warehouses=[]){
  if(!warehouses.length||warehouses.some(w=>!Number.isFinite(w.rate)))return null;
  return warehouses.reduce((sum,w)=>sum+w.rate,0);
}

function WarehouseList({warehouses=[],horizonDays=0}){
  const [showAll,setShowAll]=useState(false);
  const ordered=useMemo(()=>{
    const priority={empty:0,estimated:1,unknown_stock:2,unknown_rate:3,no_orders:4};
    return [...warehouses].sort((a,b)=>{
      const rank=(priority[a.state]??5)-(priority[b.state]??5);
      if(rank!==0)return rank;
      if(a.state==='estimated')return (a.days_left??Infinity)-(b.days_left??Infinity);
      return (a.warehouse_name||'').localeCompare(b.warehouse_name||'','ru');
    });
  },[warehouses]);
  const plan=planWarehouses(ordered,horizonDays);
  const visible=showAll?plan.rows:plan.rows.slice(0,6);

  if(!ordered.length)return <div className="forecast-empty-warehouses">Нет складов для отображения.</div>;

  return <div className="warehouse-breakdown">
    <div className="warehouse-grid">
      <div className="warehouse-grid-head">
        <span>Склад</span>
        <span>Остаток</span>
        <span>Скорость расхода</span>
        <span>Хватит на</span>
        <span>К отгрузке</span>
      </div>
      {visible.map(w=><div className="warehouse-grid-row" key={w.warehouse_id}>
        <div className="warehouse-place">
          <strong>{w.warehouse_name||'Склад Ozon'}</strong>
        </div>
        <div className="warehouse-stock">
          <strong>{n(w.available)} <small>ед.</small></strong>
        </div>
        <div className="warehouse-rate">
          <strong>{Number.isFinite(w.rate)?rateFormat(w.rate)+' ед./день':'—'}</strong>
        </div>
        <div className="warehouse-cover">
          <Days value={w}/>
          <small>{w.state==='estimated'&&w.ends_at?'до '+date(w.ends_at):w.state==='empty'?'Уже нет':''}</small>
        </div>
        <div className="warehouse-replenishment">
          {w.replenishment_quantity===null
            ?<span className="forecast-plan-unknown">—</span>
            :<strong>{n(w.replenishment_quantity)} <small>ед.</small></strong>}
        </div>
      </div>)}
    </div>
    {ordered.length>6&&<button type="button" className="warehouse-more" onClick={()=>setShowAll(v=>!v)}>
      {showAll?'Свернуть список':'Показать все склады ('+n(ordered.length)+')'}
    </button>}
  </div>;
}

export default function Replenishment({inv,hist,api}){
  const [window,setWindow]=useState(14);
  const [targetDate,setTargetDate]=useState('');
  const [data,setData]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [q,setQ]=useState('');
  const [mode,setMode]=useState('local');

  useEffect(()=>{
    let current=true;
    setData(null);
    setError('');
    if(!inv?.at||!hist?.at)return()=>{current=false};
    setBusy(true);
    api('/replenishment',{window})
      .then(r=>{if(current)setData(r)})
      .catch(e=>{if(current)setError(e.message)})
      .finally(()=>{if(current)setBusy(false)});
    return()=>{current=false};
  },[window,inv?.at,hist?.at]);

  const catalogBySku=useMemo(()=>new Map((inv?.products||[]).map(product=>[String(product.sku),product])),[inv?.products]);
  const query=q.trim().toLowerCase();
  const rows=(data?.items||[]).map(item=>{
    const product=catalogBySku.get(String(item.sku));
    return {...item,name:product?.name||item.name||'Товар',article:product?.id??null};
  }).filter(item=>[item.name,item.article].join(' ').toLowerCase().includes(query));

  const anchorDate=dateOnly(data?.at);
  const defaultTargetDate=shiftDate(anchorDate,60);
  const effectiveTargetDate=targetDate&&targetDate>=anchorDate?targetDate:defaultTargetDate;
  const horizonDays=daysBetween(anchorDate,effectiveTargetDate);

  return <section className="panel replenishment-panel">
    <div className="forecast-header">
      <h3>Прогноз пополнения</h3>
      <div className="forecast-period">
        <span className="forecast-period-label">Анализ продаж</span>
        <div className="forecast-windows" aria-label="Период анализа продаж">
          {[[7,'7 дней'],[14,'14 дней'],[30,'30 дней'],[90,'90 дней']].map(([v,label])=>
            <button type="button" key={v} onClick={()=>setWindow(v)} className={window===v?'selected':''}>{label}</button>
          )}
        </div>
      </div>
    </div>

    <div className="forecast-planning">
      <div className="forecast-planning-copy">
        <strong>Планирование поставки</strong>
      </div>
      <div className="forecast-planning-inputs">
        <label className="forecast-target-date">
          <span>Обеспечить запас до</span>
          <input type="date" value={effectiveTargetDate} min={anchorDate||undefined} disabled={!data?.at||busy} onChange={e=>setTargetDate(e.target.value)}/>
        </label>
        <div className="forecast-date-presets" aria-label="Срок пополнения">
          {[[30,'30 дн.'],[60,'60 дн.'],[90,'90 дн.']].map(([days,label])=>
            <button type="button" key={days} className={horizonDays===days?'selected':''} disabled={!anchorDate||busy} onClick={()=>setTargetDate(shiftDate(anchorDate,days))}>{label}</button>
          )}
        </div>
      </div>
    </div>

    <div className="forecast-controls">
      <div className="forecast-levels" role="group" aria-label="Уровень прогноза">
        <button type="button" aria-pressed={mode==='local'} className={mode==='local'?'active':''} onClick={()=>setMode('local')}>
          <strong>По складам</strong>
        </button>
        <button type="button" aria-pressed={mode==='total'} className={mode==='total'?'active':''} onClick={()=>setMode('total')}>
          <strong>По товару</strong>
        </button>
      </div>
      <label className="search forecast-search">
        <input aria-label="Поиск товара" placeholder="Название или артикул" value={q} onChange={e=>setQ(e.target.value)}/>
      </label>
    </div>

    {error&&<p role="alert" className="forecast-warning">{error}</p>}
    {busy?<div className="empty">Рассчитываем прогноз…</div>:
      !inv?.at||!hist?.at?
        <div className="empty"><h3>Загрузите остатки и историю отправлений</h3><p>Нажмите «Обновить» рядом с номером кабинета.</p></div>:
      data&&!rows.length?
        <div className="empty">Товары не найдены</div>:
      rows.map(p=>{
        const plan=planWarehouses(p.warehouses,horizonDays);
        const planComplete=plan.rows.length>0&&plan.unknown===0;
        const speed=combinedRate(p.warehouses);
        return <details key={p.sku} className="forecast-product-card">
          <summary className="forecast-product-summary">
            <div className="forecast-product-main">
              <strong>{p.name}</strong>
              <div className="forecast-product-meta">
                <span>Артикул: {p.article??'—'}</span>
              </div>
            </div>
            <div className="forecast-product-total">
              <strong>{n(p.total.available)} <small>ед.</small></strong>
              <span>Общий остаток</span>
            </div>
            <div className="forecast-product-rate">
              <strong>{speed===null?'—':rateFormat(speed)+' ед./день'}</strong>
              <span>Скорость расхода</span>
            </div>
            <div className="forecast-product-secondary">
              <strong>{n(p.warehouses.length)}</strong>
              <span>складов</span>
            </div>
            <div className="forecast-product-plan">
              <strong>{planComplete?n(plan.total)+' ед.':'—'}</strong>
              <span>К отгрузке</span>
            </div>
            <span className="forecast-expand-arrow">⌄</span>
          </summary>

          <div className="forecast-product-details">
            {mode==='local'?<>
              <WarehouseList warehouses={p.warehouses} horizonDays={horizonDays}/>
            </>:<>
              <div className="pooled-metrics">
                <div>
                  <span>Общий остаток</span>
                  <strong>{n(p.total.available)} <small>ед.</small></strong>
                </div>
                <div>
                  <span>Скорость расхода</span>
                  <strong>{speed===null?'—':rateFormat(speed)+' ед./день'}</strong>
                </div>
                <div>
                  <span>К отгрузке до {date(effectiveTargetDate)}</span>
                  <strong>{planComplete?n(plan.total)+' ед.':'—'}</strong>
                </div>
              </div>
            </>}
          </div>
        </details>;
      })
    }
  </section>;
}

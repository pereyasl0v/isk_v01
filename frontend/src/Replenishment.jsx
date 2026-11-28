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

function WarehouseList({warehouses=[],periodDays=0}){
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
  const plan=planWarehouses(ordered,periodDays);
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
  const [window,setWindow]=useState(30);
  const [data,setData]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [q,setQ]=useState('');
  const [mode,setMode]=useState('local');

  useEffect(()=>{
    let current=true;
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
  const displayWindow=data?.window??window;
  const rows=(data?.items||[]).map(item=>{
    const product=catalogBySku.get(String(item.sku));
    return {...item,name:product?.name||item.name||'Товар',article:product?.id??null};
  }).filter(item=>[item.name,item.article].join(' ').toLowerCase().includes(query));

  return <section className="panel replenishment-panel" aria-busy={busy}>
    <div className="forecast-header">
      <h3>Прогноз пополнения</h3>
      {busy&&<span className="forecast-loading-indicator" role="status">{data?'Обновляем прогноз…':'Загружаем прогноз…'}</span>}
      <div className="forecast-period">
        <span className="forecast-period-label">Период расчёта и отгрузки</span>
        <div className="forecast-windows" aria-label="Период расчёта и отгрузки">
          {[[30,'30 дней'],[60,'60 дней'],[90,'90 дней']].map(([v,label])=>
            <button type="button" key={v} onClick={()=>setWindow(v)} className={window===v?'selected':''}>{label}</button>
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
    {!inv?.at||!hist?.at?
      <div className="empty"><h3>Загрузите остатки и историю отправлений</h3><p>Нажмите «Обновить» рядом с номером кабинета.</p></div>:
    !data&&busy?
      <div className="forecast-loading-list" aria-hidden="true">
        {[0,1,2,3].map(index=><div className="forecast-skeleton-card" key={index}>
          <span className="forecast-skeleton forecast-skeleton-name"/>
          <span className="forecast-skeleton forecast-skeleton-total"/>
          <span className="forecast-skeleton forecast-skeleton-rate"/>
          <span className="forecast-skeleton forecast-skeleton-secondary"/>
          <span className="forecast-skeleton forecast-skeleton-plan"/>
        </div>)}
      </div>:
    data&&!rows.length?
      <div className="empty">Товары не найдены</div>:
    data?
      rows.map(p=>{
        const plan=planWarehouses(p.warehouses,displayWindow);
        const planAvailable=plan.rows.length>0&&plan.rows.some(w=>w.replenishment_quantity!==null);
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
              <strong>{planAvailable?n(plan.total)+' ед.':'—'}</strong>
              <span>К отгрузке на {displayWindow} дней</span>
              {plan.unknown>0&&<small>{planAvailable?'Частично · ':''}{n(plan.unknown)} складов без данных</small>}
            </div>
            <span className="forecast-expand-arrow">⌄</span>
          </summary>

          <div className="forecast-product-details">
            {mode==='local'?<>
              <WarehouseList warehouses={p.warehouses} periodDays={displayWindow}/>
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
                  <span>К отгрузке на {window} дней</span>
                  <strong>{planAvailable?n(plan.total)+' ед.':'—'}</strong>
                  {plan.unknown>0&&<small className="pooled-subline">{planAvailable?'Частично · ':''}{n(plan.unknown)} складов без данных</small>}
                </div>
              </div>
            </>}
          </div>
        </details>;
      }) :
      <div className="empty">Не удалось загрузить прогноз. Попробуйте обновить данные.</div>
    }
  </section>;
}

import React,{useEffect,useMemo,useState} from 'react';

const n=v=>v===null||v===undefined?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v);
const moscow={timeZone:'Europe/Moscow'};
const date=v=>v?new Date(v).toLocaleDateString('ru-RU',moscow):'—';
const states={
  empty:'Нет в наличии',
  unknown_stock:'Нет данных об остатке',
  unknown_rate:'Недостаточно данных',
  no_orders:'Нет заказов за период',
  estimated:''
};

function Days({value}){
  const className='coverage '+(
    value.state==='empty'?'danger':
    value.days_left!==null&&value.days_left<7?'attention':''
  );
  return <span className={className}>
    {value.state==='estimated'?n(value.days_left)+' дн.':(states[value.state]||'Нет данных')}
  </span>;
}

function WarehouseList({warehouses=[],enough=false}){
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
  const emptyCount=ordered.filter(w=>w.state==='empty').length;
  const urgentCount=ordered.filter(w=>w.state==='estimated'&&w.days_left!==null&&w.days_left<14).length;
  const unknownCount=ordered.filter(w=>w.state==='unknown_stock'||w.state==='unknown_rate').length;
  const visible=showAll?ordered:ordered.slice(0,6);

  if(!ordered.length)return <div className="forecast-empty-warehouses">Нет данных по складам.</div>;

  return <div className="warehouse-breakdown">
    <div className="warehouse-overview">
      <div><strong>{n(ordered.length)}</strong><span>складов в расчёте</span></div>
      <div><strong className={emptyCount?'warehouse-number-danger':''}>{n(emptyCount)}</strong><span>без остатка</span></div>
      <div><strong className={urgentCount?'warehouse-number-warning':''}>{n(urgentCount)}</strong><span>с запасом менее 14 дней</span></div>
      {unknownCount>0&&<div><strong>{n(unknownCount)}</strong><span>без полного прогноза</span></div>}
    </div>
    <div className="warehouse-grid">
      <div className="warehouse-grid-head">
        <span>Склад</span>
        <span>Остаток</span>
        <span>Заказы за период / расход</span>
        <span>Хватит на</span>
      </div>
      {visible.map(w=><div className="warehouse-grid-row" key={w.warehouse_id}>
        <div className="warehouse-place" title={'ID '+w.warehouse_id}>
          <strong>{w.warehouse_name||'Склад Ozon'}</strong>
        </div>
        <div className="warehouse-stock">
          <strong>{n(w.available)} <small>ед.</small></strong>
        </div>
        <div className="warehouse-rate">
          <strong>{enough?n(w.units)+' ед.':'—'}</strong>
          <small>{n(w.rate)} ед./день</small>
        </div>
        <div className="warehouse-cover">
          <Days value={w}/>
          <small>{w.state==='empty'?'Уже нет в наличии':w.state==='estimated'&&w.ends_at?'до '+date(w.ends_at):'Дата не определена'}</small>
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

  return <>
    <section className="panel replenishment-panel">
      <div className="forecast-header">
        <div>
          <h3>Прогноз пополнения</h3>
          <p className="muted forecast-subtitle">Остатки и расход по складам Ozon — отдельно и в сумме по товару.</p>
        </div>
        <div className="forecast-period">
          <div className="forecast-windows" aria-label="Период прогноза">
            {[[7,'7 дней'],[14,'14 дней'],[30,'30 дней'],[90,'90 дней']].map(([v,label])=>
              <button type="button" key={v} onClick={()=>setWindow(v)} className={window===v?'selected':''}>{label}</button>
            )}
          </div>
          {data&&<p className="muted forecast-period-dates">
            Заказы: {date(data.period_start+'T00:00:00+03:00')} — {date(data.period_end+'T00:00:00+03:00')}
          </p>}
        </div>
      </div>

      <div className="forecast-controls">
        <div className="forecast-levels" role="group" aria-label="Уровень прогноза">
          <button type="button" aria-pressed={mode==='local'} className={mode==='local'?'active':''} onClick={()=>setMode('local')}>
            <strong>По складам</strong>
            <span>Расход и запас каждого склада</span>
          </button>
          <button type="button" aria-pressed={mode==='total'} className={mode==='total'?'active':''} onClick={()=>setMode('total')}>
            <strong>По товару</strong>
            <span>Общий прогноз для закупки у производителя</span>
          </button>
        </div>
        <label className="search forecast-search">
          <input aria-label="Поиск товара" placeholder="Название или артикул" value={q} onChange={e=>setQ(e.target.value)}/>
        </label>
      </div>

      {error&&<p role="alert" className="forecast-warning">{error}</p>}
      {Boolean(data?.warnings?.length)&&<details className="forecast-data-alert">
        <summary>Замечания к данным <span>{data.warnings.length}</span></summary>
        <ul>{data.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>
      </details>}

      {busy?<div className="empty">Рассчитываем прогноз…</div>:
        !inv?.at||!hist?.at?
          <div className="empty"><h3>Загрузите остатки и историю отправлений</h3><p>Нажмите «Обновить» рядом с номером кабинета.</p></div>:
        data&&!rows.length?
          <div className="empty">Товары не найдены</div>:
        rows.map(p=><details key={p.sku} className="forecast-product-card">
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
            <div className="forecast-product-secondary">
              {mode==='local'?<>
                <strong>{n(p.warehouses.length)}</strong>
                <span>складов</span>
              </>:<>
                <Days value={p.total}/>
                <span>{p.total.state==='empty'?'Запас отсутствует':p.total.ends_at?'до '+date(p.total.ends_at):'Срок не определён'}</span>
              </>}
            </div>
            <span className="forecast-expand-arrow">⌄</span>
          </summary>

          <div className="forecast-product-details">
            {p.unmatched_stock_warehouses>0&&<details className="forecast-inline-note">
              <summary>Не все склады подтверждены остатками ({n(p.unmatched_stock_warehouses)})</summary>
              <p>Общий остаток взят из данных раздела «Остатки FBO». Для части складов нет текущей строки аналитики, поэтому полноту запаса на них подтвердить нельзя.</p>
            </details>}
            {mode==='local'?<>
              {p.missing_warehouse_units>0&&<p className="forecast-inline-warning">
                Для {n(p.missing_warehouse_units)} заказанных единиц не указан склад отгрузки. Их нельзя распределить по отдельным складам.
              </p>}
              <WarehouseList warehouses={p.warehouses} enough={data.enough}/>
            </>:<>
              <div className="pooled-metrics">
                <div><span>Доступно на всех складах</span><strong>{n(p.total.available)} <small>ед.</small></strong></div>
                <div><span>Общий расход</span><strong>{n(p.total.rate)} <small>ед./день</small></strong></div>
                <div><span>Хватит без пополнения</span><strong><Days value={p.total}/></strong></div>
                <div><span>Дата исчерпания</span><strong>{p.total.state==='empty'?'Уже нет в наличии':date(p.total.ends_at)}</strong></div>
              </div>
              <p className="forecast-pooled-note">Остаток и расход суммируются по всем складам. Этот прогноз нужен для планирования закупки у производителя.</p>
            </>}
          </div>
        </details>)
      }
    </section>

    <details className="panel method-help forecast-method">
      <summary>Как читать прогноз</summary>
      <p><strong>По складам:</strong> скорость рассчитывается отдельно по каждому складу на основании заказов, отгруженных с него. Дни запаса — доступный остаток, разделённый на скорость расхода.</p>
      <p><strong>По товару:</strong> доступные остатки и заказы всех складов суммируются. Это общий прогноз потребности, а не план распределения поставки по складам.</p>
      <p>В расчёт входят неотменённые отправления за выбранный период. Будущие поступления, возвраты и изменения спроса не учитываются. Дата исчерпания — ориентир, а не гарантия.</p>
    </details>
  </>;
}

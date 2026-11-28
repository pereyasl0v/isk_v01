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

function WarehouseList({warehouses=[],enough=false,horizonDays=0,targetDate=''}) {
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
  const plan=planWarehouses(ordered,horizonDays);
  const visible=showAll?plan.rows:plan.rows.slice(0,6);

  if(!ordered.length)return <div className="forecast-empty-warehouses">Нет данных по складам.</div>;

  return <div className="warehouse-breakdown">
    <div className="warehouse-overview">
      <div><strong>{n(ordered.length)}</strong><span>складов в расчёте</span></div>
      <div><strong className={emptyCount?'warehouse-number-danger':''}>{n(emptyCount)}</strong><span>без остатка</span></div>
      <div><strong className={urgentCount?'warehouse-number-warning':''}>{n(urgentCount)}</strong><span>с запасом менее 14 дней</span></div>
      {unknownCount>0&&<div><strong>{n(unknownCount)}</strong><span>без полного прогноза</span></div>}
    </div>
    <div className="warehouse-plan-summary">
      <div>
        <span>Рекомендуется отгрузить до {date(targetDate)}</span>
        <strong>{plan.unknown===plan.rows.length?'Недостаточно данных':n(plan.total)+' ед.'}</strong>
      </div>
      {plan.unknown>0&&<small>Для {n(plan.unknown)} из {n(plan.rows.length)} складов не хватает данных — итог может быть неполным.</small>}
    </div>
    <div className="warehouse-grid">
      <div className="warehouse-grid-head">
        <span>Склад</span>
        <span>Остаток</span>
        <span>Продажи / расход (фактический период)</span>
        <span>Хватит на</span>
        <span>К отгрузке</span>
      </div>
      {visible.map(w=><div className="warehouse-grid-row" key={w.warehouse_id}>
        <div className="warehouse-place" title={'ID '+w.warehouse_id}>
          <strong>{w.warehouse_name||'Склад Ozon'}</strong>
        </div>
        <div className="warehouse-stock">
          <strong>{n(w.available)} <small>ед.</small></strong>
        </div>
        <div className="warehouse-rate">
          <strong>{enough&&w.rate!==null?n(w.units)+' ед. за '+n(w.analysis_days)+' дн.':'—'}</strong>
          <small>{w.rate===null?'Недостаточно данных':n(w.rate)+' ед./день · '+n(w.orders)+' заказов'}</small>
        </div>
        <div className="warehouse-cover">
          <Days value={w}/>
          <small>{w.state==='empty'?'Уже нет в наличии':w.state==='estimated'&&w.ends_at?'до '+date(w.ends_at):'Дата не определена'}</small>
        </div>
        <div className="warehouse-replenishment">
          {w.replenishment_quantity===null
            ?<span className="forecast-plan-unknown">Нет данных</span>
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

  return <>
    <section className="panel replenishment-panel">
      <div className="forecast-header">
        <div>
          <h3>Прогноз пополнения</h3>
        </div>
        <div className="forecast-period">
          <span className="forecast-period-label">Минимальный период анализа продаж</span>
          <small className="forecast-period-hint">Если заказов мало, программа автоматически расширит анализ до доступных 90 дней.</small>
          <div className="forecast-windows" aria-label="Период истории заказов">
            {[[7,'7 дней'],[14,'14 дней'],[30,'30 дней'],[90,'90 дней']].map(([v,label])=>
              <button type="button" key={v} onClick={()=>setWindow(v)} className={window===v?'selected':''}>{label}</button>
            )}
          </div>
          {data&&<p className="muted forecast-period-dates">
            История в базе: {date(data.period_start+'T00:00:00+03:00')} — {date(data.period_end+'T00:00:00+03:00')} ({n(data.coverage_days)} дн.)
          </p>}
        </div>
      </div>

      <div className="forecast-planning">
        <div className="forecast-planning-copy">
          <strong>Спрогнозировать пополнение до даты</strong>
          <span>Потребность рассчитывается отдельно для каждого склада по его истории продаж.</span>
          <small>Если меньше 3 заказов, период анализа расширяется до 90 дней. При истории короче 30 дней и редких продажах расход не экстраполируется, чтобы не завышать отгрузку.</small>
          <small>Округление вверх до целой штуки. Пока без страхового запаса, срока доставки и товаров в пути.</small>
        </div>
        <div className="forecast-planning-inputs">
          <label className="forecast-target-date">
            <span>Дата, до которой обеспечить запас</span>
            <input type="date" value={effectiveTargetDate} min={anchorDate||undefined} disabled={!data?.at||busy} onChange={e=>setTargetDate(e.target.value)}/>
          </label>
          <div className="forecast-date-presets" aria-label="Быстрый выбор срока">
            {[[30,'30 дней'],[60,'60 дней'],[90,'90 дней']].map(([days,label])=><button type="button" key={days} className={horizonDays===days?'selected':''} disabled={!anchorDate||busy} onClick={()=>setTargetDate(shiftDate(anchorDate,days))}>{label}</button>)}
          </div>
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
        rows.map(p=>{
          const plan=planWarehouses(p.warehouses,horizonDays);
          const planAvailable=plan.rows.length>0&&plan.unknown<plan.rows.length;
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
              <div className="forecast-product-secondary">
                {mode==='local'?<>
                  <strong>{n(p.warehouses.length)}</strong>
                  <span>складов</span>
                </>:<>
                  <Days value={p.total}/>
                  <span>{p.total.state==='empty'?'Запас отсутствует':p.total.ends_at?'до '+date(p.total.ends_at):'Срок не определён'}</span>
                </>}
              </div>
              <div className="forecast-product-plan">
                <strong>{planAvailable?n(plan.total):'—'}{planAvailable&&<small> ед.</small>}</strong>
                <span>К отгрузке</span>
                {plan.unknown>0&&<small>{n(plan.unknown)} без расчёта</small>}
              </div>
              <span className="forecast-expand-arrow">⌄</span>
            </summary>

            <div className="forecast-product-details">
              {p.missing_warehouse_units>0&&<p className="forecast-inline-warning">
                Для {n(p.missing_warehouse_units)} заказанных единиц не указан склад отгрузки. Их нельзя распределить по отдельным складам.
              </p>}
              {mode==='local'?<>
                <WarehouseList warehouses={p.warehouses} enough={data.enough} horizonDays={horizonDays} targetDate={effectiveTargetDate}/>
              </>:<>
                <div className="pooled-metrics">
                  <div><span>Доступно на всех складах</span><strong>{n(p.total.available)} <small>ед.</small></strong></div>
                  <div>
                    <span>Общий расход</span>
                    <strong>{n(p.total.rate)} <small>ед./день</small></strong>
                    <small className="pooled-subline">Расчёт: {n(p.total.units)} ед. за {n(p.total.analysis_days)} дн. · {n(p.total.orders)} заказов</small>
                  </div>
                  <div>
                    <span>Хватит без пополнения</span>
                    <strong><Days value={p.total}/></strong>
                    <small className="pooled-subline">{p.total.ends_at?'до '+date(p.total.ends_at):'Дата исчерпания не определена'}</small>
                  </div>
                  <div>
                    <span>К отгрузке до {date(effectiveTargetDate)}</span>
                    <strong>{planAvailable?n(plan.total)+' ед.':'Недостаточно данных'}</strong>
                    {plan.unknown>0&&<small className="pooled-subline">{n(plan.unknown)} складов без расчёта</small>}
                  </div>
                </div>
                <p className="forecast-pooled-note">Общий остаток и расход показаны для планирования закупки у производителя. Количество к отгрузке — сумма потребности каждого склада отдельно: запас одного склада не уменьшает потребность другого.</p>
              </>}
            </div>
          </details>;
        })
      }
    </section>

  </>;
}

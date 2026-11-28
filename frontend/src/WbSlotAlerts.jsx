import React, {useEffect, useState} from 'react';
import {Bell, CircleCheck, Clock3, Trash2} from 'lucide-react';
import './wb-slot-alerts.css';

const updateInterval = 20_000;
const labels = {
  found: 'Приёмка открылась',
  waiting: 'Ожидаем приёмку',
  outside_window: 'Дата пока вне горизонта WB',
  expired: 'Дата прошла',
  error: 'Проверка временно недоступна',
};
const showDate = value => value ? value.split('-').reverse().join('.') : '';
const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short',
});

export default function WbSlotAlerts({accountId, api}) {
  const path = '/wb/accounts/' + encodeURIComponent(accountId);
  const [data, setData] = useState(null);
  const [options, setOptions] = useState([]);
  const [warehouse, setWarehouse] = useState('');
  const [box, setBox] = useState('');
  const [day, setDay] = useState('');
  const [optionsError, setOptionsError] = useState('');
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    api(path + '/slot-options').then(response => {
      if (active) setOptions(response.options);
    }).catch(error => {
      if (active) setOptionsError(error.message);
    }).finally(() => {
      if (active) setLoadingOptions(false);
    });
    return () => { active = false; };
  }, [path, api, retry]);

  useEffect(() => {
    if (busy) return;
    let active = true;
    let timer;
    async function refresh() {
      try {
        const response = await api(path + '/slot-watches');
        if (active) {
          setData(response);
          setListError('');
        }
      } catch (error) {
        if (active) setListError(error.message);
      } finally {
        if (active) timer = setTimeout(refresh, updateInterval);
      }
    }
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, api, busy]);

  const warehouses = [...new Map(options.map(option => [option.warehouse_id, option.warehouse_name]))];
  const packaging = options.filter(option => String(option.warehouse_id) === warehouse);

  async function update(suffix, body) {
    setBusy(true);
    setActionError('');
    try {
      setData(await api(path + '/slot-watches' + suffix, body));
    } catch (error) {
      setActionError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (warehouse && box && day && !busy) {
      update('', {date: day, warehouse_id: Number(warehouse), box_type_id: Number(box)});
    }
  }

  return <div className="wb-slot-page">
    <header>
      <h1>Уведомления о доступных слотах</h1>
      <p className="muted">ИСК проверяет приёмку по данным WB раз в минуту, даже при закрытой вкладке.</p>
    </header>
    <section className="panel wb-slot-panel">
      <h2>Добавить наблюдение</h2>
      <form className="wb-slot-form" onSubmit={submit}>
        <label className="field">Склад
          <select required value={warehouse} disabled={!warehouses.length || busy}
            onChange={event => { setWarehouse(event.target.value); setBox(''); }}>
            <option value="">{loadingOptions ? 'Загружаем склады…' : 'Выберите склад'}</option>
            {warehouses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="field">Тип упаковки
          <select required value={box} disabled={!packaging.length || busy} onChange={event => setBox(event.target.value)}>
            <option value="">Выберите тип</option>
            {packaging.map(option => <option key={option.box_type_id} value={option.box_type_id}>{option.box_type_name}</option>)}
          </select>
        </label>
        <label className="field">Дата поставки
          <input type="date" required min={data?.today} value={day} disabled={busy} onChange={event => setDay(event.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={!warehouse || !box || !day || busy}>
          <Bell size={16} aria-hidden="true"/> Начать наблюдение
        </button>
      </form>
      {optionsError && <div className="wb-slot-error" role="alert">
        <p>{optionsError}</p>
        <button type="button" onClick={() => { setOptionsError(''); setLoadingOptions(true); setRetry(value => value + 1); }}>Повторить</button>
      </div>}
      {!loadingOptions && !optionsError && !options.length && <p className="muted">WB пока не вернул список складов и упаковок.</p>}
      <p className="muted">WB публикует данные на 14 дней. Когда дата попадёт в этот период, начнётся проверка.</p>
    </section>
    <section className="panel wb-slot-panel">
      <h2>Мои наблюдения</h2>
      {(listError || actionError) && <p className="wb-slot-error" role="alert">{actionError || listError}</p>}
      {!data && !listError && <p className="muted">Загружаем наблюдения…</p>}
      {data?.watches.length === 0 && <p className="muted">Добавь склад, тип упаковки и дату, чтобы начать проверку.</p>}
      <div className="wb-slot-list" aria-live="polite">
        {data?.watches.map(watch => <article key={watch.id} className={'wb-slot-watch ' + watch.status}>
          <div>
            <strong>{showDate(watch.date)} · {watch.warehouse_name}</strong>
            <p className="muted">{watch.box_type_name}</p>
            <p className="wb-slot-status">
              {watch.status === 'found' ? <CircleCheck size={16}/> : <Clock3 size={16}/>}
              {labels[watch.status]}
              {watch.status === 'found' && ' · Коэффициент ' + watch.coefficient}
            </p>
            {watch.error && watch.status === 'error' && <p className="wb-slot-error">{watch.error}</p>}
            {watch.found_at && <p className="muted">Обнаружено {timeFormat.format(new Date(watch.found_at))}. Проверь дату поставки в кабинете WB.</p>}
            {watch.checked_at && !watch.found_at && <p className="muted">Проверено {timeFormat.format(new Date(watch.checked_at))}</p>}
          </div>
          <button type="button" disabled={busy} aria-label={'Удалить наблюдение на ' + showDate(watch.date)}
            onClick={() => update('/remove', {id: watch.id})}><Trash2 size={16} aria-hidden="true"/></button>
        </article>)}
      </div>
    </section>
  </div>;
}

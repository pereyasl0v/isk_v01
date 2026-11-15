"use client";
import {useEffect,useMemo,useState} from "react";
import {
  OZON_DEFAULTS, calculateOzonScenarios, parseOzonCaptureText
} from "./ozon-calc.mjs";

const LEGACY_KEY = "market-calculate-ozon-v1";
const empty = {prices:{}, products:{}, inputs:{}, importedSources:{}};
const n = value => Math.max(0, Number(String(value ?? "").replace(",", ".")) || 0);
const rub = value => new Intl.NumberFormat("ru-RU", {maximumFractionDigits:0}).format(Number.isFinite(value) ? value : 0) + " ₽";
const rub2 = value => new Intl.NumberFormat("ru-RU", {maximumFractionDigits:2}).format(Number.isFinite(value) ? value : 0) + " ₽";

function NumberField({label,value,onChange,step="any"}) {
  return <div className="field"><label>{label}</label><input type="number" min="0" step={step} value={value ?? 0} onChange={e=>onChange(e.target.value)} /></div>;
}
function TextField({label,value,onChange}) {
  return <div className="field"><label>{label}</label><input type="text" value={value ?? ""} onChange={e=>onChange(e.target.value)} /></div>;
}

export default function OzonCalculator({items=[], selectedId="", onSelect=()=>{}, userId, isAdmin=false}) {
  const storageKey = LEGACY_KEY + ":" + userId;
  const [state,setState] = useState(empty);
  const [ready,setReady] = useState(false);
  const [message,setMessage] = useState("");

  useEffect(()=>{
    try {
      let raw=localStorage.getItem(storageKey);
      if(!raw&&isAdmin){raw=localStorage.getItem(LEGACY_KEY);if(raw){localStorage.setItem(storageKey,raw);localStorage.removeItem(LEGACY_KEY)}}
      if(raw) setState({...empty,...JSON.parse(raw)});
    } catch {}
    setReady(true);
  },[storageKey,isAdmin]);
  useEffect(()=>{
    if(ready) localStorage.setItem(storageKey,JSON.stringify(state));
  },[state,ready,storageKey]);

  const item = items.find(x=>x.id===selectedId) || items[0] || null;
  const itemId = item?.id || "";
  const input = {...OZON_DEFAULTS,...(state.inputs[itemId]||{})};
  const entries = state.prices[itemId] || Array(10).fill("");
  const prices = entries.map(n).filter(value=>value>0);
  const scenarios = useMemo(
    ()=>calculateOzonScenarios(prices,item ? n(item.landedCostPerUnit ?? (n(item.yuan)*n(item.rate)+n(item.freight))) : 0,input),
    [entries.join("|"),item?.id,item?.yuan,item?.rate,item?.freight,item?.landedCostPerUnit,JSON.stringify(input)]
  );
  const updateInput = changes => {
    if(!itemId) return;
    setState(current=>({...current,inputs:{
      ...current.inputs,[itemId]:{...OZON_DEFAULTS,...(current.inputs[itemId]||{}),...changes}
    }}));
  };
  const updatePrices = values => setState(current=>({...current,prices:{...current.prices,[itemId]:values}}));

  async function importCapture(file) {
    if(!file || !item) {setMessage("Сначала добавьте товар на вкладке «Себестоимость».");return;}
    try {
      if(file.size>20*1024*1024) throw new Error("Файл больше 20 МБ.");
      const result=parseOzonCaptureText(await file.text());
      if(result.query && result.query.trim().toLowerCase()!==item.name.trim().toLowerCase()) {
        if(!confirm("В файле запрос «"+result.query+"», а выбран товар «"+item.name+"». Использовать эти цены?")) return;
      }
      const values=result.products.map(p=>p.price_rub??"").concat(Array(10).fill("")).slice(0,10);
      updatePrices(values);
      setState(current=>({...current,
        prices:{...current.prices,[itemId]:values},
        products:{...current.products,[itemId]:result.products},
        importedSources:{...current.importedSources,[itemId]:result.source}
      }));
      setMessage("Импортировано карточек: "+result.products.length+". Файл обработан локально в браузере.");
    } catch(error) {setMessage("Не удалось импортировать JSON: "+error.message);}
  }

  const columns=scenarios.flatMap(s=>[
    {key:s.key+"-fbo",label:({min:"Минимум",median:"Медиана",average:"Среднее"})[s.key]+" · FBO",result:s.fbo},
    {key:s.key+"-fbs",label:({min:"Минимум",median:"Медиана",average:"Среднее"})[s.key]+" · FBS",result:s.fbs}
  ]);
  const rows=[
    ["Цена на витрине",r=>r.buyerPrice,false],
    ["Модельная ПЦТ",r=>r.pctl,false],
    ["Кп по сценарию",r=>r.kpPct,false,"%"],
    ["Вознаграждение Ozon",r=>-r.commission,true],
    ["Эквайринг",r=>-r.acquiring,true],
    ["Обработка отправления",r=>-r.handling,true],
    ["Логистика",r=>-r.logistics,true],
    ["Доставка до места выдачи",r=>-r.lastMile,true],
    ["Резерв обратной логистики",r=>-r.reverseReserve,true],
    ["Хранение",r=>-r.storage,true],
    ["Прочие расходы",r=>-r.other,true],
    ["Затраты на Ozon за шт.",r=>-r.ozonCosts,true],
    ["К начислению за товар",r=>r.payout,false],
    ["Налог",r=>-r.tax,true],
    ["Себестоимость",r=>-r.cost,true],
    ["Итоговая прибыль",r=>r.profit,false],
    ["Маржа",r=>r.margin,false,"%"]
  ];

  return <div className="wrap">
    <section className="panel">
      <div className="flex space"><h2>Поиск ТОП-10 на Ozon</h2><a href="https://seller-edu.ozon.ru/libra/commissions-tariffs/legal-information/full-actual-commissions" target="_blank" rel="noreferrer">Официальные тарифы Ozon</a></div>
      <div className="grid">
        <div className="field"><label>Выберите товар из себестоимости</label><select value={itemId} onChange={e=>onSelect(e.target.value)}>{items.length?items.map(x=><option key={x.id} value={x.id}>{x.name} · {rub(n(x.yuan)*n(x.rate)+n(x.freight))}</option>):<option value="">Сначала добавьте товар</option>}</select></div>
        <div className="field"><label>Поисковый запрос</label><input value={item?.name||""} readOnly /></div>
      </div>
      <div className="notice">Расширение считывает карточки, которые Ozon уже показал в вашем браузере. Оно не использует закрытый API и не обходит ограничения. Сейчас экспортируются первые 10 видимых карточек, а не гарантированно 10 уникальных продавцов.</div>
      <div className="actions">
        <label className="btn" style={{cursor:"pointer"}}>Импорт ТОП-10 JSON <input type="file" accept=".json,application/json" hidden onChange={async e=>{await importCapture(e.target.files?.[0]);e.target.value="";}} /></label>
        {item&&<a href={"https://www.ozon.ru/search/?text="+encodeURIComponent(item.name)} target="_blank" rel="noreferrer">Открыть поиск Ozon</a>}
        <a href="https://github.com/pereyasl0v/isk_v01/tree/feature/ozon-digitization/extension/ozon-capture" target="_blank" rel="noreferrer">Расширение Ozon в GitHub</a>
      </div>
      {message&&<p className="muted" role="status">{message}</p>}
      {item&&<p className="muted">Себестоимость выбранного товара: <b>{rub(n(item.yuan)*n(item.rate)+n(item.freight))}</b>. Цены из поиска — витринные цены покупателя; цену продавца и скидки Ozon нельзя достоверно восстановить только по карточке.</p>}
      {item&&(state.products[itemId]||[]).length>0&&<div className="scroll"><table><thead><tr><th>№</th><th>Товар</th><th>Цена на витрине</th></tr></thead><tbody>{state.products[itemId].map(p=><tr key={p.id||p.position}><td>{p.position}</td><td>{p.url?<a href={p.url} target="_blank" rel="noreferrer">{p.name}</a>:p.name}</td><td>{rub(p.price_rub)}</td></tr>)}</tbody></table></div>}
      <h3>Цены первых 10 карточек (можно исправить вручную)</h3>
      <div className="grid">{entries.map((value,index)=><NumberField key={index} label={"Карточка "+(index+1)+", ₽"} value={value} onChange={v=>{const next=[...entries];next[index]=v;updatePrices(next);}} />)}</div>
      <p className="muted">Цен для статистики: {prices.length} из 10. {state.importedSources[itemId]?"Источник: "+state.importedSources[itemId]+".":""}</p>
    </section>

    <section className="panel">
      <h2>Параметры тарифа и товара Ozon</h2>
      <p className="muted">Ставки 23%, 1%, 29 ₽, 25 ₽ и 10 ₽ предварительно взяты из твоего XLSX-примера. Загруженная страница Ozon указывает, что описанные условия действуют с 1 декабря 2026 года. Для большинства категорий на FBO/FBS указаны 17% для товаров до 100 ₽ и 23% для 101–300 ₽; для Fashion есть отдельные условия. Комиссия рассчитывается по формуле Ozon через ПЦТ, ПП, Км и Кп. Для расчётов до 1 декабря проверь текущую редакцию тарифов.</p>
      <div className="grid">
        <TextField label="Категория Ozon" value={input.category} onChange={v=>updateInput({category:v})}/>
        <NumberField label="Объём товара, л" value={input.volumeL} onChange={v=>updateInput({volumeL:v})}/>
        <NumberField label="Вес товара, кг" value={input.weightKg} onChange={v=>updateInput({weightKg:v})}/>
        <NumberField label="Предельная ставка ПП, %" value={input.commissionPct} onChange={v=>updateInput({commissionPct:v})}/>
        <NumberField label="Модификатор ставки Км, %" value={input.commissionModifierPct} onChange={v=>updateInput({commissionModifierPct:v})}/>
        <NumberField label="Выплаты по механикам лояльности, ₽" value={input.loyaltyPayoutRub} onChange={v=>updateInput({loyaltyPayoutRub:v})}/>
        <NumberField label="Эквайринг банка, %" value={input.acquiringPct} onChange={v=>updateInput({acquiringPct:v})}/>
        <NumberField label="Логистика FBO, ₽" value={input.fboLogistics} onChange={v=>updateInput({fboLogistics:v})}/>
        <NumberField label="Логистика FBS, ₽" value={input.fbsLogistics} onChange={v=>updateInput({fbsLogistics:v})}/>
        <NumberField label="Обработка отправления FBS, ₽" value={input.fbsHandling} onChange={v=>updateInput({fbsHandling:v})}/>
        <NumberField label="Доставка до места выдачи, ₽" value={input.lastMile} onChange={v=>updateInput({lastMile:v})}/>
        <NumberField label="Хранение на единицу, ₽" value={input.storage} onChange={v=>updateInput({storage:v})}/>
        <NumberField label="Прочие расходы FBO, ₽" value={input.fboOther} onChange={v=>updateInput({fboOther:v})}/>
        <NumberField label="Прочие расходы FBS, ₽" value={input.fbsOther} onChange={v=>updateInput({fbsOther:v})}/>
        <NumberField label="Налог, %" value={input.taxPct} onChange={v=>updateInput({taxPct:v})}/>
        <NumberField label="Доля возвратов для резерва, %" value={input.returnRatePct} onChange={v=>updateInput({returnRatePct:v})}/>
      </div>
      <div className="field" style={{marginTop:18}}>
        <label>Коэффициент снижения тарифа Кр: {input.krPct}%</label>
        <input type="range" min="0" max="100" step="1" value={input.krPct} onChange={e=>updateInput({krPct:Number(e.target.value)})}/>
        <p className="muted">Применяется к введённым предельным тарифам логистики и доставки до места выдачи по формуле Ozon. Если введённые суммы уже фактические, оставь Кр = 0%.</p>
      </div>
      <div className="field" style={{marginTop:16}}>
        <label>Модельное снижение цены относительно ПЦТ: {input.priceDiscountPct}%</label>
        <input type="range" min="0" max="90" step="1" value={input.priceDiscountPct} onChange={e=>updateInput({priceDiscountPct:Number(e.target.value)})}/>
        <p className="muted">Это сценарное допущение: ПЦТ = цена на витрине ÷ (1 − процент). По нему рассчитывается Кп; это не измеренная скидка Ozon и не подтверждённый аналог СПП. В первой версии выручка продавца для начисления, эквайринга и налога принимается равной видимой цене продажи.</p>
      </div>
    </section>

    <section className="panel">
      <h2>Расчёт прибыли: три ценовых сценария × FBO / FBS</h2>
      {columns.length?<div className="scroll"><table><thead><tr><th>Статья расходов</th>{columns.map(c=><th key={c.key}>{c.label}</th>)}</tr></thead><tbody>
        {rows.map(([label,getter,isExpense,suffix])=><tr key={label}><td><b>{label}</b></td>{columns.map(c=>{const value=getter(c.result);return <td key={c.key}>{suffix==="%"?value.toFixed(1)+"%":(value<0?"−":"")+rub2(Math.abs(value))}</td>})}</tr>)}
      </tbody></table></div>:<p className="notice">Импортируй или введи цены, чтобы увидеть минимальный, медианный и средний сценарии. Для точной статистики нужны все 10 карточек.</p>}
      <p className="muted">«К начислению» — видимая цена продажи минус удержания Ozon, до налога и себестоимости. В модели не предполагаются неизвестные субсидии Ozon продавцу. «Итоговая прибыль» дополнительно вычитает налог и себестоимость. Резерв обратной логистики — ожидаемая оценка по указанной доле возвратов, а не обязательное списание с каждого заказа.</p>
    </section>
  </div>;
}

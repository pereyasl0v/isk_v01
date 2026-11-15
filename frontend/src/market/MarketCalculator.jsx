"use client";
import {useEffect,useMemo,useState} from "react";
import {parseWBCaptureText,normalizedQuery} from "./wb-import.mjs";
import OzonCalculator from "./OzonCalculator";
const KEY="market-calculate-react-v1";
const empty={items:[],page:"items",section:"selected",selectedId:"",spp:20,prices:{},settings:{commission:25,delivery:95,storage:0,advertising:0,other:0,tax:6}};
const n=x=>Math.max(0,Number(String(x??"").replace(",","."))||0);
const rub=x=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:2}).format(Number.isFinite(x)?x:0)+" ₽";
const cost=x=>n(x.yuan)*n(x.rate)+n(x.freight);
const average=a=>a.reduce((x,y)=>x+y,0)/a.length;
const median=a=>a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
function Field({label,value,onChange}) {return <div className="field"><label>{label}</label><input type="number" min="0" step="any" value={value} onChange={e=>onChange(e.target.value)} /></div>;}
export default function Calculator(){
 const [s,S]=useState(empty),[ready,R]=useState(false),[busy,B]=useState(false),[message,M]=useState("");
 useEffect(()=>{try{const raw=localStorage.getItem(KEY);if(raw){const obj=JSON.parse(raw);S({...empty,...obj,settings:{...empty.settings,...obj.settings}})}}catch{}R(true)},[]);
 useEffect(()=>{if(ready)localStorage.setItem(KEY,JSON.stringify(s))},[s,ready]);
 const set=x=>S(v=>({...v,...x}));
 const item=s.items.find(x=>x.id===s.selectedId)||s.items[0];
 const update=(id,change)=>set({items:s.items.map(x=>x.id===id?{...x,...change}:x)});
 const entries=s.prices[item?.id]||Array(10).fill("");
 const values=entries.map(n).filter(x=>x>0).sort((a,b)=>a-b);
 const summary=values.length?{min:values[0],median:median(values),average:average(values)}:null;
 const results=useMemo(()=>summary&&item?Object.entries(summary).map(([label,buyer])=>{
  const seller=buyer/(1-s.spp/100),c=cost(item),fee=seller*n(s.settings.commission)/100,tax=seller*n(s.settings.tax)/100;
  const other=n(s.settings.delivery)+n(s.settings.storage)+n(s.settings.advertising)+n(s.settings.other);
  const profit=seller-fee-tax-other-c;
  return {label,buyer,seller,c,fee,tax,other,profit,margin:profit/seller*100,roi:c?profit/c*100:0};
 }):[] ,[item,summary?.min,summary?.median,summary?.average,s.spp,s.settings]);
 async function find(){
  if(!item?.name?.trim()){M("Введите название товара для поиска");return}
  B(true);M("Запрашиваем WB через FastAPI...");
  try {
   const res=await fetch("/api/wb/search?query="+encodeURIComponent(item.name));
   const json=await res.json();
   if(!res.ok){const detail=json.detail;const why=typeof detail==="object"?(detail?.message||"Ошибка API"):String(detail||"Ошибка API");const attempts=Array.isArray(detail?.attempts)?detail.attempts.slice(0,3).join(" | "):"";throw Error(why+(attempts?" · "+attempts:""))}
   const prices=json.products.map(x=>x.price_rub??"").concat(Array(10).fill("")).slice(0,10);
   if(!prices.some(x=>n(x)>0))throw Error("WB не вернул распознанные цены");
   set({prices:{...s.prices,[item.id]:prices},products:{...(s.products||{}),[item.id]:json.products}});
   M("Получено "+json.products.length+" карточек из "+json.source+". Цены из JSON могут отличаться от цены на странице WB.");
  }catch(e){M("Серверный поиск недоступен: "+e.message+". Если WB возвращает HTTP 403, импортируйте HAR или JSON из своего браузера — это не зависит от доступа VPS к WB.")}finally{B(false)}
 }
 function exportData(){const blob=new Blob([JSON.stringify(s,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="market-calculate-backup.json";a.click();URL.revokeObjectURL(url)}
 async function importData(file){if(!file)return;try{const obj=JSON.parse(await file.text());if(!Array.isArray(obj.items)||!obj.prices)throw Error("Неверный формат");S({...empty,...obj,settings:{...empty.settings,...obj.settings}})}catch(e){M("Ошибка импорта: "+e.message)}}
 async function importWBCapture(file){
  if (!file || !item) {M("Сначала добавьте товар в разделе себестоимости.");return;}
  if (file.size > 100 * 1024 * 1024) {M("Файл слишком большой (максимум 100 МБ).");return;}
  try {
    const result = parseWBCaptureText(await file.text(), item.name);
    if (result.query && normalizedQuery(result.query) !== normalizedQuery(item.name)) {
      if (!confirm("В файле запрос «"+result.query+"», а выбран товар «"+item.name+"». Использовать эти цены для выбранного товара?")) return;
    }
    const values = result.products.map(p=>p.price_rub??"").concat(Array(10).fill("")).slice(0,10);
    if (!values.some(p=>n(p)>0)) throw Error("В сохранённой выдаче нет цен.");
    set({
      prices:{...s.prices,[item.id]:values},
      products:{...(s.products||{}),[item.id]:result.products},
      importedSources:{...(s.importedSources||{}),[item.id]:result.source}
    });
    M("Загружено "+result.products.length+" карточек: "+result.source+". HAR обработан только внутри браузера, на сервер не отправлялся. Цены из JSON могут отличаться от цены на витрине.");
  } catch(e) {M("Не удалось импортировать: "+e.message);}
 }
 const tabs=<div className="tabs"><button className={"btn "+(s.page==="items"?"selected":"secondary")} onClick={()=>set({page:"items"})}>Себестоимость</button><button className={"btn "+(s.page==="calc"?"selected":"secondary")} onClick={()=>set({page:"calc"})}>Калькулятор WB</button><button className={"btn "+(s.page==="ozon"?"selected":"secondary")} onClick={()=>set({page:"ozon"})}>Калькулятор Ozon</button></div>;
 return <div className="wrap">{tabs}
 {s.page==="items"? <>
 <div className="tabs">{[["selected","Отбираемые"],["archive","Архив"],["delivered","Осуществлённые поставки"]].map(([k,v])=><button key={k} className={"btn "+(s.section===k?"selected":"secondary")} onClick={()=>set({section:k})}>{v}</button>)}</div>
 <section className="panel"><div className="flex space"><h2>Себестоимость 1688</h2><button className="btn" onClick={()=>{const id=crypto.randomUUID();set({items:[...s.items,{id,name:"Новый товар",yuan:0,rate:12,freight:0,status:s.section}],selectedId:id})}}>+ Добавить товар</button></div>
 <p className="muted">Цена в юанях × курс руб./юань + доставка из Китая в рублях.</p><div className="scroll"><table><thead><tr><th>Название для поиска</th><th>1688, ¥</th><th>Курс, ₽/¥</th><th>Логистика, ₽</th><th>Итого, ₽</th><th>Действия</th></tr></thead><tbody>{s.items.filter(x=>x.status===s.section).map(x=><tr key={x.id}><td><input aria-label="Название" value={x.name} onChange={e=>update(x.id,{name:e.target.value})}/></td>{["yuan","rate","freight"].map(k=><td key={k}><input aria-label={k} type="number" min="0" value={x[k]} onChange={e=>update(x.id,{[k]:e.target.value})}/></td>)}<td><b>{rub(cost(x))}</b></td><td><select aria-label="Статус" value={x.status} onChange={e=>update(x.id,{status:e.target.value})}>{[["selected","Отбираемые"],["archive","Архив"],["delivered","Поставка"]].map(([a,b])=><option value={a} key={a}>{b}</option>)}</select><button className="btn secondary" onClick={()=>{if(confirm("Удалить товар?"))set({items:s.items.filter(y=>y.id!==x.id)})}}>Удалить</button></td></tr>)}{!s.items.some(x=>x.status===s.section)&&<tr><td colSpan="6">Здесь пока нет товаров.</td></tr>}</tbody></table></div></section>
 <div className="panel"><div className="actions"><button className="btn secondary" onClick={exportData}>Экспорт JSON</button><label className="btn secondary" style={{cursor:"pointer"}}>Импорт JSON <input type="file" accept=".json" hidden onChange={e=>importData(e.target.files?.[0])}/></label></div><p className="muted">Данные пока сохраняются в браузере. Для переноса на другой телефон экспортируйте JSON.</p></div>
 </>:s.page==="ozon"?<OzonCalculator items={s.items} selectedId={s.selectedId} onSelect={id=>set({selectedId:id})}/>:<>
 <section className="panel"><h2>Поиск ТОП-10 на Wildberries</h2>
 <div className="grid"><div className="field"><label>Выберите товар</label><select value={item?.id||""} onChange={e=>set({selectedId:e.target.value})}>{s.items.map(x=><option key={x.id} value={x.id}>{x.name} · {rub(cost(x))}</option>)}</select></div><div className="field"><label>Поисковый запрос</label><input value={item?.name||""} readOnly /></div></div>
 <p className="notice">WB возвращает HTTP 403 на запросы с VPS. Поэтому рекомендуемый способ сейчас — импорт HAR из Network или JSON, сохранённого браузерным скриптом. Файл разбирается локально в твоём браузере, не загружается на FastAPI. Цена product в JSON может отличаться от цены на сайте; СПП конкурентов неизвестна.</p>
 <div className="actions"><label className="btn" style={{cursor:"pointer"}}>Импорт HAR / JSON <input type="file" accept=".har,.json,application/json" hidden onChange={async e=>{await importWBCapture(e.target.files?.[0]);e.target.value="";}} /></label><button className="btn secondary" disabled={!item||busy} onClick={find}>{busy?"Поиск...":"Повторить через FastAPI (эксперимент)"}</button>{item&&<a target="_blank" rel="noopener noreferrer" href={"https://www.wildberries.ru/catalog/0/search.aspx?search="+encodeURIComponent(item.name)}>Открыть выдачу WB</a>}<a target="_blank" rel="noopener noreferrer" href="https://github.com/pereyasl0v/isk_v01/tree/feature/ozon-digitization/extension/wb-capture">Скрипт экспорта WB</a></div><p className="muted">Для HAR: открой поиск на WB, сохрани Network → Export HAR with content и импортируй файл здесь. HAR может содержать cookies и токены, не публикуй его. При импорте сохраняются только товары и цены.</p>
 {message&&<p role="status" className="muted">{message}</p>}
 {(s.products?.[item?.id]||[]).length>0&&<div className="scroll"><table><thead><tr><th>№</th><th>Карточка</th><th>product из JSON, ₽</th><th>basic из JSON, ₽</th></tr></thead><tbody>{s.products[item.id].map(p=><tr key={p.position}><td>{p.position}</td><td><a href={"https://www.wildberries.ru/catalog/"+encodeURIComponent(p.id)+"/detail.aspx"} target="_blank" rel="noopener noreferrer">{p.name}</a></td><td>{p.price_rub??"—"}</td><td>{p.basic_price_rub??"—"}</td></tr>)}</tbody></table></div>}
 <h3>Цены для расчёта (можно исправить вручную)</h3><div className="grid">{entries.map((v,i)=><Field key={i} label={"Позиция "+(i+1)+" · цена из JSON, ₽"} value={v} onChange={value=>{const a=[...entries];a[i]=value;set({prices:{...s.prices,[item.id]:a}})}}/>)}</div><p className="muted">Введено: {values.length} из 10. {values.length!==10?"Статистики предварительные до заполнения всех десяти цен.":""}</p>
 </section>
 <section className="panel"><h2>Расходы WB</h2><div className="grid">{[["commission","Комиссия WB, %"],["delivery","Логистика WB, ₽"],["storage","Хранение, ₽"],["advertising","Реклама, ₽"],["other","Прочие, ₽"],["tax","Налог с выручки, %"]].map(([k,label])=><Field key={k} label={label} value={s.settings[k]} onChange={value=>set({settings:{...s.settings,[k]:value}})}/>)}</div></section>
 <section className="panel"><h2>Прибыль по трём сценариям</h2><div className="field"><label>Предполагаемая СПП: {s.spp}%</label><input type="range" min="0" max="99" value={s.spp} onChange={e=>set({spp:Number(e.target.value)})}/></div><p className="muted">СПП неизвестна: ползунок моделирует сценарий. Значение 100% исключено (деление на ноль). Комиссия и налог условно считаются от оценочной цены продавца; фактические удержания могут отличаться.</p>
 {results.length?<div className="stats">{results.map(r=><div className="stat" key={r.label}><span>{({min:"Минимальная",median:"Медианная",average:"Средняя"})[r.label]} цена из поискового JSON</span><b>{rub(r.buyer)}</b><p className="muted">Оценка цены продавца: {rub(r.seller)}<br/>Себестоимость: {rub(r.c)}<br/>Комиссия: −{rub(r.fee)}<br/>Налог: −{rub(r.tax)}<br/>Другие расходы: −{rub(r.other)}</p><hr/><span>Расчётная прибыль</span><b className={r.profit>=0?"green":"red"}>{rub(r.profit)}</b><p className="muted">Маржа: {r.margin.toFixed(1)}% · ROI: {r.roi.toFixed(1)}%</p></div>)}</div>:<p className="notice">Введите хотя бы одну цену конкурента и добавьте товар, чтобы увидеть расчёты.</p>}
 </section>
 </>}</div>;
}

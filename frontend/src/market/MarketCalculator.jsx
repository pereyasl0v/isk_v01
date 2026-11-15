"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {parseWBCaptureText,normalizedQuery} from "./wb-import.mjs";
import {withLandedCosts,calculateWorkspaceCosts} from "./costing.mjs";
import OzonCalculator from "./OzonCalculator";

const LEGACY_KEY="market-calculate-react-v1";
const empty={items:[],shipments:[],page:"items",section:"selected",selectedId:"",spp:20,prices:{},settings:{commission:25,delivery:95,storage:0,advertising:0,other:0,tax:6}};
const n=x=>Math.max(0,Number(String(x??"").replace(",","."))||0);
const rub=x=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:2}).format(Number.isFinite(x)?x:0)+" ₽";
const cost=x=>n(x.landedCostPerUnit??(n(x.yuan)*n(x.rate)+n(x.freight)));
const average=a=>a.reduce((x,y)=>x+y,0)/a.length;
const median=a=>a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;
const defaultShipment=()=>({id:"",name:"",departureDate:"",arrivalDate:"",status:"planned",packagingPerBoxUsd:0,autoFreightUsdPerKg:0,netWeightKg:0,grossWeightKg:0,boxCount:0,usdToYuanRate:6.8,yuanToRubRate:12.4,deliveryToSpbRub:0,deliveryToHomeRub:0,loadersRub:0,packingRub:0,distributionMethod:"weight"});
const shipmentStatuses=[["planned","Подготовка"],["in_transit","В пути"],["delivered","Доставлена"]];
const productStatuses=[["selected","Отбираемые"],["archive","Архив"],["delivered","Осуществлённые поставки"]];
async function request(path,method="GET",body){
 const response=await fetch("/api"+path,{credentials:"same-origin",method,headers:body===undefined?{}:{"Content-Type":"application/json","X-Local-App":"fbo"},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 if(!response.ok){const detail=data.detail;throw new Error(typeof detail==="string"?detail:(detail?.message||"Запрос не выполнен"));}
 return data;
}
function Field({label,value,onChange}) {return <div className="field"><label>{label}</label><input type="number" min="0" step="any" value={value??0} onChange={e=>onChange(e.target.value)} /></div>;}
function TextField({label,value,onChange,placeholder=""}) {return <div className="field"><label>{label}</label><input type="text" value={value??""} placeholder={placeholder} onChange={e=>onChange(e.target.value)} /></div>;}
function SelectField({label,value,onChange,options}) {return <div className="field"><label>{label}</label><select value={value??""} onChange={e=>onChange(e.target.value)}>{options.map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></div>;}
function base64FromBuffer(buffer){
 const bytes=new Uint8Array(buffer);let binary="";
 for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
 return btoa(binary);
}

export default function Calculator({userId,isAdmin=false}){
 const storageKey=LEGACY_KEY+":"+userId;
 const [s,S]=useState(empty),[ready,R]=useState(false),[workspaceReady,WR]=useState(false);
 const [busy,B]=useState(false),[message,M]=useState(""),[saving,setSaving]=useState(false);
 const [shipmentDraft,setShipmentDraft]=useState(null);
 const revisionRef=useRef(0),lastSavedRef=useRef(""),saveQueue=useRef(Promise.resolve());

 useEffect(()=>{
  let active=true;
  async function initialise(){
   let local={...empty};
   try{
    let raw=localStorage.getItem(storageKey);
    if(!raw&&isAdmin){raw=localStorage.getItem(LEGACY_KEY);if(raw){localStorage.setItem(storageKey,raw);localStorage.removeItem(LEGACY_KEY);}}
    if(raw){const parsed=JSON.parse(raw);local={...empty,...parsed,items:Array.isArray(parsed.items)?parsed.items:[],shipments:Array.isArray(parsed.shipments)?parsed.shipments:[],settings:{...empty.settings,...parsed.settings}};}
   }catch{}
   try{
    let remote=await request("/costing");
    if(!remote.products?.length&&!remote.shipments?.length&&local.items.length){
     remote=await request("/costing","PUT",{revision:remote.revision,products:local.items,shipments:local.shipments});
    }
    if(!active)return;
    revisionRef.current=remote.revision||0;
    lastSavedRef.current=JSON.stringify({products:remote.products||[],shipments:remote.shipments||[]});
    S({...local,items:remote.products||[],shipments:remote.shipments||[],selectedId:local.selectedId||(remote.products?.[0]?.id||"")});
   }catch(error){
    if(!active)return;
    S(local);M("Не удалось загрузить общую базу себестоимости: "+error.message+". Пока показаны локальные данные этого устройства.");
   }
   if(active){R(true);WR(true);}
  }
  initialise();
  return ()=>{active=false;};
 },[storageKey,isAdmin]);

 useEffect(()=>{if(ready){try{localStorage.setItem(storageKey,JSON.stringify(s));}catch{}}},[s,ready,storageKey]);

 useEffect(()=>{
  if(!workspaceReady)return;
  const snapshot={products:s.items||[],shipments:s.shipments||[]};
  const signature=JSON.stringify(snapshot);
  if(signature===lastSavedRef.current)return;
  const timer=setTimeout(()=>{
   setSaving(true);
   saveQueue.current=saveQueue.current.then(async()=>{
    if(signature===lastSavedRef.current)return;
    const saved=await request("/costing","PUT",{revision:revisionRef.current,...snapshot});
    revisionRef.current=saved.revision;
    lastSavedRef.current=signature;
    setSaving(false);
   }).catch(error=>{
    setSaving(false);
    M(error.message+" Если данные менялись на другом устройстве, обнови базу с сервера.");
   });
  },500);
  return ()=>clearTimeout(timer);
 },[s.items,s.shipments,workspaceReady]);

 const set=changes=>S(current=>({...current,...changes}));
 const shipments=s.shipments||[];
 const costs=useMemo(()=>calculateWorkspaceCosts(s.items,shipments),[s.items,shipments]);
 const costedItems=useMemo(()=>withLandedCosts(s.items,shipments),[s.items,shipments]);
 const item=costedItems.find(x=>x.id===s.selectedId)||costedItems[0];
 const update=(id,change)=>set({items:s.items.map(x=>x.id===id?{...x,...change}:x)});
 const entries=s.prices[item?.id]||Array(10).fill("");
 const values=entries.map(n).filter(x=>x>0).sort((a,b)=>a-b);
 const summary=values.length?{min:values[0],median:median(values),average:average(values)}:null;
 const results=useMemo(()=>summary&&item?Object.entries(summary).map(([label,buyer])=>{
  const seller=buyer/(1-s.spp/100),c=cost(item),fee=seller*n(s.settings.commission)/100,tax=seller*n(s.settings.tax)/100;
  const other=n(s.settings.delivery)+n(s.settings.storage)+n(s.settings.advertising)+n(s.settings.other);
  const profit=seller-fee-tax-other-c;
  return {label,buyer,seller,c,fee,tax,other,profit,margin:profit/seller*100,roi:c?profit/c*100:0};
 }):[],[item,summary?.min,summary?.median,summary?.average,s.spp,s.settings]);

 async function refreshWorkspace(){
  if(!confirm("Заменить текущие данные товаров и поставок последней версией с сервера?"))return;
  try{
   const remote=await request("/costing");
   revisionRef.current=remote.revision||0;
   lastSavedRef.current=JSON.stringify({products:remote.products||[],shipments:remote.shipments||[]});
   set({items:remote.products||[],shipments:remote.shipments||[],selectedId:remote.products?.[0]?.id||""});
   M("Данные обновлены с сервера.");
  }catch(error){M("Не удалось обновить данные: "+error.message);}
 }

 async function importLegacyExcel(file){
  if(!file)return;
  if(file.size>10*1024*1024){M("Excel-файл больше 10 МБ.");return;}
  B(true);M("Импортируем товары и поставки из Excel…");
  try{
   const file_base64=base64FromBuffer(await file.arrayBuffer());
   const result=await request("/costing/import-xlsx","POST",{filename:file.name,file_base64});
   const snapshot={products:result.products||[],shipments:result.shipments||[]};
   revisionRef.current=result.revision||0;
   lastSavedRef.current=JSON.stringify(snapshot);
   set({items:snapshot.products,shipments:snapshot.shipments,section:"shipments",selectedId:snapshot.products[0]?.id||""});
   M("Импортировано товаров: "+result.importedProducts+". Поставок: "+result.importedShipments+". Все данные сохранены на сервере.");
  }catch(error){M("Не удалось импортировать Excel: "+error.message);}
  finally{B(false);}
 }

 async function find(){
  if(!item?.name?.trim()){M("Введите название товара для поиска");return;}
  B(true);M("Запрашиваем WB через FastAPI...");
  try{
   const res=await fetch("/api/wb/search?query="+encodeURIComponent(item.name),{credentials:"same-origin"});
   const json=await res.json();
   if(!res.ok){const detail=json.detail;const why=typeof detail==="object"?(detail?.message||"Ошибка API"):String(detail||"Ошибка API");const attempts=Array.isArray(detail?.attempts)?detail.attempts.slice(0,3).join(" | "):"";throw Error(why+(attempts?" · "+attempts:""));}
   const prices=json.products.map(x=>x.price_rub??"").concat(Array(10).fill("")).slice(0,10);
   if(!prices.some(x=>n(x)>0))throw Error("WB не вернул распознанные цены");
   set({prices:{...s.prices,[item.id]:prices},products:{...(s.products||{}),[item.id]:json.products}});
   M("Получено "+json.products.length+" карточек из "+json.source+". Цены из JSON могут отличаться от цены на странице WB.");
  }catch(error){M("Серверный поиск недоступен: "+error.message+". Если WB возвращает HTTP 403, импортируйте HAR или JSON из своего браузера — это не зависит от доступа VPS к WB.");}
  finally{B(false);}
 }

 function exportData(){
  const blob=new Blob([JSON.stringify(s,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="market-calculate-backup.json";a.click();URL.revokeObjectURL(url);
 }
 async function importData(file){
  if(!file)return;
  try{const obj=JSON.parse(await file.text());if(!Array.isArray(obj.items)||!obj.prices)throw Error("Неверный формат");
   S({...empty,...obj,items:obj.items,shipments:Array.isArray(obj.shipments)?obj.shipments:[],settings:{...empty.settings,...obj.settings}});
   M("JSON загружен. Список товаров и поставок будет сохранён на сервере.");
  }catch(error){M("Ошибка импорта: "+error.message);}
 }
 async function importWBCapture(file){
  if(!file||!item){M("Сначала добавьте товар в разделе себестоимости.");return;}
  if(file.size>100*1024*1024){M("Файл слишком большой (максимум 100 МБ).");return;}
  try{
   const result=parseWBCaptureText(await file.text(),item.name);
   if(result.query&&normalizedQuery(result.query)!==normalizedQuery(item.name)){
    if(!confirm("В файле запрос «"+result.query+"», а выбран товар «"+item.name+"». Использовать эти цены для выбранного товара?"))return;
   }
   const importedPrices=result.products.map(p=>p.price_rub??"").concat(Array(10).fill("")).slice(0,10);
   if(!importedPrices.some(p=>n(p)>0))throw Error("В сохранённой выдаче нет цен.");
   set({prices:{...s.prices,[item.id]:importedPrices},products:{...(s.products||{}),[item.id]:result.products},importedSources:{...(s.importedSources||{}),[item.id]:result.source}});
   M("Загружено "+result.products.length+" карточек: "+result.source+". HAR обработан только внутри браузера, на сервер не отправлялся. Цены из JSON могут отличаться от цены на витрине.");
  }catch(error){M("Не удалось импортировать: "+error.message);}
 }

 function addProduct(){
  const id=crypto.randomUUID();
  set({items:[...s.items,{id,name:"Новый товар",sku:"",yuan:0,rate:12,freight:0,quantity:1,unitNetWeightG:0,deliveryToGuangzhouYuan:0,shipmentId:"",status:s.section==="archive"?"archive":s.section==="delivered"?"delivered":"selected"}],selectedId:id});
 }
 function saveShipment(){
  if(!shipmentDraft?.name?.trim()){M("Укажи название поставки.");return;}
  const id=shipmentDraft.id||crypto.randomUUID();
  const row={...defaultShipment(),...shipmentDraft,id,name:shipmentDraft.name.trim()};
  const exists=shipments.some(x=>x.id===id);
  set({shipments:exists?shipments.map(x=>x.id===id?row:x):[...shipments,row],section:"shipments"});
  setShipmentDraft(null);M("Поставка сохранена.");
 }
 function deleteShipment(id){
  if(!confirm("Удалить поставку? Товары останутся в каталоге без привязки к ней."))return;
  set({shipments:shipments.filter(x=>x.id!==id),items:s.items.map(x=>x.shipmentId===id?{...x,shipmentId:""}:x)});
 }
 function deleteProduct(id){
  if(!confirm("Удалить товар?"))return;
  set({items:s.items.filter(x=>x.id!==id)});
 }
 const tabs=<div className="tabs"><button className={"btn "+(s.page==="items"?"selected":"secondary")} onClick={()=>set({page:"items"})}>Себестоимость</button><button className={"btn "+(s.page==="calc"?"selected":"secondary")} onClick={()=>set({page:"calc"})}>Калькулятор WB</button><button className={"btn "+(s.page==="ozon"?"selected":"secondary")} onClick={()=>set({page:"ozon"})}>Калькулятор Ozon</button></div>;

 return <div className="wrap">{tabs}
 {s.page==="items"?<>
  <div className="tabs">
   {[["selected","Отбираемые"],["archive","Архив"],["delivered","Осуществлённые поставки"],["shipments","Поставки"]].map(([key,label])=><button key={key} className={"btn "+(s.section===key?"selected":"secondary")} onClick={()=>set({section:key})}>{label}</button>)}
  </div>
  {s.section==="shipments"?<>
   <section className="panel">
    <div className="flex space"><h2>Поставки из Китая</h2><button className="btn" onClick={()=>setShipmentDraft(defaultShipment())}>+ Добавить поставку</button></div>
    <div className="actions">
     <label className="btn secondary" style={{cursor:"pointer"}}>Импорт Excel (.xlsx) <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={busy} onChange={async e=>{await importLegacyExcel(e.target.files?.[0]);e.target.value="";}}/></label>
     <button className="btn secondary" onClick={refreshWorkspace}>Обновить с сервера</button>
     <span className="muted">{saving?"Сохраняем…":"Сохранение на сервере"} · доступно с других устройств под тем же логином</span>
    </div>
    {shipmentDraft&&<section className="panel mc-editor">
     <div className="flex space"><h3>{shipmentDraft.id?"Редактирование поставки":"Новая поставка"}</h3><button className="btn secondary" onClick={()=>setShipmentDraft(null)}>Закрыть</button></div>
     <div className="grid">
      <TextField label="Название / номер поставки" value={shipmentDraft.name} onChange={value=>setShipmentDraft(v=>({...v,name:value}))}/>
      <TextField label="Дата отправки" value={shipmentDraft.departureDate} onChange={value=>setShipmentDraft(v=>({...v,departureDate:value}))} placeholder="ГГГГ-ММ-ДД"/>
      <TextField label="Дата получения" value={shipmentDraft.arrivalDate} onChange={value=>setShipmentDraft(v=>({...v,arrivalDate:value}))} placeholder="ГГГГ-ММ-ДД"/>
      <SelectField label="Статус" value={shipmentDraft.status} onChange={value=>setShipmentDraft(v=>({...v,status:value}))} options={shipmentStatuses}/>
      <Field label="Упаковка за коробку, $" value={shipmentDraft.packagingPerBoxUsd} onChange={value=>setShipmentDraft(v=>({...v,packagingPerBoxUsd:value}))}/>
      <Field label="Автодоставка за кг, $" value={shipmentDraft.autoFreightUsdPerKg} onChange={value=>setShipmentDraft(v=>({...v,autoFreightUsdPerKg:value}))}/>
      <Field label="Масса нетто поставки, кг" value={shipmentDraft.netWeightKg} onChange={value=>setShipmentDraft(v=>({...v,netWeightKg:value}))}/>
      <Field label="Масса брутто поставки, кг" value={shipmentDraft.grossWeightKg} onChange={value=>setShipmentDraft(v=>({...v,grossWeightKg:value}))}/>
      <Field label="Количество коробок" value={shipmentDraft.boxCount} onChange={value=>setShipmentDraft(v=>({...v,boxCount:value}))}/>
      <Field label="Курс $ → ¥" value={shipmentDraft.usdToYuanRate} onChange={value=>setShipmentDraft(v=>({...v,usdToYuanRate:value}))}/>
      <Field label="Курс ¥ → ₽ для доставки" value={shipmentDraft.yuanToRubRate} onChange={value=>setShipmentDraft(v=>({...v,yuanToRubRate:value}))}/>
      <Field label="Доставка до СПб, ₽" value={shipmentDraft.deliveryToSpbRub} onChange={value=>setShipmentDraft(v=>({...v,deliveryToSpbRub:value}))}/>
      <Field label="Доставка до дома, ₽" value={shipmentDraft.deliveryToHomeRub} onChange={value=>setShipmentDraft(v=>({...v,deliveryToHomeRub:value}))}/>
      <Field label="Грузчики, ₽" value={shipmentDraft.loadersRub} onChange={value=>setShipmentDraft(v=>({...v,loadersRub:value}))}/>
      <Field label="Упаковка, ₽" value={shipmentDraft.packingRub} onChange={value=>setShipmentDraft(v=>({...v,packingRub:value}))}/>
      <SelectField label="Распределять общие расходы" value={shipmentDraft.distributionMethod} onChange={value=>setShipmentDraft(v=>({...v,distributionMethod:value}))} options={[["weight","По весу брутто"],["quantity","По количеству единиц"],["equal","Поровну между товарами"]]}/>
     </div>
     <div className="actions"><button className="btn" onClick={saveShipment}>Сохранить поставку</button><button className="btn secondary" onClick={()=>setShipmentDraft(null)}>Отмена</button></div>
    </section>}
    <div className="scroll"><table><thead><tr><th>Поставка</th><th>Даты</th><th>Статус</th><th>Товаров</th><th>Брутто, кг</th><th>Расходы поставки, ₽</th><th>Себестоимость всех товаров, ₽</th><th>Действия</th></tr></thead><tbody>
     {shipments.map(shipment=>{
      const assigned=costedItems.filter(x=>x.shipmentId===shipment.id);
      const totalCost=assigned.reduce((sum,x)=>sum+n(x.quantity)*cost(x),0);
      const transport=(n(shipment.autoFreightUsdPerKg)*n(shipment.grossWeightKg)+n(shipment.packagingPerBoxUsd)*n(shipment.boxCount))*n(shipment.usdToYuanRate)*n(shipment.yuanToRubRate);
      const shared=n(shipment.deliveryToSpbRub)+n(shipment.deliveryToHomeRub)+n(shipment.loadersRub)+n(shipment.packingRub);
      return <tr key={shipment.id}><td><b>{shipment.name}</b><div className="muted">{shipment.distributionMethod==="weight"?"Распределение по весу":shipment.distributionMethod==="quantity"?"По количеству":"Поровну"}</div></td><td>{shipment.departureDate||"—"} → {shipment.arrivalDate||"—"}</td><td>{(shipmentStatuses.find(x=>x[0]===shipment.status)||[])[1]||shipment.status}</td><td>{assigned.length}</td><td>{n(shipment.grossWeightKg).toLocaleString("ru-RU")}</td><td>{rub(transport+shared)}</td><td><b>{rub(totalCost)}</b></td><td><div className="flex"><button className="btn secondary" onClick={()=>setShipmentDraft({...defaultShipment(),...shipment})}>Изменить</button><button className="btn secondary" onClick={()=>deleteShipment(shipment.id)}>Удалить</button></div></td></tr>;
     })}
     {!shipments.length&&<tr><td colSpan="8">Поставок пока нет. Создай поставку или импортируй старый Excel.</td></tr>}
    </tbody></table></div>
   </section>
   {shipments.map(shipment=>{
    const assigned=costedItems.filter(x=>x.shipmentId===shipment.id);
    return <section className="panel" key={shipment.id}><div className="flex space"><h3>{shipment.name} · состав поставки</h3><span className="muted">{assigned.length} товаров</span></div>
     <div className="scroll"><table><thead><tr><th>Товар</th><th>Количество</th><th>Вес нетто, кг</th><th>Закупка, ₽</th><th>Доставка, ₽</th><th>Общие расходы, ₽</th><th>Себестоимость, ₽/шт.</th></tr></thead><tbody>
      {assigned.map(product=>{const detail=costs[product.id]||{};return <tr key={product.id}><td>{product.name}</td><td>{n(product.quantity)}</td><td>{(n(product.unitNetWeightG)*n(product.quantity)/1000).toLocaleString("ru-RU",{maximumFractionDigits:3})}</td><td>{rub(detail.purchaseRub||0)}</td><td>{rub(detail.transportRub||0)}</td><td>{rub(detail.sharedExpensesRub||0)}</td><td><b>{rub(cost(product))}</b></td></tr>;})}
      {!assigned.length&&<tr><td colSpan="7">Пока нет товаров в этой поставке. Назначь поставку в карточке товара.</td></tr>}
     </tbody></table></div>
    </section>;
   })}
  </>:<>
   <section className="panel">
    <div className="flex space"><h2>Себестоимость товаров</h2><button className="btn" onClick={addProduct}>+ Добавить товар</button></div>
    <div className="actions">
     <label className="btn secondary" style={{cursor:"pointer"}}>Импорт Excel (.xlsx) <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={busy} onChange={async e=>{await importLegacyExcel(e.target.files?.[0]);e.target.value="";}}/></label>
     <button className="btn secondary" onClick={refreshWorkspace}>Обновить с сервера</button>
     <span className="muted">{saving?"Сохраняем…":"Сохранено на сервере"} · синхронизация по аккаунту</span>
    </div>
    <p className="muted">Закупочная стоимость и расходы выбранной поставки автоматически учитываются в калькуляторах WB и Ozon. Товары и поставки доступны с любого устройства после входа под тем же логином.</p>
    <div className="scroll"><table><thead><tr><th>Товар / артикул</th><th>Цена 1688, ¥</th><th>Курс закупки ¥ → ₽</th><th>Кол-во, шт.</th><th>Вес ед., г</th><th>Доставка до Гуанчжоу, ¥</th><th>Ручная логистика, ₽/шт.</th><th>Поставка</th><th>Себестоимость, ₽/шт.</th><th>Статус / действия</th></tr></thead><tbody>
     {costedItems.filter(x=>x.status===s.section).map(product=><tr key={product.id}>
      <td><input aria-label="Название товара" value={product.name} onChange={e=>update(product.id,{name:e.target.value})}/><input aria-label="Артикул" placeholder="Артикул" value={product.sku||""} onChange={e=>update(product.id,{sku:e.target.value})}/></td>
      {["yuan","rate","quantity","unitNetWeightG","deliveryToGuangzhouYuan","freight"].map(key=><td key={key}><input aria-label={key} type="number" min="0" step="any" value={product[key]??0} onChange={e=>update(product.id,{[key]:e.target.value})}/></td>)}
      <td><select aria-label="Поставка" value={product.shipmentId||""} onChange={e=>update(product.id,{shipmentId:e.target.value})}><option value="">Без поставки</option>{shipments.map(sh=><option key={sh.id} value={sh.id}>{sh.name}</option>)}</select></td>
      <td><b>{rub(cost(product))}</b>{product.costBreakdown?.source==="shipment"&&<div className="muted">{product.costBreakdown.shipmentName}</div>}</td>
      <td><select aria-label="Статус товара" value={product.status} onChange={e=>update(product.id,{status:e.target.value})}>{productStatuses.map(([key,label])=><option value={key} key={key}>{label}</option>)}</select><button className="btn secondary" onClick={()=>deleteProduct(product.id)}>Удалить</button></td>
     </tr>)}
     {!costedItems.some(x=>x.status===s.section)&&<tr><td colSpan="10">Здесь пока нет товаров.</td></tr>}
    </tbody></table></div>
   </section>
   <section className="panel"><div className="actions"><button className="btn secondary" onClick={exportData}>Экспорт JSON</button><label className="btn secondary" style={{cursor:"pointer"}}>Импорт JSON <input type="file" accept=".json" hidden onChange={e=>importData(e.target.files?.[0])}/></label></div><p className="muted">JSON — резервная копия настроек и цен WB/Ozon. Основные товары и поставки уже хранятся на сервере.</p></section>
  </>}
  {message&&<p role="status" className="muted">{message}</p>}
 </>:s.page==="ozon"?<OzonCalculator items={costedItems} selectedId={s.selectedId} onSelect={id=>set({selectedId:id})} userId={userId} isAdmin={isAdmin}/>:<>
  <section className="panel"><h2>Поиск ТОП-10 на Wildberries</h2>
   <div className="grid"><div className="field"><label>Выберите товар</label><select value={item?.id||""} onChange={e=>set({selectedId:e.target.value})}>{costedItems.map(x=><option key={x.id} value={x.id}>{x.name} · {rub(cost(x))}</option>)}</select></div><div className="field"><label>Поисковый запрос</label><input value={item?.name||""} readOnly/></div></div>
   <p className="notice">WB возвращает HTTP 403 на запросы с VPS. Поэтому рекомендуемый способ сейчас — импорт HAR из Network или JSON, сохранённого браузерным скриптом. Файл разбирается локально в твоём браузере, не загружается на FastAPI. Цена product в JSON может отличаться от цены на сайте; СПП конкурентов неизвестна.</p>
   <div className="actions"><label className="btn" style={{cursor:"pointer"}}>Импорт HAR / JSON <input type="file" accept=".har,.json,application/json" hidden onChange={async e=>{await importWBCapture(e.target.files?.[0]);e.target.value="";}}/></label><button className="btn secondary" disabled={!item||busy} onClick={find}>{busy?"Поиск...":"Повторить через FastAPI (эксперимент)"}</button>{item&&<a target="_blank" rel="noopener noreferrer" href={"https://www.wildberries.ru/catalog/0/search.aspx?search="+encodeURIComponent(item.name)}>Открыть выдачу WB</a>}<a target="_blank" rel="noopener noreferrer" href="https://github.com/pereyasl0v/isk_v01/tree/feature/ozon-digitization/extension/wb-capture">Скрипт экспорта WB</a></div>
   <p className="muted">Для HAR: открой поиск на WB, сохрани Network → Export HAR with content и импортируй файл здесь. HAR может содержать cookies и токены, не публикуй его. При импорте сохраняются только товары и цены.</p>
   {(s.products?.[item?.id]||[]).length>0&&<div className="scroll"><table><thead><tr><th>№</th><th>Карточка</th><th>product из JSON, ₽</th><th>basic из JSON, ₽</th></tr></thead><tbody>{s.products[item.id].map(p=><tr key={p.position}><td>{p.position}</td><td><a href={"https://www.wildberries.ru/catalog/"+encodeURIComponent(p.id)+"/detail.aspx"} target="_blank" rel="noopener noreferrer">{p.name}</a></td><td>{p.price_rub??"—"}</td><td>{p.basic_price_rub??"—"}</td></tr>)}</tbody></table></div>}
   <h3>Цены для расчёта (можно исправить вручную)</h3><div className="grid">{entries.map((value,index)=><Field key={index} label={"Позиция "+(index+1)+" · цена из JSON, ₽"} value={value} onChange={next=>{const nextEntries=[...entries];nextEntries[index]=next;set({prices:{...s.prices,[item.id]:nextEntries}});}}/>)}</div>
   <p className="muted">Введено: {values.length} из 10. {values.length!==10?"Статистики предварительные до заполнения всех десяти цен.":""}</p>
  </section>
  <section className="panel"><h2>Расходы WB</h2><div className="grid">{[["commission","Комиссия WB, %"],["delivery","Логистика WB, ₽"],["storage","Хранение, ₽"],["advertising","Реклама, ₽"],["other","Прочие, ₽"],["tax","Налог с выручки, %"]].map(([key,label])=><Field key={key} label={label} value={s.settings[key]} onChange={value=>set({settings:{...s.settings,[key]:value}})}/>)}</div></section>
  <section className="panel"><h2>Прибыль по трём сценариям</h2><div className="field"><label>Предполагаемая СПП: {s.spp}%</label><input type="range" min="0" max="99" value={s.spp} onChange={e=>set({spp:Number(e.target.value)})}/></div><p className="muted">СПП неизвестна: ползунок моделирует сценарий. Значение 100% исключено (деление на ноль). Комиссия и налог условно считаются от оценочной цены продавца; фактические удержания могут отличаться.</p>
   {results.length?<div className="stats">{results.map(result=><div className="stat" key={result.label}><span>{({min:"Минимальная",median:"Медианная",average:"Средняя"})[result.label]} цена из поискового JSON</span><b>{rub(result.buyer)}</b><p className="muted">Оценка цены продавца: {rub(result.seller)}<br/>Себестоимость: {rub(result.c)}<br/>Комиссия: −{rub(result.fee)}<br/>Налог: −{rub(result.tax)}<br/>Другие расходы: −{rub(result.other)}</p><hr/><span>Расчётная прибыль</span><b className={result.profit>=0?"green":"red"}>{rub(result.profit)}</b><p className="muted">Маржа: {result.margin.toFixed(1)}% · ROI: {result.roi.toFixed(1)}%</p></div>)}</div>:<p className="notice">Введите хотя бы одну цену конкурента и добавьте товар, чтобы увидеть расчёты.</p>}
  </section>
 </>}
 </div>;
}

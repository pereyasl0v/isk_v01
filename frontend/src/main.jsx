import React, {useEffect, useState, createContext, useContext, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, NavLink, Routes, Route, Navigate, useNavigate} from 'react-router-dom';
import {Boxes, LayoutDashboard, Package, Warehouse, Truck, Calculator, Plug, ListChecks, RefreshCw, ArrowUpRight, Search, Download, CircleCheck, AlertCircle, ArrowRight, LogOut, BarChart3, Plus, Users, ShieldCheck} from 'lucide-react';
import './style.css';
import Replenishment from './Replenishment';
import MarketPage from './market';
import DigitizationCached from './DigitizationCached';
import ProductDetails from './ProductDetails';
import {statusLabel,roleLabel,groupStocks} from './presentation';

const Context=createContext(null);
const nf=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const num=v=>v===null||v===undefined?'—':nf.format(v);
const date=v=>v?new Date(v).toLocaleString('ru-RU'):'Ещё не загружено';
async function api(path,body){
 const r=await fetch('/api'+path,{credentials:'same-origin',method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Local-App':'fbo'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json(); if(!r.ok){const e=new Error(data.detail||'Запрос не выполнен');e.status=r.status;throw e;}return data;
}
function useApp(){return useContext(Context)}
function Notice({children}){return <div className="notice"><AlertCircle size={18}/><span>{children}</span></div>}
function Empty({text='Пока нет данных',help='Подключите кабинет и выполните загрузку.'}){return <div className="empty"><Boxes size={34}/><h3>{text}</h3><p>{help}</p></div>}
function Table({columns,rows,empty='Нет строк для отображения',onRowClick}){
 const [page,setPage]=useState(0);const pages=Math.ceil(rows.length/30);const safe=Math.min(page,Math.max(pages-1,0));
 return <><div className="table-scroll"><table><thead><tr>{columns.map(c=><th key={c[0]}>{c[1]}</th>)}</tr></thead><tbody>{rows.slice(safe*30,safe*30+30).map((r,i)=><tr key={i} {...(onRowClick?{className:"product-clickable-row",role:"button",tabIndex:0,onClick:()=>onRowClick(r),onKeyDown:e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onRowClick(r)}}}:{})}>{columns.map(c=><td key={c[0]}>{c[2]?c[2](r[c[0]],r):String(r[c[0]]??'—')}</td>)}</tr>)}</tbody></table></div>{!rows.length?<Empty text={empty} help="Проверьте загрузку и выбранные фильтры."/>:<div className="pagination"><span>{num(rows.length)} строк · страница {safe+1} из {pages}</span><div><button disabled={safe===0} onClick={()=>setPage(safe-1)}>Назад</button><button disabled={safe>=pages-1} onClick={()=>setPage(safe+1)}>Далее</button></div></div>}</>
}
function Filter({value,set,placeholder='Поиск по названию, артикулу или SKU'}){return <label className="search"><Search size={17}/><input aria-label="Поиск" value={value} onChange={e=>set(e.target.value)} placeholder={placeholder}/></label>}
function Card({label,value,note,icon:Icon=Package}){return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={19}/></div><strong>{num(value)}</strong><small>{note}</small></div>}
function Overview(){
 const {inv,state,act}=useApp();const s=inv?.summary;
 return <><div className="overview-heading"><div><h1>Обзор запасов</h1><p className="muted mt-2">Обновлено: {date(inv?.at)}</p></div><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/sync',{})}>Обновить данные <RefreshCw size={16}/></button></div>
 <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 my-6"><Card label="Доступно к продаже" value={s?.available} note="Единиц" icon={Boxes}/><Card label="Готовится к продаже" value={s?.preparing} note="Единиц"/><Card label="В пути на Ozon" value={s?.transit} note="Единиц" icon={Truck}/><Card label="Товары" value={s?.products} note="Карточек"/></div>
 {inv?.warning&&<Notice>{inv.warning}</Notice>}
 <div className="mt-5"><ProductCatalog/></div></>
}
function ProductCatalog(){
 const {inv,me}=useApp();
 const [q,setQ]=useState('');
 const [selected,setSelected]=useState(null);
 useEffect(()=>setSelected(null),[me?.active_account_id]);
 const rows=(inv?.products||[]).filter(p=>[p.name,p.offer_id,p.id,p.sku].join(' ').toLowerCase().includes(q.toLowerCase()));
 return <><section className="panel">
  <div className="panel-title"><h3>Каталог товаров</h3><span className="badge">{rows.length} карточек</span></div>
  <Filter value={q} set={setQ}/>
  <Table rows={rows} onRowClick={setSelected} columns={[["name","Название"],["offer_id","Артикул"],["id","Код товара"],["sku","SKU"]]}/>
 </section>
 {selected&&<ProductDetails key={selected.id} product={selected} onClose={()=>setSelected(null)}/>}
 </>;
}
function Stocks(){
 const {inv}=useApp();const [q,setQ]=useState('');const [raw,setRaw]=useState(false);const [only,setOnly]=useState(true);
 const warehouseNames=new Map((inv?.analytics||[]).map(r=>[String(r.warehouse_id),r.warehouse_name]));
 const source=raw?(inv?.stocks||[]).map(r=>({...r,warehouse_name:warehouseNames.get(String(r.warehouse_id))})):(inv?.analytics||[]);
 const groups=groupStocks(inv?.products||[],source,raw);
 const shown=groups.map(g=>({...g,visible:g.rows.filter(r=>!only||(raw?r.present>0||r.reserved>0:r.available_stock_count>0))}))
  .filter(g=>g.visible.length&&[g.name,g.offer,...g.skus,...g.visible.map(r=>`${r.warehouse_name||''} ${r.warehouse_id}`)].join(' ').toLowerCase().includes(q.toLowerCase()));
 return <div className="flex flex-col gap-5"><section className="panel"><div className="panel-title"><h3>Остатки FBO</h3><div className="segmented"><button className={!raw?'selected':''} onClick={()=>setRaw(false)}>Доступные остатки</button><button className={raw?'selected':''} onClick={()=>setRaw(true)}>Учёт и резервы</button></div></div>
 <div className="filters"><Filter value={q} set={setQ}/><label className="check"><input type="checkbox" checked={only} onChange={e=>setOnly(e.target.checked)}/> Только склады с остатком</label></div>
 {!raw&&inv?.analytics===null?<Empty text="Остатки пока недоступны" help="Обновите данные. Если загрузка не удаётся, проверьте разрешение на чтение аналитики у ключа Ozon."/>:!shown.length?<Empty text="Карточки не найдены" help="Проверьте загрузку, поиск и фильтр остатков."/>:shown.map(g=><details className="stock-card" key={g.key}><summary><div className="stock-title"><strong>{g.name}</strong><span className="sku">SKU {g.skus.join(', ')}</span><small>Артикул: {g.offer}</small></div><div className="stock-total"><strong>{num(g.total)} <small>ед.</small></strong><span>{raw?'На складах':'Доступно к продаже'}</span></div><span className="expand-arrow">⌄</span></summary><div className="stock-details">{raw&&<p className="muted mb-4">Учётное количество и резерв показаны раздельно. Доступное к продаже количество находится на вкладке «Доступные остатки».</p>}<Table rows={g.visible} columns={raw?[["warehouse_name","Склад",(v,r)=><span>{v||'Склад Ozon'} <small>· ID {r.warehouse_id}</small></span>],["present","На складе, ед.",num],["reserved","В резерве, ед.",num]]:[["warehouse_name","Склад",(v,r)=><span>{v||'Склад Ozon'} <small>· ID {r.warehouse_id}</small></span>],["available_stock_count","Доступно, ед.",num],["valid_stock_count","Готовится к продаже, ед.",num],["transit_stock_count","В пути на Ozon, ед.",num],["requested_stock_count","В заявках, ед.",num]]}/></div></details>)}
 </section><History/></div>
}
function History(){const {hist,state,act}=useApp();const [days,setDays]=useState(90);const [q,setQ]=useState('');const [status,setStatus]=useState('');const postings=hist?.postings||[];const rows=postings.filter(p=>p.number.includes(q)&&(!status||p.status===status)).map(p=>({...p,units:p.products.reduce((n,r)=>n+r.quantity,0),items:p.products.map(r=>`${r.offer_id||r.sku} × ${r.quantity}`).join('; ')}));return <><section className="panel"><div className="panel-title"><h3>История FBO</h3><div className="flex gap-2"><select aria-label="Период загрузки" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={30}>30 дней</option><option value={90}>90 дней</option><option value={180}>180 дней</option><option value={365}>365 дней</option></select><button className="primary" disabled={!state||state.job.running} onClick={()=>act('/history/sync',{days})}>Загрузить историю</button></div></div><p className="muted mb-4">Снимок: {date(hist?.at)}{hist?.since&&` · период ${date(hist.since)} — ${date(hist.to)}`}</p><div className="filters"><Filter value={q} set={setQ} placeholder="Номер отправления"/><select aria-label="Статус" value={status} onChange={e=>setStatus(e.target.value)}><option value="">Все статусы</option>{[...new Set(postings.map(p=>p.status))].sort().map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select></div><Table rows={rows} columns={[["number","Отправление"],["created_at","Создано",date],["status","Статус",statusLabel],["items","Состав"],["units","Единиц",num]]}/></section></>}
function LoginScreen({onSuccess}){
 const [username,setUsername]=useState('');const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [initialized,setInitialized]=useState(null);
 useEffect(()=>{api('/auth/status').then(x=>setInitialized(x.initialized)).catch(()=>setInitialized(null))},[]);
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{username:username.trim(),password});setPassword('');await onSuccess()}catch(err){setError(err.message)}finally{setBusy(false)}}
 return <div className="auth-screen"><form className="auth-card" onSubmit={submit}>
  <div className="auth-logo"><div className="brand-icon"><Boxes size={26}/></div><div><strong>ИСК</strong><span>Интеллектуальная система контроля</span></div></div>
  <h1>Вход в систему</h1><p className="muted">Введите учётные данные, выданные администратором.</p>
  {error&&<div className="notice" role="alert">{error}</div>}
  <label className="field">Логин<input autoComplete="username" required minLength={3} maxLength={32} value={username} onChange={e=>setUsername(e.target.value)}/></label>
  <label className="field mt-4">Пароль<input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={e=>setPassword(e.target.value)}/></label>
  <button className="primary mt-5 w-full" disabled={busy}>{busy?'Входим…':'Войти'}<ArrowRight size={16}/></button>
  {initialized===false&&<div className="notice mt-4">Первый администратор ещё не создан. На сервере выполните: <code>docker compose exec isk python -m backend.admin create-admin --username admin</code></div>}
  <p className="auth-foot">Регистрация открыта только администраторам. Сессия действует 30 дней.</p>
 </form></div>
}
function Connection(){
 const {state,me,reload,setError}=useApp();const [client,setClient]=useState('');const [key,setKey]=useState('');
 const [busy,setBusy]=useState(false);const navigate=useNavigate();const accounts=me?.accounts||[];
 async function connect(e){e.preventDefault();setBusy(true);setError('');try{await api('/connect',{client_id:client.trim(),api_key:key.trim()});setKey('');await reload();navigate('/')}catch(err){setError(err.message)}finally{setBusy(false)}}
 async function select(id){setBusy(true);try{await api('/accounts/select',{account_id:id});await reload();navigate('/')}catch(err){setError(err.message)}finally{setBusy(false)}}
 async function disconnect(){setBusy(true);try{await api('/disconnect',{});await reload()}catch(err){setError(err.message)}finally{setBusy(false)}}
 const active=accounts.find(a=>a.id===me?.active_account_id);
 return <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
  <section className="panel"><div className="panel-title"><h3>Мои кабинеты Ozon</h3><Plug size={20}/></div>
   {!accounts.length&&<p className="muted">Пока нет подключённых кабинетов. Добавьте первый кабинет — ключ сохранится в зашифрованном виде и не потеряется после перезапуска сервера.</p>}
   <div className="account-list">{accounts.map(a=><div className="account-row" key={a.id}>
    <div><strong>Кабинет {a.client_id}</strong><span className={a.connected?'connected-label':'disconnected-label'}>{a.connected?'Подключён':'Ключ удалён'}</span><small>{a.roles?.join(', ')||'Роли не сохранены'}</small></div>
    <div className="account-actions">{a.connected&&<button className={me.active_account_id===a.id?'primary':''} disabled={busy||me.active_account_id===a.id} onClick={()=>select(a.id)}>{me.active_account_id===a.id?'Выбран':'Выбрать'}</button>}</div>
   </div>)}</div>
   {active&&state&&<><div className="connected mt-4"><CircleCheck size={22}/><strong>Активный кабинет {state.client_id}</strong></div><p className="muted mt-2">Срок ключа Ozon: {date(state.expires_at)}</p><button className="mt-4" disabled={busy||state.job.running} onClick={disconnect}><LogOut size={16}/> Удалить сохранённый ключ</button></>}
  </section>
  <section className="panel"><div className="panel-title"><h3>Добавить / обновить кабинет</h3><Plus size={20}/></div>
   <form onSubmit={connect}><label className="field">Идентификатор кабинета<input autoComplete="off" inputMode="numeric" pattern="[0-9]+" required value={client} onChange={e=>setClient(e.target.value)}/></label>
    <label className="field mt-4">Ключ API<input autoComplete="new-password" type="password" required minLength={10} value={key} onChange={e=>setKey(e.target.value)}/></label>
    <button className="primary mt-5" disabled={busy}>{busy?'Проверяем доступ…':'Сохранить подключение'}<ArrowRight size={16}/></button>
   </form>
   
  </section>
 </div>
}
function Logs(){const {state}=useApp();return <section className="panel"><div className="panel-title"><h3>Журнал текущего подключения</h3><span className="badge">Текущее подключение</span></div><Table rows={[...(state?.logs||[])].reverse()} columns={[["at","Время"],["message","Событие"]]}/></section>}
function AdminUsers(){
 const [users,setUsers]=useState([]);const [username,setUsername]=useState('');const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 async function load(){try{const data=await api('/admin/users');setUsers(data.users||[])}catch(e){setError(e.message)}}
 useEffect(()=>{load()},[]);
 async function create(e){e.preventDefault();setBusy(true);setError('');setMessage('');try{await api('/admin/users',{username:username.trim(),password});setUsername('');setPassword('');setMessage('Пользователь создан. Передайте ему логин и пароль безопасным способом.');await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
 async function toggle(user){setBusy(true);setError('');try{await api('/admin/users/'+user.id+'/status',{active:!user.is_active});await load()}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
  <section className="panel"><div className="panel-title"><h3>Создать пользователя</h3><Users size={20}/></div>
   <form onSubmit={create}><label className="field">Логин<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" value={username} onChange={e=>setUsername(e.target.value)}/></label>
    <label className="field mt-4">Временный пароль (от 12 символов)<input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/></label>
    <button className="primary mt-5" disabled={busy}>{busy?'Создаём…':'Создать пользователя'}<Plus size={16}/></button>
   </form>
   {error&&<div className="notice mt-4">{error}</div>}{message&&<div className="success-note mt-4">{message}</div>}
   <p className="muted mt-4">Новые пользователи получают обычные права. Администратор создаётся только через серверную команду.</p>
  </section>
  <section className="panel"><div className="panel-title"><h3>Пользователи ИСК</h3><ShieldCheck size={20}/></div>
   <div className="admin-user-list">{users.map(u=><div className="admin-user-row" key={u.id}><div><strong>{u.username}</strong><small>{u.role==='admin'?'Администратор':'Пользователь'} · {u.is_active?'Активен':'Отключён'}</small></div>{u.role!=='admin'&&<button disabled={busy} onClick={()=>toggle(u)}>{u.is_active?'Отключить':'Включить'}</button>}</div>)}</div>
  </section>
 </div>
}
const nav=[['/','Обзор',LayoutDashboard],['/digitization','Оцифровка',BarChart3],['/market-calculator','Калькулятор WB / Ozon',Calculator],['/stocks','Остатки FBO и история',Warehouse],['/replenishment','Прогноз пополнения',Calculator],['/connection','Мои кабинеты',Plug]];
function RequireAccount({children}){const {me}=useApp();return me?.active_account_id?children:<Navigate to="/connection" replace/>}
function App(){
 const [me,setMe]=useState(null);const [state,setState]=useState(null);const [inv,setInv]=useState(null);const [hist,setHist]=useState(null);const [digi,setDigi]=useState(null);
 const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [authChecked,setAuthChecked]=useState(false);const wasRunning=useRef(false);
 async function loadData(){const [i,h,d]=await Promise.all([api('/inventory'),api('/history'),api('/digitization')]);setInv(i);setHist(h);setDigi(d)}
 function clearData(){setState(null);setInv(null);setHist(null);setDigi(null)}
 async function reload(){
  try{const auth=await api('/auth/me');setMe(auth);
   if(auth.active_account_id){const [s,i,h,d]=await Promise.all([api('/state'),api('/inventory'),api('/history'),api('/digitization')]);setState(s);setInv(i);setHist(h);setDigi(d)}
   else clearData();
  }catch(e){if(e.status===401){setMe(null);clearData()}else if(e.status!==409)setError(e.message)}
  finally{setAuthChecked(true);setLoading(false)}
 }
 useEffect(()=>{reload()},[]);
 useEffect(()=>{
  if(!me?.active_account_id)return;
  const timer=setInterval(async()=>{try{const s=await api('/state');setState(s);if(wasRunning.current&&!s.job.running)await loadData();wasRunning.current=s.job.running}
   catch(e){if(e.status===401){setMe(null);clearData()}else if(e.status===409)await reload();else setError(e.message)}},1500);
  return()=>clearInterval(timer);
 },[me?.active_account_id]);
 async function act(path,body){setError('');try{await api(path,body);wasRunning.current=true;setState(s=>({...s,job:{...s.job,running:true,message:'Запускаем загрузку…',error:null}}))}catch(e){setError(e.message)}}
 async function logout(){try{await api('/auth/logout',{})}finally{setMe(null);clearData()}}
 if(!authChecked||loading)return <div className="auth-screen"><div className="auth-card">Загружаем ИСК…</div></div>;
 if(!me)return <LoginScreen onSuccess={reload}/>;
 const navItems=me.user.role==='admin'?[...nav,['/admin/users','Пользователи',Users]]:nav;
 return <Context.Provider value={{me,state,setState,inv,hist,digi,reload,act,setError}}>
  <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-icon"><Boxes size={25}/></div><div className="isk-brand">ИСК</div></div>
   <nav>{navItems.map(([path,label,Icon])=><NavLink key={path} to={path} end={path==='/'} className={({isActive})=>'nav-item '+(isActive?'active':'')}><Icon size={19}/>{label}</NavLink>)}</nav>
   <div className="sidebar-footer"><span className="status-dot"/>{me.user.username}</div>
  </aside><main><header><div className="header-actions" style={{marginLeft:"auto"}}><NavLink to="/connection" className="account"><span className={'status-dot '+(!state?'offline':'')}/>{state?('Кабинет '+state.client_id):'Выбрать кабинет'}</NavLink><button className="logout-button" onClick={logout}><LogOut size={16}/> Выйти</button></div></header>
   <div className="workspace">
    {error&&<div role="alert"><Notice>{error}<button className="ml-3" onClick={()=>setError('')}>Закрыть</button></Notice></div>}
    {state?.job.running&&<div className="progress"><RefreshCw size={17} className="animate-spin"/>{state.job.message}</div>}{state?.job.error&&<Notice>{state.job.error}</Notice>}
    <Routes>
     <Route path="/connection" element={<Connection/>}/>
     <Route path="/admin/users" element={me.user.role==='admin'?<AdminUsers/>:<Navigate to="/" replace/>}/>
     <Route path="/" element={<RequireAccount><Overview/></RequireAccount>}/>
     <Route path="/digitization" element={<RequireAccount><DigitizationCached state={state} digi={digi} act={act}/></RequireAccount>}/>
     <Route path="/market-calculator" element={<RequireAccount><MarketPage userId={me.user.id} isAdmin={me.user.role==='admin'}/></RequireAccount>}/>
     <Route path="/products" element={<Navigate to="/" replace/>}/>
     <Route path="/stocks" element={<RequireAccount><Stocks/></RequireAccount>}/>
     <Route path="/history" element={<Navigate to="/stocks" replace/>}/>
     <Route path="/replenishment" element={<RequireAccount><Replenishment inv={inv} hist={hist} api={api}/></RequireAccount>}/>
     <Route path="/plan" element={<Navigate to="/replenishment" replace/>}/><Route path="/forecast" element={<Navigate to="/replenishment" replace/>}/>
     <Route path="/logs" element={<RequireAccount><Logs/></RequireAccount>}/><Route path="*" element={<Navigate to="/" replace/>}/>
    </Routes>
   </div></main>
  </div>
 </Context.Provider>
}
createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);

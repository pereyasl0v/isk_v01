import './metricTransparency.css';

const H={
'Чистая прибыль/Марж-сть':['Итоговая прибыль после всех расходов. Маржинальность показывает долю прибыли в реализации.','Продажи − Логистика − Реклама − Хранение − Платная приёмка − Прочие удержания − Себестоимость продаж − Операционные расходы − Налоги − Номинальная комиссия − Эквайринг − Штрафы + Компенсации.\nМаржинальность = Чистая прибыль / Реализация × 100%.','TrueStats + Ozon + данные продавца'],
'Прибыль без опер. расх./Марж. без опер.':['Чистая прибыль без вычета операционных расходов продавца.','Продажи − Логистика − Реклама − Хранение − Платная приёмка − Прочие удержания − Себестоимость продаж − Налоги − Номинальная комиссия − Эквайринг − Штрафы + Компенсации.','TrueStats + Ozon + данные продавца'],
'Продажи':['Фактическая сумма продаж после скидки маркетплейса/соинвеста.','Продажи = Реализация − Скидка МП / баллы.','TrueStats + Ozon'],
'Реализация':['Сумма продаж по розничной цене до скидки маркетплейса.','Берётся из финансовых данных Ozon; зарубежные выкупы добавляются по методике TrueStats.','Ozon Seller API'],
'Заказы':['Сумма и количество заказанных товаров за период.','Сумма заказов Ozon за выбранный период.','Ozon Seller API'],
'Процент выкупа':['Доля выкупленных товаров среди товаров, по которым клиент принял решение.','Продажи, шт / (Продажи, шт + Отказы, шт + Возвраты, шт) × 100%.','Формула TrueStats + Ozon'],
'Логистика':['Расходы на логистические услуги Ozon.','Сумма типов начислений, которые TrueStats относит к логистике.','Финансовые начисления Ozon'],
'Реклама/ДРР':['Расходы на продвижение и их доля в реализации.','ДРР = Реклама / Реализация × 100%.','TrueStats + Ozon'],
'Хранение':['Стоимость размещения и хранения товаров на Ozon.','Сумма отчёта «Стоимость размещения → По товарам».','Отчёт Ozon'],
'Плат. приемка':['Расходы на платную приёмку.','Сумма соответствующих начислений Ozon.','Финансовые начисления Ozon'],
'Прочие удержания':['Отрицательные начисления, не вошедшие в отдельные категории.','Сумма прочих удержаний. Полностью вычитается из чистой прибыли.','Финансовые начисления Ozon'],
'Себестоимость продаж':['Затраты на проданные товары.','Количество продаж × (СС + ФФ), за вычетом возвратов.','Формула TrueStats + СС/ФФ продавца'],
'Операционные расходы':['Дополнительные расходы бизнеса, заданные продавцом.','Вычитаются из чистой прибыли с учётом операционных расходов.','Настройки продавца'],
'Налоги':['Налоги по выбранному налоговому режиму и ставкам.','Расчёт зависит от налоговой базы, ставки УСН/НДС и выбранных настроек.','Настройки продавца + налоговая база'],
'Налоговая База':['База для расчёта налогов.','Формируется из продаж и официальных компенсаций с учётом текущих налоговых настроек.','Расчёт ИСК по методике TrueStats'],
'Номинальная комиссия':['Вознаграждение Ozon, включая комиссию зарубежных выкупов.','Комиссия российских продаж + комиссия зарубежных выкупов.','Финансовые начисления Ozon + выкупы'],
'Эквайринг':['Расходы на обработку платежей.','Сумма начислений Ozon по эквайрингу.','Финансовые начисления Ozon'],
'ROI':['Рентабельность вложений в себестоимость проданных товаров.','ROI = Чистая прибыль / Себестоимость продаж × 100%.','Формула TrueStats'],
'Средняя себестоимость':['Средняя себестоимость одной проданной единицы.','Себестоимость продаж / Количество продаж.','Формула TrueStats'],
'Цена до СПП':['Средняя цена продажи до скидки маркетплейса.','Реализация / Количество продаж.','Формула TrueStats'],
'Сред. цена продажи':['Средняя фактическая цена продажи.','Продажи / Количество продаж.','Формула TrueStats'],
'Реклама/ДРРз':['Доля рекламных расходов в заказах.','ДРРз = Реклама / Заказы × 100%.','Формула TrueStats'],
'Средняя прибыль на 1 шт.':['Средняя чистая прибыль на проданную единицу.','Чистая прибыль / Количество продаж.','Расчёт ИСК'],
'Ср. стоимость логистики на 1 шт.':['Средний логистический расход на проданную единицу.','Логистика / Количество продаж.','Расчёт ИСК'],
'Остатки':['Доступные остатки FBO.','Сумма доступных остатков по складам Ozon.','Ozon Seller API'],
'Оборачиваемость по прод.':['Запас в днях при текущем темпе продаж.','Остатки / (Продажи, шт / Дни периода).','Формула TrueStats'],
'Оборачиваемость по зак.':['Запас в днях при текущем темпе заказов.','Остатки / (Заказы, шт / Дни периода).','Формула TrueStats'],
'Капитализация по себес.':['Стоимость остатков по себестоимости.','Σ((СС + ФФ + НДС) × Остаток SKU).','Формула TrueStats + Ozon + данные продавца'],
'Средняя капитализация':['Средняя капитализация по дневным снимкам.','Σ капитализаций по дням / Количество доступных снимков.','История ИСК'],
'Капитализация по розн.':['Стоимость остатков по розничной цене.','Требует средневзвешенной цены до СПП за прошлую полную календарную неделю.','Методика TrueStats; источник подключается'],
'Капитализ. на моих складах':['Стоимость остатков на собственных складах.','Σ((СС + ФФ + НДС) × Остаток на своём складе).','Данные продавца'],
'Остатки на моих складах':['Остатки на собственных складах.','Сумма введённых остатков по SKU.','Данные продавца'],
'FBS-остатки, шт':['Доступные остатки FBS.','Сумма доступных FBS-остатков.','Ozon Seller API'],
'GMROI':['Доходность прибыли относительно средней капитализации запасов.','Чистая прибыль / Средняя капитализация × 100%.','Методика TrueStats'],
'Годовой GMROI':['GMROI, приведённый к году.','GMROI × 365 / Количество дней периода.','Формула TrueStats'],
'Штрафы':['Штрафы и аналогичные удержания.','Сумма начислений Ozon, отнесённых к штрафам.','Финансовые начисления Ozon'],
'Скидка МП':['Скидка/соинвест маркетплейса.','Скидка МП = Реализация − Продажи.','Ozon / TrueStats'],
'Компенсация с баллами':['Компенсация скидки маркетплейса баллами/соинвестом.','Учитывается в прибыли по методике TrueStats.','Ozon'],
'Компенсация без баллов':['Официальные компенсации Ozon без баллов.','Сумма компенсаций и декомпенсаций.','Ozon Seller API'],
'Самовыкупы, шт.':['Количество самовыкупов.','Отдельный источник самовыкупов пока не подключён.','Нет данных'],
'Самовыкупы, ₽':['Сумма самовыкупов.','Отдельный источник самовыкупов пока не подключён.','Нет данных'],
'Затраты на самовыкупы (кешбэк)':['Затраты/кешбэк по самовыкупам.','Отдельный источник самовыкупов пока не подключён.','Нет данных']
};

const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s||'').replace(/\u00a0/g,' ').replace(/[^0-9,.-]/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const money=v=>v==null?'—':`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v)} ₽`;
const share=(v,b)=>v==null||b==null||b===0?'':`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v/b*100)}%`;

function labelOf(card){
 const el=card.querySelector('.metric-top > span');
 if(!el)return '';
 return el.dataset.metricLabel||norm(el.childNodes[0]?.textContent||el.textContent);
}
function cards(){const m=new Map();document.querySelectorAll('.metric').forEach(c=>{const l=labelOf(c);if(l&&!m.has(l))m.set(l,c)});return m}
function value(label){const c=cards().get(label);return c?num(c.querySelector('strong')?.textContent):null}
function nonzero(rows){return rows.filter(r=>r.display||(r.value!=null&&Math.abs(r.value)>.000001))}
function operationRows(metric){
 const panel=[...document.querySelectorAll('.panel')].find(p=>norm(p.querySelector('h3')?.textContent)==='Типы начислений Ozon');
 if(!panel)return [];
 return [...panel.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')]).filter(td=>td.length>=4&&norm(td[1].textContent)===metric).map(td=>({label:norm(td[0].textContent),display:norm(td[3].textContent)}));
}
function profitRows(withOps){
 return nonzero([
  {label:'Продажи',value:value('Продажи')},
  {label:'Логистика',value:-Math.abs(value('Логистика')||0)},
  {label:'Реклама',value:-Math.abs(value('Реклама/ДРР')||0)},
  {label:'Хранение',value:-Math.abs(value('Хранение')||0)},
  {label:'Платная приёмка',value:-Math.abs(value('Плат. приемка')||0)},
  {label:'Прочие удержания',value:-Math.abs(value('Прочие удержания')||0)},
  {label:'Себестоимость продаж',value:value('Себестоимость продаж')==null?null:-Math.abs(value('Себестоимость продаж'))},
  ...(withOps?[{label:'Операционные расходы',value:-Math.abs(value('Операционные расходы')||0)}]:[]),
  {label:'Налоги',value:-Math.abs(value('Налоги')||0)},
  {label:'Номинальная комиссия',value:-Math.abs(value('Номинальная комиссия')||0)},
  {label:'Эквайринг',value:-Math.abs(value('Эквайринг')||0)},
  {label:'Штрафы',value:-Math.abs(value('Штрафы')||0)},
  {label:'Компенсация с баллами',value:Math.abs(value('Компенсация с баллами')||0)},
  {label:'Компенсация без баллов',value:Math.abs(value('Компенсация без баллов')||0)}
 ]);
}
function details(label,card){
 if(label==='Чистая прибыль/Марж-сть')return profitRows(true);
 if(label==='Прибыль без опер. расх./Марж. без опер.')return profitRows(false);
 if(label==='Продажи')return nonzero([{label:'Реализация',value:value('Реализация')},{label:'Скидка МП',value:-Math.abs(value('Скидка МП')||0)}]);
 if(label==='ROI')return nonzero([{label:'Чистая прибыль',value:value('Чистая прибыль/Марж-сть')},{label:'Себестоимость продаж',value:value('Себестоимость продаж')}]);
 if(['Логистика','Прочие удержания','Номинальная комиссия','Эквайринг'].includes(label)){const r=operationRows(label);if(r.length)return r}
 return [{label:'Итого за период',value:num(card.querySelector('strong')?.textContent)}];
}
function docIcon(){return '<svg width="12" height="12" fill="none" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 3v4a1 1 0 0 1-1 1H5m4 8h6m-6-4h6m4-8v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7.914a1 1 0 0 1 .293-.707l3.914-3.914A1 1 0 0 1 9.914 3H18a1 1 0 0 1 1 1"></path></svg>'}
function close(){
 document.querySelectorAll('.isk-metric-popover').forEach(x=>x.remove());
 document.querySelectorAll('.isk-info-trigger,.isk-details-trigger').forEach(b=>b.setAttribute('aria-expanded','false'));
}
function combinedPopup(card,label,btn){
 close();
 const h=H[label]||['Показатель ИСК за выбранный период.','Значение формируется из данных Ozon или связанных расчётных показателей.','ИСК / Ozon'];
 const r=details(label,card);
 const base=value('Реализация');
 const p=document.createElement('div');p.className='isk-metric-popover isk-info-popover isk-combined-popover';
 const title=document.createElement('div');title.className='isk-pop-title';title.textContent=label;
 const description=document.createElement('p');description.textContent=h[0];
 const formulaTitle=document.createElement('b');formulaTitle.textContent='Как рассчитывается';
 const formula=document.createElement('pre');formula.textContent=h[1];
 const sourceTitle=document.createElement('b');sourceTitle.textContent='Источник';
 const source=document.createElement('p');source.textContent=h[2];
 const section=document.createElement('section');section.className='isk-pop-detail-section';
 const sectionTitle=document.createElement('b');sectionTitle.className='isk-pop-detail-heading';
 sectionTitle.textContent='Детализация: '+r.length;
 const list=document.createElement('div');list.className='isk-detail-list';
 r.forEach(x=>{
  const row=document.createElement('div');row.className='isk-detail-row';
  const name=document.createElement('span');name.textContent=x.label;
  const result=document.createElement('span');result.className='isk-detail-value';
  if(x.display)result.textContent=x.display;
  else{
   const sh=share(x.value,base);
   result.textContent=sh?money(x.value)+' / '+sh:money(x.value);
  }
  row.append(name,result);list.appendChild(row);
 });
 const total=document.createElement('div');total.className='isk-detail-total';
 const totalLabel=document.createElement('b');totalLabel.textContent='Итого';
 const totalValue=document.createElement('b');totalValue.textContent=card.querySelector('strong')?.textContent||'—';
 total.append(totalLabel,totalValue);
 section.append(sectionTitle,list,total);
 p.append(title,description,formulaTitle,formula,sourceTitle,source,section);
 card.appendChild(p);
 btn.setAttribute('aria-expanded','true');
}
function enhanceCard(card){
 const top=card.querySelector('.metric-top');const labelEl=top?.querySelector(':scope > span');
 if(!top||!labelEl)return;
 const label=labelEl.dataset.metricLabel||norm(labelEl.childNodes[0]?.textContent||labelEl.textContent);
 if(!label)return;
 labelEl.dataset.metricLabel=label;
 card.dataset.transparencyReady='1';
 card.style.position='relative';
 // Keep the original count/document icon: it now opens the combined explanation
 // and calculation breakdown in a single popup.
 labelEl.classList.add('isk-metric-label');
 let actions=top.querySelector(':scope > .isk-metric-actions');
 if(!actions){actions=document.createElement('div');actions.className='isk-metric-actions';top.appendChild(actions)}
 let trigger=actions.querySelector('.isk-details-trigger');
 if(!trigger){
  trigger=document.createElement('button');trigger.type='button';trigger.className='isk-details-trigger';
  trigger.dataset.testid='details-dropdown-trigger';
  trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-label','Детализация расчёта: '+label);
  trigger.innerHTML=docIcon()+'<span>0</span>';
  trigger.addEventListener('click',e=>{e.stopPropagation();combinedPopup(card,label,trigger)});
  actions.appendChild(trigger);
 }
 const count=trigger.querySelector('span');
 const next=String(details(label,card).length);
 if(count&&count.textContent!==next)count.textContent=next;
}
let scheduled=false;function enhance(){scheduled=false;if(location.pathname!=='/digitization')return;document.querySelectorAll('.metric').forEach(enhanceCard)}function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(enhance)}
new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
document.addEventListener('click',e=>{if(!e.target.closest('.isk-metric-popover,.isk-info-trigger,.isk-details-trigger'))close()});window.addEventListener('popstate',schedule);schedule();

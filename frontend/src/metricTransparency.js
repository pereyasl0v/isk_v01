import './metricTransparency.css';

const HELP = {
  'Чистая прибыль/Марж-сть': {
    description: 'Чистая прибыль показывает итоговый финансовый результат после вычета расходов. Маржинальность — доля чистой прибыли в реализации.',
    formula: 'Продажи − Логистика − Реклама − Хранение − Платная приёмка − Прочие удержания − Себестоимость продаж − Операционные расходы − Налоги − Номинальная комиссия − Эквайринг − Штрафы + Компенсации.\nМаржинальность = Чистая прибыль / Реализация × 100%.',
    source: 'Формула TrueStats + данные Ozon + себестоимость и настройки продавца.'
  },
  'Прибыль без опер. расх./Марж. без опер.': {
    description: 'Та же прибыль, но без вычета операционных расходов продавца.',
    formula: 'Продажи − Логистика − Реклама − Хранение − Платная приёмка − Прочие удержания − Себестоимость продаж − Налоги − Номинальная комиссия − Эквайринг − Штрафы + Компенсации.',
    source: 'Формула TrueStats + данные Ozon + себестоимость продавца.'
  },
  'Продажи': {
    description: 'Сумма продаж после скидки маркетплейса/соинвеста. Используется в расчёте прибыли.',
    formula: 'Продажи = Реализация − Скидка МП / баллы.',
    source: 'Данные Ozon и формула TrueStats.'
  },
  'Реализация': {
    description: 'Сумма продаж по розничной цене до скидки маркетплейса.',
    formula: 'Берётся из финансовых данных Ozon; зарубежные выкупы учитываются по правилам TrueStats.',
    source: 'Ozon Seller API.'
  },
  'Заказы': {
    description: 'Сумма и количество заказанных товаров за выбранный период.',
    formula: 'Суммируются заказы Ozon за выбранный период.',
    source: 'Ozon Seller API / отправления.'
  },
  'Процент выкупа': {
    description: 'Доля выкупленных товаров среди товаров, по которым клиент принял решение.',
    formula: 'Продажи, шт / (Продажи, шт + Отказы, шт + Возвраты, шт) × 100%.',
    source: 'Формула TrueStats + продажи/возвраты Ozon.'
  },
  'Логистика': {
    description: 'Расходы на логистические услуги Ozon за выбранный период.',
    formula: 'Сумма начислений Ozon, относящихся к логистике по методике сверки TrueStats.',
    source: 'Ozon Seller API / финансовые начисления.'
  },
  'Реклама/ДРР': {
    description: 'Расходы на продвижение и их доля в реализации.',
    formula: 'ДРР = Реклама / Реализация × 100%.',
    source: 'Ozon Seller API; сейчас учитывается доступная реклама/оплата за заказ.'
  },
  'Хранение': {
    description: 'Стоимость размещения и хранения товаров на складах Ozon.',
    formula: 'Сумма отчёта Ozon «Стоимость размещения → По товарам» за выбранный период.',
    source: 'Отчёт Ozon по размещению.'
  },
  'Плат. приемка': {
    description: 'Платная приёмка товаров Ozon за выбранный период.',
    formula: 'Сумма соответствующих начислений Ozon.',
    source: 'Ozon Seller API / финансовые начисления.'
  },
  'Прочие удержания': {
    description: 'Остальные отрицательные начисления Ozon, не отнесённые к отдельным категориям.',
    formula: 'Сумма прочих удержаний. В чистой прибыли вычитается полностью.',
    source: 'Ozon Seller API / финансовые начисления.'
  },
  'Себестоимость продаж': {
    description: 'Затраты продавца на товары, проданные за выбранный период.',
    formula: 'Количество продаж × (Себестоимость товара + Фулфилмент), за вычетом возвратов.',
    source: 'Формула TrueStats + введённые продавцом СС и ФФ.'
  },
  'Операционные расходы': {
    description: 'Дополнительные расходы бизнеса, которые продавец задаёт вручную.',
    formula: 'Вычитаются из чистой прибыли с учётом операционных расходов.',
    source: 'Настройки продавца.'
  },
  'Налоги': {
    description: 'Расчёт налогов по выбранным в ИСК ставкам.',
    formula: 'Расчёт зависит от налогового режима и введённых ставок. Текущий режим отображается в блоке настроек.',
    source: 'Настройки продавца + налоговая база.'
  },
  'Налоговая База': {
    description: 'База, от которой ИСК рассчитывает налог.',
    formula: 'Формируется из продаж и официальных компенсаций с учётом текущих налоговых настроек.',
    source: 'Расчёт ИСК по методике TrueStats.'
  },
  'Номинальная комиссия': {
    description: 'Вознаграждение Ozon, включая комиссию по зарубежным выкупам.',
    formula: 'Комиссия российских продаж + комиссия зарубежных выкупов.',
    source: 'Ozon Seller API / финансовые начисления и выкупы маркетплейсом.'
  },
  'Эквайринг': {
    description: 'Расходы на обработку платежей.',
    formula: 'Сумма начислений Ozon по эквайрингу.',
    source: 'Ozon Seller API / финансовые начисления.'
  },
  'ROI': {
    description: 'Рентабельность вложений в себестоимость проданных товаров.',
    formula: 'ROI = Чистая прибыль / Себестоимость продаж × 100%.',
    source: 'Формула TrueStats.'
  },
  'Средняя себестоимость': {
    description: 'Средняя себестоимость одной проданной единицы.',
    formula: 'Себестоимость продаж / Количество продаж.',
    source: 'Формула TrueStats.'
  },
  'Цена до СПП': {
    description: 'Средняя цена продажи до скидки маркетплейса.',
    formula: 'Реализация / Количество продаж.',
    source: 'Формула TrueStats.'
  },
  'Сред. цена продажи': {
    description: 'Средняя фактическая цена продажи после скидки маркетплейса.',
    formula: 'Продажи / Количество продаж.',
    source: 'Формула TrueStats.'
  },
  'Реклама/ДРРз': {
    description: 'Доля рекламных расходов в сумме заказов.',
    formula: 'ДРРз = Реклама / Заказы × 100%.',
    source: 'Формула TrueStats.'
  },
  'Средняя прибыль на 1 шт.': {
    description: 'Средняя чистая прибыль на одну проданную единицу.',
    formula: 'Чистая прибыль / Количество продаж.',
    source: 'Расчёт ИСК по данным периода.'
  },
  'Ср. стоимость логистики на 1 шт.': {
    description: 'Средний расход на логистику на одну проданную единицу.',
    formula: 'Логистика / Количество продаж.',
    source: 'Расчёт ИСК по данным Ozon.'
  },
  'Остатки': {description:'Текущий доступный остаток FBO.', formula:'Сумма доступных остатков по складам Ozon.', source:'Ozon Seller API.'},
  'Оборачиваемость по прод.': {description:'На сколько дней хватит текущего остатка при темпе продаж выбранного периода.', formula:'Остаток / (Продажи, шт / Количество дней периода).', source:'Формула TrueStats.'},
  'Оборачиваемость по зак.': {description:'На сколько дней хватит текущего остатка при темпе заказов выбранного периода.', formula:'Остаток / (Заказы, шт / Количество дней периода).', source:'Формула TrueStats.'},
  'Капитализация по себес.': {description:'Стоимость текущих остатков по себестоимости.', formula:'(СС + ФФ + НДС) × Остаток по каждому SKU, затем сумма.', source:'Формула TrueStats + остатки Ozon + данные продавца.'},
  'Средняя капитализация': {description:'Средняя капитализация остатков по накопленным дневным снимкам.', formula:'Сумма дневных капитализаций / Количество доступных дневных снимков.', source:'История снимков ИСК.'},
  'Капитализация по розн.': {description:'Стоимость остатков по розничной цене.', formula:'Требует исторической средневзвешенной цены до СПП за прошлую полную календарную неделю.', source:'Методика TrueStats; источник ещё подключается.'},
  'Капитализ. на моих складах': {description:'Стоимость остатков на собственных складах продавца.', formula:'(СС + ФФ + НДС) × остаток на собственном складе.', source:'Данные продавца.'},
  'Остатки на моих складах': {description:'Количество товара на собственных складах продавца.', formula:'Сумма введённых остатков по SKU.', source:'Данные продавца.'},
  'FBS-остатки, шт': {description:'Остатки FBS по данным Ozon.', formula:'Сумма доступных FBS-остатков.', source:'Ozon Seller API.'},
  'GMROI': {description:'Доходность валовой маржи относительно средней капитализации запасов.', formula:'Чистая прибыль / Средняя капитализация × 100%.', source:'Методика TrueStats.'},
  'Годовой GMROI': {description:'GMROI, приведённый к годовому значению.', formula:'GMROI × 365 / Количество дней периода.', source:'Формула TrueStats.'},
  'Штрафы': {description:'Штрафы и аналогичные удержания Ozon.', formula:'Сумма начислений Ozon, отнесённых к штрафам.', source:'Ozon Seller API.'},
  'Скидка МП': {description:'Скидка/соинвест маркетплейса, уменьшающая сумму продаж относительно реализации.', formula:'Скидка МП = Реализация − Продажи.', source:'Данные Ozon / расчёт TrueStats.'},
  'Компенсация с баллами': {description:'Компенсация скидки маркетплейса баллами/соинвестом.', formula:'Используется в расчёте прибыли по правилам TrueStats.', source:'Данные Ozon.'},
  'Компенсация без баллов': {description:'Официальные компенсации Ozon, не связанные с баллами.', formula:'Сумма компенсаций и декомпенсаций Ozon.', source:'Ozon Seller API.'},
  'Самовыкупы, шт.': {description:'Количество самовыкупов.', formula:'Пока отдельный источник самовыкупов в ИСК не подключён.', source:'Нет данных.'},
  'Самовыкупы, ₽': {description:'Сумма самовыкупов.', formula:'Пока отдельный источник самовыкупов в ИСК не подключён.', source:'Нет данных.'},
  'Затраты на самовыкупы (кешбэк)': {description:'Затраты/кешбэк, связанные с самовыкупами.', formula:'Пока отдельный источник самовыкупов в ИСК не подключён.', source:'Нет данных.'}
};

const moneyText = value => {
  if (value == null || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value)} ₽`;
};

const normalize = text => String(text || '').replace(/\s+/g,' ').trim();
const parseNumber = text => {
  const cleaned=String(text||'').replace(/\u00a0/g,' ').replace(/[^0-9,.-]/g,'').replace(',','.');
  const value=Number(cleaned);
  return Number.isFinite(value)?value:null;
};

function cardMap(){
  const map=new Map();
  document.querySelectorAll('.metric').forEach(card=>{
    const span=card.querySelector('.metric-top > span');
    if(!span)return;
    const label=normalize(span.childNodes[0]?.textContent || span.textContent);
    if(label && !map.has(label)) map.set(label,card);
  });
  return map;
}

function cardValue(label){
  const card=cardMap().get(label);
  return card?parseNumber(card.querySelector('strong')?.textContent):null;
}

function percentOf(value,base){
  if(value==null||base==null||base===0)return '';
  return `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value/base*100)}%`;
}

function operationRows(metric){
  const panels=[...document.querySelectorAll('.panel')];
  const panel=panels.find(p=>normalize(p.querySelector('h3')?.textContent)==='Типы начислений Ozon');
  if(!panel)return [];
  const rows=[];
  panel.querySelectorAll('tbody tr').forEach(tr=>{
    const td=[...tr.querySelectorAll('td')];
    if(td.length<4)return;
    if(normalize(td[1].textContent)!==metric)return;
    rows.push({label:normalize(td[0].textContent),display:normalize(td[3].textContent),source:'Ozon'});
  });
  return rows;
}

function nonZero(rows){
  return rows.filter(r=>r.display || (r.value!=null && Math.abs(r.value)>0.000001));
}

function profitRows(withOps=true){
  const rows=[
    {label:'Продажи',value:cardValue('Продажи')},
    {label:'Логистика',value:-Math.abs(cardValue('Логистика')||0)},
    {label:'Реклама',value:-Math.abs(cardValue('Реклама/ДРР')||0)},
    {label:'Хранение',value:-Math.abs(cardValue('Хранение')||0)},
    {label:'Платная приёмка',value:-Math.abs(cardValue('Плат. приемка')||0)},
    {label:'Прочие удержания',value:-Math.abs(cardValue('Прочие удержания')||0)},
    {label:'Себестоимость продаж',value:cardValue('Себестоимость продаж')==null?null:-Math.abs(cardValue('Себестоимость продаж'))},
    ...(withOps?[{label:'Операционные расходы',value:-Math.abs(cardValue('Операционные расходы')||0)}]:[]),
    {label:'Налоги',value:-Math.abs(cardValue('Налоги')||0)},
    {label:'Номинальная комиссия',value:-Math.abs(cardValue('Номинальная комиссия')||0)},
    {label:'Эквайринг',value:-Math.abs(cardValue('Эквайринг')||0)},
    {label:'Штрафы',value:-Math.abs(cardValue('Штрафы')||0)},
    {label:'Компенсация с баллами',value:Math.abs(cardValue('Компенсация с баллами')||0)},
    {label:'Компенсация без баллов',value:Math.abs(cardValue('Компенсация без баллов')||0)}
  ];
  return nonZero(rows);
}

function detailRows(label,card){
  if(label==='Чистая прибыль/Марж-сть')return profitRows(true);
  if(label==='Прибыль без опер. расх./Марж. без опер.')return profitRows(false);
  if(label==='Продажи')return nonZero([
    {label:'Реализация',value:cardValue('Реализация')},
    {label:'Скидка МП',value:-Math.abs(cardValue('Скидка МП')||0)}
  ]);
  if(label==='ROI')return nonZero([
    {label:'Чистая прибыль',value:cardValue('Чистая прибыль/Марж-сть')},
    {label:'Себестоимость продаж',value:cardValue('Себестоимость продаж')}
  ]);
  if(label==='Логистика'){
    const rows=operationRows('Логистика');
    if(rows.length)return rows;
  }
  if(label==='Прочие удержания'){
    const rows=operationRows('Прочие удержания');
    if(rows.length)return rows;
  }
  if(label==='Номинальная комиссия'){
    const rows=operationRows('Номинальная комиссия');
    if(rows.length)return rows;
  }
  if(label==='Эквайринг'){
    const rows=operationRows('Эквайринг');
    if(rows.length)return rows;
  }
  const value=parseNumber(card.querySelector('strong')?.textContent);
  return [{label:'Итого за период',value,source:HELP[label]?.source||'Расчёт ИСК'}];
}

function closePopovers(except=null){
  document.querySelectorAll('.isk-metric-popover').forEach(el=>{if(el!==except)el.remove()});
}

function showInfo(card,label,button){
  closePopovers();
  const info=HELP[label]||{
    description:'Показатель ИСК за выбранный период.',
    formula:'Значение формируется из данных Ozon или связанных расчётных показателей.',
    source:'ИСК / Ozon.'
  };
  const pop=document.createElement('div');
  pop.className='isk-metric-popover isk-info-popover';
  const title=document.createElement('div'); title.className='isk-pop-title'; title.textContent=label;
  const d=document.createElement('p'); d.textContent=info.description;
  const fTitle=document.createElement('b'); fTitle.textContent='Как рассчитывается';
  const f=document.createElement('pre'); f.textContent=info.formula;
  const sTitle=document.createElement('b'); sTitle.textContent='Источник';
  const s=document.createElement('p'); s.textContent=info.source;
  pop.append(title,d,fTitle,f,sTitle,s);
  card.appendChild(pop);
  button.setAttribute('aria-expanded','true');
}

function showDetails(card,label,button){
  closePopovers();
  const rows=detailRows(label,card);
  const base=cardValue('Реализация');
  const total=parseNumber(card.querySelector('strong')?.textContent);
  const pop=document.createElement('div');
  pop.className='isk-metric-popover isk-details-popover';
  const title=document.createElement('div'); title.className='isk-pop-title'; title.textContent=`${label}: ${rows.length}`;
  pop.appendChild(title);
  const list=document.createElement('div'); list.className='isk-detail-list';
  rows.forEach(row=>{
    const line=document.createElement('div'); line.className='isk-detail-row';
    const left=document.createElement('span'); left.textContent=row.label;
    const right=document.createElement('span'); right.className='isk-detail-value';
    if(row.display) right.textContent=row.display;
    else {
      const amount=moneyText(row.value);
      const share=percentOf(row.value,base);
      right.textContent=share?`${amount} / ${share}`:amount;
    }
    line.append(left,right); list.appendChild(line);
  });
  pop.appendChild(list);
  const totalLine=document.createElement('div'); totalLine.className='isk-detail-total';
  const totalLabel=document.createElement('b'); totalLabel.textContent='Итого';
  const totalValue=document.createElement('b'); totalValue.textContent=card.querySelector('strong')?.textContent||moneyText(total);
  totalLine.append(totalLabel,totalValue); pop.appendChild(totalLine);
  card.appendChild(pop);
  button.setAttribute('aria-expanded','true');
}

function documentIcon(){
  return '<svg width="12" height="12" fill="none" stroke-width="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 3v4a1 1 0 0 1-1 1H5m4 8h6m-6-4h6m4-8v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7.914a1 1 0 0 1 .293-.707l3.914-3.914A1 1 0 0 1 9.914 3H18a1 1 0 0 1 1 1"></path></svg>';
}

function enhanceCard(card){
  if(card.dataset.transparencyReady==='1')return;
  const top=card.querySelector('.metric-top');
  const labelEl=top?.querySelector(':scope > span');
  if(!top||!labelEl)return;
  const label=normalize(labelEl.textContent);
  card.dataset.transparencyReady='1';
  card.style.position='relative';

  const titleWrap=document.createElement('span');
  titleWrap.className='isk-metric-label';
  titleWrap.textContent=label;
  labelEl.replaceWith(titleWrap);

  const info=document.createElement('button');
  info.type='button'; info.className='isk-info-trigger'; info.textContent='i';
  info.setAttribute('aria-label',`Как рассчитывается: ${label}`);
  info.setAttribute('aria-haspopup','dialog'); info.setAttribute('aria-expanded','false');
  info.addEventListener('click',e=>{e.stopPropagation();showInfo(card,label,info)});
  titleWrap.appendChild(info);

  const oldIcon=top.querySelector(':scope > svg');
  if(oldIcon)oldIcon.remove();
  const actions=document.createElement('div'); actions.className='isk-metric-actions';
  const detail=document.createElement('button');
  detail.type='button'; detail.className='isk-details-trigger'; detail.dataset.testid='details-dropdown-trigger';
  detail.setAttribute('aria-label',`Детализация расчёта: ${label}`);
  detail.setAttribute('aria-haspopup','dialog'); detail.setAttribute('aria-expanded','false');
  const count=detailRows(label,card).length;
  detail.innerHTML=`${documentIcon()}<span>${count}</span>`;
  detail.addEventListener('click',e=>{e.stopPropagation();showDetails(card,label,detail)});
  actions.appendChild(detail); top.appendChild(actions);
}

function refreshCounts(){
  document.querySelectorAll('.metric[data-transparency-ready="1"]').forEach(card=>{
    const label=normalize(card.querySelector('.isk-metric-label')?.childNodes[0]?.textContent || card.querySelector('.isk-metric-label')?.textContent);
    const span=card.querySelector('.isk-details-trigger span');
    if(span)span.textContent=String(detailRows(label,card).length);
  });
}

let scheduled=false;
function enhance(){
  scheduled=false;
  if(location.pathname!=='/digitization')return;
  document.querySelectorAll('.metric').forEach(enhanceCard);
  refreshCounts();
}
function schedule(){
  if(scheduled)return; scheduled=true; requestAnimationFrame(enhance);
}

const observer=new MutationObserver(schedule);
observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
window.addEventListener('popstate',schedule);
document.addEventListener('click',e=>{
  if(!e.target.closest('.isk-metric-popover,.isk-info-trigger,.isk-details-trigger')){
    closePopovers();
    document.querySelectorAll('.isk-info-trigger,.isk-details-trigger').forEach(b=>b.setAttribute('aria-expanded','false'));
  }
});

schedule();

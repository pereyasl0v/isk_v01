const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
const parseNum=s=>{const x=Number(String(s||'').replace(/\u00a0/g,' ').replace(/[^0-9,.-]/g,'').replace(',','.'));return Number.isFinite(x)?x:0};
const rub=v=>`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v)} ₽`;

function findPanel(title){
 return [...document.querySelectorAll('.panel')].find(p=>norm(p.querySelector('h3')?.textContent)===title);
}

function salesBySku(){
 const panel=findPanel('По SKU');
 const map=new Map();
 if(!panel)return map;
 [...panel.querySelectorAll('tbody tr')].forEach(tr=>{
  const td=[...tr.querySelectorAll('td')];
  if(td.length<8)return;
  const sku=norm(td[1].textContent);
  map.set(sku,{name:norm(td[0].textContent),qty:parseNum(td[2].textContent)});
 });
 return map;
}

function ensureInfo(panel){
 let box=panel.querySelector('.isk-cost-explain');
 if(box)return box;
 box=document.createElement('div');
 box.className='isk-cost-explain';
 box.innerHTML='<strong>Как считается себестоимость продаж</strong><span>По каждому SKU: продано, шт × (ваша себестоимость 1 шт. + ФФ 1 шт.). Затем все товары складываются.</span><small>Значения привязаны к SKU. Проверьте название товара и SKU перед вводом — перестановка себестоимости между товарами напрямую меняет чистую прибыль.</small><b class="isk-cost-total"></b>';
 const tableWrap=panel.querySelector('.table-scroll');
 panel.insertBefore(box,tableWrap||panel.firstChild);
 return box;
}

function enhanceCostTable(){
 if(location.pathname!=='/digitization')return;
 const panel=findPanel('Себестоимость товаров');
 if(!panel)return;
 const table=panel.querySelector('table');
 if(!table)return;
 const sales=salesBySku();
 const head=[...table.querySelectorAll('thead th')];
 if(head.length<8)return;
 head[2].textContent='Ваша себестоимость 1 шт., ₽';
 head[3].textContent='ФФ 1 шт., ₽';
 if(!table.querySelector('th[data-cost-sold]')){
  const th=document.createElement('th');th.dataset.costSold='1';th.textContent='Продано за период';
  head[1].after(th);
  const thCalc=document.createElement('th');thCalc.dataset.costCalc='1';thCalc.textContent='Себестоимость продаж за период';
  table.querySelector('thead tr').appendChild(thCalc);
 }
 const tbody=table.querySelector('tbody');
 const rows=[...tbody.querySelectorAll('tr')];
 rows.forEach(tr=>{
  const td=[...tr.querySelectorAll('td')];
  const sku=norm(td[1]?.textContent);
  const sale=sales.get(sku)||{qty:0};
  let sold=tr.querySelector('td[data-cost-sold]');
  if(!sold){sold=document.createElement('td');sold.dataset.costSold='1';td[1].after(sold)}
  sold.textContent=`${sale.qty} шт`;
  let calc=tr.querySelector('td[data-cost-calc]');
  if(!calc){calc=document.createElement('td');calc.dataset.costCalc='1';tr.appendChild(calc)}
  const inputs=[...tr.querySelectorAll('input')];
  const cost=parseNum(inputs[0]?.value),ff=parseNum(inputs[1]?.value);
  const total=sale.qty*(cost+ff);
  calc.innerHTML=`<strong>${rub(total)}</strong><small>${sale.qty} × (${rub(cost)} + ${rub(ff)})</small>`;
  tr.dataset.soldQty=String(sale.qty);
 });
 rows.sort((a,b)=>Number(b.dataset.soldQty||0)-Number(a.dataset.soldQty||0)||norm(a.cells[0]?.textContent).localeCompare(norm(b.cells[0]?.textContent),'ru')).forEach(r=>tbody.appendChild(r));
 const total=rows.reduce((sum,tr)=>{
  const td=[...tr.querySelectorAll('td')];const sku=norm(td[1]?.textContent);const qty=(sales.get(sku)||{qty:0}).qty;const inputs=[...tr.querySelectorAll('input')];return sum+qty*(parseNum(inputs[0]?.value)+parseNum(inputs[1]?.value));
 },0);
 const box=ensureInfo(panel);const totalEl=box.querySelector('.isk-cost-total');if(totalEl)totalEl.textContent=`Итого себестоимость продаж за период: ${rub(total)}`;
}

function cogsRows(){
 const panel=findPanel('Себестоимость товаров');
 if(!panel)return [];
 return [...panel.querySelectorAll('tbody tr')].map(tr=>{
  const td=[...tr.querySelectorAll('td')];
  const name=norm(td[0]?.textContent),sku=norm(td[1]?.textContent);
  const sold=tr.querySelector('td[data-cost-sold]');
  const qty=parseNum(sold?.textContent);
  const inputs=[...tr.querySelectorAll('input')];
  const cost=parseNum(inputs[0]?.value),ff=parseNum(inputs[1]?.value);
  return {label:`${name} · ${sku}`,display:`${qty} шт × (${rub(cost)} + ${rub(ff)}) = ${rub(qty*(cost+ff))}`,value:qty*(cost+ff)};
 }).filter(x=>x.value!==0);
}

function showCogsDetails(card,button){
 document.querySelectorAll('.isk-metric-popover').forEach(x=>x.remove());
 const rows=cogsRows();
 const pop=document.createElement('div');pop.className='isk-metric-popover isk-details-popover';
 const title=document.createElement('div');title.className='isk-pop-title';title.textContent=`Себестоимость продаж: ${rows.length}`;pop.appendChild(title);
 const list=document.createElement('div');list.className='isk-detail-list';
 rows.forEach(x=>{const row=document.createElement('div');row.className='isk-detail-row isk-cost-detail-row';const l=document.createElement('span');l.textContent=x.label;const v=document.createElement('span');v.className='isk-detail-value';v.textContent=x.display;row.append(l,v);list.appendChild(row)});pop.appendChild(list);
 const total=document.createElement('div');total.className='isk-detail-total';const a=document.createElement('b');a.textContent='Итого';const z=document.createElement('b');z.textContent=rub(rows.reduce((s,x)=>s+x.value,0));total.append(a,z);pop.appendChild(total);card.appendChild(pop);button.setAttribute('aria-expanded','true');
}

document.addEventListener('click',e=>{
 const btn=e.target.closest('.isk-details-trigger');
 if(!btn)return;
 const card=btn.closest('.metric');
 const label=norm(card?.querySelector('.metric-top > span')?.childNodes[0]?.textContent);
 if(label!=='Себестоимость продаж')return;
 e.preventDefault();e.stopImmediatePropagation();showCogsDetails(card,btn);
},true);

document.addEventListener('input',e=>{if(e.target.closest('.panel')&&findPanel('Себестоимость товаров')?.contains(e.target))requestAnimationFrame(enhanceCostTable)});
let scheduled=false;function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;enhanceCostTable()})}
new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
window.addEventListener('popstate',schedule);schedule();

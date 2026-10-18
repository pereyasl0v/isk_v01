const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
const parseNum=s=>{const x=Number(String(s||'').replace(/\u00a0/g,' ').replace(/[^0-9,.-]/g,'').replace(',','.'));return Number.isFinite(x)?x:0};
const rub=v=>`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v)} ₽`;
const setText=(el,text)=>{if(el&&el.textContent!==text)el.textContent=text};

function findPanel(title){
 return [...document.querySelectorAll('.panel')].find(p=>norm(p.querySelector('h3')?.textContent)===title);
}

function ensureStyles(){
 if(document.getElementById('isk-cost-guard-style'))return;
 const style=document.createElement('style');style.id='isk-cost-guard-style';style.textContent=`
 .isk-cost-explain{display:flex;flex-direction:column;gap:6px;margin:0 0 16px;padding:14px 16px;border:1px solid #dce7df;border-radius:9px;background:#f5faf6;color:#42634f;font-size:12px;line-height:1.55}
 .isk-cost-explain strong{font-size:13px;color:#244a35}.isk-cost-explain small{font-size:11px;color:#718579}.isk-cost-explain .isk-cost-total{margin-top:4px;color:#183f2c;font-size:13px}
 td[data-cost-calc] strong{display:block;font-size:12px;color:#294b38}td[data-cost-calc] small{display:block;margin-top:3px;font-size:10px;white-space:nowrap}.isk-cost-detail-row{align-items:flex-start}.isk-cost-detail-row .isk-detail-value{max-width:330px;white-space:normal;text-align:right}
 `;document.head.appendChild(style);
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
 box.innerHTML='<strong>Как считается себестоимость продаж</strong><span>По каждому SKU: продано, шт × (ваша себестоимость 1 шт. + ФФ 1 шт.). Затем все товары складываются.</span><small>Значения привязаны к SKU. Всегда сверяйте название товара и SKU перед вводом: если себестоимости двух товаров поменять местами, чистая прибыль изменится на ту же сумму.</small><b class="isk-cost-total"></b>';
 const tableWrap=panel.querySelector('.table-scroll');
 panel.insertBefore(box,tableWrap||panel.firstChild);
 return box;
}

function enhanceCostTable(){
 if(location.pathname!=='/digitization')return;
 ensureStyles();
 const panel=findPanel('Себестоимость товаров');
 if(!panel)return;
 const table=panel.querySelector('table');
 if(!table)return;
 const sales=salesBySku();
 let head=[...table.querySelectorAll('thead th')];
 if(head.length<8)return;
 setText(head[2],'Ваша себестоимость 1 шт., ₽');
 setText(head[3],'ФФ 1 шт., ₽');
 if(!table.querySelector('th[data-cost-sold]')){
  const th=document.createElement('th');th.dataset.costSold='1';th.textContent='Продано за период';head[1].after(th);
  const thCalc=document.createElement('th');thCalc.dataset.costCalc='1';thCalc.textContent='Себестоимость продаж за период';table.querySelector('thead tr').appendChild(thCalc);
 }
 const tbody=table.querySelector('tbody');
 const rows=[...tbody.querySelectorAll('tr')];
 rows.forEach(tr=>{
  const td=[...tr.querySelectorAll('td')];
  const sku=norm(td[1]?.textContent);
  const sale=sales.get(sku)||{qty:0};
  let sold=tr.querySelector('td[data-cost-sold]');
  if(!sold){sold=document.createElement('td');sold.dataset.costSold='1';td[1].after(sold)}
  setText(sold,`${sale.qty} шт`);
  let calc=tr.querySelector('td[data-cost-calc]');
  if(!calc){calc=document.createElement('td');calc.dataset.costCalc='1';tr.appendChild(calc)}
  const inputs=[...tr.querySelectorAll('input')];
  const cost=parseNum(inputs[0]?.value),ff=parseNum(inputs[1]?.value),total=sale.qty*(cost+ff);
  const key=`${sale.qty}|${cost}|${ff}|${total}`;
  if(calc.dataset.formulaKey!==key){calc.dataset.formulaKey=key;calc.innerHTML=`<strong>${rub(total)}</strong><small>${sale.qty} × (${rub(cost)} + ${rub(ff)})</small>`}
  tr.dataset.soldQty=String(sale.qty);
 });
 const desired=[...rows].sort((a,b)=>Number(b.dataset.soldQty||0)-Number(a.dataset.soldQty||0)||norm(a.cells[0]?.textContent).localeCompare(norm(b.cells[0]?.textContent),'ru'));
 const current=[...tbody.querySelectorAll('tr')];
 if(desired.some((r,i)=>current[i]!==r))desired.forEach(r=>tbody.appendChild(r));
 const total=rows.reduce((sum,tr)=>{
  const td=[...tr.querySelectorAll('td')],sku=norm(td[1]?.textContent),qty=(sales.get(sku)||{qty:0}).qty,inputs=[...tr.querySelectorAll('input')];
  return sum+qty*(parseNum(inputs[0]?.value)+parseNum(inputs[1]?.value));
 },0);
 const box=ensureInfo(panel),totalEl=box.querySelector('.isk-cost-total');setText(totalEl,`Итого себестоимость продаж за период: ${rub(total)}`);
}

function cogsRows(){
 const panel=findPanel('Себестоимость товаров');
 if(!panel)return [];
 return [...panel.querySelectorAll('tbody tr')].map(tr=>{
  const td=[...tr.querySelectorAll('td')],name=norm(td[0]?.textContent),sku=norm(td[1]?.textContent),qty=parseNum(tr.querySelector('td[data-cost-sold]')?.textContent),inputs=[...tr.querySelectorAll('input')],cost=parseNum(inputs[0]?.value),ff=parseNum(inputs[1]?.value),value=qty*(cost+ff);
  return {label:`${name} · ${sku}`,display:`${qty} шт × (${rub(cost)} + ${rub(ff)}) = ${rub(value)}`,value};
 }).filter(x=>x.value!==0);
}

function showCogsDetails(card,button){
 document.querySelectorAll('.isk-metric-popover').forEach(x=>x.remove());
 const rows=cogsRows(),pop=document.createElement('div');pop.className='isk-metric-popover isk-details-popover';
 const title=document.createElement('div');title.className='isk-pop-title';title.textContent=`Себестоимость продаж: ${rows.length}`;pop.appendChild(title);
 const list=document.createElement('div');list.className='isk-detail-list';
 rows.forEach(x=>{const row=document.createElement('div');row.className='isk-detail-row isk-cost-detail-row';const l=document.createElement('span');l.textContent=x.label;const v=document.createElement('span');v.className='isk-detail-value';v.textContent=x.display;row.append(l,v);list.appendChild(row)});pop.appendChild(list);
 const total=document.createElement('div');total.className='isk-detail-total';const a=document.createElement('b');a.textContent='Итого';const z=document.createElement('b');z.textContent=rub(rows.reduce((s,x)=>s+x.value,0));total.append(a,z);pop.appendChild(total);card.appendChild(pop);button.setAttribute('aria-expanded','true');
}

document.addEventListener('click',e=>{
 const btn=e.target.closest('.isk-details-trigger');if(!btn)return;
 const card=btn.closest('.metric'),label=norm(card?.querySelector('.metric-top > span')?.childNodes[0]?.textContent);
 if(label!=='Себестоимость продаж')return;
 e.preventDefault();e.stopImmediatePropagation();showCogsDetails(card,btn);
},true);

document.addEventListener('input',e=>{const panel=findPanel('Себестоимость товаров');if(panel?.contains(e.target))requestAnimationFrame(enhanceCostTable)});
let scheduled=false;function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;enhanceCostTable()})}
new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
window.addEventListener('popstate',schedule);schedule();

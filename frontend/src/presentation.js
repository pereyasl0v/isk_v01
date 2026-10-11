export const statusLabel = value => ({
 awaiting_packaging:'Ожидает упаковки', awaiting_deliver:'Ожидает отгрузки',
 delivering:'Доставляется', delivered:'Доставлено', cancelled:'Отменено',
 awaiting_registration:'Ожидает регистрации', acceptance_in_progress:'Идёт приёмка',
 arbitration:'Спор', client_arbitration:'Спор с покупателем', not_accepted:'Не принято',
 driver_pickup:'Забирает водитель', sent_by_seller:'Передано продавцом'
}[value] || 'Другой статус');
export const roleLabel = value => ({'Admin read only':'Администратор — только чтение',
 Admin:'Администратор', 'Posting FBO':'Отправления со склада Ozon',
 'Posting FBS':'Отправления со склада продавца', 'Read only':'Только чтение',
 'Product':'Товары', 'Products':'Товары', 'Analytics':'Аналитика'}[value] || 'Доступ к операциям кабинета');

export function groupStocks(products, rows, raw=false) {
 const bySku=new Map(),byOffer=new Map(),byId=new Map();
 for(const p of products){
  if(p.sku)bySku.set(String(p.sku),p);
  if(p.offer_id)byOffer.set(String(p.offer_id),p);
  if(p.id??p.product_id)byId.set(String(p.id??p.product_id),p);
 }
 const groups=new Map();
 for(const row of rows){
  const p=byId.get(String(row.product_id))||bySku.get(String(row.sku))||byOffer.get(String(row.offer_id));
  const key=String(p?.id??p?.product_id??p?.offer_id??row.offer_id??row.sku);
  if(!groups.has(key))groups.set(key,{key,name:p?.name||row.name||'Товар без названия',
   offer:p?.offer_id||row.offer_id||'',skus:new Set(),rows:[],total:0});
  const g=groups.get(key);g.skus.add(String(row.sku));g.rows.push(row);
  g.total+=Number(raw?row.present:row.available_stock_count)||0;
 }
 return [...groups.values()].map(g=>({...g,skus:[...g.skus]})).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
}

// Counts are based on the same date-filtered Ozon postings displayed in History.
// Unknown / pending states remain visible as "Other" in the expanded diagram
// so the chart never pretends the three requested statuses cover all orders.
const TYPES=[
 {key:'delivering',label:'Доставляется',color:'#268bc1'},
 {key:'delivered',label:'Доставлено',color:'#26865a'},
 {key:'cancelled',label:'Отменено',color:'#dc7065'},
 {key:'other',label:'Другие статусы',color:'#c7d1d0'}
];

export function postingStatusGroup(posting){
 const status=String(posting?.status||'').toLowerCase().trim();
 const substatus=String(posting?.substatus||'').toLowerCase().trim();
 if(['cancelled','canceled','posting_cancelled','posting_canceled'].includes(status))return 'cancelled';
 if(['delivered','posting_delivered','posting_received'].includes(status))return 'delivered';
 if(['delivering','posting_on_way_to_city','posting_on_way_to_pickup_point','posting_transferring_to_delivery','posting_in_delivery_point'].includes(status))return 'delivering';
 // Fall back to Ozon posting substatus only if the posting status is absent.
 if(!status){
  if(['posting_cancelled','posting_canceled'].includes(substatus))return 'cancelled';
  if(['posting_received','posting_delivered'].includes(substatus))return 'delivered';
  if(['posting_on_way_to_city','posting_on_way_to_pickup_point','posting_transferring_to_delivery','posting_in_delivery_point'].includes(substatus))return 'delivering';
 }
 return 'other';
}

export function shipmentStatusSummary(postings){
 const rows=Array.isArray(postings)?postings:[];
 const totals={delivering:0,delivered:0,cancelled:0,other:0};
 let units=0,cancelledUnits=0;
 for(const posting of rows){
  const group=postingStatusGroup(posting);
  totals[group]++;
  const quantity=(Array.isArray(posting?.products)?posting.products:[])
   .reduce((sum,item)=>{
    const n=Number(item?.quantity);
    return sum+(Number.isFinite(n)&&n>0?n:0);
   },0);
  units+=quantity;
  if(group==='cancelled')cancelledUnits+=quantity;
 }
 const total=rows.length;
 const items=TYPES.map(type=>({
  ...type,count:totals[type.key],percentage:total?totals[type.key]/total*100:0
 }));
 let offset=0;
 const stops=items.filter(item=>item.count>0).map(item=>{
  const start=offset;
  offset+=item.percentage;
  return item.color+' '+start.toFixed(4)+'% '+offset.toFixed(4)+'%';
 });
 return {
  total,
  units,
  cancelledUnits,
  cancelledPostings:totals.cancelled,
  items,
  preview:items.slice(0,3),
  gradient:stops.length?'conic-gradient('+stops.join(', ')+')':'#e7ece9'
 };
}

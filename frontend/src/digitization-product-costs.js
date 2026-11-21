import {useEffect, useState} from 'react';

async function requestProductCosts(path,method='GET',body){
 const response=await fetch(path,{
  credentials:'same-origin',method,
  ...(body!==undefined&&{headers:{'Content-Type':'application/json','X-Local-App':'fbo'},body:JSON.stringify(body)}),
 });
 const data=await response.json();
 if(!response.ok)throw new Error(data.detail||'Не удалось обратиться к базе себестоимости.');
 return data;
}

function readLegacyCosts(key){
 try{
  const raw=localStorage.getItem(key);
  const costs=JSON.parse(raw);
  if(costs&&typeof costs==='object'&&!Array.isArray(costs)&&Object.keys(costs).length){
   return {raw,costs};
  }
 }catch{}
 return null;
}

export function useProductCosts(accountId,clientId){
 const path='/api/accounts/'+encodeURIComponent(accountId)+'/product-costs';
 const legacyKey='isk-digitization-costs-'+clientId;
 const [legacy,setLegacy]=useState(()=>readLegacyCosts(legacyKey));
 const [costs,setCosts]=useState({});
 const [drafts,setDrafts]=useState({});
 const [pending,setPending]=useState({});
 const [loaded,setLoaded]=useState(false);
 const [loading,setLoading]=useState(true);
 const [importing,setImporting]=useState(false);
 const [error,setError]=useState('');
 const [attempt,reload]=useState(0);
 const saving=Object.keys(pending).length>0;

 useEffect(()=>{
  let live=true;
  requestProductCosts(path).then(data=>{
   if(!live)return;
   setCosts(data.costs);
   setLoaded(true);
  }).catch(err=>{
   if(live)setError('Не удалось загрузить себестоимость. '+err.message);
  }).finally(()=>{
   if(live)setLoading(false);
  });
  return()=>{live=false};
 },[path,attempt]);

 function retryLoad(){
  setError('');
  setLoading(true);
  reload(attempt+1);
 }

 function edit(sku,value){
  setDrafts(previous=>({...previous,[sku]:value}));
 }

 async function save(sku,value,badInput){
  if(!loaded||importing||pending[sku]||!(sku in drafts))return;
  const cost=value===''?null:Number(value);
  if(badInput||(cost!==null&&(!Number.isFinite(cost)||cost<0||cost>1_000_000_000))){
   setError('Введите себестоимость от 0 до 1 000 000 000 ₽.');
   return;
  }
  const clearDraft=()=>setDrafts(previous=>{
   const next={...previous};
   delete next[sku];
   return next;
  });
  if(cost===(costs[sku]?.cost??null)){clearDraft();return}
  setError('');
  setPending(previous=>({...previous,[sku]:true}));
  try{
   const row=await requestProductCosts(path+'/'+encodeURIComponent(sku),'PUT',{cost});
   setCosts(previous=>({...previous,[sku]:row}));
   clearDraft();
  }catch(err){
   setError('Не удалось сохранить себестоимость. '+err.message+' Чтобы повторить, вернитесь в поле и нажмите Enter.');
  }finally{
   setPending(previous=>{
    const next={...previous};
    delete next[sku];
    return next;
   });
  }
 }

 async function importLegacy(){
  if(!legacy||!loaded||importing||saving||Object.keys(drafts).length)return;
  setImporting(true);
  setError('');
  try{
   const data=await requestProductCosts(path+'/import','POST',{costs:legacy.costs});
   setCosts(data.costs);
   try{
    if(localStorage.getItem(legacyKey)===legacy.raw)localStorage.removeItem(legacyKey);
   }catch{}
   setLegacy(readLegacyCosts(legacyKey));
  }catch(err){
   setError('Не удалось перенести себестоимость из браузера. '+err.message);
  }finally{
   setImporting(false);
  }
 }

 return {costs,drafts,pending,loaded,loading,importing,saving,error,legacy,retryLoad,edit,save,importLegacy};
}

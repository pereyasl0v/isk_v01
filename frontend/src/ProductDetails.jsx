import React, {useEffect, useRef, useState} from 'react';
import {Download, FileText, Paperclip, Save, Trash2, Upload, X} from 'lucide-react';
import './productDetails.css';

const sizeText=bytes=>bytes>=1024*1024
 ? (bytes/(1024*1024)).toFixed(1)+' МБ'
 : Math.max(1,Math.ceil(bytes/1024))+' КБ';
const niceDate=value=>value?new Date(value).toLocaleDateString('ru-RU'):'';

async function jsonResponse(response){
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.detail||'Не удалось выполнить действие.');
 return data;
}

export default function ProductDetails({product,onClose}){
 const productId=String(product.id);
 const path='/api/products/'+encodeURIComponent(productId);
 const fileInput=useRef(null);
 const closeButton=useRef(null);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [description,setDescription]=useState('');
 const [savedDescription,setSavedDescription]=useState('');
 const [documents,setDocuments]=useState([]);
 const [error,setError]=useState('');
 const [message,setMessage]=useState('');

 useEffect(()=>{
  const onKeyDown=event=>{if(event.key==='Escape')onClose()};
  document.addEventListener('keydown',onKeyDown);
  closeButton.current?.focus();
  return()=>document.removeEventListener('keydown',onKeyDown);
 },[onClose]);

 useEffect(()=>{
  let active=true;
  setLoading(true);
  setError('');
  fetch(path+'/details',{credentials:'same-origin'})
   .then(jsonResponse)
   .then(data=>{
    if(!active)return;
    setDescription(data.description||'');
    setSavedDescription(data.description||'');
    setDocuments(data.documents||[]);
   })
   .catch(err=>{if(active)setError(err.message)})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[path]);

 async function reload(){
  const data=await jsonResponse(await fetch(path+'/details',{credentials:'same-origin'}));
  setDocuments(data.documents||[]);
 }

 async function saveDescription(){
  setError('');setMessage('');setBusy(true);
  try{
   const data=await jsonResponse(await fetch(path+'/details',{
    method:'PUT',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({description})
   }));
   setSavedDescription(data.description);
   setMessage('Описание сохранено.');
  }catch(err){setError(err.message)}
  finally{setBusy(false)}
 }

 async function uploadFiles(files){
  if(!files?.length)return;
  setError('');setMessage('');setBusy(true);
  let count=0;
  try{
   for(const file of Array.from(files)){
    if(file.size>15*1024*1024)throw new Error('Файл '+file.name+' больше 15 МБ.');
    if(!file.size)throw new Error('Файл '+file.name+' пустой.');
    await jsonResponse(await fetch(path+'/documents',{
     method:'POST',credentials:'same-origin',
     headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},
     body:file
    }));
    count++;
   }
   setMessage(count===1?'Файл прикреплён.':'Прикреплено файлов: '+count+'.');
  }catch(err){setError(err.message)}
  finally{
   try{await reload()}catch(err){setError(err.message)}
   setBusy(false);
  }
 }

 async function removeFile(document){
  if(!window.confirm('Удалить файл «'+document.name+'»?'))return;
  setError('');setMessage('');setBusy(true);
  try{
   await jsonResponse(await fetch(path+'/documents/'+encodeURIComponent(document.id),{
    method:'DELETE',credentials:'same-origin'
   }));
   await reload();
   setMessage('Файл удалён.');
  }catch(err){setError(err.message)}
  finally{setBusy(false)}
 }

 return <div className="product-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <section className="product-modal" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title">
   <div className="product-modal-heading">
    <div>
     <span className="product-modal-eyebrow">Карточка товара</span>
     <h2 id="product-dialog-title">{product.name||'Товар'}</h2>
    </div>
    <button ref={closeButton} className="product-modal-close" type="button" aria-label="Закрыть карточку" onClick={onClose}><X size={19}/></button>
   </div>
   <div className="product-modal-meta">
    <span>Артикул: <strong>{product.offer_id||'—'}</strong></span>
    <span>Код Ozon: <strong>{product.id}</strong></span>
   </div>
   {loading?<div className="product-modal-loading">Загружаем карточку товара…</div>:<>
    <div className="product-modal-section">
     <div className="product-modal-section-head"><h3>Описание и заметки</h3><span>{description.length}/4000</span></div>
     <textarea
      aria-label="Описание и заметки по товару"
      rows={4}
      maxLength={4000}
      placeholder="Добавьте описание товара или важную информацию…"
      value={description}
      disabled={busy}
      onChange={event=>setDescription(event.target.value)}
     />
     <div className="product-modal-actions">
      <button type="button" className="primary" disabled={busy||description===savedDescription} onClick={saveDescription}><Save size={15}/> Сохранить описание</button>
     </div>
    </div>
    <div className="product-modal-section">
     <div className="product-modal-section-head"><h3>Прикреплённые документы</h3><span>{documents.length} файлов</span></div>
     {documents.length?<ul className="product-document-list">
      {documents.map(doc=><li key={doc.id} className="product-document">
       <FileText size={20} className="product-document-icon"/>
       <div className="product-document-text"><strong title={doc.name}>{doc.name}</strong><small>{sizeText(doc.size)} · {niceDate(doc.added_at)}</small></div>
       <a href={path+'/documents/'+encodeURIComponent(doc.id)} aria-label={'Скачать '+doc.name} title="Скачать"><Download size={17}/></a>
       <button type="button" disabled={busy} title="Удалить" aria-label={'Удалить '+doc.name} onClick={()=>removeFile(doc)}><Trash2 size={17}/></button>
      </li>)}
     </ul>:<div className="product-document-empty"><Paperclip size={18}/> Пока нет прикреплённых документов</div>}
     <input
      ref={fileInput}
      type="file"
      multiple
      accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.xml,.odt,.ods,.jpg,.jpeg,.png,.webp,.zip"
      className="product-hidden-file-input"
      aria-label="Выбрать файлы для товара"
      onChange={event=>{
       const files=event.target.files;
       uploadFiles(files);
       event.target.value='';
      }}
     />
     <button type="button" disabled={busy||documents.length>=40} className="product-attach-button" onClick={()=>fileInput.current?.click()}>
      <Upload size={16}/> Прикрепить файлы
     </button>
     
    </div>
   </>}
   {error&&<div className="product-modal-error" role="alert">{error}</div>}
   {message&&<div className="product-modal-success" role="status">{message}</div>}
  </section>
 </div>;
}

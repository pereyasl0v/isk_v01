import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Barcode as BarcodeIcon, Download, RotateCcw, CheckCircle2, AlertCircle, FileText, Archive, Search, X, Trash2, Save} from 'lucide-react';
import './barcodeGenerator.css';

const SIZE_OPTIONS = [
 {key:'58x40', label:'58 × 40', width:58, height:40},
 {key:'60x30', label:'60 × 30', width:60, height:30},
 {key:'60x40', label:'60 × 40', width:60, height:40},
 {key:'70x30', label:'70 × 30', width:70, height:30}
];

const INITIAL_VALUES = {
 productName:'', article:'', brand:'', color:'', size:'',
 completeness:'1 ед.', material:'', shelfLife:'не ограничен', additionalInfo:'',
 importer:'', importerInn:'', importerAddress:'', country:'',
 manufacturer:'', manufacturerAddress:'', manufacturingDate:''
};

const INITIAL_ENABLED = {
 productName:true, article:false, brand:true, color:true, size:true,
 completeness:true, material:true, shelfLife:true, additionalInfo:true,
 importer:true, importerInn:true, importerAddress:true, country:true,
 manufacturer:true, manufacturerAddress:true, manufacturingDate:true
};

const PRODUCT_FIELDS = [
 {key:'productName', label:'Название товара', placeholder:'Например, Щипцы СВП', wide:true},
 {key:'article', label:'Артикул', placeholder:'Артикул или SKU'},
 {key:'brand', label:'Бренд', placeholder:'Название бренда'},
 {key:'color', label:'Цвет', placeholder:'Цвет товара'},
 {key:'size', label:'Размер', placeholder:'Размер или модель'}
];

const EXTRA_FIELDS = [
 {key:'completeness', label:'Комплектация', placeholder:'Например, 1 ед.'},
 {key:'material', label:'Материал', placeholder:'Материал товара'},
 {key:'shelfLife', label:'Срок годности', placeholder:'Например, не ограничен'},
 {key:'additionalInfo', label:'Доп. информация', placeholder:'Произвольный текст', wide:true}
];

const MAKER_FIELDS = [
 {key:'importer', label:'Импортер', placeholder:'Наименование импортера', wide:true},
 {key:'importerInn', label:'ИНН импортера', placeholder:'ИНН'},
 {key:'importerAddress', label:'Адрес импортера', placeholder:'Адрес', wide:true},
 {key:'country', label:'Страна изготовления', placeholder:'Например, Китай'},
 {key:'manufacturer', label:'Изготовитель', placeholder:'Наименование изготовителя', wide:true},
 {key:'manufacturerAddress', label:'Адрес изготовителя', placeholder:'Адрес изготовителя', wide:true},
 {key:'manufacturingDate', label:'Дата изготовления', placeholder:'ДД.ММ.ГГГГ'}
];

const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function eanCheckDigit(firstTwelve){
 const sum = firstTwelve.split('').reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
 return String((10 - sum % 10) % 10);
}

function parseEan13(raw){
 const digits = String(raw || '').replace(/\D/g,'');
 if(!digits) return {valid:false, code:'', error:'Введите 12 или 13 цифр EAN-13.'};
 if(digits.length === 12){
  return {valid:true, code:digits + eanCheckDigit(digits), calculated:true, error:''};
 }
 if(digits.length === 13){
  const expected = eanCheckDigit(digits.slice(0,12));
  if(digits[12] !== expected) return {valid:false, code:'', expected, error:'Неверная контрольная цифра. Для этого номера последняя цифра должна быть '+expected+'.'};
  return {valid:true, code:digits, calculated:false, error:''};
 }
 return {valid:false, code:'', error:'В EAN-13 должно быть 12 цифр (контрольная добавится автоматически) или 13 цифр.'};
}

function encodeEan13(code){
 const first = Number(code[0]);
 const parity = EAN_PARITY[first];
 let pattern = '101';
 for(let i=1;i<=6;i++){
  const digit = Number(code[i]);
  pattern += parity[i-1] === 'L' ? EAN_L[digit] : EAN_G[digit];
 }
 pattern += '01010';
 for(let i=7;i<=12;i++) pattern += EAN_R[Number(code[i])];
 pattern += '101';
 return pattern;
}

function fontFor(bold, size){
 return (bold ? '700 ' : '400 ') + size + 'px Arial, "DejaVu Sans", sans-serif';
}

function buildLabelSegments(values, enabled){
 const segments = [];
 const add = (key, label, boldValue=false) => {
  const value = String(values[key] || '').trim();
  if(!enabled[key] || !value) return;
  if(segments.length) segments.push({text:' ',bold:false});
  if(label) segments.push({text:label+': ',bold:true});
  segments.push({text:value,bold:boldValue});
 };
 add('productName','',true);
 add('importer','Импортер');
 add('importerInn','ИНН импортера');
 add('importerAddress','Адрес импортера');
 add('article','Артикул');
 add('brand','Бренд');
 add('color','Цвет');
 add('size','Размер');
 add('completeness','Комплектация');
 add('material','Материал');
 add('shelfLife','Срок годности');
 add('additionalInfo','Доп. информация');
 add('country','Страна изготовления');
 add('manufacturer','Изготовитель');
 add('manufacturerAddress','Адрес изготовителя');
 add('manufacturingDate','Дата изготовления');
 return segments;
}

// Vector outlines reproduce the black certification symbols on the supplied
// reference labels. Draw on the same canvas used for preview and PDF export.
const CERTIFICATION_MARKS = {
 eac: {
  width:50, height:44,
  path:'M0 0H11V5H5V19H11V24H5V38H11V43H0Z M16 0H34V44H28V24H22V44H16Z M22 4V19H28V4Z M39 0H50V5H45V39H50V44H39Z'
 },
 rst: {
  width:56, height:44,
  path:'M51 7C37 -2 19 -3 7 7C-3 15 -3 29 7 37C19 47 37 46 51 37V30C41 34 28 29 28 22C28 13 40 9 51 14Z M8 15C8 10 12 8 17 8C23 8 26 12 26 17C26 23 21 26 14 25V20C18 21 21 19 21 16C21 12 14 12 13 16V35L8 31Z M44 18H56V22H53V26H47V22H44Z'
 }
};

function certificationLayout(options, widthPx, heightPx, scale){
 const marks = [];
 const right = widthPx - 2.5 * scale;
 const bottom = heightPx - 1.8 * scale;
 const gap = 1.5 * scale;
 const height = 5 * scale;
 const selected = [];
 if(options.showRst) selected.push('rst');
 if(options.showEac) selected.push('eac');
 // Both signs are stacked on 40 mm labels, like the reference. On compact
 // 30 mm labels they sit side by side so neither sign touches barcode digits.
 const horizontal = options.size.height <= 30;
 let x = right;
 let y = bottom;
 for(const key of selected.slice().reverse()){
  const mark = CERTIFICATION_MARKS[key];
  const h = height;
  const w = h * mark.width / mark.height;
  marks.push({mark,x:x-w,y:y-h,w,h});
  if(horizontal) x -= w + gap;
  else y -= h + gap;
 }
 return marks;
}

function drawCertificationMarks(ctx, marks){
 ctx.fillStyle = '#000000';
 for(const item of marks){
  ctx.save();
  ctx.translate(item.x,item.y);
  ctx.scale(item.w/item.mark.width,item.h/item.mark.height);
  ctx.fill(new Path2D(item.mark.path),'evenodd');
  ctx.restore();
 }
}

function wrapRichText(ctx, segments, fontSize, widthForLine){
 const lines = [];
 let current = [];
 let currentWidth = 0;
 const pushLine = () => {
  if(current.length) lines.push(current);
  current = [];
  currentWidth = 0;
 };
 for(const segment of segments){
  const parts = segment.text.match(/\s+|[^\s]+/g) || [];
  for(const part of parts){
   const whitespace = /^\s+$/.test(part);
   ctx.font = fontFor(segment.bold,fontSize);
   if(whitespace && !current.length) continue;
   const width = ctx.measureText(part).width;
   if(!whitespace && current.length && currentWidth + width > widthForLine(lines.length)){
    pushLine();
   }
   if(whitespace && currentWidth + width > widthForLine(lines.length)){
    pushLine();
    continue;
   }
   if(!whitespace && width > widthForLine(lines.length) && !current.length){
    let chunk = '';
    for(const char of part){
     if(chunk && ctx.measureText(chunk+char).width > widthForLine(lines.length)){
      current.push({text:chunk,bold:segment.bold});
      pushLine();
      chunk = char;
     }else chunk += char;
    }
    if(chunk){
     const chunkWidth = ctx.measureText(chunk).width;
     current.push({text:chunk,bold:segment.bold});
     currentWidth += chunkWidth;
    }
    continue;
   }
   current.push({text:part,bold:segment.bold});
   currentWidth += width;
  }
 }
 pushLine();
 return lines;
}

// Shared dimensions keep the barcode, placeholder and text aligned.
const BARCODE_TOP_MM = 2.8;
const BARCODE_HEIGHT_MM = 10.3;
const BARCODE_DIGIT_BASELINE_MM = BARCODE_TOP_MM + BARCODE_HEIGHT_MM + 4.55;
const BARCODE_TEXT_START_MM = BARCODE_DIGIT_BASELINE_MM + 1.5;

function renderBarcode(ctx, code, widthMm, scale){
 const pattern = encodeEan13(code);
 const barcodeWidth = (widthMm - 8) * scale;
 const moduleWidth = barcodeWidth / 117;
 const x0 = 4 * scale;
 const y0 = BARCODE_TOP_MM * scale;
 const barHeight = BARCODE_HEIGHT_MM * scale;
 ctx.fillStyle = '#111111';
 for(let i=0;i<pattern.length;i++){
  if(pattern[i] !== '1') continue;
  const guard = i < 3 || (i >= 45 && i < 50) || i >= 92;
  ctx.fillRect(x0 + (11+i)*moduleWidth, y0, moduleWidth + 0.18, barHeight + (guard ? 1.25*scale : 0));
 }
 const digitY = BARCODE_DIGIT_BASELINE_MM * scale;
 ctx.fillStyle = '#111111';
 ctx.font = fontFor(true,3.35*scale);
 ctx.textBaseline = 'alphabetic';
 ctx.textAlign = 'left';
 ctx.fillText(code[0],x0+0.2*scale,digitY);
 ctx.textAlign = 'center';
 ctx.fillText(code.slice(1,7).split('').join(' '),x0+(11+21)*moduleWidth,digitY);
 ctx.fillText(code.slice(7,13).split('').join(' '),x0+(58+21)*moduleWidth,digitY);
}

function renderLabelCanvas(canvas, options){
 const size = options.size;
 const dpi = 300;
 const scale = dpi / 25.4;
 const widthPx = Math.round(size.width * scale);
 const heightPx = Math.round(size.height * scale);
 canvas.width = widthPx;
 canvas.height = heightPx;
 const ctx = canvas.getContext('2d');
 ctx.fillStyle = '#ffffff';
 ctx.fillRect(0,0,widthPx,heightPx);
 ctx.textBaseline = 'alphabetic';
 let textStart = 3.5 * scale;
 if(options.barcodeEnabled){
  if(options.code) renderBarcode(ctx,options.code,size.width,scale);
  else{
   ctx.save();
   ctx.strokeStyle = '#c7d1ca';
   ctx.setLineDash([5,5]);
   ctx.strokeRect(4*scale,3*scale,(size.width-8)*scale,14*scale);
   ctx.setLineDash([]);
   ctx.fillStyle = '#829188';
   ctx.font = fontFor(false,2.2*scale);
   ctx.textAlign = 'center';
   ctx.fillText('Введите код EAN-13',widthPx/2,10.5*scale);
   ctx.restore();
  }
  textStart = BARCODE_TEXT_START_MM * scale;
 }
 const segments = buildLabelSegments(options.values,options.enabled);
 const marks = certificationLayout(options,widthPx,heightPx,scale);
 const maxWidth = (size.width - 5) * scale;
 const availableHeight = heightPx - textStart - 1.8*scale;
 let effectiveFontMm = options.textSize;
 let fontPx = effectiveFontMm * scale;
 let lineHeight = fontPx * 1.16;
 // No marks: every line uses the full printable width. Otherwise only
 // lines intersecting an enabled mark are shortened.
 const widthForLine = !marks.length ? () => maxWidth : index => {
  const top = textStart + index * lineHeight;
  const bottom = top + lineHeight;
  return marks.reduce((width,item) => {
   if(bottom > item.y - 0.5*scale && top < item.y + item.h + 0.5*scale){
    return Math.min(width,item.x - 2.5*scale - scale);
   }
   return width;
  },maxWidth);
 };
 let lines = wrapRichText(ctx,segments,fontPx,widthForLine);
 while(lines.length * lineHeight > availableHeight && effectiveFontMm > 0.85){
  effectiveFontMm = Math.max(0.85,Math.round((effectiveFontMm - 0.05)*100)/100);
  fontPx = effectiveFontMm * scale;
  lineHeight = fontPx * 1.16;
  lines = wrapRichText(ctx,segments,fontPx,widthForLine);
 }
 const maxLines = Math.max(0,Math.floor(availableHeight / lineHeight));
 const overflow = lines.length > maxLines;
 const visibleLines = lines.slice(0,maxLines);
 let y = textStart + fontPx;
 ctx.textAlign = 'left';
 ctx.fillStyle = '#111111';
 for(const line of visibleLines){
  let x = 2.5 * scale;
  for(const token of line){
   ctx.font = fontFor(token.bold,fontPx);
   ctx.fillText(token.text,x,y);
   x += ctx.measureText(token.text).width;
  }
  y += lineHeight;
 }
 drawCertificationMarks(ctx,marks);
 return {effectiveFontMm,overflow,lineCount:lines.length,visibleLines:visibleLines.length};
}

function buildPdf(jpegBytes, pixelWidth, pixelHeight, widthMm, heightMm){
 const encoder = new TextEncoder();
 const chunks = [];
 let byteOffset = 0;
 const offsets = new Array(6).fill(0);
 const addBytes = bytes => {chunks.push(bytes);byteOffset += bytes.length;};
 const addText = value => addBytes(encoder.encode(value));
 const pageWidth = widthMm * 72 / 25.4;
 const pageHeight = heightMm * 72 / 25.4;
 addText('%PDF-1.4\n%ISK\n');
 const object = (id,write) => {
  offsets[id] = byteOffset;
  addText(id+' 0 obj\n');
  write();
  addText('\nendobj\n');
 };
 object(1,()=>addText('<< /Type /Catalog /Pages 2 0 R >>'));
 object(2,()=>addText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
 object(3,()=>addText('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+pageWidth.toFixed(4)+' '+pageHeight.toFixed(4)+'] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
 object(4,()=>{
  addText('<< /Type /XObject /Subtype /Image /Width '+pixelWidth+' /Height '+pixelHeight+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+jpegBytes.length+' >>\nstream\n');
  addBytes(jpegBytes);
  addText('\nendstream');
 });
 const content = 'q\n'+pageWidth.toFixed(4)+' 0 0 '+pageHeight.toFixed(4)+' 0 0 cm\n/Im0 Do\nQ';
 object(5,()=>addText('<< /Length '+encoder.encode(content).length+' >>\nstream\n'+content+'\nendstream'));
 const xrefOffset = byteOffset;
 addText('xref\n0 6\n0000000000 65535 f \n');
 for(let i=1;i<=5;i++) addText(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
 addText('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xrefOffset+'\n%%EOF');
 return new Blob(chunks,{type:'application/pdf'});
}

function canvasToBlob(canvas){
 return new Promise((resolve,reject)=>{
  canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось подготовить изображение этикетки.')),'image/jpeg',0.97);
 });
}

function Field({field,value,enabled,onValue,onEnabled}){
 return <div className={'barcode-field'+(field.wide?' barcode-field-wide':'')}>
  <label className="barcode-field-toggle">
   <input type="checkbox" checked={Boolean(enabled[field.key])} onChange={event=>onEnabled(field.key,event.target.checked)}/>
   <span>{field.label}</span>
  </label>
  <input type="text" value={value} placeholder={field.placeholder} onChange={event=>onValue(field.key,event.target.value)} aria-label={field.label}/>
 </div>;
}

async function barcodeArchiveRequest(path, method='GET', body){
 const response = await fetch('/api'+path,{
  credentials:'same-origin',
  method,
  headers:body===undefined?{}:{'Content-Type':'application/json','X-Local-App':'fbo'},
  body:body===undefined?undefined:JSON.stringify(body)
 });
 const data = await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(data.detail||'Не удалось выполнить операцию с архивом.');
 return data;
}

function formatArchiveDate(value){
 if(!value) return '—';
 const date = new Date(value);
 return Number.isNaN(date.getTime())?'—':date.toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'});
}

export default function BarcodeGenerator(){
 const [values,setValues] = useState(INITIAL_VALUES);
 const [enabled,setEnabled] = useState(INITIAL_ENABLED);
 const [code,setCode] = useState('');
 const [barcodeEnabled,setBarcodeEnabled] = useState(true);
 const [sizeKey,setSizeKey] = useState('58x40');
 const [textSize,setTextSize] = useState(1.76);
 const [showEac,setShowEac] = useState(false);
 const [showRst,setShowRst] = useState(false);
 const [exporting,setExporting] = useState(false);
 const [exportError,setExportError] = useState('');
 const [exportSuccess,setExportSuccess] = useState(false);
 const [recordId,setRecordId] = useState(null);
 const [archiveOpen,setArchiveOpen] = useState(false);
 const [archiveQuery,setArchiveQuery] = useState('');
 const [archiveItems,setArchiveItems] = useState([]);
 const [archiveLoading,setArchiveLoading] = useState(false);
 const [archiveLoadingId,setArchiveLoadingId] = useState(null);
 const [archiveError,setArchiveError] = useState('');
 const [archiveNotice,setArchiveNotice] = useState('');
 const [savingArchive,setSavingArchive] = useState(false);
 const previewRef = useRef(null);
 const size = useMemo(()=>SIZE_OPTIONS.find(item=>item.key===sizeKey)||SIZE_OPTIONS[0],[sizeKey]);
 const codeResult = useMemo(()=>parseEan13(code),[code]);
 const [renderMeta,setRenderMeta] = useState({effectiveFontMm:1.76,overflow:false,lineCount:0,visibleLines:0});

 useEffect(()=>{
  if(!previewRef.current) return;
  const meta = renderLabelCanvas(previewRef.current,{
   values,enabled,code:codeResult.valid?codeResult.code:'',barcodeEnabled,size,textSize,showEac,showRst
  });
  setRenderMeta(meta);
 },[values,enabled,codeResult,barcodeEnabled,size,textSize,showEac,showRst]);

 useEffect(()=>{
  if(!archiveOpen) return;
  let active = true;
  const timer = window.setTimeout(async()=>{
   setArchiveLoading(true);
   setArchiveError('');
   try{
    const result = await barcodeArchiveRequest('/barcodes?q='+encodeURIComponent(archiveQuery));
    if(active) setArchiveItems(result.items||[]);
   }catch(error){
    if(active) setArchiveError(error?.message||'Не удалось загрузить архив.');
   }finally{
    if(active) setArchiveLoading(false);
   }
  },180);
  return ()=>{
   active = false;
   window.clearTimeout(timer);
  };
 },[archiveOpen,archiveQuery]);

 const openArchive = () => {
  setArchiveQuery('');
  setArchiveError('');
  setArchiveOpen(true);
 };
 const loadArchivedLabel = async(id) => {
  setArchiveLoadingId(id);
  setArchiveError('');
  try{
   const record = await barcodeArchiveRequest('/barcodes/'+encodeURIComponent(id));
   const data = record.data||{};
   setValues({...INITIAL_VALUES,...(data.values||{})});
   setEnabled({...INITIAL_ENABLED,...(data.enabled||{})});
   setCode(data.code||record.code||'');
   setBarcodeEnabled(data.barcodeEnabled!==false);
   setSizeKey(SIZE_OPTIONS.some(option=>option.key===data.sizeKey)?data.sizeKey:'58x40');
   setTextSize(Number.isFinite(Number(data.textSize))?Number(data.textSize):1.76);
   setShowEac(Boolean(data.showEac));
   setShowRst(Boolean(data.showRst));
   setRecordId(record.id);
   setExportError('');
   setExportSuccess(false);
   setArchiveNotice('Загружена этикетка из архива: '+record.name);
   setArchiveOpen(false);
  }catch(error){
   setArchiveError(error?.message||'Не удалось открыть этикетку.');
  }finally{
   setArchiveLoadingId(null);
  }
 };
 const saveToArchive = async() => {
  const name = String(values.productName||'').trim();
  if(!name){
   setExportError('Укажите наименование товара перед сохранением в архив.');
   return;
  }
  if(barcodeEnabled&&!codeResult.valid){
   setExportError('Введите корректный EAN-13 перед сохранением.');
   return;
  }
  setSavingArchive(true);
  setExportError('');
  setArchiveNotice('');
  try{
   const finalCode = codeResult.valid?codeResult.code:'';
   const body = {
    name,
    code:finalCode,
    data:{values,enabled,code:finalCode,barcodeEnabled,sizeKey,textSize,showEac,showRst}
   };
   const result = recordId
    ? await barcodeArchiveRequest('/barcodes/'+encodeURIComponent(recordId),'PUT',body)
    : await barcodeArchiveRequest('/barcodes','POST',body);
   setRecordId(result.id);
   setArchiveNotice(recordId?'Изменения сохранены в архиве.':'Этикетка сохранена в архиве.');
   setExportSuccess(false);
  }catch(error){
   setExportError(error?.message||'Не удалось сохранить этикетку в архив.');
  }finally{
   setSavingArchive(false);
  }
 };
 const deleteArchivedLabel = async(item) => {
  if(!window.confirm('Удалить этикетку «'+item.name+'» из архива?')) return;
  try{
   await barcodeArchiveRequest('/barcodes/'+encodeURIComponent(item.id),'DELETE');
   setArchiveItems(current=>current.filter(row=>row.id!==item.id));
   if(recordId===item.id) setRecordId(null);
   setArchiveNotice('Этикетка удалена из архива.');
  }catch(error){
   setArchiveError(error?.message||'Не удалось удалить этикетку.');
  }
 };

 const updateValue = (key,value) => {
  setValues(current=>({...current,[key]:value}));
  setExportSuccess(false);
  setArchiveNotice('');
 };
 const updateEnabled = (key,value) => {
  setEnabled(current=>({...current,[key]:value}));
  setExportSuccess(false);
  setArchiveNotice('');
 };
 const reset = () => {
  setValues(INITIAL_VALUES);
  setEnabled(INITIAL_ENABLED);
  setCode('');
  setBarcodeEnabled(true);
  setSizeKey('58x40');
  setTextSize(1.76);
  setShowEac(false);
  setShowRst(false);
  setRecordId(null);
  setExportError('');
  setExportSuccess(false);
  setArchiveNotice('');
 };
 const downloadPdf = async () => {
  if(barcodeEnabled && !codeResult.valid) return;
  if(renderMeta.overflow){
   setExportError('Часть текста не помещается на этикетку. Отключите лишние поля или уменьшите размер текста.');
   return;
  }
  setExporting(true);
  setExportError('');
  setExportSuccess(false);
  try{
   const canvas = previewRef.current;
   if(!canvas) throw new Error('Предпросмотр ещё не готов. Повторите попытку.');
   const jpeg = await canvasToBlob(canvas);
   const bytes = new Uint8Array(await jpeg.arrayBuffer());
   const pdf = buildPdf(bytes,canvas.width,canvas.height,size.width,size.height);
   const url = URL.createObjectURL(pdf);
   const link = document.createElement('a');
   const safeName = String(values.article || codeResult.code || 'etiketka').replace(/[^a-zA-Z0-9_-]+/g,'_');
   link.href = url;
   link.download = 'barcode_'+safeName+'_'+size.key+'.pdf';
   document.body.appendChild(link);
   link.click();
   link.remove();
   window.setTimeout(()=>URL.revokeObjectURL(url),1500);
   setExportSuccess(true);
  }catch(error){
   setExportError(error?.message || 'Не удалось сформировать PDF.');
  }finally{
   setExporting(false);
  }
 };

 const codeStatus = !code ? null : codeResult.valid
  ? {kind:'valid',text:codeResult.calculated?'Контрольная цифра добавлена автоматически: '+codeResult.code:'Контрольная цифра EAN-13 верна.'}
  : {kind:'error',text:codeResult.error};

 return <div className="barcode-page">
  <div className="page-heading barcode-page-heading">
   <div className="barcode-heading-icon"><BarcodeIcon size={25}/></div>
   <div className="barcode-heading-copy">
    <div className="eyebrow">ИНСТРУМЕНТЫ</div>
    <h1>Штрихкоды</h1>
    <p>Создавайте этикетки EAN-13 с данными товара и скачивайте PDF для печати.</p>
    {recordId&&<span className="barcode-editing-indicator">Редактируется запись из архива</span>}
   </div>
   <div className="barcode-heading-actions">
    <button type="button" className="barcode-archive-open" onClick={openArchive}><Archive size={16}/> Архив</button>
    <button type="button" className="barcode-reset-button" onClick={reset}><RotateCcw size={15}/> Новая этикетка</button>
   </div>
  </div>

  <div className="barcode-layout">
   <div className="barcode-form-column">
    <section className="barcode-card">
     <div className="barcode-card-heading">
      <div><h3>Данные товара</h3><p>Отметьте галочкой поля, которые нужно напечатать на этикетке.</p></div>
     </div>
     <div className="barcode-fields-grid">
      {PRODUCT_FIELDS.map(field=><Field key={field.key} field={field} value={values[field.key]} enabled={enabled} onValue={updateValue} onEnabled={updateEnabled}/>)}
     </div>
    </section>

    <details className="barcode-card barcode-details" open>
     <summary><span><strong>Дополнительные сведения</strong><small>Комплектация, материал, срок годности и свой текст</small></span><span className="barcode-details-arrow">⌄</span></summary>
     <div className="barcode-fields-grid">
      {EXTRA_FIELDS.map(field=><Field key={field.key} field={field} value={values[field.key]} enabled={enabled} onValue={updateValue} onEnabled={updateEnabled}/>)}
     </div>
    </details>

    <details className="barcode-card barcode-details" open>
     <summary><span><strong>Импортер и изготовитель</strong><small>Реквизиты, страна и дата изготовления</small></span><span className="barcode-details-arrow">⌄</span></summary>
     <div className="barcode-fields-grid">
      {MAKER_FIELDS.map(field=><Field key={field.key} field={field} value={values[field.key]} enabled={enabled} onValue={updateValue} onEnabled={updateEnabled}/>)}
     </div>
    </details>

    <section className="barcode-card barcode-code-card">
     <div className="barcode-card-heading"><div><h3>Штрихкод EAN-13</h3><p>Введите 12 цифр — контрольная цифра рассчитается автоматически, либо укажите все 13 цифр.</p></div></div>
     <label className="barcode-print-toggle"><input type="checkbox" checked={barcodeEnabled} onChange={event=>{setBarcodeEnabled(event.target.checked);setExportError('');setExportSuccess(false);setArchiveNotice('')}}/><span>Печатать штрихкод на этикетке</span></label>
     <label className="barcode-code-label" htmlFor="barcode-ean-input">Код EAN-13</label>
     <input id="barcode-ean-input" className="barcode-code-input" inputMode="numeric" autoComplete="off" maxLength={13} value={code} onChange={event=>{setCode(event.target.value.replace(/\D/g,'').slice(0,13));setExportError('');setExportSuccess(false);setArchiveNotice('')}} placeholder="Введите 12 или 13 цифр" disabled={!barcodeEnabled}/>
     {codeStatus&&<div className={'barcode-code-status '+codeStatus.kind}>{codeStatus.kind==='valid'?<CheckCircle2 size={16}/>:<AlertCircle size={16}/>}<span>{codeStatus.text}</span></div>}
     <p className="barcode-code-note"><AlertCircle size={14}/> Проверка контрольной цифры не регистрирует и не выдаёт номер GS1. Используйте код, присвоенный вашему товару. Данные этикетки обрабатываются в браузере и не отправляются на сервер.</p>
    </section>
   </div>

   <section className="barcode-preview-card">
    <div className="barcode-card-heading barcode-preview-heading"><div><h3>Предпросмотр этикетки</h3><p>Макет обновляется автоматически при изменении полей.</p></div><FileText size={19}/></div>
    <div className="barcode-size-settings">
     <span>Размер этикетки, мм</span>
     <div className="barcode-size-buttons" role="group" aria-label="Размер этикетки">
      {SIZE_OPTIONS.map(option=><button key={option.key} type="button" className={sizeKey===option.key?'selected':''} aria-pressed={sizeKey===option.key} onClick={()=>{setSizeKey(option.key);setArchiveNotice('')}}>{option.label}</button>)}
     </div>
    </div>
    <div className="barcode-preview-stage">
     <canvas ref={previewRef} className="barcode-preview-canvas" aria-label="Предпросмотр этикетки со штрихкодом"/>
     <span className="barcode-preview-dimensions">{size.width} × {size.height} мм</span>
    </div>
    <div className="barcode-print-settings">
     <div className="barcode-setting-row">
      <label htmlFor="barcode-text-size">Размер текста</label>
      <div className="barcode-range-control"><input id="barcode-text-size" type="range" min="0.85" max="2.4" step="0.05" value={textSize} onChange={event=>{setTextSize(Number(event.target.value));setArchiveNotice('')}}/><output>{renderMeta.effectiveFontMm.toFixed(2)} мм</output></div>
     </div>
     <div className="barcode-setting-row barcode-marks-row">
      <span>Маркировка</span>
      <div className="barcode-mark-options">
       <label><input type="checkbox" checked={showEac} onChange={event=>{setShowEac(event.target.checked);setArchiveNotice('')}}/> EAC</label>
       <label><input type="checkbox" checked={showRst} onChange={event=>{setShowRst(event.target.checked);setArchiveNotice('')}}/> РСТ</label>
      </div>
     </div>
    </div>
    {renderMeta.overflow&&<div className="barcode-warning"><AlertCircle size={16}/> Слишком много текста. Уменьшите размер шрифта или отключите часть полей.</div>}
    {barcodeEnabled&&!codeResult.valid&&<div className="barcode-preview-hint">Введите корректный код EAN-13, чтобы сформировать PDF со штрихкодом.</div>}
    {exportError&&<div className="barcode-warning"><AlertCircle size={16}/>{exportError}</div>}
    {archiveNotice&&<div className="barcode-success"><CheckCircle2 size={16}/>{archiveNotice}</div>}
    {exportSuccess&&<div className="barcode-success"><CheckCircle2 size={16}/> PDF готов. Проверьте папку загрузок.</div>}
    <button type="button" className="barcode-save-button" onClick={saveToArchive} disabled={savingArchive||!String(values.productName||'').trim()||(barcodeEnabled&&!codeResult.valid)}>
     <Save size={16}/>{savingArchive?'Сохраняем…':recordId?'Сохранить изменения':'Сохранить в архив'}
    </button>
    <button type="button" className="primary barcode-download-button" onClick={downloadPdf} disabled={exporting||(barcodeEnabled&&!codeResult.valid)||renderMeta.overflow}>
     <Download size={17}/>{exporting?'Формируем PDF…':'Скачать PDF'}
    </button>
    <p className="barcode-download-note">PDF создаётся в точном размере {size.width} × {size.height} мм. Печать — масштаб 100%, без подгонки под страницу.</p>
   </section>
  </div>

  {archiveOpen&&<div className="barcode-archive-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setArchiveOpen(false)}}>
   <section className="barcode-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="barcode-archive-title">
    <div className="barcode-archive-header">
     <div><h2 id="barcode-archive-title">Архив штрихкодов</h2><p>Сохранённые этикетки. Выберите запись, чтобы открыть и отредактировать её.</p></div>
     <button type="button" className="barcode-archive-close" aria-label="Закрыть архив" onClick={()=>setArchiveOpen(false)}><X size={19}/></button>
    </div>
    <label className="barcode-archive-search">
     <Search size={18}/>
     <input type="search" value={archiveQuery} onChange={event=>setArchiveQuery(event.target.value)} placeholder="Поиск по наименованию товара…" maxLength={100} autoFocus/>
    </label>
    <div className="barcode-archive-list" aria-live="polite">
     {archiveLoading&&<div className="barcode-archive-state">Загружаем архив…</div>}
     {!archiveLoading&&archiveError&&<div className="barcode-archive-error">{archiveError}</div>}
     {!archiveLoading&&!archiveError&&!archiveItems.length&&<div className="barcode-archive-empty"><Archive size={27}/><strong>{archiveQuery?'Ничего не найдено':'Архив пока пуст'}</strong><span>{archiveQuery?'Попробуйте изменить поисковый запрос.':'Сохраните созданную этикетку — она появится здесь.'}</span></div>}
     {!archiveLoading&&archiveItems.map(item=><div className="barcode-archive-item" key={item.id}>
      <button type="button" className="barcode-archive-item-main" onClick={()=>loadArchivedLabel(item.id)} disabled={archiveLoadingId===item.id}>
       <span className="barcode-archive-item-title">{item.name}</span>
       <span className="barcode-archive-item-meta">{item.code?'EAN-13: '+item.code:'Без штрихкода'} · Изменено: {formatArchiveDate(item.updated_at)}</span>
       <span className="barcode-archive-item-action">{archiveLoadingId===item.id?'Открываем…':'Открыть и редактировать'}</span>
      </button>
      <button type="button" className="barcode-archive-delete" aria-label={'Удалить '+item.name} title="Удалить из архива" onClick={()=>deleteArchivedLabel(item)}><Trash2 size={16}/></button>
     </div>)}
    </div>
    <div className="barcode-archive-footer">
     <span>{archiveItems.length} {archiveItems.length===1?'этикетка':archiveItems.length>=2&&archiveItems.length<=4?'этикетки':'этикеток'}</span>
     <button type="button" className="primary" onClick={()=>{reset();setArchiveOpen(false)}}>Создать новую этикетку</button>
    </div>
   </section>
  </div>}
 </div>;
}

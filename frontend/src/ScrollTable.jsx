import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';

export default function ScrollTable({ children, label, stickyColumn = false }) {
 const scroller=useRef(null);
 const hintId=useId();
 const [overflow,setOverflow]=useState(false);

 useEffect(()=>{
  const element=scroller.current;
  const measure=()=>setOverflow(element.scrollWidth>element.clientWidth+1);
  const observer=new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(element.firstElementChild);
  measure();
  return()=>observer.disconnect();
 },[]);

 return <>
  <div ref={scroller} className={'table-scroll'+(stickyColumn?' table-sticky-column':'')}
   role={overflow?'region':undefined} aria-label={overflow?label:undefined}
   aria-describedby={overflow?hintId:undefined} tabIndex={overflow?0:undefined}>
   {children}
  </div>
  {overflow&&<p id={hintId} className="table-scroll-hint"><ArrowLeftRight size={14} aria-hidden="true"/> Прокрутите таблицу в сторону</p>}
 </>;
}

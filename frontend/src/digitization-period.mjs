function moscowCalendarDate(value){
 const parts=new Intl.DateTimeFormat('en-US',{
  timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(value);
 const year=Number(parts.find(part=>part.type==='year').value);
 const month=Number(parts.find(part=>part.type==='month').value);
 const day=Number(parts.find(part=>part.type==='day').value);
 return new Date(Date.UTC(year,month-1,day));
}

/**
 * Returns an inclusive range ending yesterday in Moscow time, matching Ozon's
 * reporting-day boundary. A 7-day range includes yesterday and the prior 6 days.
 */
export function getDigitizationPeriod(days, now=new Date()){
 if(!Number.isInteger(days)||days<1)throw new RangeError('days must be a positive integer');
 const end=moscowCalendarDate(now);
 end.setUTCDate(end.getUTCDate()-1);
 const start=new Date(end);
 start.setUTCDate(start.getUTCDate()-(days-1));
 return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10)};
}

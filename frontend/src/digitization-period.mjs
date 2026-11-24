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

/**
 * Local SQLite always wins. Request Ozon only for genuinely missing closed
 * days. Yesterday becomes eligible after 08:00 Moscow time, when the scheduled
 * sync is expected to have started.
 */
export function shouldAutoLoadDigitization(coverage, now=new Date()){
 const missing=coverage?.missing_days;
 if(!Array.isArray(missing)||!missing.length)return false;
 const yesterday=getDigitizationPeriod(1,now).to;
 const hour=Number(new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'
 }).format(now));
 return missing.some(day=>typeof day==='string'&&(day<yesterday||(day===yesterday&&hour>=8)));
}

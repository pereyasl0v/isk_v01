function localDateString(value){
 const year=value.getFullYear();
 const month=String(value.getMonth()+1).padStart(2,'0');
 const day=String(value.getDate()).padStart(2,'0');
 return `${year}-${month}-${day}`;
}

/**
 * Returns an inclusive range ending yesterday in the browser's local timezone.
 * For example, 7 days means yesterday and the previous 6 calendar days.
 */
export function getDigitizationPeriod(days, now=new Date()){
 if(!Number.isInteger(days)||days<1)throw new RangeError('days must be a positive integer');
 const end=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
 const start=new Date(end.getFullYear(),end.getMonth(),end.getDate()-(days-1));
 return {from:localDateString(start),to:localDateString(end)};
}

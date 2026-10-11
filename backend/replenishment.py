"""Two-level coverage: each SKU/dispatch warehouse, then pooled SKU stock."""
from datetime import datetime, timedelta, timezone, time
from collections import defaultdict
from .inventory import quantity

MSK=timezone(timedelta(hours=3))
ACTIVE={'awaiting_packaging','awaiting_deliver','delivering','delivered'}
WINDOWS=(7,14,30,90)

def parse(value):
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:raise ValueError('Timezone required')
    return dt.astimezone(MSK)

def estimate(stock,units,days,known,anchor):
    rate=units/days if known else None
    if stock is None:
        return {'available':None,'units':units,'rate':rate,'days_left':None,'ends_at':None,'state':'unknown_stock'}
    if stock==0:
        return {'available':0,'units':units,'rate':rate,'days_left':0,'ends_at':None,'state':'empty'}
    if rate is None:
        return {'available':stock,'units':units,'rate':None,'days_left':None,'ends_at':None,'state':'unknown_rate'}
    if rate==0:
        return {'available':stock,'units':units,'rate':0,'days_left':None,'ends_at':None,'state':'no_orders'}
    days_left=stock/rate
    # Avoid overflow for very large stock and tiny rates.
    date=(anchor+timedelta(days=days_left)).isoformat() if days_left<365000 else None
    return {'available':stock,'units':units,'rate':rate,'days_left':days_left,'ends_at':date,'state':'estimated'}

def calculate(snapshot,history,window):
    if window not in WINDOWS:raise ValueError('Unsupported window')
    anchor=parse(snapshot['at'])
    start=parse(history['since']);end=min(parse(history['to']),anchor).date()
    first=start.date()+timedelta(days=0 if start.time()==time(0) else 1)
    coverage=max(0,(end-first).days)
    enough=coverage>=window
    begin=end-timedelta(days=window)
    warehouses={};names={};pairs={};raw_pairs=set();skus=set()
    for p in snapshot['products']:
        if p.get('sku'):
            k=str(p['sku']);skus.add(k);names[k]={'name':p.get('name',''),'offer_id':p.get('offer_id','')}
    for r in snapshot['stocks']:
        k=str(r['sku']);w=str(r['warehouse_id']);skus.add(k);raw_pairs.add((k,w))
        warehouses.setdefault(w,'');names.setdefault(k,{'name':'','offer_id':r.get('offer_id','')})
    for r in snapshot['analytics']:
        k=str(r['sku']);w=str(r['warehouse_id']);skus.add(k)
        warehouses[w]=r.get('warehouse_name') or warehouses.get(w,'')
        if (k,w) in pairs:raise ValueError('Duplicate warehouse stock')
        pairs[k,w]=quantity(r,'available_stock_count')
        names.setdefault(k,{'name':r.get('name',''),'offer_id':r.get('offer_id','')})
        if not names[k]['name']:names[k]['name']=r.get('name','')
    totals=defaultdict(int);local=defaultdict(int);unassigned=defaultdict(int)
    unexpected=defaultdict(int);seen=set()
    for posting in history['postings']:
        number=posting['number']
        if number in seen:continue
        seen.add(number)
        day=parse(posting['created_at']).date()
        if not begin<=day<end:continue
        w=posting.get('warehouse_id')
        if w:
            w=str(w);warehouses[w]=posting.get('warehouse_name') or warehouses.get(w,'')
        for p in posting['products']:
            k=str(p['sku']);skus.add(k);names.setdefault(k,{'name':p.get('name',''),'offer_id':p.get('offer_id','')})
            n=int(p['quantity'])
            if n<0:raise ValueError('Negative units')
            if posting['status'] not in ACTIVE:
                if posting['status']!='cancelled':unexpected[k]+=n
                continue
            totals[k]+=n
            if w:local[k,w]+=n
            else:unassigned[k]+=n
    rows=[]
    for k in sorted(skus):
        details=[]
        local_known=enough and history.get('warehouse_attribution',False) and not unassigned[k] and not unexpected[k]
        for w in sorted(warehouses,key=lambda w:(warehouses[w],w)):
            details.append({'warehouse_id':w,'warehouse_name':warehouses[w] or 'Склад Ozon',
                            **estimate(pairs.get((k,w)),local[k,w],window,local_known,anchor)})
        # Same authoritative source as the FBO stock screen. Extra historical/raw
        # warehouse identifiers must not erase quantities returned by analytics.
        required={w for sku,w in raw_pairs if sku==k}|{w for sku,w in local if sku==k}
        known={w for sku,w in pairs if sku==k}
        missing=required-known
        total_stock=sum(n for (sku,w),n in pairs.items() if sku==k) if known else None
        order={'estimated':0,'empty':1,'no_orders':2,'unknown_rate':3,'unknown_stock':4}
        details.sort(key=lambda r:(order[r['state']],r['days_left'] if r['days_left'] is not None else float('inf'),r['warehouse_name']))
        pooled=estimate(total_stock,totals[k],window,enough and not unexpected[k],anchor)
        rows.append({'sku':k,**names[k],'warehouses':details,'total':pooled,
                     'missing_warehouse_units':unassigned[k],
                     'unmatched_stock_warehouses':len(missing),
                     'stock_scope':'analytics',
                     'local_history_ready':bool(history.get('warehouse_attribution',False)),
                     'unknown_status_units':unexpected[k]})
    warnings=[]
    if not enough:warnings.append(f'Доступно {coverage} полных дней истории, нужно {window}. Загрузите более длинный период.')
    if not history.get('warehouse_attribution',False):warnings.append('История загружена старой версией без складов отгрузки. Загрузите её заново в разделе «История отправлений».')
    if (anchor.date()-end).days>1:warnings.append('История отстаёт от остатков. Обновите оба набора данных.')
    return {'at':snapshot['at'],'history_at':history.get('at'),'window':window,
            'period_start':str(begin),'period_end':str(end-timedelta(days=1)),
            'coverage_days':coverage,'enough':enough,'warnings':warnings,'items':rows}

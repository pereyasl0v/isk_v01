"""Warehouse-level replenishment forecasts with adaptive sales-history windows."""
from datetime import datetime, timedelta, timezone, time
from collections import defaultdict
from .inventory import quantity

MSK=timezone(timedelta(hours=3))
ACTIVE={'awaiting_packaging','awaiting_deliver','delivering','delivered'}
WINDOWS=(7,14,30,90)
ANALYSIS_WINDOWS=(7,14,30,60,90)
MIN_SAMPLE_ORDERS=3
MIN_SPARSE_HISTORY_DAYS=30
MAX_ANALYSIS_DAYS=90


def parse(value):
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:raise ValueError('Timezone required')
    return dt.astimezone(MSK)


def estimate(stock,units,days,orders,known,anchor):
    rate=units/days if known and days>0 else None
    common={'units':units,'orders':orders,'analysis_days':days,'rate':rate}
    if stock is None:
        return {'available':None,**common,'days_left':None,'ends_at':None,'state':'unknown_stock'}
    if stock==0:
        return {'available':0,**common,'days_left':0,'ends_at':None,'state':'empty'}
    if rate is None:
        return {'available':stock,**common,'days_left':None,'ends_at':None,'state':'unknown_rate'}
    if rate==0:
        return {'available':stock,**common,'days_left':None,'ends_at':None,'state':'no_orders'}
    days_left=stock/rate
    date=(anchor+timedelta(days=days_left)).isoformat() if days_left<365000 else None
    return {'available':stock,**common,'days_left':days_left,'ends_at':date,'state':'estimated'}


def _add_daily(bucket,key,day,number,units):
    row=bucket[key][day]
    row['units']+=units
    row['orders'].add(number)


def _measure(daily,key,end,days):
    start=end-timedelta(days=days)
    units=0
    orders=set()
    for day,row in daily.get(key,{}).items():
        if start<=day<end:
            units+=row['units']
            orders.update(row['orders'])
    return units,len(orders)


def _sum_daily(daily,key,end,days):
    start=end-timedelta(days=days)
    return sum(units for day,units in daily.get(key,{}).items() if start<=day<end)


def _analysis_period(daily,key,end,candidates,max_days):
    """Use the shortest reliable window; extend sparse samples to available history."""
    for days in candidates:
        units,orders=_measure(daily,key,end,days)
        if orders>=MIN_SAMPLE_ORDERS:
            return days,units,orders,True
    days=max_days
    units,orders=_measure(daily,key,end,days)
    # A sparse sample is only extrapolated when there is at least a month of
    # history. With a shorter sample, suppress the rate rather than inflate it.
    reliable=days>=MIN_SPARSE_HISTORY_DAYS or orders>=MIN_SAMPLE_ORDERS
    return days,units,orders,reliable


def calculate(snapshot,history,window):
    if window not in WINDOWS:raise ValueError('Unsupported window')
    anchor=parse(snapshot['at'])
    start=parse(history['since'])
    end=min(parse(history['to']),anchor).date()
    first=start.date()+timedelta(days=0 if start.time()==time(0) else 1)
    coverage=max(0,(end-first).days)
    enough=coverage>=window
    max_days=min(MAX_ANALYSIS_DAYS,coverage)
    candidates=[d for d in ANALYSIS_WINDOWS if window<=d<=max_days]
    if max_days>=window and max_days not in candidates:
        candidates.append(max_days)
    if not candidates and max_days>0:
        candidates=[max_days]
    history_begin=end-timedelta(days=max_days)

    warehouses={}
    names={}
    pairs={}
    raw_pairs=set()
    skus=set()
    for p in snapshot['products']:
        if p.get('sku'):
            k=str(p['sku'])
            skus.add(k)
            names[k]={'name':p.get('name',''),'offer_id':p.get('offer_id','')}
    for r in snapshot['stocks']:
        k=str(r['sku'])
        w=str(r['warehouse_id'])
        skus.add(k)
        raw_pairs.add((k,w))
        warehouses.setdefault(w,'')
        names.setdefault(k,{'name':'','offer_id':r.get('offer_id','')})
    for r in snapshot['analytics']:
        k=str(r['sku'])
        w=str(r['warehouse_id'])
        skus.add(k)
        warehouses[w]=r.get('warehouse_name') or warehouses.get(w,'')
        if (k,w) in pairs:raise ValueError('Duplicate warehouse stock')
        pairs[k,w]=quantity(r,'available_stock_count')
        names.setdefault(k,{'name':r.get('name',''),'offer_id':r.get('offer_id','')})
        if not names[k]['name']:names[k]['name']=r.get('name','')

    total_daily=defaultdict(lambda:defaultdict(lambda:{'units':0,'orders':set()}))
    local_daily=defaultdict(lambda:defaultdict(lambda:{'units':0,'orders':set()}))
    unassigned_daily=defaultdict(lambda:defaultdict(int))
    unexpected_daily=defaultdict(lambda:defaultdict(int))
    seen=set()
    for posting in history['postings']:
        if str(posting.get('scheme') or 'FBO').upper()!='FBO':
            continue
        number=posting['number']
        if number in seen:continue
        seen.add(number)
        day=parse(posting['created_at']).date()
        if not history_begin<=day<end:continue
        w=posting.get('warehouse_id')
        if w:
            w=str(w)
            warehouses[w]=posting.get('warehouse_name') or warehouses.get(w,'')
        for p in posting['products']:
            k=str(p['sku'])
            skus.add(k)
            names.setdefault(k,{'name':p.get('name',''),'offer_id':p.get('offer_id','')})
            units=int(p['quantity'])
            if units<0:raise ValueError('Negative units')
            if posting['status'] not in ACTIVE:
                if posting['status']!='cancelled':
                    unexpected_daily[k][day]+=units
                continue
            if units==0:continue
            _add_daily(total_daily,k,day,number,units)
            if w:
                _add_daily(local_daily,(k,w),day,number,units)
            else:
                unassigned_daily[k][day]+=units

    rows=[]
    low_sample=False
    for k in sorted(skus):
        pooled_days,pooled_units,pooled_orders,pooled_ready=_analysis_period(
            total_daily,k,end,candidates,max_days
        ) if max_days else (0,0,0,False)
        pooled_unknown=_sum_daily(unexpected_daily,k,end,pooled_days) if pooled_days else 0
        pooled_unassigned=_sum_daily(unassigned_daily,k,end,pooled_days) if pooled_days else 0
        pooled=estimate(
            sum(n for (sku,_),n in pairs.items() if sku==k) if any(sku==k for sku,_ in pairs) else None,
            pooled_units,pooled_days,pooled_orders,
            enough and pooled_ready and not pooled_unknown,anchor
        )
        if enough and not pooled_ready:
            low_sample=True

        details=[]
        for w in sorted(warehouses,key=lambda value:(warehouses[value],value)):
            days,units,orders,ready=_analysis_period(
                local_daily,(k,w),end,candidates,max_days
            ) if max_days else (0,0,0,False)
            unassigned=_sum_daily(unassigned_daily,k,end,days) if days else 0
            unexpected=_sum_daily(unexpected_daily,k,end,days) if days else 0
            local_known=(
                enough and ready and history.get('warehouse_attribution',False)
                and not unassigned and not unexpected
            )
            details.append({
                'warehouse_id':w,
                'warehouse_name':warehouses[w] or 'Склад Ozon',
                **estimate(pairs.get((k,w)),units,days,orders,local_known,anchor)
            })
            if enough and not ready:
                low_sample=True

        required={w for sku,w in raw_pairs if sku==k}|{w for sku,w in local_daily if sku==k}
        known={w for sku,w in pairs if sku==k}
        missing=required-known
        order={'estimated':0,'empty':1,'no_orders':2,'unknown_rate':3,'unknown_stock':4}
        details.sort(key=lambda r:(
            order[r['state']],
            r['days_left'] if r['days_left'] is not None else float('inf'),
            r['warehouse_name']
        ))
        rows.append({
            'sku':k,**names[k],'warehouses':details,'total':pooled,
            'missing_warehouse_units':pooled_unassigned,
            'unmatched_stock_warehouses':len(missing),
            'stock_scope':'analytics',
            'local_history_ready':bool(history.get('warehouse_attribution',False)),
            'unknown_status_units':pooled_unknown
        })

    warnings=[]
    if not enough:
        warnings.append(
            f'Доступно {coverage} полных дней истории, нужно не менее {window}. '
            'Загрузите более длинный период.'
        )
    if low_sample:
        warnings.append(
            'По части товаров мало заказов. Период анализа автоматически расширяется '
            'до доступной истории (максимум 90 дней); если истории меньше 30 дней, '
            'расход не рассчитывается, чтобы не завышать пополнение.'
        )
    if not history.get('warehouse_attribution',False):
        warnings.append(
            'История загружена старой версией без складов отгрузки. '
            'Загрузите её заново в разделе «История отправлений».'
        )
    if (anchor.date()-end).days>1:
        warnings.append('История отстаёт от остатков. Обновите оба набора данных.')
    period_start=end-timedelta(days=coverage)
    return {
        'at':snapshot['at'],'history_at':history.get('at'),'window':window,
        'period_start':str(period_start),'period_end':str(end-timedelta(days=1)) if coverage else str(end),
        'coverage_days':coverage,'enough':enough,'minimum_sample_orders':MIN_SAMPLE_ORDERS,
        'max_analysis_days':max_days,'warnings':warnings,'items':rows
    }

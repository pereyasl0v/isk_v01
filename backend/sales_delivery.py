"""Combine free daily Ozon order analytics and shipment delivery events.

The delivered series counts *units*, not postings. It uses the last-status-change
date filter only when Ozon confirms the current status is delivered. These are
historical approximations when later status transitions could have occurred;
verified push event timestamps take precedence where known.
"""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

MOSCOW=ZoneInfo('Europe/Moscow')
SCHEMES=('FBO','FBS')


def local_day(timestamp):
    if not timestamp:
        return None
    try:
        value=datetime.fromisoformat(str(timestamp).replace('Z','+00:00'))
        if value.tzinfo is None:
            return None
        return value.astimezone(MOSCOW).date().isoformat()
    except (ValueError,TypeError,OverflowError):
        return None


def iter_days(first,last):
    value=first
    while value<=last:
        yield value.isoformat()
        value+=timedelta(days=1)


def delivered_snapshot(api,first,last,previous,progress):
    """Refresh today/previous 2 days, reuse successfully checked older days."""
    cached=(previous or {}).get('delivery_days') or {}
    today=datetime.now(MOSCOW).date()
    result={}
    for index,day in enumerate(iter_days(first,last),1):
        old=cached.get(day) or {}
        current_date=date.fromisoformat(day)
        result[day]={}
        for scheme in SCHEMES:
            record=old.get(scheme) or {}
            if record.get('ok') and current_date < today-timedelta(days=2):
                result[day][scheme]=record
                continue
            try:
                postings=api.delivered_postings_for_day(current_date,scheme)
                record={'ok':True,'postings':postings}
            except Exception as exc:
                # Preserve the most recent valid data if a refresh fails,
                # but explicitly mark the failed date as unverified.
                record={'ok':False,'postings':[],'error':str(exc)[:400]}
            result[day][scheme]=record
        if index==1 or index%5==0 or index==(last-first).days+1:
            progress(f'Доставки Ozon: проверено {index} дней из {(last-first).days+1}.')
    return result


def _products_by_posting(history):
    return {
        ('FBO' if not p.get('scheme') else str(p['scheme']).upper(),str(p.get('number'))):p.get('products') or []
        for p in (history or {}).get('postings') or []
        if isinstance(p,dict) and p.get('number')
    }


def build_sales_with_deliveries(orders,delivery_days,events=(),history=None):
    """Produce daily totals and per-SKU rows, keeping unknown values as None."""
    dates=[item['date'] for item in orders.get('rows') or []]
    post_products=_products_by_posting(history)
    events_by_post={}
    for event in events or ():
        key=(event.get('scheme') or 'FBO',str(event.get('posting_number')))
        date_value=local_day(event.get('delivered_at'))
        products=event.get('products') or post_products.get(key) or []
        if date_value and products:
            events_by_post[key]={'date':date_value,'products':products}
    units_by_day={}
    missing=set()
    seen_events=set()
    for day in dates:
        slot=(delivery_days or {}).get(day) or {}
        if not all((slot.get(scheme) or {}).get('ok') for scheme in SCHEMES):
            missing.add(day)
            continue
        postings={}
        for scheme in SCHEMES:
            for item in slot[scheme].get('postings') or []:
                number=str(item.get('number') or '').strip()
                if number:
                    postings[(scheme,number)]=item.get('products') or []
        for key,products in postings.items():
            if key in events_by_post:
                continue
            for p in products:
                k=(day,str(p['sku']))
                units_by_day[k]=units_by_day.get(k,0)+int(p['quantity'])
    for key,entry in events_by_post.items():
        if key in seen_events:
            continue
        seen_events.add(key)
        day=entry['date']
        if day not in dates or day in missing:
            continue
        for p in entry['products']:
            k=(day,str(p['sku']))
            units_by_day[k]=units_by_day.get(k,0)+int(p['quantity'])

    rows=[]
    for item in orders.get('rows') or []:
        day=item['date']
        delivered=(sum(value for (d,_),value in units_by_day.items() if d==day)
                   if day not in missing else None)
        rows.append({**item,'delivered_units':delivered})
    sku_values={(str(item['sku']),item['date']):dict(item)
                for item in orders.get('by_sku') or []}
    for (day,sku),quantity in units_by_day.items():
        row=sku_values.setdefault((sku,day),{
            'date':day,'sku':sku,'ordered_units':0,'ordered_revenue':0.0,
        })
        row['delivered_units']=quantity
    by_sku=[]
    for (sku,day),row in sorted(sku_values.items()):
        row={**row,'delivered_units':(
            None if day in missing else units_by_day.get((day,sku),0)
        )}
        by_sku.append(row)
    errors=[]
    for scheme in SCHEMES:
        failures=[day for day in dates if not ((delivery_days or {}).get(day) or {}).get(scheme,{}).get('ok')]
        if failures:
            example=((delivery_days or {}).get(failures[0]) or {}).get(scheme) or {}
            errors.append(f'{scheme}: нет подтверждённых данных за {len(failures)} дн. ({example.get("error") or "загрузка не выполнялась"})')
    return {
        **orders,
        'rows':rows,'by_sku':by_sku,'delivery_days':delivery_days,
        'delivered_available':len(missing)<len(dates),
        'delivered_error':'; '.join(errors) if errors else None,
        'delivery_source':'postings_last_status_change_and_verified_push',
        'delivery_incomplete_days':sorted(missing),
    }

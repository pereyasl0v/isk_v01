"""Combine daily Ozon orders with delivery events from FBS API and FBO Push.

The delivered series counts product units, not postings. FBS dates are sourced
from the delivered-status API filter; FBO delivery dates are accepted only from
verified Ozon Push events. Missing scheme coverage is explicitly marked partial.
"""
from datetime import date, datetime, timedelta, timezone

# Moscow stays at UTC+03:00 for Ozon reporting periods. Avoid OS tzdata.
MOSCOW=timezone(timedelta(hours=3))
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
    """Load FBS delivered postings by day; FBO history is Push-only."""
    cached=(previous or {}).get('delivery_days') or {}
    today=datetime.now(MOSCOW).date()
    result={}
    total=(last-first).days+1
    for index,day in enumerate(iter_days(first,last),1):
        old=cached.get(day) or {}
        current_date=date.fromisoformat(day)
        result[day]={}
        for scheme in SCHEMES:
            record=old.get(scheme) or {}
            if scheme=='FBO':
                # FBO posting-list filters use creation dates, not delivery
                # dates. Never fabricate a delivery date from those filters.
                result[day][scheme]=record if record.get('ok') else {
                    'ok':False,'postings':[],
                    'error':(
                        'Исторические доставки FBO недоступны через список API; '
                        'новые подтверждённые события поступают через Ozon Push.'
                    ),
                }
                continue
            if record.get('ok') and current_date < today-timedelta(days=2):
                result[day][scheme]=record
                continue
            try:
                postings=api.delivered_postings_for_day(current_date,scheme)
                record={'ok':True,'postings':postings}
            except Exception as exc:
                record={'ok':False,'postings':[],'error':str(exc)[:400]}
            result[day][scheme]=record
        if index==1 or index%5==0 or index==total:
            progress(f'Доставки Ozon: проверено {index} дней из {total}.')
    return result


def _products_by_posting(history):
    return {
        ('FBO' if not p.get('scheme') else str(p['scheme']).upper(),str(p.get('number'))):p.get('products') or []
        for p in (history or {}).get('postings') or []
        if isinstance(p,dict) and p.get('number')
    }


def build_sales_with_deliveries(orders,delivery_days,events=(),history=None):
    """Count delivered product units and expose incomplete FBO/FBS coverage."""
    dates=[item['date'] for item in orders.get('rows') or []]
    date_set=set(dates)
    post_products=_products_by_posting(history)
    fetched={}
    covered={}
    missing=set()
    partial=set()
    scope=set()

    for day in dates:
        slot=(delivery_days or {}).get(day) or {}
        schemes={scheme for scheme in SCHEMES if (slot.get(scheme) or {}).get('ok')}
        covered[day]=schemes
        scope.update(schemes)
        if not schemes:
            missing.add(day)
        elif len(schemes)<len(SCHEMES):
            partial.add(day)
        collected={}
        for scheme in schemes:
            for item in slot[scheme].get('postings') or []:
                number=str(item.get('number') or '').strip()
                if not number:
                    continue
                key=(scheme,number)
                products=item.get('products') or []
                collected[key]=products
                post_products.setdefault(key,products)
        fetched[day]=collected

    # FBO Push gives the status-transition timestamp. Product rows come from
    # webhook enrichment or the already saved posting history.
    verified={}
    for event in events or ():
        key=(str(event.get('scheme') or 'FBO').upper(),
             str(event.get('posting_number') or ''))
        delivered_day=local_day(event.get('delivered_at'))
        products=event.get('products') or post_products.get(key) or []
        if delivered_day and delivered_day in date_set and products:
            verified[key]={'date':delivered_day,'products':products}
            scope.add(key[0])
            if not covered.get(delivered_day):
                partial.add(delivered_day)
                missing.discard(delivered_day)

    units={}
    def add(day,products):
        for product in products:
            key=(day,str(product['sku']))
            units[key]=units.get(key,0)+int(product['quantity'])

    for day,postings in fetched.items():
        for key,products in postings.items():
            if key not in verified:
                add(day,products)
    for item in verified.values():
        add(item['date'],item['products'])

    rows=[]
    unknown=set(missing)
    for row in orders.get('rows') or []:
        day=row['date']
        count=sum(value for (d,_),value in units.items() if d==day)
        # A partial scheme returning zero does not prove that nothing was
        # delivered through the unavailable scheme.
        delivered=None if day in missing or (day in partial and count==0) else count
        if delivered is None:
            unknown.add(day)
        rows.append({**row,'delivered_units':delivered,
                     'delivery_partial':day in partial})

    sku_values={(str(row['sku']),row['date']):dict(row)
                for row in orders.get('by_sku') or []}
    for (day,sku),value in units.items():
        sku_values.setdefault((sku,day),{
            'date':day,'sku':sku,'ordered_units':0,'ordered_revenue':0.0,
        })
    by_sku=[]
    for (sku,day),row in sorted(sku_values.items()):
        count=units.get((day,sku),0)
        delivered=None if day in missing or (day in partial and count==0) else count
        by_sku.append({
            **row,'delivered_units':delivered,
            'delivery_partial':day in partial,
        })

    errors=[]
    for scheme in SCHEMES:
        failures=[day for day in dates if scheme not in covered.get(day,set())]
        if failures:
            record=((delivery_days or {}).get(failures[0]) or {}).get(scheme) or {}
            errors.append(
                f'{scheme}: неполные данные за {len(failures)} дн. '
                f'({record.get("error") or "данных ещё нет"})'
            )

    incomplete=sorted(missing|partial)
    complete=bool(dates) and not incomplete
    available=any(row['delivered_units'] is not None for row in rows)
    return {
        **orders,
        'rows':rows,'by_sku':by_sku,'delivery_days':delivery_days,
        'delivered_available':available,
        'delivery_complete':complete,
        'delivery_error':'; '.join(errors) if errors else None,
        'delivery_source':'fbs_delivered_status_and_verified_fbo_push',
        'delivery_incomplete_days':incomplete,
        'delivery_unknown_days':sorted(unknown),
        'delivery_scope':sorted(scope),
        'delivery_label':'Доставлено' if complete else 'Доставлено · неполные данные',
    }

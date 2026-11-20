"""Combine free daily Ozon order analytics and shipment delivery events.

The delivered series counts *units*, not postings. It uses the last-status-change
date filter only when Ozon confirms the current status is delivered. These are
historical approximations when later status transitions could have occurred;
verified push event timestamps take precedence where known.
"""
from datetime import date, datetime, timedelta, timezone

# Moscow stays at UTC+03:00 for the 2026 Ozon reporting periods. Avoid
# dependency on OS tzdata in the read-only slim Docker container.
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
    """Count only confirmed shipment units; identify partial FBO/FBS coverage."""
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

    verified={}
    for event in events or ():
        key=(str(event.get('scheme') or 'FBO').upper(),
             str(event.get('posting_number') or ''))
        delivered_day=local_day(event.get('delivered_at'))
        products=event.get('products') or post_products.get(key) or []
        if delivered_day and delivered_day in date_set and products:
            verified[key]={'date':delivered_day,'products':products}
            scope.add(key[0])
            # Receiving one event does not establish the *total* for a day.
            if delivered_day not in covered or not covered[delivered_day]:
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
    for row in orders.get('rows') or []:
        day=row['date']
        delivered=(None if day in missing else
                   sum(value for (d,_),value in units.items() if d==day))
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
        by_sku.append({
            **row,
            'delivered_units':None if day in missing else units.get((day,sku),0),
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
    label=('Доставлено' if scope==set(SCHEMES)
           else 'Доставлено '+('/'.join(sorted(scope))) if scope else 'Доставлено')
    return {
        **orders,
        'rows':rows,'by_sku':by_sku,'delivery_days':delivery_days,
        'delivered_available':len(missing)<len(dates),
        'delivered_error':'; '.join(errors) if errors else None,
        'delivery_source':'postings_last_status_change_and_verified_push',
        'delivery_incomplete_days':sorted(missing|partial),
        'delivery_scope':sorted(scope),'delivery_label':label,
    }

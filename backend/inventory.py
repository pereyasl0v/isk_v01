"""Semantically separate row counts, quantities, reservations and in-flight FBO stock."""
import math
from collections import defaultdict

FIELDS = ('available_stock_count','valid_stock_count','transit_stock_count','requested_stock_count')
OUTBOUND_FIELDS = (
    'outbound_pending_delivery',
    'outbound_returns_picking',
    'outbound_returns_ready_to_ship',
    'outbound_returns_return_to_seller',
)


def quantity(row, field):
    value = row.get(field)
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Некорректное или отсутствующее количество в аналитике')
    return int(value)


def optional_quantity(row, field):
    """New Ozon stock-status fields may be omitted when their quantity is zero."""
    if field not in row or row.get(field) is None:
        return 0
    return quantity(row, field)


def has_outbound_fields(rows):
    # An empty, successful inventory is a known zero. For non-empty analytics,
    # at least one new status field must be present or capitalization would
    # silently omit all units travelling to/from customers.
    return not rows or any(any(field in row for field in OUTBOUND_FIELDS) for row in rows)


def outbound_totals(rows):
    if not has_outbound_fields(rows):
        return None
    return {
        field: sum(optional_quantity(row, field) for row in rows)
        for field in OUTBOUND_FIELDS
    }


def summarize(snapshot):
    products=snapshot['products']
    rows=snapshot.get('analytics')
    output={'products':len(products),'warehouse_rows':len(snapshot['stocks']),
            'analytics_rows':len(rows) if rows is not None else None,
            'stocked_skus':None,'available':None,'preparing':None,'transit':None,'requested':None,
            'outbound_fields_available':False,'outbound_pending_delivery':None,
            'outbound_returns':None,'capitalization_quantity':None}
    if rows is not None:
        output.update(available=sum(quantity(x,FIELDS[0]) for x in rows),
                      preparing=sum(quantity(x,FIELDS[1]) for x in rows),
                      transit=sum(quantity(x,FIELDS[2]) for x in rows),
                      requested=sum(quantity(x,FIELDS[3]) for x in rows),
                      stocked_skus=len({str(x['sku']) for x in rows if quantity(x,FIELDS[0])>0}))
        outbound=outbound_totals(rows)
        if outbound is not None:
            output.update(outbound_fields_available=True,
                          outbound_pending_delivery=outbound['outbound_pending_delivery'],
                          outbound_returns=sum(outbound[field] for field in OUTBOUND_FIELDS[1:]),
                          capitalization_quantity=output['available']+sum(outbound.values()))
    return output


def aggregate(snapshot):
    if snapshot.get('analytics') is None:
        return []
    source=snapshot['analytics']
    outbound_available=has_outbound_fields(source)
    grouped=defaultdict(list)
    for r in source:
        grouped[str(r['sku'])].append(r)
    result=[]
    for sku, rows in grouped.items():
        rates=[]
        for row in rows:
            ads=row.get('ads')
            if isinstance(ads,(int,float)) and not isinstance(ads,bool) and math.isfinite(ads) and ads>=0:
                rates.append(float(ads))
        consistent=len(rates)==len(rows) and max(rates,default=0)-min(rates,default=0)<.000001
        outbound={field:sum(optional_quantity(x,field) for x in rows) for field in OUTBOUND_FIELDS}
        available=sum(quantity(x,'available_stock_count') for x in rows)
        result.append({'sku':sku,'offer_id':rows[0].get('offer_id',''),
            'name':rows[0].get('name',''),
            'available':available,
            'preparing':sum(quantity(x,'valid_stock_count') for x in rows),
            'transit':sum(quantity(x,'transit_stock_count') for x in rows),
            'requested':sum(quantity(x,'requested_stock_count') for x in rows),
            **outbound,
            'capitalization_quantity':available+sum(outbound.values()) if outbound_available else None,
            'ads':rates[0] if rates and consistent else None,
            'restricted':any(r.get('turnover_grade')=='RESTRICTED_NO_SALES' for r in rows)})
    return result

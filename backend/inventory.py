"""Semantically separate row counts, quantities, reservations and future receipts."""
import math
from collections import defaultdict

FIELDS = ('available_stock_count','valid_stock_count','transit_stock_count','requested_stock_count')

def quantity(row, field):
    value = row.get(field)
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Некорректное или отсутствующее количество в аналитике')
    return int(value)

def summarize(snapshot):
    products=snapshot['products']
    rows=snapshot.get('analytics')
    output={'products':len(products),'warehouse_rows':len(snapshot['stocks']),
            'analytics_rows':len(rows) if rows is not None else None,
            'stocked_skus':None,'available':None,'preparing':None,'transit':None,'requested':None}
    if rows is not None:
        output.update(available=sum(quantity(x,FIELDS[0]) for x in rows),
                      preparing=sum(quantity(x,FIELDS[1]) for x in rows),
                      transit=sum(quantity(x,FIELDS[2]) for x in rows),
                      requested=sum(quantity(x,FIELDS[3]) for x in rows),
                      stocked_skus=len({str(x['sku']) for x in rows if quantity(x,FIELDS[0])>0}))
    return output

def aggregate(snapshot):
    if snapshot.get('analytics') is None:
        return []
    grouped=defaultdict(list)
    for r in snapshot['analytics']:
        grouped[str(r['sku'])].append(r)
    result=[]
    for sku, rows in grouped.items():
        rates=[]
        for row in rows:
            ads=row.get('ads')
            if isinstance(ads,(int,float)) and not isinstance(ads,bool) and math.isfinite(ads) and ads>=0:
                rates.append(float(ads))
        consistent=len(rates)==len(rows) and max(rates,default=0)-min(rates,default=0)<.000001
        result.append({'sku':sku,'offer_id':rows[0].get('offer_id',''),
            'name':rows[0].get('name',''),
            'available':sum(quantity(x,'available_stock_count') for x in rows),
            'preparing':sum(quantity(x,'valid_stock_count') for x in rows),
            'transit':sum(quantity(x,'transit_stock_count') for x in rows),
            'requested':sum(quantity(x,'requested_stock_count') for x in rows),
            'ads':rates[0] if rates and consistent else None,
            'restricted':any(r.get('turnover_grade')=='RESTRICTED_NO_SALES' for r in rows)})
    return result

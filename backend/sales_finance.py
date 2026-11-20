"""Combine daily order analytics with already stored Ozon financial sales history.

Unlike Ozon's Premium delivered_units metric, this is *realization* by
accrual day: sales less returns, plus marketplace buyouts. It is never labeled
as delivery and unavailable days remain unknown rather than zero.
"""
from .digitization import summarize as summarize_digitization


def add_financial_sales(orders, daily_records):
    totals = {}
    details = {}
    incomplete = []
    for record in daily_records or []:
        day = str(record.get('day') or '')
        if not day:
            continue
        try:
            result = summarize_digitization(record)
        except (ValueError, KeyError, TypeError):
            continue
        metrics = result.get('metrics') or {}
        quantity = metrics.get('sales_quantity')
        amount = metrics.get('sales_amount')
        if quantity is None or amount is None:
            continue
        products = result.get('products') or []
        product_units = sum(int(p.get('sales_quantity') or 0) for p in products)
        sku_complete = product_units == int(quantity)
        partial = bool(record.get('buyout_error')) or not sku_complete
        totals[day] = {
            'sold_units': int(quantity),
            'sold_amount': float(amount),
            'sales_partial': partial,
        }
        if partial:
            incomplete.append(day)
        for product in products:
            sku = str(product.get('sku') or '')
            if sku:
                details[(sku,day)] = {
                    'sku': sku, 'date': day,
                    'sold_units': int(product.get('sales_quantity') or 0),
                    'sold_amount': float(product.get('sales_amount') or 0),
                    'sales_partial': partial,
                }

    rows = [
        {
            **row, **totals.get(row['date'], {
                'sold_units': None, 'sold_amount': None, 'sales_partial': False,
            }),
        } for row in orders.get('rows') or []
    ]
    by_sku = {(str(row['sku']),row['date']):dict(row)
              for row in orders.get('by_sku') or []
              if row.get('sku') is not None and row.get('date')}
    for key,detail in details.items():
        target = by_sku.setdefault(key, {
            'sku': key[0], 'date': key[1],
            'ordered_units': 0, 'ordered_revenue': 0.0,
        })
        target.update(detail)
    for key,target in by_sku.items():
        if 'sold_units' not in target:
            overall = totals.get(key[1])
            # A SKU with no sales has a known zero only if the overall
            # day is complete and every booked sale had a SKU.
            known = overall is not None and not overall['sales_partial']
            target['sold_units'] = 0 if known else None
            target['sold_amount'] = 0.0 if known else None
            target['sales_partial'] = bool(overall and overall['sales_partial'])

    missing = [row['date'] for row in rows if row['sold_units'] is None]
    return {
        **orders,
        'rows': rows,
        'by_sku': sorted(by_sku.values(),key=lambda row:(row['sku'],row['date'])),
        'financial_sales_available': len(missing)<len(rows),
        'financial_sales_missing_days': missing,
        'financial_sales_incomplete_days': incomplete,
        'financial_sales_source': 'sqlite_digitization_days',
    }

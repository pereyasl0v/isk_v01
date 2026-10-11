"""Financial snapshot aggregation for Ozon Seller API transactions."""
from collections import defaultdict
from datetime import datetime
import math

LOGISTICS_MARKERS = (
    'fulfillment', 'pickup', 'dropoff', 'flowtrans', 'deliv', 'return',
    'redistribution', 'courier', 'crossdocking',
)
STORAGE_MARKERS = ('storage', 'warehouse')


def _number(value):
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _expense(value):
    """Return a positive expense regardless of API sign convention."""
    value = _number(value)
    return -value if value < 0 else value


def _service_bucket(name):
    name = (name or '').lower()
    if any(marker in name for marker in STORAGE_MARKERS):
        return 'storage'
    if any(marker in name for marker in LOGISTICS_MARKERS):
        return 'logistics'
    return 'other_services'


def summarize(snapshot):
    operations = snapshot.get('operations') or []
    totals = {
        'operations': len(operations),
        'gross_sales': 0.0,
        'commission': 0.0,
        'logistics': 0.0,
        'storage': 0.0,
        'other_services': 0.0,
        'net_accrual': 0.0,
    }
    by_type = defaultdict(lambda: {'name': '', 'count': 0, 'amount': 0.0})
    by_sku = defaultdict(lambda: {
        'sku': '', 'name': '', 'operations': 0, 'gross_sales': 0.0,
        'commission': 0.0, 'services': 0.0, 'net_accrual': 0.0,
    })
    unallocated = 0

    for op in operations:
        sale = _number(op.get('accruals_for_sale'))
        commission = _expense(op.get('sale_commission'))
        amount = _number(op.get('amount'))
        totals['gross_sales'] += sale
        totals['commission'] += commission
        totals['net_accrual'] += amount

        services_total = 0.0
        for service in op.get('services') or []:
            price = _expense(service.get('price'))
            services_total += price
            bucket = _service_bucket(service.get('name'))
            totals[bucket] += price

        code = str(op.get('operation_type') or 'unknown')
        bucket = by_type[code]
        bucket['name'] = op.get('operation_type_name') or code
        bucket['count'] += 1
        bucket['amount'] += amount

        items = op.get('items') or []
        skus = {str(item.get('sku')) for item in items if item.get('sku') is not None}
        if len(skus) == 1:
            sku = next(iter(skus))
            row = by_sku[sku]
            row['sku'] = sku
            row['name'] = next((item.get('name') for item in items if item.get('name')), row['name'])
            row['operations'] += 1
            row['gross_sales'] += sale
            row['commission'] += commission
            row['services'] += services_total
            row['net_accrual'] += amount
        elif items:
            unallocated += 1

    for key in ('gross_sales', 'commission', 'logistics', 'storage', 'other_services', 'net_accrual'):
        totals[key] = round(totals[key], 2)
    totals['ozon_expenses'] = round(
        totals['commission'] + totals['logistics'] + totals['storage'] + totals['other_services'], 2)
    totals['profit_before_cogs_tax_ads'] = totals['net_accrual']

    types = sorted(
        ({'type': code, **value, 'amount': round(value['amount'], 2)} for code, value in by_type.items()),
        key=lambda row: abs(row['amount']), reverse=True,
    )
    products = []
    for row in by_sku.values():
        for key in ('gross_sales', 'commission', 'services', 'net_accrual'):
            row[key] = round(row[key], 2)
        products.append(dict(row))
    products.sort(key=lambda row: abs(row['net_accrual']), reverse=True)

    return {
        'at': snapshot.get('at'),
        'since': snapshot.get('since'),
        'to': snapshot.get('to'),
        'totals': totals,
        'operation_types': types,
        'products': products,
        'unallocated_product_operations': unallocated,
        'note': 'Чистое начисление Ozon показано до себестоимости, налогов и рекламы. SKU-детализация включает только операции, где однозначно определён один SKU.',
    }

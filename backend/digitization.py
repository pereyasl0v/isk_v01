"""Aggregate Ozon /v1/finance/accrual/* snapshots into dashboard metrics."""
from collections import defaultdict
import math

LOGISTICS_MARKERS = (
    'logistic', 'delivery', 'return', 'pickup', 'dropoff', 'courier', 'crossdock',
    'логист', 'достав', 'возврат', 'перевоз', 'обработк отправ',
)
STORAGE_MARKERS = ('storage', 'placement', 'хранен', 'размещен', 'складск')


def _number(value):
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _money(value):
    if isinstance(value, dict):
        return _number(value.get('amount'))
    return _number(value)


def _expense(value):
    value = _money(value)
    return -value if value < 0 else 0.0


def _service_bucket(name):
    name = (name or '').lower()
    if any(marker in name for marker in STORAGE_MARKERS):
        return 'storage'
    if any(marker in name for marker in LOGISTICS_MARKERS):
        return 'logistics'
    return 'other_services'


def _fee_pairs(node):
    """Yield every nested {type_id/accrual_id, accrued} pair once."""
    if isinstance(node, dict):
        type_id = node.get('accrual_id', node.get('type_id'))
        if type_id is not None and isinstance(node.get('accrued'), dict):
            yield str(type_id), _money(node.get('accrued'))
        for value in node.values():
            yield from _fee_pairs(value)
    elif isinstance(node, list):
        for value in node:
            yield from _fee_pairs(value)


def summarize(snapshot):
    accruals = snapshot.get('accruals') or []
    type_rows = snapshot.get('accrual_types') or []
    names = {}
    for row in type_rows:
        key = row.get('id')
        if key is not None:
            names[str(key)] = row.get('description') or row.get('name') or str(key)

    totals = {
        'operations': len(accruals),
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

    def add_fee(type_id, amount, sku=None):
        expense = -amount if amount < 0 else 0.0
        totals[_service_bucket(names.get(type_id, type_id))] += expense
        if sku is not None:
            row = by_sku[str(sku)]
            row['sku'] = str(sku)
            row['services'] += expense
            row['net_accrual'] += amount

    for accrual in accruals:
        amount = _money(accrual.get('total_amount'))
        totals['net_accrual'] += amount
        type_id = str(accrual.get('accrual_id', accrual.get('type_id', 'unknown')))
        type_bucket = by_type[type_id]
        type_bucket['name'] = names.get(type_id, type_id)
        type_bucket['count'] += 1
        type_bucket['amount'] += amount

        posting = accrual.get('posting') or {}
        for product in posting.get('products') or []:
            sku = product.get('sku')
            if sku is None:
                continue
            row = by_sku[str(sku)]
            row['sku'] = str(sku)
            row['operations'] += 1
            commission = product.get('commission') or {}
            sale = _money(commission.get('seller_price'))
            signed_commission = _money(commission.get('sale_commission'))
            commission_expense = -signed_commission if signed_commission < 0 else 0.0
            totals['gross_sales'] += sale
            totals['commission'] += commission_expense
            row['gross_sales'] += sale
            row['commission'] += commission_expense
            row['net_accrual'] += sale + signed_commission

            delivery = product.get('delivery') or {}
            delivery_total = _money(delivery.get('total_accrued'))
            # delivery.total_accrued is the signed SKU-level total. Individual
            # services are used only to classify the same expense by type.
            row['net_accrual'] += delivery_total
            for fee_type, fee_amount in _fee_pairs(delivery.get('services') or []):
                expense = -fee_amount if fee_amount < 0 else 0.0
                totals[_service_bucket(names.get(fee_type, fee_type))] += expense
            row['services'] += -delivery_total if delivery_total < 0 else 0.0

        for group in (accrual.get('item_fees') or {}).get('fees') or []:
            sku = group.get('sku')
            for fee_type, fee_amount in _fee_pairs(group.get('fees') or []):
                add_fee(fee_type, fee_amount, sku)

        for section in ('non_item_fee', 'container_fees'):
            for fee_type, fee_amount in _fee_pairs(accrual.get(section)):
                add_fee(fee_type, fee_amount)

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
        'unallocated_product_operations': 0,
        'note': 'Чистое начисление Ozon берётся из total_amount актуального API начислений. Полная чистая прибыль появится после добавления себестоимости, налогов и рекламы.',
    }

"""Daily SQLite source for Ozon digitization.

The UI period is only a filter over closed-day facts stored locally. Ozon is
used to fill or explicitly refresh days; arbitrary sub-periods are then built
without network access.
"""
from collections import defaultdict
from datetime import date, timedelta

from .legacy import ApiError
from .ozon import POSTING_NUMBER


def _daterange(first, last):
    day = first
    while day <= last:
        yield day
        day += timedelta(days=1)


def _sum_sales_facts(items):
    result = {'revenue': 0.0, 'partner_programs': 0.0, 'discount_points': 0.0}
    products = defaultdict(lambda: {
        'sku': '', 'revenue': 0.0, 'partner_programs': 0.0, 'discount_points': 0.0,
    })
    for facts in items:
        if not isinstance(facts, dict):
            continue
        for key in ('revenue', 'partner_programs', 'discount_points'):
            result[key] += float(facts.get(key) or 0)
        for row in facts.get('products') or []:
            sku = str(row.get('sku') or '')
            if not sku:
                continue
            target = products[sku]
            target['sku'] = sku
            for key in ('revenue', 'partner_programs', 'discount_points'):
                target[key] += float(row.get(key) or 0)
    result['products'] = list(products.values())
    return result


def download_digitization_day(api, day, progress):
    """Download one closed Moscow calendar day without a placement report.

    Placement reports have a strict creation quota, so the daily source uses
    normal financial accruals for storage. This keeps every day independently
    reusable and makes arbitrary local ranges possible.
    """
    if not isinstance(day, date):
        day = date.fromisoformat(str(day))
    iso_day = day.isoformat()

    type_data = api.call('/v1/finance/accrual/types', {})
    accrual_types = type_data.get('accrual_types') or []
    if not isinstance(accrual_types, list):
        raise ApiError('Ozon вернул некорректный справочник начислений.')

    raw_accruals = []
    posting_numbers = set()
    last_id = ''
    seen = set()
    for _ in range(1000):
        data = api.call('/v1/finance/accrual/by-day', {'date': iso_day, 'last_id': last_id})
        batch = data.get('accruals') or []
        if not isinstance(batch, list):
            raise ApiError('Ozon вернул некорректный список начислений.')
        raw_accruals.extend(batch)
        for item in batch:
            unit = str(item.get('unit_number') or '').strip()
            if POSTING_NUMBER.match(unit):
                posting_numbers.add(unit)
        nxt = data.get('last_id') or ''
        if not nxt or not batch:
            break
        if nxt in seen:
            raise ApiError('Ozon повторил курсор финансовых начислений.')
        seen.add(nxt)
        last_id = nxt
    else:
        raise ApiError('Слишком много страниц финансовых начислений за один день.')

    posting_rows = api._posting_accrual_rows(sorted(posting_numbers), day, day, progress) if posting_numbers else []
    accrual_rows = list(posting_rows)
    accrual_rows.extend(api._flatten_fee_rows(raw_accruals, include_posting=False))
    by_day_fee_rows = api._flatten_fee_rows(raw_accruals, include_posting=True)
    sales_facts = api._sales_facts(raw_accruals)

    buyout_products = []
    buyout_error = None
    try:
        data = api.call('/v1/finance/products/buyout', {'date_from': iso_day, 'date_to': iso_day})
        buyout_products = data.get('products') or []
        if not isinstance(buyout_products, list):
            raise ApiError('Ozon вернул некорректный отчёт по выкупленным товарам.')
    except ApiError as exc:
        buyout_error = str(exc)

    returns = None
    returns_error = None
    try:
        returns = api._returns_for_period(day, day, progress)
    except ApiError as exc:
        returns_error = str(exc)

    orders = api._orders_for_period(day, day, progress)
    progress(f'Оцифровка: {iso_day} сохранена как самостоятельный день')

    return {
        'since': iso_day,
        'to': iso_day,
        'effective_to': iso_day,
        'current_day_excluded': False,
        'accrual_types': accrual_types,
        'accrual_rows': accrual_rows,
        'by_day_fee_rows': by_day_fee_rows,
        'sales_facts': sales_facts,
        'buyout_products': buyout_products,
        'buyout_error': buyout_error,
        'placement_cost': None,
        'placement_error': None,
        'returns': returns,
        'returns_error': returns_error,
        'orders': orders,
        'local_daily_source': True,
    }


def combine_digitization_days(rows, first, requested_last, effective_last):
    """Combine closed-day raw snapshots into one arbitrary local period."""
    payloads = [row for row in rows if isinstance(row, dict)]
    payloads.sort(key=lambda row: str(row.get('day') or row.get('since') or ''))

    accrual_types = []
    accrual_rows = []
    by_day_fee_rows = []
    sales_parts = []
    buyout_products = []
    buyout_errors = []
    returns_errors = []
    order_errors = []
    returns_complete = True
    returns_quantity = 0
    returns_rows = 0
    returns_by_type = defaultdict(int)
    return_filters = set()
    orders = {'amount': 0.0, 'quantity': 0, 'postings': 0, 'fbo': 0, 'fbs': 0, 'errors': []}

    for row in payloads:
        if row.get('accrual_types'):
            accrual_types = row.get('accrual_types') or accrual_types
        accrual_rows.extend(row.get('accrual_rows') or [])
        by_day_fee_rows.extend(row.get('by_day_fee_rows') or [])
        sales_parts.append(row.get('sales_facts') or {})
        buyout_products.extend(row.get('buyout_products') or [])
        if row.get('buyout_error'):
            buyout_errors.append(str(row.get('buyout_error')))

        decision = row.get('returns')
        if decision is None:
            returns_complete = False
        else:
            returns_quantity += int(decision.get('quantity') or 0)
            returns_rows += int(decision.get('rows') or 0)
            if decision.get('date_filter'):
                return_filters.add(str(decision.get('date_filter')))
            for key, value in (decision.get('by_type') or {}).items():
                returns_by_type[str(key)] += int(value or 0)
        if row.get('returns_error'):
            returns_errors.append(str(row.get('returns_error')))

        day_orders = row.get('orders') or {}
        for key in ('amount', 'quantity', 'postings', 'fbo', 'fbs'):
            orders[key] += day_orders.get(key) or 0
        order_errors.extend(str(x) for x in (day_orders.get('errors') or []))

    orders['amount'] = round(float(orders['amount']), 2)
    orders['quantity'] = int(orders['quantity'])
    orders['postings'] = int(orders['postings'])
    orders['fbo'] = int(orders['fbo'])
    orders['fbs'] = int(orders['fbs'])
    orders['errors'] = order_errors

    returns = None
    if returns_complete:
        returns = {
            'quantity': int(returns_quantity),
            'rows': int(returns_rows),
            'by_type': dict(returns_by_type),
            'date_filter': next(iter(return_filters)) if len(return_filters) == 1 else 'mixed',
        }

    latest_at = None
    for row in payloads:
        value = row.get('at')
        if value and (latest_at is None or str(value) > str(latest_at)):
            latest_at = value

    return {
        'at': latest_at,
        'since': first.isoformat(),
        'to': requested_last.isoformat(),
        'effective_to': effective_last.isoformat() if effective_last >= first else None,
        'current_day_excluded': requested_last > effective_last,
        'accrual_types': accrual_types,
        'accrual_rows': accrual_rows,
        'by_day_fee_rows': by_day_fee_rows,
        'sales_facts': _sum_sales_facts(sales_parts),
        'buyout_products': buyout_products,
        'buyout_error': '; '.join(dict.fromkeys(buyout_errors)) or None,
        'placement_cost': None,
        'placement_error': None,
        'returns': returns,
        'returns_error': '; '.join(dict.fromkeys(returns_errors)) or None,
        'orders': orders,
        'local_daily_source': True,
        'local_days': [str(row.get('day') or row.get('since') or '') for row in payloads],
    }


def requested_days(first, last):
    return [day.isoformat() for day in _daterange(first, last)] if last >= first else []

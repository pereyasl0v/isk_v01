"""TrueStats-style Ozon reconciliation built from current Seller API data.

The metric names and grouping rules follow the public TrueStats instruction
"Инструкция по сверке данных в оцифровке для Ozon (для нового API)".
We intentionally do not guess broad service categories: known report types are
matched explicitly, and every unmatched deduction remains visible in
"Прочие удержания" and in the diagnostic table.
"""
from collections import defaultdict
import math


LOGISTICS_TYPES = {
    'Логистика',
    'Обратная логистика',
    'Логистика - отмена начисления',
    'Доставка до места выдачи',
    'Доставка до места выдачи силами Ozon',
    'Обработка возвратов, отмен и невыкупов партнёрами',
    'Обработка отправления Drop-off (СЦ)',
    'Обработка отправления Drop-off (СЦ) - отмена начисления',
}

# TrueStats verifies storage against FBO -> "Стоимость размещения" -> report by
# products. Seller API exposes the same charge through the accrual dictionary;
# these are the known names used for that charge. They are explicit on purpose.
STORAGE_TYPES = {
    'Размещение товаров на складе Ozon',
    'Размещение товаров на складе',
    'Стоимость размещения',
    'Хранение',
}

REVENUE_TYPE = 'Выручка'
RETURN_REVENUE_TYPE = 'Возврат выручки'
PARTNER_TYPES = {'Программы партнеров', 'Программы партнёров'}
ACQUIRING_TYPE = 'Эквайринг'
DISCOUNT_POINTS_TYPE = 'Баллы за скидки'

# Advertising is deliberately NOT calculated from Seller API accruals. TrueStats
# reconciles it against Promotion analytics + "Оплата за заказ". That is a
# separate Performance/Promotion API and requires separate credentials.
ADVERTISING_LIKE_TYPES = {
    'Реклама', 'Продвижение', 'Продвижение товара', 'Продвижение товаров',
}


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


def _expense(signed_amount):
    """Display a net deduction as a positive expense, preserving cancellations."""
    return max(0.0, -_number(signed_amount))


def _type_name(row):
    # /v1/finance/accrual/types calls this field `name`; `description` explains it.
    # TrueStats groups by the report column "Тип начисления", so name is primary.
    return str(row.get('name') or row.get('description') or row.get('id') or '')


def _is_compensation(name):
    lowered = name.casefold()
    return 'компенсац' in lowered or 'декомпенсац' in lowered


def _sale_sign(name):
    if name == REVENUE_TYPE:
        return 1
    if name == RETURN_REVENUE_TYPE:
        return -1
    return 0


def summarize(snapshot):
    accruals = snapshot.get('accruals') or []
    type_rows = snapshot.get('accrual_types') or []
    buyouts = snapshot.get('buyout_products') or []

    names = {}
    for row in type_rows:
        key = row.get('id')
        if key is not None:
            names[str(key)] = _type_name(row)

    amount_by_type = defaultdict(float)
    rows_by_type = defaultdict(int)
    units_by_type = defaultdict(set)
    operation_rows = defaultdict(lambda: {'name': '', 'count': 0, 'amount': 0.0})

    realization_domestic = 0.0
    nominal_commission_domestic = 0.0
    discount_points_from_products = 0.0
    products = defaultdict(lambda: {
        'sku': '', 'sales_quantity': 0, 'sales_amount': 0.0, 'realization': 0.0,
    })

    for index, accrual in enumerate(accruals):
        type_id = str(accrual.get('accrual_id', accrual.get('type_id', 'unknown')))
        name = names.get(type_id, type_id)
        amount = _money(accrual.get('total_amount'))
        amount_by_type[name] += amount
        rows_by_type[name] += 1

        unit_number = str(accrual.get('unit_number') or '').strip()
        units_by_type[name].add(unit_number or f'row:{index}')

        diagnostic = operation_rows[name]
        diagnostic['name'] = name
        diagnostic['count'] += 1
        diagnostic['amount'] += amount

        sign = _sale_sign(name)
        if not sign:
            continue

        posting = accrual.get('posting') or {}
        for product in posting.get('products') or []:
            commission = product.get('commission') or {}
            seller_price = abs(_money(commission.get('seller_price')))
            nominal_commission = abs(_money(commission.get('commission')))
            bonus = abs(_money(commission.get('bonus')))

            realization_domestic += sign * seller_price
            nominal_commission_domestic += sign * nominal_commission
            discount_points_from_products += sign * bonus

            sku = product.get('sku')
            if sku is not None:
                row = products[str(sku)]
                row['sku'] = str(sku)
                row['sales_quantity'] += sign
                row['realization'] += sign * seller_price
                row['sales_amount'] += sign * abs(amount)

    revenue = amount_by_type.get(REVENUE_TYPE, 0.0)
    return_revenue = amount_by_type.get(RETURN_REVENUE_TYPE, 0.0)
    partner_programs = sum(amount_by_type.get(name, 0.0) for name in PARTNER_TYPES)

    revenue_qty = len(units_by_type.get(REVENUE_TYPE, set()))
    return_qty = len(units_by_type.get(RETURN_REVENUE_TYPE, set()))

    buyout_realization = 0.0
    buyout_commission = 0.0
    buyout_quantity = 0
    for item in buyouts:
        quantity = int(_number(item.get('quantity')))
        seller_price = _number(item.get('seller_price_per_instance'))
        buyout_price = _number(item.get('buyout_price'))
        buyout_quantity += quantity
        buyout_realization += seller_price * quantity
        buyout_commission += (seller_price - buyout_price) * quantity

        sku = item.get('sku')
        if sku is not None:
            row = products[str(sku)]
            row['sku'] = str(sku)
            row['sales_quantity'] += quantity
            row['realization'] += seller_price * quantity
            row['sales_amount'] += seller_price * quantity

    logistics_signed = sum(amount_by_type.get(name, 0.0) for name in LOGISTICS_TYPES)
    storage_signed = sum(amount_by_type.get(name, 0.0) for name in STORAGE_TYPES)
    acquiring_signed = amount_by_type.get(ACQUIRING_TYPE, 0.0)

    discount_points_by_type = amount_by_type.get(DISCOUNT_POINTS_TYPE, 0.0)
    discount_points = abs(discount_points_by_type) if discount_points_by_type else max(0.0, discount_points_from_products)

    compensation_signed = sum(
        amount for name, amount in amount_by_type.items() if _is_compensation(name)
    )

    # Revenue in the accrual report is separated from "Возврат выручки". The
    # TrueStats "Сумма продаж" is net domestic revenue + partner programs +
    # original seller value of marketplace buyouts.
    domestic_sales = revenue - abs(return_revenue) + partner_programs
    sales_amount = domestic_sales + buyout_realization
    sales_quantity = revenue_qty - return_qty + buyout_quantity
    realization = realization_domestic + buyout_realization
    nominal_commission = nominal_commission_domestic + buyout_commission

    excluded_from_other = set(LOGISTICS_TYPES) | set(STORAGE_TYPES) | {
        REVENUE_TYPE, RETURN_REVENUE_TYPE, ACQUIRING_TYPE, DISCOUNT_POINTS_TYPE,
    } | PARTNER_TYPES | ADVERTISING_LIKE_TYPES

    other_deductions = 0.0
    for name, signed in amount_by_type.items():
        if name in excluded_from_other or _is_compensation(name):
            continue
        if signed < 0:
            other_deductions += -signed

    orders = snapshot.get('orders') or {}
    orders_amount = orders.get('amount')
    orders_quantity = orders.get('quantity')
    orders_errors = orders.get('errors') or []

    metrics = {
        'realization': round(realization, 2),
        'logistics': round(_expense(logistics_signed), 2),
        'storage': round(_expense(storage_signed), 2),
        'nominal_commission': round(max(0.0, nominal_commission), 2),
        'acquiring': round(_expense(acquiring_signed), 2),
        'advertising': None,
        'sales_quantity': int(sales_quantity),
        'sales_amount': round(sales_amount, 2),
        'orders_amount': round(_number(orders_amount), 2) if orders_amount is not None else None,
        'orders_quantity': int(_number(orders_quantity)) if orders_quantity is not None else None,
        'discount_points': round(discount_points, 2),
        'compensations': round(compensation_signed, 2),
        'other_deductions': round(other_deductions, 2),
    }

    components = {
        'domestic_realization': round(realization_domestic, 2),
        'marketplace_buyout_realization': round(buyout_realization, 2),
        'revenue': round(revenue, 2),
        'return_revenue': round(return_revenue, 2),
        'partner_programs': round(partner_programs, 2),
        'marketplace_buyout_quantity': buyout_quantity,
        'marketplace_buyout_commission': round(buyout_commission, 2),
        'nominal_commission_domestic': round(nominal_commission_domestic, 2),
    }

    warnings = []
    if snapshot.get('buyout_error'):
        warnings.append('Выкупы маркетплейсом не загружены: показатели Реализация, Номинальная комиссия, Количество продаж и Сумма продаж неполные.')
    if orders_errors:
        warnings.append('Сверка заказов неполная: ' + '; '.join(str(x) for x in orders_errors))
    warnings.append('Реклама пока не рассчитывается: по инструкции TrueStats она берётся из Аналитики продвижения + Оплата за заказ, а это отдельный Promotion/Performance API, не Seller API.')

    types = []
    for name, row in operation_rows.items():
        category = 'Прочие удержания'
        if name in LOGISTICS_TYPES:
            category = 'Сумма логистики'
        elif name in STORAGE_TYPES:
            category = 'Сумма хранения'
        elif name == ACQUIRING_TYPE:
            category = 'Эквайринг'
        elif name in (REVENUE_TYPE, RETURN_REVENUE_TYPE):
            category = 'Количество продаж / Сумма продаж'
        elif name in PARTNER_TYPES:
            category = 'Сумма продаж'
        elif name == DISCOUNT_POINTS_TYPE:
            category = 'Баллы за скидки'
        elif _is_compensation(name):
            category = 'Компенсации'
        elif name in ADVERTISING_LIKE_TYPES:
            category = 'Реклама (не используется: нужен Promotion API)'
        elif row['amount'] >= 0:
            category = 'Доход / не является удержанием'
        types.append({
            'name': name,
            'count': row['count'],
            'amount': round(row['amount'], 2),
            'truestats_metric': category,
        })
    types.sort(key=lambda row: abs(row['amount']), reverse=True)

    product_rows = []
    for row in products.values():
        row['sales_amount'] = round(row['sales_amount'], 2)
        row['realization'] = round(row['realization'], 2)
        product_rows.append(dict(row))
    product_rows.sort(key=lambda row: abs(row['realization']), reverse=True)

    return {
        'at': snapshot.get('at'),
        'since': snapshot.get('since'),
        'to': snapshot.get('to'),
        'metrics': metrics,
        'components': components,
        'operation_types': types,
        'products': product_rows,
        'warnings': warnings,
        'methodology': 'Метрики сгруппированы по публичной инструкции TrueStats для Ozon (новый API).',
    }

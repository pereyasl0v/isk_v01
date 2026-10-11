"""TrueStats-style Ozon reconciliation built from current Seller API data."""
from collections import defaultdict
import math

LOGISTICS_TYPES = {
    'Логистика', 'Обратная логистика', 'Логистика - отмена начисления',
    'Доставка до места выдачи', 'Доставка до места выдачи силами Ozon',
    'Обработка возвратов, отмен и невыкупов партнёрами',
    'Обработка отправления Drop-off (СЦ)',
    'Обработка отправления Drop-off (СЦ) - отмена начисления',
}
STORAGE_TYPES = {
    'Размещение товаров на складе Ozon', 'Размещение товаров на складе',
    'Стоимость размещения', 'Хранение',
}
REVENUE_TYPE = 'Выручка'
RETURN_REVENUE_TYPE = 'Возврат выручки'
PARTNER_TYPES = {'Программы партнеров', 'Программы партнёров'}
ACQUIRING_TYPE = 'Эквайринг'
DISCOUNT_POINTS_TYPE = 'Баллы за скидки'
ADVERTISING_LIKE_TYPES = {'Реклама', 'Продвижение', 'Продвижение товара', 'Продвижение товаров'}


def _number(value):
    if isinstance(value, bool) or value is None:
        return 0.0
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _money(value):
    return _number(value.get('amount')) if isinstance(value, dict) else _number(value)


def _expense(value):
    return max(0.0, -_number(value))


def _percent(part, base):
    part = _number(part)
    base = _number(base)
    if not base:
        return None
    return round(part / base * 100, 2)


def _average(total, quantity):
    quantity = int(_number(quantity))
    if quantity <= 0:
        return None
    return round(_number(total) / quantity, 2)


def _norm(value):
    text = str(value or '').strip().casefold().replace('ё', 'е')
    text = text.replace('–', '-').replace('—', '-')
    return ' '.join(text.split())


def _aliases(row):
    values = []
    for key in ('description', 'name'):
        value = str(row.get(key) or '').strip()
        if value and value not in values:
            values.append(value)
    return values


def _matches(aliases, targets):
    normalized = {_norm(v) for v in aliases}
    return any(_norm(target) in normalized for target in targets)


def _contains_compensation(aliases):
    return any('компенсац' in _norm(v) for v in aliases)


def _classify(aliases):
    """Map Ozon type aliases to the exact TrueStats bucket without fuzzy substring grouping."""
    if _matches(aliases, {REVENUE_TYPE}):
        return REVENUE_TYPE
    if _matches(aliases, {RETURN_REVENUE_TYPE}):
        return RETURN_REVENUE_TYPE
    if _matches(aliases, PARTNER_TYPES):
        return 'Программы партнеров'
    if _matches(aliases, {ACQUIRING_TYPE}):
        return ACQUIRING_TYPE
    if _matches(aliases, {DISCOUNT_POINTS_TYPE}):
        return DISCOUNT_POINTS_TYPE
    if _matches(aliases, LOGISTICS_TYPES):
        return 'Сумма логистики'
    if _matches(aliases, STORAGE_TYPES):
        return 'Сумма хранения'
    if _matches(aliases, ADVERTISING_LIKE_TYPES):
        return 'Реклама'
    if _contains_compensation(aliases):
        return 'Компенсации'
    return 'Прочие удержания'


def summarize(snapshot):
    accruals = snapshot.get('accruals') or []
    type_rows = snapshot.get('accrual_types') or []
    buyouts = snapshot.get('buyout_products') or []

    type_info = {}
    for row in type_rows:
        key = row.get('id')
        if key is None:
            continue
        aliases = _aliases(row)
        type_info[str(key)] = {
            'aliases': aliases,
            'display': (row.get('description') or row.get('name') or str(key)),
            'bucket': _classify(aliases),
        }

    amount_by_bucket = defaultdict(float)
    units_by_bucket = defaultdict(set)
    operation_rows = defaultdict(lambda: {'name': '', 'count': 0, 'amount': 0.0, 'bucket': ''})

    realization_domestic = 0.0
    nominal_commission_domestic = 0.0
    discount_points_from_products = 0.0
    products = defaultdict(lambda: {
        'sku': '', 'sales_quantity': 0, 'sales_amount': 0.0, 'realization': 0.0
    })

    for index, accrual in enumerate(accruals):
        type_id = str(accrual.get('accrual_id', accrual.get('type_id', 'unknown')))
        info = type_info.get(
            type_id,
            {'aliases': [type_id], 'display': type_id, 'bucket': 'Прочие удержания'},
        )
        bucket = info['bucket']
        display = str(info['display'])
        amount = _money(accrual.get('total_amount'))
        amount_by_bucket[bucket] += amount

        unit_number = str(accrual.get('unit_number') or '').strip()
        units_by_bucket[bucket].add(unit_number or f'row:{index}')

        diag_key = f'{type_id}:{display}'
        diagnostic = operation_rows[diag_key]
        diagnostic['name'] = display
        diagnostic['bucket'] = bucket
        diagnostic['count'] += 1
        diagnostic['amount'] += amount

        sign = 1 if bucket == REVENUE_TYPE else -1 if bucket == RETURN_REVENUE_TYPE else 0
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

    revenue = amount_by_bucket.get(REVENUE_TYPE, 0.0)
    return_revenue = amount_by_bucket.get(RETURN_REVENUE_TYPE, 0.0)
    partner_programs = amount_by_bucket.get('Программы партнеров', 0.0)
    revenue_qty = len(units_by_bucket.get(REVENUE_TYPE, set()))
    return_qty = len(units_by_bucket.get(RETURN_REVENUE_TYPE, set()))

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

    placement_cost = snapshot.get('placement_cost')
    storage_from_report = placement_cost is not None
    storage_value = (
        abs(_number(placement_cost))
        if storage_from_report
        else _expense(amount_by_bucket.get('Сумма хранения', 0.0))
    )

    discount_by_type = amount_by_bucket.get(DISCOUNT_POINTS_TYPE, 0.0)
    discount_points = (
        abs(discount_by_type)
        if discount_by_type
        else max(0.0, discount_points_from_products)
    )
    compensation_signed = amount_by_bucket.get('Компенсации', 0.0)

    domestic_sales = revenue - abs(return_revenue) + partner_programs
    sales_amount = domestic_sales + buyout_realization
    sales_quantity = revenue_qty - return_qty + buyout_quantity
    realization = realization_domestic + buyout_realization
    nominal_commission = nominal_commission_domestic + buyout_commission

    logistics = _expense(amount_by_bucket.get('Сумма логистики', 0.0))
    acquiring = _expense(amount_by_bucket.get(ACQUIRING_TYPE, 0.0))
    other_deductions = _expense(amount_by_bucket.get('Прочие удержания', 0.0))
    returns_amount = abs(return_revenue)
    returns_quantity = return_qty

    orders = snapshot.get('orders') or {}
    orders_amount = orders.get('amount')
    orders_quantity = orders.get('quantity')
    orders_errors = orders.get('errors') or []

    # These TrueStats dashboard metrics require seller-owned inputs that do not
    # exist in Seller API. They stay empty until those sources are connected.
    clean_profit = snapshot.get('clean_profit')
    taxes = snapshot.get('taxes')
    cogs = snapshot.get('cogs')
    if clean_profit is not None:
        clean_profit = round(_number(clean_profit), 2)
    if taxes is not None:
        taxes = round(_number(taxes), 2)
    if cogs is not None:
        cogs = round(_number(cogs), 2)

    margin = _percent(clean_profit, realization) if clean_profit is not None else None
    roi = _percent(clean_profit, cogs) if clean_profit is not None and cogs else None
    average_profit = _average(clean_profit, sales_quantity) if clean_profit is not None else None

    metrics = {
        # Exact top-card names in TrueStats "Оцифровка".
        'orders_amount': round(_number(orders_amount), 2) if orders_amount is not None else None,
        'orders_quantity': int(_number(orders_quantity)) if orders_quantity is not None else None,
        'sales_amount': round(sales_amount, 2),
        'sales_quantity': int(sales_quantity),
        'clean_profit': clean_profit,
        'margin': margin,
        'returns_amount': round(returns_amount, 2),
        'returns_quantity': int(returns_quantity),
        'logistics': round(logistics, 2),
        'logistics_share': _percent(logistics, realization),
        'nominal_commission': round(max(0.0, nominal_commission), 2),
        'nominal_commission_share': _percent(max(0.0, nominal_commission), realization),
        'roi': roi,
        'average_profit': average_profit,
        'taxes': taxes,
        'taxes_share': _percent(taxes, realization) if taxes is not None else None,

        # Reconciliation metrics used below the cards.
        'realization': round(realization, 2),
        'storage': round(storage_value, 2),
        'acquiring': round(acquiring, 2),
        'advertising': None,
        'discount_points': round(discount_points, 2),
        'compensations': round(compensation_signed, 2),
        'other_deductions': round(other_deductions, 2),
    }

    summary = {
        'price_before_spp': _average(realization, sales_quantity),
        'average_sale_price': _average(sales_amount, sales_quantity),
        'realization': round(realization, 2),
        'sales': round(sales_amount, 2),
        'to_transfer': None,
        'returns': round(returns_amount, 2),
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
        'storage_from_placement_report': storage_from_report,
        'storage_accrual_fallback': round(
            _expense(amount_by_bucket.get('Сумма хранения', 0.0)), 2
        ),
    }

    warnings = []
    if snapshot.get('buyout_error'):
        warnings.append(
            'Выкупы маркетплейсом не загружены: показатели Реализация, '
            'Номинальная комиссия, Продажи и количество продаж неполные.'
        )
    if snapshot.get('placement_error'):
        warnings.append(
            'Отчёт «Стоимость размещения → По товарам» не загружен. '
            'Сумма хранения показана по начислениям как резервный вариант и '
            'может не совпадать с TrueStats.'
        )
    if orders_errors:
        warnings.append('Сверка заказов неполная: ' + '; '.join(str(x) for x in orders_errors))
    warnings.append(
        'Реклама пока не рассчитывается: по методике TrueStats она берётся из '
        'Аналитики продвижения + Оплата за заказ, то есть из отдельного '
        'Promotion/Performance API.'
    )
    if clean_profit is None or taxes is None or cogs is None:
        warnings.append(
            'Чистая прибыль, ROI, Средняя прибыль и Налоги не подменяются '
            'расчётами Seller API: для них нужны себестоимость/фулфилмент, '
            'налоговые настройки, реклама и операционные расходы продавца.'
        )

    types = []
    for row in operation_rows.values():
        category = row['bucket']
        if category == 'Сумма хранения':
            category = 'Сумма хранения (резерв; основной источник — отчёт размещения)'
        elif category == 'Реклама':
            category = 'Реклама (не используется: нужен Promotion API)'
        elif category == 'Прочие удержания' and row['amount'] >= 0:
            category = 'Доход / не является удержанием'
        types.append({
            'name': row['name'],
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
        'summary': summary,
        'components': components,
        'operation_types': types,
        'products': product_rows,
        'warnings': warnings,
        'methodology': 'Метрики названы и сгруппированы как в TrueStats «Оцифровка».',
    }

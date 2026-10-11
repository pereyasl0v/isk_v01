"""TrueStats-compatible Ozon digitization metrics.

The calculations intentionally mirror the public TrueStats reconciliation guide:
financial rows are grouped by the exact Ozon accrual type, quantities are summed
from the accrual rows, returns use seller price, and marketplace buyouts separate
gross realization from the amount actually paid to the seller.
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
REVENUE_TYPE = 'Выручка'
RETURN_REVENUE_TYPE = 'Возврат выручки'
PARTNER_TYPES = {'Программы партнеров', 'Программы партнёров'}
COMMISSION_TYPES = {'Вознаграждение за продажу', 'Возврат вознаграждения'}
ACQUIRING_TYPE = 'Эквайринг'
DISCOUNT_POINTS_TYPE = 'Баллы за скидки'
ORDER_PROMOTION_TYPE = 'Продвижение с оплатой за заказ'
STORAGE_TYPES = {
    'Размещение товаров на складе Ozon',
    'Размещение товаров на складе',
    'Стоимость размещения',
    'Хранение',
}


def _number(value):
    if isinstance(value, bool) or value is None:
        return 0.0
    if isinstance(value, dict):
        value = value.get('amount')
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _norm(value):
    text = str(value or '').strip().casefold().replace('ё', 'е')
    text = text.replace('–', '-').replace('—', '-')
    return ' '.join(text.split())


def _percent(part, base):
    part = _number(part)
    base = _number(base)
    if not base:
        return None
    return round(part / base * 100, 2)


def _average(total, quantity):
    quantity = _number(quantity)
    if quantity <= 0:
        return None
    return round(_number(total) / quantity, 2)


def _type_catalog(type_rows):
    result = {}
    for row in type_rows:
        key = row.get('id')
        if key is None:
            continue
        name = str(row.get('name') or '').strip()
        description = str(row.get('description') or '').strip()
        result[str(key)] = {
            'name': name or description or str(key),
            'description': description,
        }
    return result


def _bucket(type_name):
    normalized = _norm(type_name)
    if normalized == _norm(REVENUE_TYPE):
        return REVENUE_TYPE
    if normalized == _norm(RETURN_REVENUE_TYPE):
        return RETURN_REVENUE_TYPE
    if normalized in {_norm(v) for v in PARTNER_TYPES}:
        return 'Программы партнеров'
    if normalized in {_norm(v) for v in COMMISSION_TYPES}:
        return 'Номинальная комиссия'
    if normalized == _norm(ACQUIRING_TYPE):
        return ACQUIRING_TYPE
    if normalized == _norm(DISCOUNT_POINTS_TYPE):
        return DISCOUNT_POINTS_TYPE
    if normalized == _norm(ORDER_PROMOTION_TYPE):
        return 'Реклама'
    if normalized in {_norm(v) for v in LOGISTICS_TYPES}:
        return 'Логистика'
    if normalized in {_norm(v) for v in STORAGE_TYPES}:
        return 'Хранение'
    if 'компенсац' in normalized:
        return 'Компенсации'
    return 'Прочие удержания'


def _buyout_amount(item, quantity):
    """Amount credited to seller for the foreign buyout.

    Ozon's buyout response contains both the seller price (gross realization) and
    the buyout amount after the marketplace deduction. TrueStats uses the latter
    in "Продажи" and the former in "Реализация".
    """
    amount = item.get('amount')
    if amount is not None:
        return _number(amount)
    return _number(item.get('buyout_price')) * quantity


def summarize(snapshot):
    type_info = _type_catalog(snapshot.get('accrual_types') or [])
    rows = snapshot.get('accrual_rows')
    legacy_snapshot = rows is None
    rows = rows or []
    buyouts = snapshot.get('buyout_products') or []

    by_bucket = defaultdict(float)
    by_type = defaultdict(lambda: {'name': '', 'count': 0, 'amount': 0.0, 'bucket': ''})
    products = defaultdict(lambda: {
        'sku': '', 'sales_quantity': 0.0, 'sales_amount': 0.0, 'realization': 0.0,
    })

    domestic_realization = 0.0
    return_realization = 0.0
    revenue_quantity = 0.0
    return_quantity = 0.0

    for row in rows:
        type_id = str(row.get('type_id', 'unknown'))
        info = type_info.get(type_id, {})
        type_name = str(row.get('type_name') or info.get('name') or type_id)
        bucket = _bucket(type_name)
        amount = _number(row.get('amount'))
        quantity = abs(_number(row.get('quantity')))
        seller_price = abs(_number(row.get('seller_price')))
        sku = row.get('sku')

        by_bucket[bucket] += amount
        diagnostic = by_type[f'{type_id}:{type_name}']
        diagnostic['name'] = type_name
        diagnostic['bucket'] = bucket
        diagnostic['count'] += 1
        diagnostic['amount'] += amount

        if bucket == REVENUE_TYPE:
            gross = seller_price * quantity
            domestic_realization += gross
            revenue_quantity += quantity
            if sku not in (None, '', 0, '0'):
                product = products[str(sku)]
                product['sku'] = str(sku)
                product['sales_quantity'] += quantity
                product['realization'] += gross
                product['sales_amount'] += amount
        elif bucket == RETURN_REVENUE_TYPE:
            gross = seller_price * quantity
            return_realization += gross
            return_quantity += quantity
            if sku not in (None, '', 0, '0'):
                product = products[str(sku)]
                product['sku'] = str(sku)
                product['sales_quantity'] -= quantity
                product['realization'] -= gross
        elif bucket == 'Программы партнеров' and sku not in (None, '', 0, '0'):
            product = products[str(sku)]
            product['sku'] = str(sku)
            product['sales_amount'] += amount

    buyout_gross = 0.0
    buyout_sales = 0.0
    buyout_commission = 0.0
    buyout_quantity = 0.0
    for item in buyouts:
        quantity = abs(_number(item.get('quantity')))
        seller_price = _number(item.get('seller_price_per_instance'))
        gross = seller_price * quantity
        credited = _buyout_amount(item, quantity)
        buyout_gross += gross
        buyout_sales += credited
        buyout_commission += gross - credited
        buyout_quantity += quantity
        sku = item.get('sku')
        if sku not in (None, '', 0, '0'):
            product = products[str(sku)]
            product['sku'] = str(sku)
            product['sales_quantity'] += quantity
            product['realization'] += gross
            product['sales_amount'] += credited

    revenue = by_bucket.get(REVENUE_TYPE, 0.0)
    partner_programs = by_bucket.get('Программы партнеров', 0.0)
    realization = domestic_realization - return_realization + buyout_gross
    sales_amount = revenue + partner_programs + buyout_sales
    sales_quantity = revenue_quantity - return_quantity + buyout_quantity

    commission_domestic = abs(by_bucket.get('Номинальная комиссия', 0.0))
    nominal_commission = commission_domestic + buyout_commission
    logistics = abs(by_bucket.get('Логистика', 0.0))
    acquiring = abs(by_bucket.get(ACQUIRING_TYPE, 0.0))
    returns_amount = return_realization

    placement_cost = snapshot.get('placement_cost')
    storage_from_report = placement_cost is not None
    storage = (
        abs(_number(placement_cost))
        if storage_from_report
        else abs(by_bucket.get('Хранение', 0.0))
    )

    # Seller API exposes "Оплата за заказ" in financial accruals. Other campaign
    # spend is added later when Promotion/Performance API is connected.
    order_promotion = abs(by_bucket.get('Реклама', 0.0))
    promotion_spend = snapshot.get('promotion_spend')
    advertising = order_promotion
    if promotion_spend is not None:
        advertising += abs(_number(promotion_spend))

    discount_points = abs(by_bucket.get(DISCOUNT_POINTS_TYPE, 0.0))
    compensations = by_bucket.get('Компенсации', 0.0)

    known_buckets = {
        REVENUE_TYPE, RETURN_REVENUE_TYPE, 'Программы партнеров',
        'Номинальная комиссия', ACQUIRING_TYPE, DISCOUNT_POINTS_TYPE,
        'Реклама', 'Логистика', 'Хранение', 'Компенсации',
    }
    other_deductions = 0.0
    for item in by_type.values():
        if item['bucket'] not in known_buckets and item['amount'] < 0:
            other_deductions += -item['amount']

    orders = snapshot.get('orders') or {}
    orders_amount = orders.get('amount')
    orders_quantity = orders.get('quantity')

    clean_profit = snapshot.get('clean_profit')
    taxes = snapshot.get('taxes')
    cogs = snapshot.get('cogs')
    clean_profit = round(_number(clean_profit), 2) if clean_profit is not None else None
    taxes = round(_number(taxes), 2) if taxes is not None else None
    cogs = round(_number(cogs), 2) if cogs is not None else None

    metrics = {
        'orders_amount': round(_number(orders_amount), 2) if orders_amount is not None else None,
        'orders_quantity': int(_number(orders_quantity)) if orders_quantity is not None else None,
        'sales_amount': round(sales_amount, 2),
        'sales_quantity': int(round(sales_quantity)),
        'clean_profit': clean_profit,
        'margin': _percent(clean_profit, realization) if clean_profit is not None else None,
        'returns_amount': round(returns_amount, 2),
        'returns_quantity': int(round(return_quantity)),
        'logistics': round(logistics, 2),
        'logistics_share': _percent(logistics, realization),
        'nominal_commission': round(nominal_commission, 2),
        'nominal_commission_share': _percent(nominal_commission, realization),
        'roi': _percent(clean_profit, cogs) if clean_profit is not None and cogs else None,
        'average_profit': _average(clean_profit, sales_quantity) if clean_profit is not None else None,
        'taxes': taxes,
        'taxes_share': _percent(taxes, realization) if taxes is not None else None,
        'realization': round(realization, 2),
        'storage': round(storage, 2),
        'acquiring': round(acquiring, 2),
        'advertising': round(advertising, 2),
        'discount_points': round(discount_points, 2),
        'compensations': round(compensations, 2),
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
        'domestic_realization': round(domestic_realization - return_realization, 2),
        'marketplace_buyout_realization': round(buyout_gross, 2),
        'marketplace_buyout_sales': round(buyout_sales, 2),
        'revenue': round(revenue, 2),
        'partner_programs': round(partner_programs, 2),
        'marketplace_buyout_quantity': int(round(buyout_quantity)),
        'marketplace_buyout_commission': round(buyout_commission, 2),
        'nominal_commission_domestic': round(commission_domestic, 2),
        'order_promotion': round(order_promotion, 2),
        'storage_from_placement_report': storage_from_report,
        'storage_accrual_fallback': round(abs(by_bucket.get('Хранение', 0.0)), 2),
    }

    warnings = []
    if legacy_snapshot:
        warnings.append(
            'Этот снимок создан старой версией оцифровки. Нажмите «Обновить», '
            'чтобы Ozon начисления были загружены по type_id, quantity и seller_price.'
        )
    if snapshot.get('current_day_excluded'):
        warnings.append(
            f'Для совпадения с закрытыми данными TrueStats текущий день не включён: '
            f'расчёт выполнен по {snapshot.get("effective_to") or "предыдущий день"} включительно.'
        )
    if snapshot.get('buyout_error'):
        warnings.append(
            'Выкупы маркетплейсом не загружены: Реализация, Продажи, '
            'Номинальная комиссия и количество продаж неполные.'
        )
    if snapshot.get('placement_error'):
        warnings.append(
            'Отчёт «Стоимость размещения → По товарам» не загружен. '
            'Хранение показано по финансовым начислениям как резервный вариант.'
        )
    order_errors = (orders.get('errors') or [])
    if order_errors:
        warnings.append('Сверка заказов неполная: ' + '; '.join(str(x) for x in order_errors))
    if promotion_spend is None:
        warnings.append(
            'Реклама сейчас включает «Продвижение с оплатой за заказ» из Seller API. '
            'Расходы из «Аналитики продвижения» потребуют Promotion/Performance API.'
        )
    if clean_profit is None or taxes is None or cogs is None:
        warnings.append(
            'Чистая прибыль, ROI, Средняя прибыль и Налоги требуют данных продавца: '
            'себестоимости, налоговой настройки и операционных расходов.'
        )

    operation_types = []
    for item in by_type.values():
        category = item['bucket']
        if category == 'Хранение':
            category = 'Сумма хранения (резерв; основной источник — отчёт размещения)'
        elif category == 'Реклама':
            category = 'Реклама: Оплата за заказ'
        elif category == 'Прочие удержания' and item['amount'] >= 0:
            category = 'Доход / не является удержанием'
        operation_types.append({
            'name': item['name'],
            'count': item['count'],
            'amount': round(item['amount'], 2),
            'truestats_metric': category,
        })
    operation_types.sort(key=lambda item: abs(item['amount']), reverse=True)

    product_rows = []
    for row in products.values():
        row['sales_quantity'] = int(round(row['sales_quantity']))
        row['sales_amount'] = round(row['sales_amount'], 2)
        row['realization'] = round(row['realization'], 2)
        product_rows.append(dict(row))
    product_rows.sort(key=lambda row: abs(row['realization']), reverse=True)

    return {
        'at': snapshot.get('at'),
        'since': snapshot.get('since'),
        'to': snapshot.get('to'),
        'effective_to': snapshot.get('effective_to') or snapshot.get('to'),
        'metrics': metrics,
        'summary': summary,
        'components': components,
        'operation_types': operation_types,
        'products': product_rows,
        'warnings': warnings,
        'methodology': 'Метрики рассчитаны по публичной инструкции TrueStats для Ozon и текущему Seller API.',
    }

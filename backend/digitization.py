"""TrueStats-compatible Ozon digitization metrics."""
from collections import defaultdict
import math

REVENUE_TYPE = 'Выручка'
RETURN_REVENUE_TYPE = 'Возврат выручки'
PARTNER_BUCKET = 'Программы партнеров'
COMMISSION_BUCKET = 'Номинальная комиссия'
ACQUIRING_BUCKET = 'Эквайринг'
DISCOUNT_BUCKET = 'Баллы за скидки'
AD_BUCKET = 'Реклама'
LOGISTICS_BUCKET = 'Логистика'
STORAGE_BUCKET = 'Хранение'
COMPENSATION_BUCKET = 'Компенсации'
OTHER_BUCKET = 'Прочие удержания'

MACHINE_BUCKETS = {
    'salecommission': COMMISSION_BUCKET,
    'logistic': LOGISTICS_BUCKET,
    'returnflowlogistic': LOGISTICS_BUCKET,
    'lastmilecourier': LOGISTICS_BUCKET,
    'deliverytohandoverplacebyozon': LOGISTICS_BUCKET,
    'pickuppointreturnacceptance': LOGISTICS_BUCKET,
    'acquiring': ACQUIRING_BUCKET,
    'promotion': AD_BUCKET,
}

RUSSIAN_BUCKETS = {
    'выручка': REVENUE_TYPE,
    'возврат выручки': RETURN_REVENUE_TYPE,
    'программы партнеров': PARTNER_BUCKET,
    'программы партнёров': PARTNER_BUCKET,
    'вознаграждение за продажу': COMMISSION_BUCKET,
    'возврат вознаграждения': COMMISSION_BUCKET,
    'эквайринг': ACQUIRING_BUCKET,
    'баллы за скидки': DISCOUNT_BUCKET,
    'продвижение с оплатой за заказ': AD_BUCKET,
    'логистика': LOGISTICS_BUCKET,
    'обратная логистика': LOGISTICS_BUCKET,
    'логистика - отмена начисления': LOGISTICS_BUCKET,
    'доставка до места выдачи': LOGISTICS_BUCKET,
    'доставка до места выдачи силами ozon': LOGISTICS_BUCKET,
    'обработка возвратов, отмен и невыкупов партнерами': LOGISTICS_BUCKET,
    'обработка возвратов, отмен и невыкупов партнёрами': LOGISTICS_BUCKET,
    'обработка отправления drop-off (сц)': LOGISTICS_BUCKET,
    'обработка отправления drop-off (сц) - отмена начисления': LOGISTICS_BUCKET,
    'размещение товаров на складе ozon': STORAGE_BUCKET,
    'размещение товаров на складе': STORAGE_BUCKET,
    'стоимость размещения': STORAGE_BUCKET,
    'хранение': STORAGE_BUCKET,
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
    base = _number(base)
    return round(_number(part) / base * 100, 2) if base else None


def _average(total, quantity):
    quantity = _number(quantity)
    return round(_number(total) / quantity, 2) if quantity > 0 else None


def _type_catalog(type_rows):
    result = {}
    for row in type_rows:
        key = row.get('id')
        if key is None:
            continue
        name = str(row.get('name') or '').strip()
        description = str(row.get('description') or '').strip()
        result[str(key)] = {'name': name or description or str(key), 'description': description}
    return result


def _bucket(type_name, description=''):
    for value in (type_name, description):
        normalized = _norm(value)
        machine = normalized.replace('_', '').replace('-', '').replace(' ', '')
        if machine in MACHINE_BUCKETS:
            return MACHINE_BUCKETS[machine]
        if normalized in RUSSIAN_BUCKETS:
            return RUSSIAN_BUCKETS[normalized]
        if 'компенсац' in normalized or 'compensation' in normalized:
            return COMPENSATION_BUCKET
    return OTHER_BUCKET


def _buyout_amount(item, quantity):
    if item.get('amount') is not None:
        return _number(item.get('amount'))
    return _number(item.get('buyout_price')) * quantity


def _sum_fee_bucket(rows, type_info, wanted):
    total = 0.0
    for row in rows or []:
        info = type_info.get(str(row.get('type_id')), {})
        name = str(row.get('type_name') or info.get('name') or row.get('type_id') or '')
        if _bucket(name, info.get('description', '')) == wanted:
            total += _number(row.get('amount'))
    return total


def summarize(snapshot):
    type_info = _type_catalog(snapshot.get('accrual_types') or [])
    rows = snapshot.get('accrual_rows') or []
    by_day_fee_rows = snapshot.get('by_day_fee_rows') or []
    sales_facts = snapshot.get('sales_facts') or {}
    buyouts = snapshot.get('buyout_products') or []

    by_bucket = defaultdict(float)
    by_type = defaultdict(lambda: {'name': '', 'count': 0, 'amount': 0.0, 'bucket': ''})
    products = defaultdict(lambda: {'sku': '', 'sales_quantity': 0.0, 'sales_amount': 0.0, 'realization': 0.0})

    domestic_realization = 0.0
    return_realization = 0.0
    revenue_quantity = 0.0
    return_quantity = 0.0

    for row in rows:
        type_id = str(row.get('type_id', 'unknown'))
        info = type_info.get(type_id, {})
        type_name = str(row.get('type_name') or info.get('name') or type_id)
        bucket = _bucket(type_name, info.get('description', ''))
        amount = _number(row.get('amount'))
        quantity = abs(_number(row.get('quantity')))
        signed_seller_price = _number(row.get('seller_price'))
        sku = row.get('sku')

        by_bucket[bucket] += amount
        diagnostic = by_type[f'{type_id}:{type_name}']
        diagnostic['name'] = type_name
        diagnostic['bucket'] = bucket
        diagnostic['count'] += 1
        diagnostic['amount'] += amount

        if bucket == COMMISSION_BUCKET and quantity > 0 and signed_seller_price:
            gross = abs(signed_seller_price) * quantity
            is_return = signed_seller_price < 0 or amount > 0
            if is_return:
                return_realization += gross
                return_quantity += quantity
                if sku not in (None, '', 0, '0'):
                    p = products[str(sku)]
                    p['sku'] = str(sku)
                    p['sales_quantity'] -= quantity
                    p['realization'] -= gross
            else:
                domestic_realization += gross
                revenue_quantity += quantity
                if sku not in (None, '', 0, '0'):
                    p = products[str(sku)]
                    p['sku'] = str(sku)
                    p['sales_quantity'] += quantity
                    p['realization'] += gross

    revenue = _number(sales_facts.get('revenue'))
    partner_programs = _number(sales_facts.get('partner_programs'))
    discount_points = _number(sales_facts.get('discount_points'))
    if not sales_facts:
        revenue = by_bucket.get(REVENUE_TYPE, 0.0)
        partner_programs = by_bucket.get(PARTNER_BUCKET, 0.0)
        discount_points = by_bucket.get(DISCOUNT_BUCKET, 0.0)

    for item in sales_facts.get('products') or []:
        sku = item.get('sku')
        if sku in (None, '', 0, '0'):
            continue
        p = products[str(sku)]
        p['sku'] = str(sku)
        p['sales_amount'] += _number(item.get('revenue')) + _number(item.get('partner_programs'))

    buyout_gross = buyout_sales = buyout_commission = buyout_quantity = 0.0
    for item in buyouts:
        quantity = abs(_number(item.get('quantity')))
        gross = _number(item.get('seller_price_per_instance')) * quantity
        credited = _buyout_amount(item, quantity)
        buyout_gross += gross
        buyout_sales += credited
        buyout_commission += gross - credited
        buyout_quantity += quantity
        sku = item.get('sku')
        if sku not in (None, '', 0, '0'):
            p = products[str(sku)]
            p['sku'] = str(sku)
            p['sales_quantity'] += quantity
            p['realization'] += gross
            p['sales_amount'] += credited

    realization = domestic_realization - return_realization + buyout_gross
    sales_amount = revenue + partner_programs + buyout_sales
    sales_quantity = revenue_quantity - return_quantity + buyout_quantity
    commission_domestic = abs(by_bucket.get(COMMISSION_BUCKET, 0.0))
    nominal_commission = commission_domestic + buyout_commission
    logistics = abs(by_bucket.get(LOGISTICS_BUCKET, 0.0))

    acquiring_source = _sum_fee_bucket(by_day_fee_rows, type_info, ACQUIRING_BUCKET)
    acquiring = abs(acquiring_source if by_day_fee_rows else by_bucket.get(ACQUIRING_BUCKET, 0.0))
    ad_source = _sum_fee_bucket(by_day_fee_rows, type_info, AD_BUCKET)
    order_promotion = abs(ad_source if by_day_fee_rows else by_bucket.get(AD_BUCKET, 0.0))

    placement_cost = snapshot.get('placement_cost')
    storage = abs(_number(placement_cost)) if placement_cost is not None else abs(by_bucket.get(STORAGE_BUCKET, 0.0))

    promotion_spend = snapshot.get('promotion_spend')
    advertising = order_promotion + (abs(_number(promotion_spend)) if promotion_spend is not None else 0.0)
    compensations = by_bucket.get(COMPENSATION_BUCKET, 0.0)

    known = {REVENUE_TYPE, RETURN_REVENUE_TYPE, PARTNER_BUCKET, COMMISSION_BUCKET,
             ACQUIRING_BUCKET, DISCOUNT_BUCKET, AD_BUCKET, LOGISTICS_BUCKET,
             STORAGE_BUCKET, COMPENSATION_BUCKET}
    other_deductions = sum(-item['amount'] for item in by_type.values()
                           if item['bucket'] not in known and item['amount'] < 0)

    orders = snapshot.get('orders') or {}
    clean_profit = snapshot.get('clean_profit')
    taxes = snapshot.get('taxes')
    cogs = snapshot.get('cogs')
    clean_profit = round(_number(clean_profit), 2) if clean_profit is not None else None
    taxes = round(_number(taxes), 2) if taxes is not None else None
    cogs = round(_number(cogs), 2) if cogs is not None else None

    metrics = {
        'orders_amount': round(_number(orders.get('amount')), 2) if orders.get('amount') is not None else None,
        'orders_quantity': int(_number(orders.get('quantity'))) if orders.get('quantity') is not None else None,
        'sales_amount': round(sales_amount, 2),
        'sales_quantity': int(round(sales_quantity)),
        'clean_profit': clean_profit,
        'margin': _percent(clean_profit, realization) if clean_profit is not None else None,
        'returns_amount': round(return_realization, 2),
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
        'discount_points': round(abs(discount_points), 2),
        'compensations': round(compensations, 2),
        'other_deductions': round(other_deductions, 2),
    }

    summary = {
        'price_before_spp': _average(realization, sales_quantity),
        'average_sale_price': _average(sales_amount, sales_quantity),
        'realization': round(realization, 2),
        'sales': round(sales_amount, 2),
        'to_transfer': None,
        'returns': round(return_realization, 2),
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
        'storage_from_placement_report': placement_cost is not None,
        'storage_accrual_fallback': round(abs(by_bucket.get(STORAGE_BUCKET, 0.0)), 2),
    }

    warnings = []
    if snapshot.get('current_day_excluded'):
        warnings.append(f'Текущий день не включён в сравнение с TrueStats: расчёт по {snapshot.get("effective_to")}.')
    if snapshot.get('buyout_error'):
        warnings.append('Выкупы маркетплейсом не загружены. Ошибка Ozon: ' + str(snapshot.get('buyout_error')))
    if snapshot.get('placement_error'):
        warnings.append('Отчёт стоимости размещения не загружен: ' + str(snapshot.get('placement_error')))
    if orders.get('errors'):
        warnings.append('Сверка заказов неполная: ' + '; '.join(str(x) for x in orders.get('errors')))
    if promotion_spend is None:
        warnings.append('Реклама включает «Продвижение с оплатой за заказ» из Seller API; прочая реклама потребует Promotion API.')
    if clean_profit is None or taxes is None or cogs is None:
        warnings.append('Чистая прибыль, ROI, Средняя прибыль и Налоги требуют себестоимости, налоговой настройки и операционных расходов.')

    operation_types = []
    for item in by_type.values():
        category = item['bucket']
        if category == AD_BUCKET:
            category = 'Реклама: Продвижение с оплатой за заказ'
        elif category == OTHER_BUCKET and item['amount'] >= 0:
            category = 'Доход / не является удержанием'
        operation_types.append({'name': item['name'], 'count': item['count'],
                                'amount': round(item['amount'], 2), 'truestats_metric': category})
    operation_types.sort(key=lambda item: abs(item['amount']), reverse=True)

    product_rows = []
    for row in products.values():
        row['sales_quantity'] = int(round(row['sales_quantity']))
        row['sales_amount'] = round(row['sales_amount'], 2)
        row['realization'] = round(row['realization'], 2)
        product_rows.append(dict(row))
    product_rows.sort(key=lambda row: abs(row['realization']), reverse=True)

    return {
        'at': snapshot.get('at'), 'since': snapshot.get('since'), 'to': snapshot.get('to'),
        'effective_to': snapshot.get('effective_to') or snapshot.get('to'),
        'metrics': metrics, 'summary': summary, 'components': components,
        'operation_types': operation_types, 'products': product_rows, 'warnings': warnings,
        'methodology': 'Метрики рассчитаны по инструкции TrueStats и текущему Ozon Seller API.',
    }

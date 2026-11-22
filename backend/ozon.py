"""Read-only Ozon Seller API adapter."""
import math
import csv
import io
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, time as dt_time, timedelta, timezone
from openpyxl import load_workbook
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({
    '/v1/analytics/stocks', '/v1/analytics/data', '/v3/posting/fbo/list', '/v4/posting/fbs/list',
    '/v1/finance/accrual/by-day', '/v1/finance/accrual/types',
    '/v1/finance/accrual/postings', '/v1/finance/products/buyout',
    '/v1/report/placement/by-products/create', '/v1/report/info',
    '/v1/returns/list', '/v2/product/info/stocks-by-warehouse/fbs',
})

MOSCOW_TZ = timezone(timedelta(hours=3))
POSTING_NUMBER = re.compile(r'^\d+-\d+-\d+$')


class Ozon(BaseOzon):
    def analytics(self, products, stocks, progress):
        skus = sorted({str(p['sku']) for p in products if p.get('sku')} |
                      {str(s['sku']) for s in stocks if s.get('sku')})
        unique = {}
        for offset in range(0, len(skus), 100):
            data = self.call('/v1/analytics/stocks', {'skus': skus[offset:offset + 100]})
            for row in data['items']:
                key = (str(row['sku']), str(row['warehouse_id']))
                if key in unique:
                    raise ApiError('Повтор строки аналитики Ozon. Итоги не рассчитаны.')
                unique[key] = row
            progress(f'Аналитика: {min(offset + 100, len(skus))} / {len(skus)} SKU')
        if products and not unique:
            raise ApiError('Ozon не вернул строки аналитики для каталога.')
        return list(unique.values())

    def daily_sales(self, date_from, date_to, progress):
        """Free daily ordered units and sales volume grouped by SKU and day.

        Delivered items are fetched separately from FBO/FBS posting statuses.
        Never request the Premium-only delivered_units analytics metric.
        """
        first=self._as_date(date_from)
        last=self._as_date(date_to)
        if last < first or (last-first).days>92:
            raise ApiError('Период продаж должен содержать от 1 до 93 дней.')
        metrics=['ordered_units','revenue']
        base={
            'date_from':first.isoformat(),'date_to':last.isoformat(),
            'dimension':['sku','day'],'filters':[],
            'limit':1000,'offset':0,'metrics':metrics,
        }
        by_day={}
        by_sku_day={}
        offset=0
        for _ in range(100):
            data=self.call('/v1/analytics/data',{**base,'offset':offset})
            result=data.get('result')
            if not isinstance(result,dict) or not isinstance(result.get('data'),list):
                raise ApiError('Ozon вернул некорректную структуру дневной аналитики.')
            batch=result['data']
            for raw in batch:
                if not isinstance(raw,dict):
                    raise ApiError('Ozon вернул некорректную строку аналитики.')
                dimensions=raw.get('dimensions')
                values=raw.get('metrics')
                if (not isinstance(dimensions,list) or len(dimensions)<2
                    or not all(isinstance(d,dict) for d in dimensions[:2])
                    or not isinstance(values,list) or len(values)<2):
                    raise ApiError('Ozon не вернул SKU, дату или метрики заказов.')
                sku=str(dimensions[0].get('id') or '').strip()
                raw_day=str(dimensions[1].get('id') or dimensions[1].get('name') or '')[:10]
                try:
                    day=date.fromisoformat(raw_day)
                except ValueError:
                    raise ApiError('Ozon вернул неизвестный формат даты заказа.') from None
                if not sku or day < first or day > last:
                    raise ApiError('Ozon вернул неизвестный SKU или дату вне периода.')
                try:
                    ordered=float(str(values[0] if values[0] is not None else 0).replace(' ','').replace(',','.'))
                    revenue=float(str(values[1] if values[1] is not None else 0).replace(' ','').replace(',','.'))
                    if not math.isfinite(ordered) or not math.isfinite(revenue):
                        raise ValueError('non-finite metric')
                except (ValueError,TypeError):
                    raise ApiError('Некорректные значения количества или суммы заказов.') from None
                for target in (
                    by_day.setdefault(day.isoformat(),{'ordered_units':0,'ordered_revenue':0}),
                    by_sku_day.setdefault((sku,day.isoformat()),{
                        'sku':sku,'date':day.isoformat(),
                        'ordered_units':0,'ordered_revenue':0,
                    }),
                ):
                    target['ordered_units']+=ordered
                    target['ordered_revenue']+=revenue
            if len(batch)<base['limit']:
                break
            offset+=base['limit']
        else:
            raise ApiError('Слишком много страниц аналитики Ozon.')
        def format_values(row):
            return {
                'ordered_units':int(round(row.get('ordered_units',0))),
                'ordered_revenue':round(row.get('ordered_revenue',0),2),
            }
        rows=[]
        day=first
        while day<=last:
            rows.append({'date':day.isoformat(),
                         **format_values(by_day.get(day.isoformat(),{}))})
            day+=timedelta(days=1)
        by_sku=[
            {'sku':sku,'date':day,**format_values(values)}
            for (sku,day),values in sorted(by_sku_day.items())
        ]
        progress(f'Заказы Ozon: загружено {len(rows)} дней, {len(by_sku)} строк по SKU.')
        return {
            'date_from':first.isoformat(),'date_to':last.isoformat(),
            'rows':rows,'by_sku':by_sku,'error':None,
            'source':'ozon_seller_api_v1_analytics_data',
        }

    def fbs_stocks(self, products, progress):
        """Get seller-warehouse (FBS/rFBS) free stock for the current catalog."""
        skus = sorted({str(p.get('sku')) for p in products if p.get('sku')})
        rows = {}
        for offset in range(0, len(skus), 1000):
            chunk = skus[offset:offset + 1000]
            cursor = ''
            seen = set()
            for _ in range(10000):
                data = self.call('/v2/product/info/stocks-by-warehouse/fbs', {
                    'cursor': cursor, 'limit': 1000, 'sku': chunk,
                })
                batch = data.get('products') or []
                if not isinstance(batch, list):
                    raise ApiError('Ozon вернул некорректные FBS-остатки.')
                for row in batch:
                    key = (str(row.get('sku') or ''), str(row.get('warehouse_id') or ''))
                    rows[key] = {
                        'sku': str(row.get('sku') or ''),
                        'offer_id': str(row.get('offer_id') or ''),
                        'warehouse_id': str(row.get('warehouse_id') or ''),
                        'warehouse_name': str(row.get('warehouse_name') or ''),
                        'free_stock': int(row.get('free_stock') or 0),
                        'present': int(row.get('present') or 0),
                        'reserved': int(row.get('reserved') or 0),
                    }
                if not data.get('has_next', False):
                    break
                nxt = data.get('cursor') or ''
                if not nxt or nxt in seen:
                    raise ApiError('Ozon повторил курсор FBS-остатков.')
                seen.add(nxt)
                cursor = nxt
            else:
                raise ApiError('Слишком много страниц FBS-остатков.')
            progress(f'FBS-остатки: {min(offset + 1000, len(skus))} / {len(skus)} SKU')
        result = list(rows.values())
        return {
            'quantity': sum(max(0, int(r.get('free_stock') or 0)) for r in result),
            'rows': result,
        }

    @staticmethod
    def _normalize_posting(posting, scheme):
        if not isinstance(posting, dict):
            raise ApiError(f'Ozon вернул некорректное отправление {scheme}.')
        number = str(posting.get('posting_number') or '').strip()
        if not number:
            raise ApiError(f'Ozon вернул отправление {scheme} без номера.')
        raw_products = posting.get('products')
        if not isinstance(raw_products, list):
            raise ApiError(f'Ozon вернул некорректный состав отправления {number}.')
        products = []
        for product in raw_products:
            if not isinstance(product, dict) or product.get('sku') in (None, ''):
                raise ApiError(f'Ozon вернул товар без SKU в отправлении {number}.')
            try:
                quantity = int(product.get('quantity'))
            except (TypeError, ValueError):
                raise ApiError(f'Ozon вернул некорректное количество в отправлении {number}.') from None
            if quantity < 0:
                raise ApiError(f'Ozon вернул отрицательное количество в отправлении {number}.')
            products.append({
                'sku': str(product['sku']),
                'offer_id': str(product.get('offer_id') or ''),
                'name': str(product.get('name') or ''),
                'quantity': quantity,
                'price': Ozon._price(product.get('price')),
            })

        analytics = posting.get('analytics_data') or {}
        delivery = posting.get('delivery_method') or {}
        warehouse_id = analytics.get('warehouse_id') or delivery.get('warehouse_id')
        warehouse_name = (
            analytics.get('warehouse_name') or analytics.get('warehouse')
            or delivery.get('warehouse') or delivery.get('name')
        )
        return {
            'number': number,
            'scheme': scheme,
            'status': str(posting.get('status') or 'unknown'),
            'substatus': str(posting.get('substatus') or ''),
            'created_at': posting.get('created_at'),
            'in_process_at': posting.get('in_process_at'),
            'shipment_date': posting.get('shipment_date'),
            'delivering_date': posting.get('delivering_date'),
            'warehouse_id': str(warehouse_id) if warehouse_id not in (None, '') else None,
            'warehouse_name': str(warehouse_name) if warehouse_name else None,
            'products': products,
        }

    def _postings_for_scheme(self, path, scheme, since, until, progress):
        cursor, seen, rows = '', set(), {}
        for _ in range(10000):
            data = self.call(path, {
                'cursor': cursor, 'limit': 100, 'sort_dir': 'ASC',
                'filter': {'since': since.isoformat(), 'to': until.isoformat()},
                'with': {'analytics_data': True, 'financial_data': False, 'legal_info': False},
            })
            batch = data.get('postings')
            if not isinstance(batch, list):
                raise ApiError(f'Ozon вернул некорректный список отправлений {scheme}.')
            for posting in batch:
                normalized = self._normalize_posting(posting, scheme)
                rows[normalized['number']] = normalized
            progress(f'История {scheme}: {len(rows)} отправлений')
            if not data.get('has_next', False):
                return list(rows.values())
            nxt = data.get('cursor') or ''
            if not nxt or nxt in seen:
                raise ApiError(f'Ozon повторил курсор истории {scheme}.')
            seen.add(nxt)
            cursor = nxt
        raise ApiError(f'История {scheme} слишком велика. Уменьшите период.')

    def fbo_posting_by_number(self,number):
        """Look up a single FBO shipment for webhook SKU enrichment."""
        number=str(number or '').strip()
        if not number or len(number)>100:
            raise ApiError('Некорректный номер отправления FBO.')
        response=self.call('/v3/posting/fbo/list',{
            'cursor':'','limit':100,'sort_dir':'ASC',
            'filter':{'posting_number':[number]},
            'with':{'analytics_data':False,'financial_data':False,'legal_info':False},
        })
        postings=response.get('postings')
        if not isinstance(postings,list):
            raise ApiError('Ozon не вернул состав отправления FBO.')
        for raw in postings:
            if str(raw.get('posting_number') or '')==number:
                return self._normalize_posting(raw,'FBO')
        raise ApiError('Отправление FBO пока не найдено в API.')

    def delivered_postings_for_day(self, day, scheme):
        """Shipments whose most recent status switched to delivered on this day.

        For historical FBO/FBS data this is the *last status transition*,
        not an invented delivery timestamp or an order creation date.
        """
        from datetime import time as dt_time
        day=self._as_date(day)
        first=datetime.combine(day,dt_time.min,tzinfo=MOSCOW_TZ).astimezone(timezone.utc)
        until=(datetime.combine(day+timedelta(days=1),dt_time.min,tzinfo=MOSCOW_TZ)
               .astimezone(timezone.utc))
        if scheme=='FBO':
            # FBO list v3 does NOT expose a confirmed last-status-change
            # date filter. Its since/to bounds are order creation dates.
            # Assigning those deliveries to creation days would be false.
            raise ApiError(
                'Историческая дата доставки FBO недоступна через список '
                'отправлений. Для точных новых событий подключите Ozon Push.'
            )
        elif scheme=='FBS':
            path='/v4/posting/fbs/list'
            filter_data={
                'last_changed_status_date':{
                    'from':first.isoformat(),'to':until.isoformat(),
                },
                'statuses':['delivered'],
            }
        else:
            raise ApiError('Неизвестная схема доставки Ozon.')
        cursor,seen,rows='',set(),{}
        for _ in range(1000):
            response=self.call(path,{
                'cursor':cursor,'limit':100,'sort_dir':'ASC',
                'filter':filter_data,
                'with':{'analytics_data':False,'financial_data':False,'legal_info':False},
            })
            postings=response.get('postings')
            if not isinstance(postings,list):
                raise ApiError(f'Ozon вернул некорректный список доставок {scheme}.')
            for posting in postings:
                if str(posting.get('status') or '').lower()!='delivered':
                    continue
                row=self._normalize_posting(posting,scheme)
                actual=posting.get('fact_delivery_date')
                if actual:
                    try:
                        actual_day=datetime.fromisoformat(
                            str(actual).replace('Z','+00:00')
                        ).astimezone(MOSCOW_TZ).date()
                    except (ValueError,TypeError):
                        raise ApiError(f'Некорректная дата доставки {scheme}.') from None
                    if actual_day != day:
                        # Last status change may be later than delivery.
                        continue
                rows[row['number']]=row
            if not response.get('has_next'):
                return list(rows.values())
            next_cursor=str(response.get('cursor') or '')
            if not next_cursor or next_cursor in seen:
                raise ApiError(f'Ozon повторил курсор доставок {scheme}.')
            seen.add(next_cursor)
            cursor=next_cursor
        raise ApiError(f'Список доставок {scheme} слишком велик.')

    def postings(self, days, progress):
        until = datetime.now(timezone.utc)
        since = until - timedelta(days=days)
        sources = {}
        errors = []
        rows = {}
        for scheme, path in (
            ('FBO', '/v3/posting/fbo/list'),
            ('FBS', '/v4/posting/fbs/list'),
        ):
            try:
                batch = self._postings_for_scheme(path, scheme, since, until, progress)
            except ApiError as exc:
                sources[scheme.lower()] = {'ok': False, 'error': str(exc)}
                errors.append(f'{scheme}: {exc}')
                progress(f'История {scheme} недоступна: {exc}')
                continue
            sources[scheme.lower()] = {'ok': True, 'count': len(batch)}
            for posting in batch:
                rows[(scheme, posting['number'])] = posting

        if not any(source.get('ok') for source in sources.values()):
            raise ApiError('Не удалось загрузить историю отправлений FBO и FBS: ' + '; '.join(errors))

        fbo_rows = [row for row in rows.values() if row['scheme'] == 'FBO']
        warehouse_attribution = all(row.get('warehouse_id') for row in fbo_rows)
        ordered = sorted(
            rows.values(),
            key=lambda row: str(row.get('created_at') or row.get('in_process_at') or ''),
        )
        return {
            'since': since.isoformat(),
            'to': until.isoformat(),
            'warehouse_attribution': warehouse_attribution,
            'sources': sources,
            'errors': errors,
            'postings': ordered,
        }

    def current_day_orders(self, day, progress):
        history = self.postings(1, progress)
        if history['errors']:
            raise ApiError('Неполная история заказов: ' + '; '.join(history['errors']))

        iso_day = day.isoformat()
        by_sku = {}
        for posting in history['postings']:
            created = posting.get('created_at') or posting.get('in_process_at')
            if not created:
                raise ApiError('Ozon вернул отправление без даты заказа.')
            try:
                local_date = datetime.fromisoformat(created.replace('Z', '+00:00')).astimezone(MOSCOW_TZ).date()
            except (ValueError, TypeError):
                raise ApiError('Ozon вернул некорректную дату заказа.') from None
            if local_date != day:
                continue
            for product in posting['products']:
                row = by_sku.setdefault(product['sku'], {
                    'sku': product['sku'], 'date': iso_day, 'ordered_units': 0, 'ordered_revenue': 0.0,
                })
                row['ordered_units'] += product['quantity']
                row['ordered_revenue'] += product['price'] * product['quantity']
        total = {'date': iso_day, 'ordered_units': 0, 'ordered_revenue': 0.0}
        for row in by_sku.values():
            total['ordered_units'] += row['ordered_units']
            total['ordered_revenue'] += row['ordered_revenue']
            row['ordered_revenue'] = round(row['ordered_revenue'], 2)
        total['ordered_revenue'] = round(total['ordered_revenue'], 2)
        return total, list(by_sku.values())

    @staticmethod
    def _as_date(value):
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value))
        except ValueError as exc:
            raise ApiError('Некорректная дата периода оцифровки.') from exc

    @staticmethod
    def _price(value):
        if isinstance(value, dict):
            value = value.get('amount', value.get('price'))
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _report_number(value):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        text = str(value or '').strip().replace('\xa0', '').replace(' ', '').replace(',', '.')
        for suffix in ('₽', 'руб.', 'руб'):
            text = text.replace(suffix, '')
        try:
            return float(text)
        except ValueError:
            return 0.0

    @staticmethod
    def _closed_last_day(requested_last):
        today_moscow = datetime.now(MOSCOW_TZ).date()
        if requested_last >= today_moscow:
            return today_moscow - timedelta(days=1), True
        return requested_last, False

    @staticmethod
    def _date_chunks(first, last, days=31):
        """Yield inclusive date ranges without imposing a UI-visible period limit."""
        if days < 1:
            raise ValueError('Размер блока периода должен быть положительным.')
        current = first
        while current <= last:
            chunk_last = min(last, current + timedelta(days=days - 1))
            yield current, chunk_last
            current = chunk_last + timedelta(days=1)

    def _orders_for_period(self, first, last, progress):
        if last < first:
            return {'amount': 0.0, 'quantity': 0, 'postings': 0, 'fbo': 0, 'fbs': 0, 'errors': []}
        result = {'amount': 0.0, 'quantity': 0, 'postings': 0, 'fbo': 0, 'fbs': 0, 'errors': []}
        for chunk_first, chunk_last in self._date_chunks(first, last):
            since_msk = datetime.combine(chunk_first, dt_time.min, tzinfo=MOSCOW_TZ)
            until_msk = datetime.combine(chunk_last, dt_time.max, tzinfo=MOSCOW_TZ)
            since = since_msk.astimezone(timezone.utc).isoformat()
            until = until_msk.astimezone(timezone.utc).isoformat()
            for scheme, path in (('fbo', '/v3/posting/fbo/list'), ('fbs', '/v4/posting/fbs/list')):
                cursor = ''
                seen = set()
                try:
                    for _ in range(10000):
                        data = self.call(path, {
                            'cursor': cursor, 'limit': 100, 'sort_dir': 'ASC',
                            'filter': {'since': since, 'to': until},
                            'with': {'analytics_data': False, 'financial_data': False, 'legal_info': False},
                        })
                        postings = data.get('postings') or []
                        if not isinstance(postings, list):
                            raise ApiError(f'Ozon вернул некорректный список заказов {scheme.upper()}.')
                        for posting in postings:
                            result['postings'] += 1
                            result[scheme] += 1
                            for product in posting.get('products') or []:
                                quantity = int(product.get('quantity') or 0)
                                result['quantity'] += quantity
                                result['amount'] += self._price(product.get('price')) * quantity
                        progress(
                            f'Заказы {scheme.upper()}: {result[scheme]} отправлений · '
                            f'{chunk_first.isoformat()}—{chunk_last.isoformat()}'
                        )
                        if not data.get('has_next', False):
                            break
                        nxt = data.get('cursor') or ''
                        if not nxt or nxt in seen:
                            raise ApiError(f'Ozon повторил курсор заказов {scheme.upper()}.')
                        seen.add(nxt)
                        cursor = nxt
                    else:
                        raise ApiError(f'Слишком много страниц заказов {scheme.upper()}.')
                except ApiError as exc:
                    result['errors'].append(
                        f'{scheme.upper()} {chunk_first.isoformat()}—{chunk_last.isoformat()}: {exc}'
                    )
                    progress(f'Заказы {scheme.upper()} недоступны: {exc}')
        result['amount'] = round(result['amount'], 2)
        return result

    def _returns_for_period(self, first, last, progress):
        """Count customer decision events for the TrueStats buyout percentage."""
        if last < first:
            return {'quantity': 0, 'rows': 0, 'by_type': {}, 'date_filter': 'visual_status_change_moment'}

        def load(date_filter):
            quantity = 0
            row_count = 0
            by_type = {}
            seen_return_ids = set()
            for chunk_first, chunk_last in self._date_chunks(first, last):
                since_msk = datetime.combine(chunk_first, dt_time.min, tzinfo=MOSCOW_TZ)
                until_msk = datetime.combine(chunk_last, dt_time.max, tzinfo=MOSCOW_TZ)
                since = since_msk.astimezone(timezone.utc).isoformat()
                until = until_msk.astimezone(timezone.utc).isoformat()
                last_id = 0
                seen_cursors = set()
                for _ in range(10000):
                    data = self.call('/v1/returns/list', {
                        'filter': {
                            date_filter: {'time_from': since, 'time_to': until},
                        },
                        'limit': 500,
                        'last_id': last_id,
                    })
                    batch = data.get('returns') or []
                    if not isinstance(batch, list):
                        raise ApiError('Ozon вернул некорректный список возвратов.')
                    for item in batch:
                        item_id = item.get('id')
                        dedupe_key = str(item_id) if item_id not in (None, '') else None
                        if dedupe_key is not None and dedupe_key in seen_return_ids:
                            continue
                        if dedupe_key is not None:
                            seen_return_ids.add(dedupe_key)
                        q = int((item.get('product') or {}).get('quantity') or 0)
                        q = max(0, q)
                        quantity += q
                        row_count += 1
                        kind = str(item.get('type') or 'Unknown')
                        by_type[kind] = by_type.get(kind, 0) + q
                    progress(
                        f'Возвраты/отказы: {row_count} строк · {quantity} шт · '
                        f'{chunk_first.isoformat()}—{chunk_last.isoformat()}'
                    )
                    if not data.get('has_next', False):
                        break
                    if not batch:
                        raise ApiError('Ozon указал следующую страницу возвратов без данных.')
                    nxt = batch[-1].get('id')
                    try:
                        nxt = int(nxt)
                    except (TypeError, ValueError):
                        raise ApiError('Ozon не вернул last_id для возвратов.') from None
                    if nxt in seen_cursors:
                        raise ApiError('Ozon повторил last_id возвратов.')
                    seen_cursors.add(nxt)
                    last_id = nxt
                else:
                    raise ApiError('Слишком много страниц возвратов.')
            return {
                'quantity': quantity,
                'rows': row_count,
                'by_type': by_type,
                'date_filter': date_filter,
            }

        # TrueStats defines redemption by the customer decision. visual_status_change_moment
        # is closer to that event than the later physical logistic-return date.
        try:
            return load('visual_status_change_moment')
        except ApiError as exc:
            progress(f'События решения покупателя недоступны, используем дату логистического возврата: {exc}')
            result = load('logistic_return_date')
            result['fallback_error'] = str(exc)
            return result

    def _download_report_bytes(self, url):
        url = str(url or '').strip()
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or '').lower()
        if parsed.scheme != 'https' or not (host.endswith('.ozon.ru') or host.endswith('.ozone.ru')):
            raise ApiError('Ozon вернул недопустимую ссылку на отчёт размещения.')
        request = urllib.request.Request(url, headers={'User-Agent': 'ISK/0.1'})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                data = response.read(50 * 1024 * 1024 + 1)
        except OSError as exc:
            raise ApiError('Не удалось скачать отчёт о стоимости размещения.') from exc
        if len(data) > 50 * 1024 * 1024:
            raise ApiError('Отчёт о стоимости размещения слишком большой.')
        return data

    def _placement_sum(self, raw):
        target = 'Начисленная стоимость размещения'
        if raw[:2] == b'PK':
            try:
                workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
                for sheet in workbook.worksheets:
                    rows = sheet.iter_rows(values_only=True)
                    index = None
                    for _ in range(30):
                        row = next(rows, None)
                        if row is None:
                            break
                        normalized = [' '.join(str(v or '').split()) for v in row]
                        if target in normalized:
                            index = normalized.index(target)
                            break
                    if index is None:
                        continue
                    total = 0.0
                    for row in rows:
                        if index < len(row):
                            total += self._report_number(row[index])
                    return round(total, 2)
            except Exception as exc:
                raise ApiError('Не удалось прочитать XLSX-отчёт стоимости размещения.') from exc
        else:
            text = None
            for encoding in ('utf-8-sig', 'cp1251'):
                try:
                    text = raw.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
            if text is None:
                raise ApiError('Неизвестная кодировка отчёта стоимости размещения.')
            sample = text[:4096]
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=';,\t')
            except csv.Error:
                dialect = csv.excel
                dialect.delimiter = ';'
            rows = csv.reader(io.StringIO(text), dialect)
            index = None
            for _ in range(30):
                row = next(rows, None)
                if row is None:
                    break
                normalized = [' '.join(str(v or '').split()) for v in row]
                if target in normalized:
                    index = normalized.index(target)
                    break
            if index is not None:
                total = 0.0
                for row in rows:
                    if index < len(row):
                        total += self._report_number(row[index])
                return round(total, 2)
        raise ApiError('В отчёте Ozon нет столбца «Начисленная стоимость размещения».')

    def _placement_cost_report(self, first, last, progress):
        if last < first:
            return 0.0
        created = self.call('/v1/report/placement/by-products/create', {
            'date_from': first.isoformat(), 'date_to': last.isoformat(),
        })
        code = created.get('code') or ''
        if not code:
            raise ApiError('Ozon не вернул идентификатор отчёта стоимости размещения.')
        progress('Формируется отчёт стоимости размещения…')
        for _ in range(45):
            info = self.call('/v1/report/info', {'code': code}).get('result') or {}
            status = info.get('status')
            if status == 'success':
                value = self._placement_sum(self._download_report_bytes(info.get('file')))
                progress(f'Стоимость размещения: {value:.2f} ₽')
                return value
            if status == 'failed':
                raise ApiError('Ozon не смог сформировать отчёт стоимости размещения.')
            self.sleep(1)
        raise ApiError('Ozon слишком долго формирует отчёт стоимости размещения.')

    def _posting_accrual_rows(self, posting_numbers, first, last, progress):
        rows = []
        for offset in range(0, len(posting_numbers), 200):
            chunk = posting_numbers[offset:offset + 200]
            data = self.call('/v1/finance/accrual/postings', {'posting_numbers': chunk})
            groups = data.get('posting_accruals') or []
            if not isinstance(groups, list):
                raise ApiError('Ozon вернул некорректные начисления по отправлениям.')
            for group in groups:
                posting_number = str(group.get('posting_number') or '')
                for accrual in group.get('accruals') or []:
                    accrual_date = str(accrual.get('accrual_date') or '')[:10]
                    try:
                        row_date = date.fromisoformat(accrual_date)
                    except ValueError:
                        continue
                    if first <= row_date <= last:
                        rows.append({
                            'posting_number': posting_number,
                            'accrual_date': accrual_date,
                            'type_id': accrual.get('type_id'),
                            'amount': self._price(accrual.get('accrued')),
                            'quantity': self._price(accrual.get('quantity')),
                            'seller_price': self._price(accrual.get('seller_price')),
                            'sku': accrual.get('sku'),
                        })
            progress(f'Детализация начислений: {min(offset + 200, len(posting_numbers))} / {len(posting_numbers)} отправлений')
        return rows

    def _flatten_fee_rows(self, accruals, include_posting):
        result = []
        for accrual in accruals:
            unit = str(accrual.get('unit_number') or '').strip()
            if not include_posting and POSTING_NUMBER.match(unit):
                continue
            accrual_date = str(accrual.get('date') or '')[:10]

            def append_fee(fee, sku=None):
                if not isinstance(fee, dict) or fee.get('type_id') is None:
                    return
                result.append({
                    'posting_number': unit, 'accrual_date': accrual_date,
                    'type_id': fee.get('type_id'), 'amount': self._price(fee.get('accrued')),
                    'quantity': 0, 'seller_price': 0, 'sku': sku,
                })

            append_fee(accrual.get('non_item_fee'))
            for fee in (accrual.get('container_fees') or {}).get('fees') or []:
                append_fee(fee)
            for item in (accrual.get('item_fees') or {}).get('fees') or []:
                sku = item.get('sku')
                for fee in item.get('fees') or []:
                    append_fee(fee, sku)
            for product in (accrual.get('posting') or {}).get('products') or []:
                sku = product.get('sku')
                for fee in (product.get('delivery') or {}).get('services') or []:
                    append_fee(fee, sku)
        return result

    def _sales_facts(self, accruals):
        totals = {'revenue': 0.0, 'partner_programs': 0.0, 'discount_points': 0.0}
        by_sku = {}
        for accrual in accruals:
            for product in (accrual.get('posting') or {}).get('products') or []:
                commission = product.get('commission') or {}
                revenue = self._price(commission.get('sale_amount'))
                partner = self._price(commission.get('coinvestment'))
                bonus = self._price(commission.get('bonus'))
                totals['revenue'] += revenue
                totals['partner_programs'] += partner
                totals['discount_points'] += bonus
                sku = product.get('sku')
                if sku not in (None, '', 0, '0'):
                    key = str(sku)
                    row = by_sku.setdefault(key, {
                        'sku': key, 'revenue': 0.0,
                        'partner_programs': 0.0, 'discount_points': 0.0,
                    })
                    row['revenue'] += revenue
                    row['partner_programs'] += partner
                    row['discount_points'] += bonus
        totals['products'] = list(by_sku.values())
        return totals

    def finance_transactions(self, date_from, date_to, progress):
        first = self._as_date(date_from)
        requested_last = self._as_date(date_to)
        if requested_last < first:
            raise ApiError('Дата окончания не может быть раньше даты начала.')
        effective_last, current_day_excluded = self._closed_last_day(requested_last)

        type_data = self.call('/v1/finance/accrual/types', {})
        accrual_types = type_data.get('accrual_types') or []
        if not isinstance(accrual_types, list):
            raise ApiError('Ozon вернул некорректный справочник начислений.')

        raw_accruals = []
        posting_numbers = set()
        if effective_last >= first:
            current_day = first
            while current_day <= effective_last:
                last_id = ''
                seen = set()
                for _ in range(1000):
                    data = self.call('/v1/finance/accrual/by-day', {
                        'date': current_day.isoformat(), 'last_id': last_id,
                    })
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
                progress(f'Начисления Ozon: {current_day.isoformat()} · {len(raw_accruals)} блоков')
                current_day += timedelta(days=1)

        posting_rows = (
            self._posting_accrual_rows(sorted(posting_numbers), first, effective_last, progress)
            if posting_numbers and effective_last >= first else []
        )
        accrual_rows = list(posting_rows)
        accrual_rows.extend(self._flatten_fee_rows(raw_accruals, include_posting=False))
        by_day_fee_rows = self._flatten_fee_rows(raw_accruals, include_posting=True)
        sales_facts = self._sales_facts(raw_accruals)
        progress(f'Строк начислений для сверки: {len(accrual_rows)}')

        buyout_products = []
        buyout_error = None
        if effective_last >= first:
            try:
                for chunk_first, chunk_last in self._date_chunks(first, effective_last):
                    data = self.call('/v1/finance/products/buyout', {
                        'date_from': chunk_first.isoformat(), 'date_to': chunk_last.isoformat(),
                    })
                    products = data.get('products') or []
                    if not isinstance(products, list):
                        raise ApiError('Ozon вернул некорректный отчёт по выкупленным товарам.')
                    buyout_products.extend(products)
                    progress(
                        f'Выкупы маркетплейсом: {len(buyout_products)} строк · '
                        f'{chunk_first.isoformat()}—{chunk_last.isoformat()}'
                    )
            except ApiError as exc:
                buyout_error = str(exc)
                progress(f'Выкупы маркетплейсом недоступны: {exc}')

        placement_cost = None
        placement_error = None
        if effective_last >= first:
            try:
                placement_cost = self._placement_cost_report(first, effective_last, progress)
            except ApiError as exc:
                placement_error = str(exc)
                progress(f'Стоимость размещения недоступна: {exc}')
        else:
            placement_cost = 0.0

        returns = None
        returns_error = None
        if effective_last >= first:
            try:
                returns = self._returns_for_period(first, effective_last, progress)
            except ApiError as exc:
                returns_error = str(exc)
                progress(f'Возвраты/отказы недоступны: {exc}')

        orders = self._orders_for_period(first, effective_last, progress)

        return {
            'since': first.isoformat(), 'to': requested_last.isoformat(),
            'effective_to': effective_last.isoformat() if effective_last >= first else None,
            'current_day_excluded': current_day_excluded,
            'accrual_types': accrual_types, 'accrual_rows': accrual_rows,
            'by_day_fee_rows': by_day_fee_rows, 'sales_facts': sales_facts,
            'buyout_products': buyout_products, 'buyout_error': buyout_error,
            'placement_cost': placement_cost, 'placement_error': placement_error,
            'returns': returns, 'returns_error': returns_error,
            'orders': orders,
        }

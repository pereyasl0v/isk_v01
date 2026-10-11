"""Read-only Ozon Seller API adapter."""
from datetime import date, datetime, time as dt_time, timedelta, timezone
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({
    '/v1/analytics/stocks', '/v3/posting/fbo/list', '/v4/posting/fbs/list',
    '/v1/finance/accrual/by-day', '/v1/finance/accrual/types',
    '/v1/finance/products/buyout',
})


class Ozon(BaseOzon):
    def analytics(self, products, stocks, progress):
        skus = sorted({str(p['sku']) for p in products if p.get('sku')} |
                      {str(s['sku']) for s in stocks if s.get('sku')})
        unique = {}
        for offset in range(0, len(skus), 100):
            data = self.call('/v1/analytics/stocks', {'skus':skus[offset:offset+100]})
            for row in data['items']:
                key = (str(row['sku']), str(row['warehouse_id']))
                if key in unique:
                    raise ApiError('Повтор строки аналитики Ozon. Итоги не рассчитаны.')
                unique[key] = row
            progress(f'Аналитика: {min(offset+100,len(skus))} / {len(skus)} SKU')
        if products and not unique:
            raise ApiError('Ozon не вернул строки аналитики для каталога.')
        return list(unique.values())

    def postings(self, days, progress):
        until = datetime.now(timezone.utc)
        since = until - timedelta(days=days)
        cursor, seen, rows = '', set(), {}
        for page in range(10000):
            data = self.call('/v3/posting/fbo/list', {
                'cursor':cursor, 'limit':100, 'sort_dir':'ASC',
                'filter':{'since':since.isoformat(),'to':until.isoformat()},
                'with':{'analytics_data':True,'financial_data':False,'legal_info':False}})
            for posting in data['postings']:
                rows[posting['posting_number']] = {
                    'number':posting['posting_number'], 'status':posting['status'],
                    'created_at':posting['created_at'],
                    'warehouse_id':str((posting.get('analytics_data') or {}).get('warehouse_id') or '') or None,
                    'warehouse_name':(posting.get('analytics_data') or {}).get('warehouse_name') or None,
                    'products':[{'sku':str(p['sku']), 'offer_id':p.get('offer_id',''),
                                 'name':p.get('name',''), 'quantity':int(p['quantity'])}
                                for p in posting['products']]}
            progress(f'История FBO: {len(rows)} отправлений')
            if not data.get('has_next',False):
                return {'since':since.isoformat(),'to':until.isoformat(),'warehouse_attribution':True,'postings':list(rows.values())}
            nxt=data.get('cursor','')
            if not nxt or nxt in seen:
                raise ApiError('Повтор курсора истории. Предыдущие данные сохранены.')
            seen.add(nxt)
            cursor=nxt
        raise ApiError('История слишком велика. Уменьшите период.')

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
            value = value.get('amount')
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    def _orders_for_period(self, first, last, progress):
        """Return FBO+FBS order quantity and amount for the selected creation period."""
        since = datetime.combine(first, dt_time.min, tzinfo=timezone.utc).isoformat()
        until = datetime.combine(last, dt_time.max, tzinfo=timezone.utc).isoformat()
        result = {'amount': 0.0, 'quantity': 0, 'postings': 0, 'fbo': 0, 'fbs': 0, 'errors': []}

        for scheme, path in (('fbo', '/v3/posting/fbo/list'), ('fbs', '/v4/posting/fbs/list')):
            cursor = ''
            seen = set()
            try:
                for _ in range(10000):
                    payload = {
                        'cursor': cursor,
                        'limit': 100,
                        'sort_dir': 'ASC',
                        'filter': {'since': since, 'to': until},
                        'with': {'analytics_data': False, 'financial_data': False, 'legal_info': False},
                    }
                    data = self.call(path, payload)
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
                    progress(f'Заказы {scheme.upper()}: {result[scheme]} отправлений')
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
                # A seller may not use one of the schemes. Keep the other scheme usable,
                # but surface the reason so the UI never presents the total as complete.
                result['errors'].append(f'{scheme.upper()}: {exc}')
                progress(f'Заказы {scheme.upper()} недоступны: {exc}')

        result['amount'] = round(result['amount'], 2)
        return result

    def finance_transactions(self, date_from, date_to, progress):
        """Download the exact Seller API sources used for TrueStats-style reconciliation.

        /v1/finance/accrual/by-day replaces the retired transaction/list method.
        /v1/finance/products/buyout is required for marketplace buyouts (foreign sales).
        FBO/FBS posting lists are used only for the separate orders reconciliation metric.
        """
        first = self._as_date(date_from)
        last = self._as_date(date_to)
        if last < first:
            raise ApiError('Дата окончания не может быть раньше даты начала.')
        if (last - first).days > 30:
            raise ApiError('Финансовый период в одном запросе должен быть не больше 31 дня.')

        type_data = self.call('/v1/finance/accrual/types', {})
        accrual_types = type_data.get('accrual_types') or []
        if not isinstance(accrual_types, list):
            raise ApiError('Ozon вернул некорректный справочник начислений.')

        all_accruals = []
        current_day = first
        while current_day <= last:
            last_id = ''
            seen = set()
            for _ in range(1000):
                data = self.call('/v1/finance/accrual/by-day', {
                    'date': current_day.isoformat(), 'last_id': last_id,
                })
                batch = data.get('accruals') or []
                if not isinstance(batch, list):
                    raise ApiError('Ozon вернул некорректный список начислений.')
                all_accruals.extend(batch)
                nxt = data.get('last_id') or ''
                if not nxt or not batch:
                    break
                if nxt in seen:
                    raise ApiError('Ozon повторил курсор финансовых начислений.')
                seen.add(nxt)
                last_id = nxt
            else:
                raise ApiError('Слишком много страниц финансовых начислений за один день.')
            progress(f'Начисления Ozon: {current_day.isoformat()} · всего {len(all_accruals)}')
            current_day += timedelta(days=1)

        buyout_products = []
        buyout_error = None
        try:
            data = self.call('/v1/finance/products/buyout', {
                'date_from': first.isoformat(), 'date_to': last.isoformat(),
            })
            buyout_products = data.get('products') or []
            if not isinstance(buyout_products, list):
                raise ApiError('Ozon вернул некорректный отчёт по выкупленным товарам.')
            progress(f'Выкупы маркетплейсом: {len(buyout_products)} строк')
        except ApiError as exc:
            buyout_error = str(exc)
            progress(f'Выкупы маркетплейсом недоступны: {exc}')

        orders = self._orders_for_period(first, last, progress)

        return {
            'since': first.isoformat(),
            'to': last.isoformat(),
            'accrual_types': accrual_types,
            'accruals': all_accruals,
            'buyout_products': buyout_products,
            'buyout_error': buyout_error,
            'orders': orders,
        }

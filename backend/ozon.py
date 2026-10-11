"""Read-only contracts from the attached Ozon documentation (2026-10-10)."""
from datetime import datetime, timedelta, timezone
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({'/v1/analytics/stocks', '/v3/posting/fbo/list', '/v3/finance/transaction/list'})

class Ozon(BaseOzon):
    def analytics(self, products, stocks, progress):
        skus = sorted({str(p['sku']) for p in products if p.get('sku')} |
                      {str(s['sku']) for s in stocks if s.get('sku')})
        unique = {}
        for offset in range(0, len(skus), 100):
            data = self.call('/v1/analytics/stocks', {'skus':skus[offset:offset+100]})
            for row in data['items']:
                # No global ADS summation: the same SKU's ADS repeats across warehouses.
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
                # Store only operational fields; no buyer data or whole response dump.
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

    def finance_transactions(self, days, progress):
        """Download finance transactions for a short accounting window.

        Ozon limits the date range of this method, so the UI intentionally caps it
        at 31 days. Raw responses are reduced to fields needed for analytics.
        """
        if days < 1 or days > 31:
            raise ApiError('Финансовый период должен быть от 1 до 31 дня.')
        until = datetime.now(timezone.utc)
        since = until - timedelta(days=days)
        operations = []
        page = 1
        page_count = 1
        while page <= page_count:
            data = self.call('/v3/finance/transaction/list', {
                'filter': {
                    'date': {'from': since.isoformat(), 'to': until.isoformat()},
                    'operation_type': [],
                    'posting_number': '',
                    'transaction_type': 'all',
                },
                'page': page,
                'page_size': 1000,
            })
            result = data.get('result') or {}
            batch = result.get('operations') or []
            if not isinstance(batch, list):
                raise ApiError('Ozon вернул некорректный список финансовых операций.')
            for row in batch:
                operations.append({
                    'operation_id': row.get('operation_id'),
                    'operation_date': row.get('operation_date'),
                    'operation_type': row.get('operation_type'),
                    'operation_type_name': row.get('operation_type_name'),
                    'amount': row.get('amount'),
                    'accruals_for_sale': row.get('accruals_for_sale'),
                    'sale_commission': row.get('sale_commission'),
                    'posting': row.get('posting') or {},
                    'items': [
                        {'name': item.get('name',''), 'sku': item.get('sku')}
                        for item in (row.get('items') or [])
                    ],
                    'services': [
                        {'name': service.get('name',''), 'price': service.get('price')}
                        for service in (row.get('services') or [])
                    ],
                })
            page_count = int(result.get('page_count') or page)
            progress(f'Финансы Ozon: {len(operations)} операций · страница {page} из {page_count}')
            page += 1
            if page > 10000:
                raise ApiError('Слишком много страниц финансовых операций. Уменьшите период.')
        return {'since': since.isoformat(), 'to': until.isoformat(), 'operations': operations}

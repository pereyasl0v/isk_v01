"""Read-only contracts from the attached Ozon documentation (2026-10-10)."""
from datetime import datetime, timedelta, timezone
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({'/v1/analytics/stocks', '/v3/posting/fbo/list'})

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

"""Read-only Ozon Seller API adapter."""
from datetime import datetime, timedelta, timezone
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({
    '/v1/analytics/stocks', '/v3/posting/fbo/list',
    '/v1/finance/accrual/by-day', '/v1/finance/accrual/types',
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

    def finance_transactions(self, days, progress):
        """Download current Ozon finance accruals day-by-day.

        Ozon disabled /v3/finance/transaction/list in September 2026.
        The supported replacement /v1/finance/accrual/by-day accepts one date
        and cursor pagination, so a period is assembled locally.
        """
        if days < 1 or days > 31:
            raise ApiError('Финансовый период должен быть от 1 до 31 дня.')
        type_data = self.call('/v1/finance/accrual/types', {})
        accrual_types = type_data.get('accrual_types') or []
        if not isinstance(accrual_types, list):
            raise ApiError('Ozon вернул некорректный справочник начислений.')

        today = datetime.now(timezone.utc).date()
        first = today - timedelta(days=days-1)
        all_accruals = []
        current_day = first
        while current_day <= today:
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
            progress(f'Финансы Ozon: {current_day.isoformat()} · всего {len(all_accruals)} начислений')
            current_day += timedelta(days=1)

        return {
            'since': first.isoformat(), 'to': today.isoformat(),
            'accrual_types': accrual_types, 'accruals': all_accruals,
        }

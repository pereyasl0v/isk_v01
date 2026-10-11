"""Read-only Ozon Seller API adapter."""
import csv
import io
import urllib.parse
import urllib.request
from datetime import date, datetime, time as dt_time, timedelta, timezone
from openpyxl import load_workbook
from .legacy import Ozon as BaseOzon, ApiError, ALLOWED

ALLOWED.update({
    '/v1/analytics/stocks', '/v3/posting/fbo/list', '/v4/posting/fbs/list',
    '/v1/finance/accrual/by-day', '/v1/finance/accrual/types',
    '/v1/finance/products/buyout',
    '/v1/report/placement/by-products/create', '/v1/report/info',
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
                result['errors'].append(f'{scheme.upper()}: {exc}')
                progress(f'Заказы {scheme.upper()} недоступны: {exc}')

        result['amount'] = round(result['amount'], 2)
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
                    header = None
                    index = None
                    for _ in range(30):
                        row = next(rows, None)
                        if row is None:
                            break
                        normalized = [' '.join(str(v or '').split()) for v in row]
                        if target in normalized:
                            header = normalized
                            index = normalized.index(target)
                            break
                    if header is None:
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
                file_url = info.get('file')
                raw = self._download_report_bytes(file_url)
                value = self._placement_sum(raw)
                progress(f'Стоимость размещения: {value:.2f} ₽')
                return value
            if status == 'failed':
                raise ApiError('Ozon не смог сформировать отчёт стоимости размещения.')
            self.sleep(1)
        raise ApiError('Ozon слишком долго формирует отчёт стоимости размещения.')

    def finance_transactions(self, date_from, date_to, progress):
        """Download Seller API sources required by the public TrueStats reconciliation."""
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

        placement_cost = None
        placement_error = None
        try:
            placement_cost = self._placement_cost_report(first, last, progress)
        except ApiError as exc:
            placement_error = str(exc)
            progress(f'Стоимость размещения недоступна: {exc}')

        orders = self._orders_for_period(first, last, progress)

        return {
            'since': first.isoformat(),
            'to': last.isoformat(),
            'accrual_types': accrual_types,
            'accruals': all_accruals,
            'buyout_products': buyout_products,
            'buyout_error': buyout_error,
            'placement_cost': placement_cost,
            'placement_error': placement_error,
            'orders': orders,
        }

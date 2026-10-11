"""Read-only Ozon adapter. Contract: user-provided Seller API body, 2026-10-10."""
import json
import time
import urllib.request
import urllib.error

BASE = 'https://api-seller.ozon.ru'
ALLOWED = {'/v1/roles', '/v3/product/list', '/v3/product/info/list',
           '/v1/product/info/stocks-by-warehouse/fbo'}

class ApiError(Exception):
    pass

class Ozon:
    def __init__(self, client_id, api_key, transport=None, sleep=time.sleep):
        self.client_id = client_id.strip()
        self.api_key = api_key.strip()
        if not self.client_id.isdigit() or not self.api_key:
            raise ApiError('Укажите числовой Client ID и непустой API Key.')
        if '\n' in self.api_key or '\r' in self.api_key:
            raise ApiError('API Key должен быть одной строкой.')
        self.transport = transport
        self.sleep = sleep

    def call(self, path, payload):
        if path not in ALLOWED:
            raise ApiError('Операция не разрешена модулем чтения.')
        if self.transport:
            return self.transport(path, payload)
        request = urllib.request.Request(BASE + path,
            data=json.dumps(payload).encode(), method='POST', headers={
                'Client-Id': self.client_id, 'Api-Key': self.api_key,
                'Content-Type': 'application/json'})
        # Reject redirects: credentials may only reach the fixed API host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(NoRedirect())
        for attempt in range(4):
            try:
                self.sleep(.12)
                with opener.open(request, timeout=40) as response:
                    result = json.load(response)
                if not isinstance(result, dict):
                    raise ApiError('Неожиданный формат ответа Ozon.')
                return result
            except urllib.error.HTTPError as exc:
                code = exc.code
                if code in (429, 500, 502, 503, 504) and attempt < 3:
                    try:
                        delay = max(1, float(exc.headers.get('Retry-After', 2 ** attempt)))
                    except (ValueError, TypeError):
                        delay = 2 ** attempt
                    if delay > 60:
                        raise ApiError('Ozon запросил долгую паузу. Повторите позднее.') from None
                    self.sleep(delay)
                    continue
                hints = {400:'Проверьте параметры запроса и актуальность схемы API.',
                         401:'Проверьте Client ID и ключ.',
                         403:'Проверьте права, срок ключа и доступ кабинета.',
                         429:'Лимит запросов. Повторите позднее.'}
                raise ApiError(f'Ozon HTTP {code}. ' + hints.get(code, 'Запрос не выполнен.')) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise ApiError('Нет ответа Ozon. Проверьте интернет и повторите.') from None
            except (ValueError, UnicodeError):
                raise ApiError('Ozon вернул некорректный JSON.') from None

    def roles(self):
        return self.call('/v1/roles', {})

    def download(self, progress=lambda text: None):
        cursor = ''
        seen = set()
        products = {}
        while True:
            data = self.call('/v3/product/list', {
                'filter': {'visibility':'ALL'}, 'last_id':cursor, 'limit':1000})['result']
            rows = data['items']
            for row in rows:
                products[str(row['product_id'])] = row
            progress(f'Каталог: {len(products)} товаров')
            if not rows:
                break
            nxt = data.get('last_id', '')
            if not nxt:
                break
            if nxt in seen:
                raise ApiError('Ozon повторил курсор каталога. Загрузка отменена.')
            seen.add(nxt)
            cursor = nxt
        ids = list(products)
        detailed = {}
        for offset in range(0, len(ids), 1000):
            data = self.call('/v3/product/info/list', {'product_id':ids[offset:offset+1000]})
            for row in data['items']:
                pid = str(row['id']) if 'id' in row else str(row['product_id'])
                detailed[pid] = row
            progress(f'Карточки: {len(detailed)}')
        if set(detailed) != set(products):
            raise ApiError('Ответ с карточками неполный. Предыдущая база сохранена.')
        stocks = {}
        offers = [str(row['offer_id']) for row in products.values()]
        for offset in range(0, len(offers), 1000):
            cursor = ''
            seen = set()
            while True:
                data = self.call('/v1/product/info/stocks-by-warehouse/fbo', {
                    'offer_ids':offers[offset:offset+1000], 'limit':1000, 'cursor':cursor})
                for row in data['products']:
                    key = (str(row['sku']), str(row['warehouse_id']))
                    stocks[key] = row
                progress(f'Остатки: {len(stocks)} строк по складам')
                if not data.get('has_next', False):
                    break
                nxt = data.get('cursor', '')
                if not nxt or nxt in seen:
                    raise ApiError('Некорректный курсор остатков. Загрузка отменена.')
                seen.add(nxt)
                cursor = nxt
        return list(detailed.values()), list(stocks.values())

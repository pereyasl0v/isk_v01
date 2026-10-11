"""Read-only Ozon adapter. Contract: user-provided Seller API body, 2026-10-10."""
import json
import os
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = 'https://api-seller.ozon.ru'
ALLOWED = {'/v1/roles', '/v3/product/list', '/v3/product/info/list',
           '/v1/product/info/stocks-by-warehouse/fbo'}

# These responses are safe/useful to reuse during one connected session.
# In particular, placement report creation has a strict Ozon limit (5/day),
# so the same period must reuse the already-created report code.
SESSION_CACHE_PATHS = {
    '/v1/finance/accrual/types',
    '/v1/report/placement/by-products/create',
}
PLACEMENT_CREATE_PATH = '/v1/report/placement/by-products/create'
PLACEMENT_CACHE_TTL = 12 * 3600

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
        self._response_cache = {}
        self._response_cache_at = {}
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0
        data_dir = Path(os.environ.get(
            'OZON_FBO_DATA_DIR',
            str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'VKR_Ozon_FBO_Web')
        ))
        self._placement_cache_file = data_dir / 'ozon_report_cache.json'
        self._load_placement_cache()

    @staticmethod
    def _cache_key(path, payload):
        if path not in SESSION_CACHE_PATHS:
            return None
        return path + ':' + json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

    def _load_placement_cache(self):
        try:
            raw = json.loads(self._placement_cache_file.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            return
        now = time.time()
        for key, record in (raw or {}).items():
            if not key.startswith(PLACEMENT_CREATE_PATH + ':') or not isinstance(record, dict):
                continue
            saved_at = record.get('at')
            result = record.get('result')
            try:
                fresh = now - float(saved_at) <= PLACEMENT_CACHE_TTL
            except (TypeError, ValueError):
                fresh = False
            if fresh and isinstance(result, dict) and result.get('code'):
                # Scope cache to the current Client ID so report codes from
                # another cabinet can never be reused accidentally.
                client_prefix = f'client={self.client_id}|'
                if key.startswith(client_prefix + PLACEMENT_CREATE_PATH + ':'):
                    self._response_cache[key[len(client_prefix):]] = result
                    self._response_cache_at[key[len(client_prefix):]] = float(saved_at)

    def _save_placement_cache(self):
        try:
            self._placement_cache_file.parent.mkdir(parents=True, exist_ok=True)
            existing = {}
            try:
                existing = json.loads(self._placement_cache_file.read_text(encoding='utf-8')) or {}
            except (OSError, ValueError, TypeError):
                pass
            now = time.time()
            cleaned = {}
            for key, record in existing.items():
                if not isinstance(record, dict):
                    continue
                try:
                    if now - float(record.get('at')) <= PLACEMENT_CACHE_TTL:
                        cleaned[key] = record
                except (TypeError, ValueError):
                    continue
            for key, result in self._response_cache.items():
                if key.startswith(PLACEMENT_CREATE_PATH + ':') and isinstance(result, dict) and result.get('code'):
                    cleaned[f'client={self.client_id}|{key}'] = {
                        'at': self._response_cache_at.get(key, now),
                        'result': result,
                    }
            temp = self._placement_cache_file.with_suffix('.tmp')
            temp.write_text(json.dumps(cleaned, ensure_ascii=False), encoding='utf-8')
            temp.replace(self._placement_cache_file)
        except OSError:
            # Cache failure must never break Seller API reads.
            pass

    def _remember(self, cache_key, result):
        if cache_key is not None:
            self._response_cache[cache_key] = result
            self._response_cache_at[cache_key] = time.time()
            if cache_key.startswith(PLACEMENT_CREATE_PATH + ':'):
                self._save_placement_cache()
        return result

    def _throttle(self):
        # The global Ozon limit may be higher, but individual methods can have
        # stricter limits. A small per-session gap prevents bursts when a sync
        # chains many finance/report requests one after another.
        with self._rate_lock:
            now = time.monotonic()
            wait = 0.25 - (now - self._last_request_at)
            if wait > 0:
                self.sleep(wait)
            self._last_request_at = time.monotonic()

    def call(self, path, payload):
        if path not in ALLOWED:
            raise ApiError('Операция не разрешена модулем чтения.')

        cache_key = self._cache_key(path, payload)
        if cache_key is not None and cache_key in self._response_cache:
            return self._response_cache[cache_key]

        if self.transport:
            result = self.transport(path, payload)
            if not isinstance(result, dict):
                raise ApiError('Неожиданный формат ответа Ozon.')
            return self._remember(cache_key, result)

        request = urllib.request.Request(BASE + path,
            data=json.dumps(payload).encode(), method='POST', headers={
                'Client-Id': self.client_id, 'Api-Key': self.api_key,
                'Content-Type': 'application/json'})

        # Reject redirects: credentials may only reach the fixed API host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        opener = urllib.request.build_opener(NoRedirect())
        for attempt in range(6):
            try:
                self._throttle()
                with opener.open(request, timeout=40) as response:
                    result = json.load(response)
                    remaining = response.headers.get('Ratelimit-Remaining')
                if not isinstance(result, dict):
                    raise ApiError('Неожиданный формат ответа Ozon.')
                # If Ozon says this method's bucket is exhausted, do not fire
                # the next request immediately even though this one succeeded.
                if remaining is not None:
                    try:
                        if int(remaining) <= 0:
                            self.sleep(1)
                    except (TypeError, ValueError):
                        pass
                return self._remember(cache_key, result)
            except urllib.error.HTTPError as exc:
                code = exc.code
                if code in (429, 500, 502, 503, 504) and attempt < 5:
                    try:
                        header = exc.headers.get('Retry-After')
                        delay = float(header) if header is not None else float(2 ** attempt)
                        delay = max(1.0, delay)
                    except (ValueError, TypeError):
                        delay = float(2 ** attempt)

                    # Long Retry-After usually means a method-specific quota,
                    # not a short burst. Do not freeze the local app for hours.
                    if delay > 120:
                        if path == PLACEMENT_CREATE_PATH:
                            raise ApiError(
                                'Ozon исчерпал лимит отчётов стоимости размещения '
                                '(не больше 5 созданий в день). Уже созданный отчёт '
                                'для того же периода ИСК переиспользует автоматически.'
                            ) from None
                        raise ApiError(
                            f'Ozon временно ограничил метод {path}. '
                            f'Повторите примерно через {int(delay)} сек.'
                        ) from None
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

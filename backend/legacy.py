"""Read-only Ozon adapter. Contract: user-provided Seller API body, 2026-10-10."""
import hashlib
import json
import math
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
import os
import threading
import time
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta, timezone
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

# Persistent cache is deliberately limited to historical/reporting methods.
# Live stock/catalog methods are never read from this cache.
PERSISTENT_CACHE_TTLS = {
    '/v1/finance/accrual/types': 7 * 86400,
    '/v1/finance/accrual/postings': 12 * 3600,
    '/v1/finance/products/buyout': 12 * 3600,
    '/v1/returns/list': 12 * 3600,
    # Ozon limits this endpoint to one request per minute; a 30-minute
    # persistent cache also stays below the 50/day free-plan quota.
    '/v1/analytics/data': 30 * 60,
    PLACEMENT_CREATE_PATH: PLACEMENT_CACHE_TTL,
}
MOSCOW_TZ = timezone(timedelta(hours=3))
_ANALYTICS_RATE_LOCK = threading.Lock()
_ANALYTICS_RATE_LOCKS = {}
_ANALYTICS_LAST_REQUEST = {}


class ApiError(Exception):
    pass


class Ozon:
    def __init__(self, client_id, api_key, transport=None, sleep=time.sleep,
                 cache_get=None, cache_put=None):
        self.client_id = client_id.strip()
        self.api_key = api_key.strip()
        if not self.client_id.isdigit() or not self.api_key:
            raise ApiError('Укажите числовой Client ID и непустой API Key.')
        if '\n' in self.api_key or '\r' in self.api_key:
            raise ApiError('API Key должен быть одной строкой.')
        self.transport = transport
        self.sleep = sleep
        self.cache_get = cache_get
        self.cache_put = cache_put
        self._response_cache = {}
        self._response_cache_at = {}
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0
        # Per-worker context: a paused digitization never changes other API jobs.
        self._rate_limit_recovery = threading.local()
        self._persistent_cache_hits = 0
        self._api_requests = 0
        data_dir = Path(os.environ.get(
            'OZON_FBO_DATA_DIR',
            str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'VKR_Ozon_FBO_Web')
        ))
        self._placement_cache_file = data_dir / 'ozon_report_cache.json'
        self._load_placement_cache()

    @staticmethod
    def _canonical_payload(payload):
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

    @classmethod
    def _cache_key(cls, path, payload):
        if path not in SESSION_CACHE_PATHS:
            return None
        return path + ':' + cls._canonical_payload(payload)

    @classmethod
    def _persistent_cache_key(cls, path, payload):
        if path != '/v1/finance/accrual/by-day' and path not in PERSISTENT_CACHE_TTLS:
            return None
        raw=(path + ':' + cls._canonical_payload(payload)).encode('utf-8')
        return path + ':' + hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _persistent_cache_ttl(path, payload):
        # Finance-by-day is the biggest source of repeated calls. A closed day
        # is reusable, but recent days receive a shorter TTL because Ozon may
        # still post corrections after the calendar day has ended.
        if path == '/v1/finance/accrual/by-day':
            try:
                requested=date.fromisoformat(str(payload.get('date') or ''))
            except ValueError:
                return None
            age=(datetime.now(MOSCOW_TZ).date()-requested).days
            if age <= 0:
                return None
            if age == 1:
                return 2 * 3600
            if age <= 7:
                return 12 * 3600
            return 30 * 86400
        return PERSISTENT_CACHE_TTLS.get(path)

    def cache_counters(self):
        return {'hits':self._persistent_cache_hits,'api_requests':self._api_requests}

    def _load_placement_cache(self):
        try:
            raw = json.loads(self._placement_cache_file.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            return
        now = time.time()
        client_prefix = f'client={self.client_id}|'
        for key, record in (raw or {}).items():
            if not key.startswith(client_prefix + PLACEMENT_CREATE_PATH + ':') or not isinstance(record, dict):
                continue
            saved_at = record.get('at')
            result = record.get('result')
            try:
                fresh = now - float(saved_at) <= PLACEMENT_CACHE_TTL
            except (TypeError, ValueError):
                fresh = False
            if fresh and isinstance(result, dict) and result.get('code'):
                inner_key = key[len(client_prefix):]
                self._response_cache[inner_key] = result
                self._response_cache_at[inner_key] = float(saved_at)

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

    def _read_persistent_cache(self, path, payload):
        key=self._persistent_cache_key(path,payload)
        ttl=self._persistent_cache_ttl(path,payload)
        if key is None or ttl is None or self.cache_get is None:
            return None, key
        try:
            result=self.cache_get('ozon_api',key,ttl)
        except Exception:
            result=None
        if isinstance(result,dict):
            self._persistent_cache_hits += 1
            return result,key
        return None,key

    def _remember(self, session_key, persistent_key, result):
        if session_key is not None:
            self._response_cache[session_key] = result
            self._response_cache_at[session_key] = time.time()
            if session_key.startswith(PLACEMENT_CREATE_PATH + ':'):
                self._save_placement_cache()
        if persistent_key is not None and self.cache_put is not None:
            try:
                self.cache_put('ozon_api',persistent_key,result)
            except Exception:
                # SQL cache must never turn a successful Ozon response into a failure.
                pass
        return result

    def _throttle(self, path=None):
        # /v1/analytics/data is limited to one request per minute per seller.
        # Coordinate across Ozon instances so reconnects do not bypass it.
        if path == '/v1/analytics/data':
            with _ANALYTICS_RATE_LOCK:
                client_lock = _ANALYTICS_RATE_LOCKS.setdefault(
                    self.client_id, threading.Lock()
                )
            with client_lock:
                now = time.monotonic()
                wait = 60.0 - (now - _ANALYTICS_LAST_REQUEST.get(self.client_id, 0.0))
                if wait > 0:
                    self.sleep(wait)
                _ANALYTICS_LAST_REQUEST[self.client_id] = time.monotonic()
            return
        # A small per-session gap prevents bursts when a sync chains many
        # ordinary finance/report requests one after another.
        with self._rate_lock:
            now = time.monotonic()
            wait = 0.25 - (now - self._last_request_at)
            if wait > 0:
                self.sleep(wait)
            self._last_request_at = time.monotonic()

    @contextmanager
    def auto_retry_429(self, progress, on_wait=None, on_resume=None):
        """Keep digitization active and optionally publish retry timing.

        Recovery callbacks are scoped to the current worker thread so another
        account job cannot change this worker's on-screen waiting state.
        """
        old = getattr(self._rate_limit_recovery, 'callbacks', None)
        self._rate_limit_recovery.callbacks = (progress, on_wait, on_resume)
        try:
            yield
        finally:
            self._rate_limit_recovery.callbacks = old

    @staticmethod
    def _retry_after_seconds(value):
        if value is None:
            return None
        try:
            seconds = float(value)
            return seconds if math.isfinite(seconds) and seconds >= 0 else None
        except (ValueError, TypeError, OverflowError):
            try:
                moment = parsedate_to_datetime(value)
                if moment.tzinfo is None:
                    return None
                return max(0.0, (moment - datetime.now(timezone.utc)).total_seconds())
            except (ValueError, TypeError, OverflowError):
                return None

    def _wait_for_429(self, path, retry_after=None):
        callbacks = getattr(self._rate_limit_recovery, 'callbacks', None)
        if callbacks is None:
            return False
        progress, on_wait, on_resume = callbacks
        suggested = self._retry_after_seconds(retry_after)
        delay = max(60.0, suggested if suggested is not None else 60.0)
        if on_wait:
            on_wait(delay)
        progress(
            'Ozon временно ограничил частоту запросов. '
            'Загрузка продолжится автоматически — повторно выбирать период не нужно.'
        )
        try:
            self.sleep(delay)
        finally:
            if on_resume:
                on_resume()
        progress('Ограничение Ozon снято, продолжаем загрузку выбранного периода…')
        return True

    def call(self, path, payload):
        if path not in ALLOWED:
            raise ApiError('Операция не разрешена модулем чтения.')

        session_key = self._cache_key(path, payload)
        if session_key is not None and session_key in self._response_cache:
            return self._response_cache[session_key]

        cached,persistent_key=self._read_persistent_cache(path,payload)
        if cached is not None:
            if session_key is not None:
                self._response_cache[session_key]=cached
                self._response_cache_at[session_key]=time.time()
            return cached

        if self.transport:
            # Test/custom transports use the same recovery semantics as HTTP.
            while True:
                self._api_requests += 1
                try:
                    result = self.transport(path, payload)
                except urllib.error.HTTPError as exc:
                    if exc.code == 429 and self._wait_for_429(
                        path, exc.headers.get('Retry-After') if exc.headers else None
                    ):
                        continue
                    raise
                except ApiError as exc:
                    if str(exc).startswith('Ozon HTTP 429') and self._wait_for_429(path):
                        continue
                    raise
                if not isinstance(result, dict):
                    raise ApiError('Неожиданный формат ответа Ozon.')
                return self._remember(session_key, persistent_key, result)

        request = urllib.request.Request(BASE + path,
            data=json.dumps(payload).encode(), method='POST', headers={
                'Client-Id': self.client_id, 'Api-Key': self.api_key,
                'Content-Type': 'application/json'})

        # Reject redirects: credentials may only reach the fixed API host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        opener = urllib.request.build_opener(NoRedirect())
        attempt = 0
        while True:
            try:
                self._throttle(path)
                self._api_requests += 1
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
                return self._remember(session_key, persistent_key, result)
            except urllib.error.HTTPError as exc:
                code = exc.code
                header = exc.headers.get('Retry-After') if exc.headers else None
                if code == 429 and self._wait_for_429(path, header):
                    # Stay on the same HTTP request, page/cursor and day.
                    # No extra work is requested from the user.
                    continue
                if code in (429, 500, 502, 503, 504) and attempt < 5:
                    suggested = self._retry_after_seconds(header)
                    delay = max(1.0, suggested if suggested is not None else float(2 ** attempt))

                    # Long Retry-After usually means a method-specific quota,
                    # not a short burst. Do not freeze other jobs for hours.
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
                    attempt += 1
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

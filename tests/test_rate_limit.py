import os
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from backend.legacy import Ozon, ALLOWED, ApiError


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        ALLOWED.add('/v1/report/placement/by-products/create')
        ALLOWED.add('/v1/finance/accrual/by-day')
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'OZON_FBO_DATA_DIR': self.temp.name})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_reuses_same_placement_report_creation(self):
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            return {'code': 'REPORT-1'}

        api = Ozon('123', 'secret', transport=transport)
        payload = {'date_from': '2026-09-30', 'date_to': '2026-10-10'}
        first = api.call('/v1/report/placement/by-products/create', payload)
        second = api.call('/v1/report/placement/by-products/create', payload)

        self.assertEqual(first, {'code': 'REPORT-1'})
        self.assertEqual(second, first)
        self.assertEqual(len(calls), 1)

    def test_reuses_report_creation_after_restart(self):
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            return {'code': 'REPORT-PERSISTED'}

        payload = {'date_from': '2026-09-30', 'date_to': '2026-10-10'}
        first_api = Ozon('123', 'secret', transport=transport)
        self.assertEqual(
            first_api.call('/v1/report/placement/by-products/create', payload)['code'],
            'REPORT-PERSISTED',
        )

        second_api = Ozon('123', 'secret', transport=transport)
        self.assertEqual(
            second_api.call('/v1/report/placement/by-products/create', payload)['code'],
            'REPORT-PERSISTED',
        )
        self.assertEqual(len(calls), 1)

    def test_different_report_periods_are_not_mixed(self):
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            return {'code': f'REPORT-{len(calls)}'}

        api = Ozon('123', 'secret', transport=transport)
        first = api.call('/v1/report/placement/by-products/create', {
            'date_from': '2026-09-30', 'date_to': '2026-10-10',
        })
        second = api.call('/v1/report/placement/by-products/create', {
            'date_from': '2026-10-01', 'date_to': '2026-10-10',
        })

        self.assertNotEqual(first['code'], second['code'])
        self.assertEqual(len(calls), 2)


    def test_digitization_429_waits_one_minute_then_resumes_same_request(self):
        attempts = []
        sleeps = []
        messages = []
        payload = {'date':'2026-11-24','last_id':'cursor-17'}
        def transport(path, body):
            attempts.append((path, body.copy()))
            if len(attempts) < 3:
                raise ApiError('Ozon HTTP 429. Лимит запросов. Повторите позднее.')
            return {'accruals':[{'id':'success'}]}

        api = Ozon('123','secret',transport=transport,sleep=sleeps.append)
        waiting = []
        resumed = []
        with api.auto_retry_429(messages.append, on_wait=waiting.append, on_resume=lambda:resumed.append(True)):
            result = api.call('/v1/finance/accrual/by-day', payload)
        self.assertEqual(result, {'accruals':[{'id':'success'}]})
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(item == ('/v1/finance/accrual/by-day',payload) for item in attempts))
        self.assertEqual(sleeps, [60.0, 60.0])
        self.assertTrue(any('Ozon временно ограничил частоту запросов' in text for text in messages))
        self.assertTrue(any('Загрузка продолжится автоматически' in text for text in messages))
        self.assertTrue(all('429' not in text for text in messages))
        self.assertEqual(waiting, [60.0, 60.0])
        self.assertEqual(resumed, [True, True])
        self.assertEqual(api.cache_counters()['api_requests'],3)
        self.assertIsNone(api._rate_limit_recovery.callbacks)

    def test_digitization_429_respects_longer_retry_after_from_ozon(self):
        sleeps = []
        messages = []
        calls = []
        def transport(path, body):
            calls.append(body.copy())
            if len(calls) == 1:
                raise urllib.error.HTTPError(
                    'https://api-seller.ozon.ru'+path,429,'Too Many Requests',
                    {'Retry-After':'125'},None
                )
            return {'accruals':[]}
        api = Ozon('123','secret',transport=transport,sleep=sleeps.append)
        with api.auto_retry_429(messages.append):
            result = api.call('/v1/finance/accrual/by-day',{'date':'2026-11-24'})
        self.assertEqual(result, {'accruals':[]})
        self.assertEqual(sleeps,[125.0])
        self.assertEqual(len(calls),2)
        self.assertTrue(any('125 сек.' in text for text in messages))

    def test_digitization_429_works_on_real_http_error_path(self):
        sleeps = []
        messages = []
        attempts = []
        class Success:
            headers = {}
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,*args): return b'{"accruals":[]}'
        class Opener:
            def open(self,request,timeout):
                attempts.append(request.full_url)
                if len(attempts) == 1:
                    raise urllib.error.HTTPError(request.full_url,429,'Too Many Requests',{},None)
                return Success()
        api = Ozon('123','secret',sleep=sleeps.append)
        with patch('urllib.request.build_opener',return_value=Opener()):
            with api.auto_retry_429(messages.append):
                result = api.call('/v1/finance/accrual/by-day',{'date':'2026-11-24'})
        self.assertEqual(result,{'accruals':[]})
        self.assertEqual(len(attempts),2)
        self.assertIn(60.0,sleeps)

    def test_other_errors_are_not_retried_and_recovery_is_scoped(self):
        sleeps = []
        def forbidden(path, body):
            raise ApiError('Ozon HTTP 403. Проверьте права.')
        api = Ozon('123','secret',transport=forbidden,sleep=sleeps.append)
        with api.auto_retry_429(lambda _:None):
            with self.assertRaisesRegex(ApiError,'403'):
                api.call('/v1/finance/accrual/by-day',{'date':'2026-11-24'})
        self.assertEqual(sleeps, [])
        self.assertIsNone(api._rate_limit_recovery.callbacks)

        rate_limited = Ozon(
            '123','secret',
            transport=lambda *_: (_ for _ in ()).throw(
                ApiError('Ozon HTTP 429. Лимит запросов. Повторите позднее.')
            ),
            sleep=sleeps.append
        )
        with self.assertRaisesRegex(ApiError,'429'):
            rate_limited.call('/v1/finance/accrual/by-day',{'date':'2026-11-24'})
        self.assertEqual(sleeps, [])


if __name__ == '__main__':
    unittest.main()

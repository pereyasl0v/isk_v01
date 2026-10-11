import tempfile
import unittest
from pathlib import Path

from backend.legacy import Ozon, ALLOWED
from backend.storage import Store


class SqlApiCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.temp.name)/'cache.sqlite3')
        ALLOWED.add('/v1/finance/accrual/by-day')

    def tearDown(self):
        self.temp.cleanup()

    def api(self,client,transport):
        return Ozon(
            client,
            'secret',
            transport=transport,
            cache_get=lambda namespace,key,max_age: self.store.cache_get(client,namespace,key,max_age),
            cache_put=lambda namespace,key,value: self.store.cache_put(client,namespace,key,value),
        )

    def test_closed_finance_day_is_reused_after_new_ozon_instance(self):
        calls=[]

        def transport(path,payload):
            calls.append((path,payload))
            return {'accruals':[{'id':'A'}],'last_id':''}

        payload={'date':'2026-09-30','last_id':''}
        first=self.api('123',transport)
        self.assertEqual(first.call('/v1/finance/accrual/by-day',payload)['accruals'][0]['id'],'A')

        second=self.api('123',transport)
        self.assertEqual(second.call('/v1/finance/accrual/by-day',payload)['accruals'][0]['id'],'A')
        self.assertEqual(len(calls),1)
        self.assertEqual(second.cache_counters()['hits'],1)
        self.assertEqual(second.cache_counters()['api_requests'],0)

    def test_cache_is_isolated_by_client(self):
        calls=[]

        def transport(path,payload):
            calls.append((path,payload))
            return {'accruals':[],'last_id':''}

        payload={'date':'2026-09-30','last_id':''}
        self.api('123',transport).call('/v1/finance/accrual/by-day',payload)
        self.api('456',transport).call('/v1/finance/accrual/by-day',payload)
        self.assertEqual(len(calls),2)

    def test_live_stock_is_not_persistently_cached(self):
        calls=[]

        def transport(path,payload):
            calls.append((path,payload))
            return {'products':[],'has_next':False}

        path='/v1/product/info/stocks-by-warehouse/fbo'
        payload={'offer_ids':['A'],'limit':1000,'cursor':''}
        self.api('123',transport).call(path,payload)
        self.api('123',transport).call(path,payload)
        self.assertEqual(len(calls),2)


if __name__ == '__main__':
    unittest.main()

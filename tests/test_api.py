import os
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
scratch=tempfile.TemporaryDirectory()
os.environ['OZON_FBO_DATA_DIR']=scratch.name
from fastapi.testclient import TestClient
from backend import main
from backend.storage import Store
from backend.ozon import ApiError

HEAD={'Origin':'http://127.0.0.1:8000','X-Local-App':'fbo'}
class FakeOzon:
    def __init__(self,c,k):self.client_id=c
    def roles(self):return {'roles':[{'name':'Read only'}],'expires_at':'2027-01-01T00:00:00Z'}
    def download(self,progress):
        return ([{'id':1,'sku':100,'offer_id':'A','name':'Товар'}],
                [{'product_id':1,'sku':100,'offer_id':'A','warehouse_id':1,'present':12,'reserved':2}])
    def analytics(self,p,s,progress):
        return [{'sku':100,'warehouse_id':1,'offer_id':'A','name':'Товар',
          'available_stock_count':10,'valid_stock_count':0,'transit_stock_count':0,
          'requested_stock_count':0,'ads':1}]

class ApiTests(unittest.TestCase):
    def setUp(self):
        main.sessions.clear()
        self.tmp=tempfile.TemporaryDirectory()
        main.store=Store(Path(self.tmp.name)/'db.sqlite')
        self.client=TestClient(main.app)
        self.mock=patch.object(main,'Ozon',FakeOzon);self.mock.start()
    def tearDown(self):
        self.mock.stop();self.client.close();self.tmp.cleanup()
    def login(self,c='123'):
        r=self.client.post('/api/connect',headers=HEAD,json={'client_id':c,'api_key':'secret-test'})
        self.assertEqual(r.status_code,200)
        self.assertNotIn('secret-test',r.text)
    def wait(self):
        for _ in range(100):
            r=self.client.get('/api/state').json()
            if not r['job']['running']:return r
            time.sleep(.01)
        self.fail('Background job did not finish')
    def test_missing_session_and_csrf(self):
        self.assertEqual(self.client.get('/api/inventory').status_code,401)
        self.assertEqual(self.client.post('/api/connect',json={'client_id':'123','api_key':'secret'}).status_code,403)
    def test_validation_does_not_echo_secret(self):
        r=self.client.post('/api/connect',headers=HEAD,json={'client_id':'abc','api_key':'never-echo-this'})
        self.assertEqual(r.status_code,422);self.assertNotIn('never-echo-this',r.text)
    def test_sync_summary_plan_and_separation(self):
        self.login()
        self.assertEqual(self.client.post('/api/sync',headers=HEAD,json={}).status_code,200)
        self.assertIsNone(self.wait()['job']['error'])
        data=self.client.get('/api/inventory').json()
        self.assertEqual(data['summary']['available'],10)
        self.assertEqual(self.client.post('/api/replenishment',headers=HEAD,json={'window':14}).status_code,409)
        self.login('456')
        self.assertIsNone(self.client.get('/api/inventory').json()['at'])
    def test_analytics_failure_is_unknown(self):
        self.login()
        with patch.object(FakeOzon,'analytics',side_effect=ApiError('Denied')):
            self.client.post('/api/sync',headers=HEAD,json={});self.wait()
        d=self.client.get('/api/inventory').json()
        self.assertIsNone(d['summary']['available']);self.assertTrue(d['warning'])
        self.assertEqual(d['summary']['warehouse_rows'],1)
    def test_disconnect_and_invalid_plan(self):
        self.login()
        self.assertEqual(self.client.post('/api/replenishment',headers=HEAD,json={'window':'bad'}).status_code,422)
        self.client.post('/api/disconnect',headers=HEAD,json={})
        self.assertEqual(self.client.get('/api/state').status_code,401)
    def test_replenishment_endpoint(self):
        self.login()
        self.client.post('/api/sync',headers=HEAD,json={});self.wait()
        main.store.save('123','history',{'since':'2020-01-01T00:00:00+03:00',
            'to':'2030-01-01T00:00:00+03:00','warehouse_attribution':True,'postings':[]})
        r=self.client.post('/api/replenishment',headers=HEAD,json={'window':14})
        self.assertEqual(r.status_code,200)
        self.assertEqual(r.json()['items'][0]['total']['state'],'no_orders')
        self.assertEqual(self.client.post('/api/replenishment',headers=HEAD,json={'window':28}).status_code,422)

    def test_spa_routes(self):
        for route in ['/','/stocks','/connection','/history']:
            r=self.client.get(route)
            self.assertEqual(r.status_code,200)
            self.assertIn('<div id="root">',r.text)
        self.assertEqual(self.client.get('/api/missing').status_code,404)

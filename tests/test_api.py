import base64
import json
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

scratch=tempfile.TemporaryDirectory()
os.environ['OZON_FBO_DATA_DIR']=scratch.name
os.environ['ISK_ENCRYPTION_KEY']=base64.urlsafe_b64encode(b'isk-test-key-32-bytes-0123456789').decode('ascii')

from fastapi.testclient import TestClient
from backend import main
from backend.storage import Store
from backend.import_legacy import import_legacy_database, LegacyImportError
from backend.security import hash_password, token_digest
from backend.ozon import ApiError

HEAD={'Origin':'http://127.0.0.1:8000'}
ADMIN_PASSWORD='Admin-Password-2026!'


class FakeOzon:
    def __init__(self,c,k,**kwargs):
        self.client_id=c
        self.api_key=k
    def roles(self):
        return {'roles':[{'name':'Read only'}],'expires_at':'2027-01-01T00:00:00Z'}
    def download(self,progress):
        return ([{'id':1,'sku':100,'offer_id':'A','name':'Товар'}],
                [{'product_id':1,'sku':100,'offer_id':'A','warehouse_id':1,'present':12,'reserved':2}])
    def fbs_stocks(self,products,progress):
        return {'quantity':0,'rows':[]}
    def analytics(self,p,s,progress):
        return [{'sku':100,'warehouse_id':1,'offer_id':'A','name':'Товар',
          'available_stock_count':10,'valid_stock_count':0,'transit_stock_count':0,
          'requested_stock_count':0,'ads':1}]
    def postings(self,days,progress):
        return {'since':'2020-01-01T00:00:00+03:00','to':'2030-01-01T00:00:00+03:00',
                'warehouse_attribution':True,'postings':[]}
    def fbo_posting_by_number(self,number):
        return {'number':number,'scheme':'FBO',
                'products':[{'sku':'100','quantity':2,'name':'Товар','offer_id':'A'}]}
    def cache_counters(self):
        return {'hits':0,'api_requests':0}


class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        main.store=Store(Path(self.tmp.name)/'db.sqlite',encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        main.store.create_user('admin',hash_password(ADMIN_PASSWORD),'admin')
        self.client=TestClient(main.app)
        self.mock=patch.object(main,'Ozon',FakeOzon)
        self.mock.start()
        self.login(self.client,'admin',ADMIN_PASSWORD)

    def tearDown(self):
        self.mock.stop()
        self.client.close()
        self.tmp.cleanup()

    def login(self,client,username,password):
        r=client.post('/api/auth/login',headers=HEAD,json={'username':username,'password':password})
        self.assertEqual(r.status_code,200,r.text)
        self.assertNotIn(password,r.text)

    def connect(self,client=None,client_id='123',api_key='ozon-secret-key-123456'):
        client=client or self.client
        r=client.post('/api/connect',headers=HEAD,json={'client_id':client_id,'api_key':api_key})
        self.assertEqual(r.status_code,200,r.text)
        self.assertNotIn(api_key,r.text)
        return r.json()

    def wait(self,client=None):
        client=client or self.client
        for _ in range(100):
            r=client.get('/api/state')
            if r.status_code!=200:
                self.fail(r.text)
            if not r.json()['job']['running']:
                return r.json()
            time.sleep(.01)
        self.fail('Background job did not finish')

    def test_auto_deploy_marker_tracks_background_jobs_and_gate_blocks_new_jobs(self):
        import threading
        self.connect()
        marker=Path(self.tmp.name)/'.isk_active_job'
        gate=Path(self.tmp.name)/'.isk_deploying'
        started=threading.Event()
        done=threading.Event()

        def slow_postings(api,days,progress):
            started.set()
            if not done.wait(timeout=5):
                raise RuntimeError('Test background job never released')
            return {'postings':[], 'sources':{'fbo':{'ok':True},'fbs':{'ok':True}},
                    'errors':[]}
        with patch.object(main,'ACTIVE_JOB_MARKER',marker), \
             patch.object(main,'DEPLOY_GATE',gate), \
             patch.object(FakeOzon,'postings',new=slow_postings):
            gate.touch()
            response=self.client.post('/api/history/sync',headers=HEAD,json={'days':7})
            self.assertEqual(response.status_code,409)
            self.assertFalse(marker.exists())
            gate.unlink()
            try:
                response=self.client.post('/api/history/sync',headers=HEAD,json={'days':7})
                self.assertEqual(response.status_code,200,response.text)
                self.assertTrue(started.wait(timeout=5))
                self.assertTrue(marker.exists())
            finally:
                done.set()
            self.assertIsNone(self.wait()['job']['error'])
            self.assertFalse(marker.exists())

    def test_login_required_and_csrf(self):
        anonymous=TestClient(main.app)
        self.assertEqual(anonymous.get('/api/auth/me').status_code,401)
        self.assertEqual(anonymous.get('/api/inventory').status_code,401)
        self.assertEqual(anonymous.get('/api/wb/search?query=mug').status_code,401)
        self.assertEqual(anonymous.post('/api/auth/login',json={
            'username':'admin','password':ADMIN_PASSWORD
        }).status_code,403)
        self.assertTrue(anonymous.get('/api/auth/status').json()['initialized'])
        anonymous.close()

    def test_signed_ozon_fbo_webhook_requires_valid_token_and_is_idempotent(self):
        self.connect()
        with patch.dict(os.environ,{'ISK_PUBLIC_URL':'https://isk.example.test'}):
            info=self.client.get('/api/ozon/push/info')
        self.assertEqual(info.status_code,200,info.text)
        self.assertTrue(info.json()['available'])
        self.assertEqual(info.json()['event_type'],'TYPE_FBO_POSTING_STATE_CHANGED')
        url=info.json()['url']
        from urllib.parse import urlparse
        path=urlparse(url).path
        event={
            'message_type':'TYPE_FBO_POSTING_STATE_CHANGED',
            'uuid':'stable-event-1',
            'posting_number':'123-456-1',
            'new_state':'posting_delivered',
            'changed_state_date':'2026-11-20T10:15:00Z',
        }
        self.assertEqual(self.client.post(path,json=event).status_code,200)
        self.assertEqual(self.client.post(path,json=event).status_code,200)
        auth=self.client.get('/api/auth/me').json()
        scope='account:'+auth['active_account_id']
        rows=main.store.delivery_events(scope)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['posting_number'],'123-456-1')
        self.assertEqual(rows[0]['products'][0]['quantity'],2)
        self.assertEqual(
            self.client.post(path.rsplit('/',1)[0]+'/invalid',json=event).status_code,403
        )
        missing=dict(event,changed_state_date='missing')
        self.assertEqual(self.client.post(path,json=missing).status_code,422)

    def test_sales_api_uses_saved_financial_days_not_premium_delivery(self):
        self.connect()
        auth=self.client.get('/api/auth/me').json()
        scope='account:'+auth['active_account_id']
        main.store.save(scope,'sales_analytics',{
            'date_from':'2026-11-18','date_to':'2026-11-19',
            'rows':[
                {'date':'2026-11-18','ordered_units':2,'ordered_revenue':200.0},
                {'date':'2026-11-19','ordered_units':3,'ordered_revenue':300.0},
            ],
            'by_sku':[
                {'date':'2026-11-19','sku':'100','ordered_units':3,'ordered_revenue':300.0},
            ],
        })
        main.store.save_digitization_day(scope,'2026-11-19',{'from':'test'})
        financial={
            'metrics':{'sales_quantity':2,'sales_amount':150},
            'products':[{'sku':'100','sales_quantity':2,'sales_amount':150}],
        }
        with patch('backend.sales_finance.summarize_digitization',return_value=financial):
            res=self.client.get('/api/sales')
        self.assertEqual(res.status_code,200,res.text)
        data=res.json()
        self.assertEqual(data['rows'][1]['sold_units'],2)
        self.assertEqual(data['by_sku'][0]['sold_units'],2)
        self.assertIsNone(data['rows'][0]['sold_units'])
        self.assertEqual(data['financial_sales_missing_days'],['2026-11-18'])
        self.assertNotIn('delivered_units',data['rows'][1])

    def test_session_is_persistent_and_30_days(self):
        cookie=self.client.cookies.get('isk_session')
        self.assertTrue(cookie)
        digest=token_digest(cookie)
        with main.store.db() as c:
            row=c.execute('SELECT created_at,expires_at FROM auth_sessions WHERE token_hash=?',(digest,)).fetchone()
        self.assertAlmostEqual(row[1]-row[0],30*24*60*60,delta=2)
        self.connect()
        main.runtime_accounts.clear()  # simulates losing all in-memory Ozon clients on process restart
        state=self.client.get('/api/state')
        self.assertEqual(state.status_code,200,state.text)
        self.assertEqual(state.json()['client_id'],'123')

    def test_api_key_and_analytics_payloads_are_encrypted(self):
        account=self.connect()
        saved=main.store.get_ozon_account(account['account_id'],main.store.get_user_by_username('admin')['id'])
        self.assertTrue(saved['api_key_ciphertext'].startswith('v1:'))
        self.assertNotIn('ozon-secret-key-123456',saved['api_key_ciphertext'])
        scope='account:'+account['account_id']
        main.store.save(scope,'inventory',{'private_metric':123})
        with main.store.db() as c:
            row=c.execute('SELECT payload FROM snapshots WHERE client=? AND kind=?',(scope,'inventory')).fetchone()
        self.assertTrue(row[0].startswith('enc:v1:'))
        self.assertEqual(main.store.latest(scope,'inventory')['private_metric'],123)

    def test_user_data_isolation(self):
        first=self.connect()
        scope1='account:'+first['account_id']
        main.store.save(scope1,'inventory',{'products':[{'name':'user one'}]})
        user=main.store.create_user('seller2',hash_password('Seller-Password-2026!'),'user')
        second_client=TestClient(main.app)
        try:
            self.login(second_client,'seller2','Seller-Password-2026!')
            second=self.connect(second_client,client_id='123',api_key='another-secret-key-123456')
            self.assertNotEqual(first['account_id'],second['account_id'])
            self.assertIsNone(main.store.latest('account:'+second['account_id'],'inventory'))
            self.assertEqual(main.store.latest(scope1,'inventory')['products'][0]['name'],'user one')
            self.assertEqual(second_client.get('/api/admin/users').status_code,403)
        finally:
            second_client.close()

    def test_admin_can_create_users_but_regular_user_cannot(self):
        r=self.client.post('/api/admin/users',headers=HEAD,json={
            'username':'seller3','password':'Seller-Password-2026!'
        })
        self.assertEqual(r.status_code,200,r.text)
        created=TestClient(main.app)
        try:
            self.login(created,'seller3','Seller-Password-2026!')
            self.assertEqual(created.get('/api/admin/users').status_code,403)
            self.assertEqual(created.post('/api/admin/users',headers=HEAD,json={
                'username':'seller4','password':'Seller-Password-2026!'
            }).status_code,403)
        finally:
            created.close()

    def test_legacy_account_records_are_labeled_ozon_in_api(self):
        # A new marketplace selector must never silently reclassify or rewrite
        # existing Ozon IDs, keys, permissions, snapshots or active sessions.
        first=self.connect(client_id='123')
        second=self.connect(client_id='456')
        original_ids={first['account_id'],second['account_id']}
        me=self.client.get('/api/auth/me')
        self.assertEqual(me.status_code,200,me.text)
        self.assertEqual(me.json()['active_account_id'],second['account_id'])
        accounts=me.json()['accounts']
        self.assertEqual({row['id'] for row in accounts},original_ids)
        self.assertEqual({row['marketplace'] for row in accounts},{'ozon'})
        self.assertEqual({row['client_id'] for row in accounts},{'123','456'})
        self.assertTrue(all(row['connected'] for row in accounts))

        directory=self.client.get('/api/accounts')
        self.assertEqual(directory.status_code,200,directory.text)
        self.assertEqual({row['marketplace'] for row in directory.json()['accounts']},{'ozon'})

        selected=self.client.post('/api/accounts/select',headers=HEAD,
                                  json={'account_id':first['account_id']})
        self.assertEqual(selected.status_code,200,selected.text)
        self.assertEqual(self.client.get('/api/auth/me').json()['active_account_id'],first['account_id'])

        disconnected=self.client.post('/api/disconnect',headers=HEAD,json={})
        self.assertEqual(disconnected.status_code,200,disconnected.text)
        by_id={row['id']:row for row in self.client.get('/api/accounts').json()['accounts']}
        self.assertEqual(set(by_id),original_ids)
        self.assertEqual(by_id[first['account_id']]['marketplace'],'ozon')
        self.assertFalse(by_id[first['account_id']]['connected'])
        self.assertTrue(by_id[second['account_id']]['connected'])

    def test_disconnect_keeps_account_and_history_for_reconnect(self):
        account=self.connect()
        scope='account:'+account['account_id']
        main.store.save(scope,'inventory',{'products':[{'name':'persisted'}]})
        self.assertEqual(self.client.post('/api/disconnect',headers=HEAD,json={}).status_code,200)
        self.assertEqual(self.client.get('/api/auth/me').json()['accounts'][0]['connected'],False)
        self.assertEqual(self.client.post('/api/connect',headers=HEAD,json={
            'client_id':'123','api_key':'replacement-secret-key-123'
        }).status_code,200)
        self.assertEqual(main.store.latest(scope,'inventory')['products'][0]['name'],'persisted')

    def test_legacy_data_migrates_to_first_account_scope(self):
        with main.store.db() as c:
            c.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                      ('123','inventory','2026-01-01T00:00:00+00:00',json.dumps({'products':[{'name':'legacy'}]})))
        account=self.connect()
        scope='account:'+account['account_id']
        self.assertEqual(main.store.latest(scope,'inventory')['products'][0]['name'],'legacy')
        self.assertIsNone(main.store.latest('123','inventory'))
        with main.store.db() as c:
            row=c.execute('SELECT payload FROM snapshots WHERE client=?',(scope,)).fetchone()
        self.assertTrue(row[0].startswith('enc:v1:'))


    def test_legacy_database_import_is_atomic_encrypted_and_idempotent(self):
        account=self.connect(client_id='123')
        scope='account:'+account['account_id']
        now=datetime.now(timezone.utc).isoformat()
        main.store.save(scope,'inventory',{'products':[{'name':'new current snapshot'}]})

        source_path=Path(self.tmp.name)/'legacy.sqlite3'
        legacy=sqlite3.connect(source_path)
        legacy.executescript('''
            CREATE TABLE snapshots (
                id INTEGER PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL,
                at TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE api_cache (
                client TEXT NOT NULL, namespace TEXT NOT NULL, cache_key TEXT NOT NULL,
                updated_at REAL NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(client,namespace,cache_key));
            CREATE TABLE digitization_periods (
                client TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL,
                updated_at TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(client,date_from,date_to));
            CREATE TABLE digitization_days (
                client TEXT NOT NULL, day TEXT NOT NULL, updated_at TEXT NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(client,day));
        ''')
        old_at='2026-10-01T10:00:00+00:00'
        old_digitization={'since':'2026-10-01','to':'2026-10-01',
                          'effective_to':'2026-10-01','products':[],'postings':[]}
        legacy.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                       ('123','inventory',old_at,json.dumps({'products':[{'name':'old'}]})))
        legacy.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                       ('123','digitization',old_at,json.dumps(old_digitization)))
        legacy.execute('INSERT INTO api_cache VALUES (?,?,?,?,?)',
                       ('123','ozon_api','cache-a',100.0,json.dumps({'cached':'one'})))
        legacy.execute('INSERT INTO api_cache VALUES (?,?,?,?,?)',
                       ('123','ozon_api','cache-b',101.0,json.dumps({'cached':'two'})))
        legacy.execute('INSERT INTO digitization_periods VALUES (?,?,?,?,?)',
                       ('123','2026-10-01','2026-10-01',old_at,json.dumps(old_digitization)))
        legacy.execute('INSERT INTO digitization_days VALUES (?,?,?,?)',
                       ('123','2026-10-01',old_at,json.dumps(old_digitization)))
        legacy.commit()
        legacy.close()

        import hashlib
        original_hash=hashlib.sha256(source_path.read_bytes()).hexdigest()
        result=import_legacy_database(source_path,main.store,'admin')
        self.assertEqual(result['status'],'imported')
        self.assertEqual(result['source_client_id'],'123')
        self.assertEqual(result['imported_rows'],{
            'snapshots':2,'api_cache':2,'digitization_periods':1,'digitization_days':1
        })
        self.assertEqual(main.store.latest(scope,'inventory')['products'][0]['name'],
                         'new current snapshot')
        self.assertEqual(main.store.latest(scope,'digitization')['since'],'2026-10-01')
        self.assertEqual(main.store.cache_stats(scope,'ozon_api')['entries'],2)
        self.assertEqual(main.store.digitization_period_count(scope),1)
        self.assertEqual(main.store.digitization_coverage(scope)['days'],1)

        with main.store.db() as c:
            for table in ('snapshots','api_cache','digitization_periods','digitization_days'):
                payloads=[row[0] for row in c.execute(
                    f'SELECT payload FROM "{table}" WHERE client=?',(scope,)).fetchall()]
                self.assertTrue(payloads)
                self.assertTrue(all(value.startswith('enc:v1:') for value in payloads),table)

        second=import_legacy_database(source_path,main.store,'admin')
        self.assertEqual(second['status'],'already_imported')
        with main.store.db() as c:
            self.assertEqual(c.execute(
                'SELECT COUNT(*) FROM snapshots WHERE client=?',(scope,)).fetchone()[0],3)
        self.assertEqual(hashlib.sha256(source_path.read_bytes()).hexdigest(),original_hash)

        reopened=Store(Path(self.tmp.name)/'db.sqlite',encryption_key=main.ENCRYPTION_KEY)
        self.assertEqual(reopened.latest(scope,'inventory')['products'][0]['name'],
                         'new current snapshot')
        self.assertEqual(reopened.digitization_coverage(scope)['days'],1)

    def test_legacy_database_import_rejects_wrong_owner_without_writes(self):
        account=self.connect(client_id='123')
        source_path=Path(self.tmp.name)/'legacy-wrong-owner.sqlite3'
        legacy=sqlite3.connect(source_path)
        legacy.executescript('''
            CREATE TABLE snapshots (
                id INTEGER PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL,
                at TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE api_cache (
                client TEXT NOT NULL, namespace TEXT NOT NULL, cache_key TEXT NOT NULL,
                updated_at REAL NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(client,namespace,cache_key));
            CREATE TABLE digitization_periods (
                client TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL,
                updated_at TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(client,date_from,date_to));
            CREATE TABLE digitization_days (
                client TEXT NOT NULL, day TEXT NOT NULL, updated_at TEXT NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(client,day));
        ''')
        legacy.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                       ('999','inventory','2026-10-01T00:00:00+00:00','{"products":[]}'))
        legacy.commit()
        legacy.close()
        with self.assertRaises(LegacyImportError):
            import_legacy_database(source_path,main.store,'admin')
        with main.store.db() as c:
            self.assertEqual(c.execute(
                'SELECT COUNT(*) FROM legacy_database_imports').fetchone()[0],0)
            self.assertEqual(c.execute(
                'SELECT COUNT(*) FROM snapshots WHERE client=?',
                ('account:'+account['account_id'],)).fetchone()[0],0)

    def test_expired_session_is_rejected(self):
        cookie=self.client.cookies.get('isk_session')
        digest=token_digest(cookie)
        with main.store.db() as c:
            c.execute('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?',(time.time()-1,digest))
        self.assertEqual(self.client.get('/api/auth/me').status_code,401)

    def test_password_validation_does_not_echo_secret(self):
        secret='NeverEchoThisSecret-123'
        r=self.client.post('/api/connect',headers=HEAD,json={'client_id':'abc','api_key':secret})
        self.assertEqual(r.status_code,422)
        self.assertNotIn(secret,r.text)

    def test_product_costs_persist_per_account_and_import_only_missing_skus(self):
        first=self.connect(client_id='123')['account_id']
        second=self.connect(client_id='456')['account_id']
        path=f'/api/accounts/{first}/product-costs'
        other_path=f'/api/accounts/{second}/product-costs'
        self.assertEqual(self.client.get(path).json(),{'costs':{}})
        self.assertEqual(self.client.put(path+'/100',headers=HEAD,json={'cost':0}).status_code,200)
        legacy={'costs':{'100':{'cost':50},'101':{'cost':15,'fulfillment':5,'vat':2,'own_stock':3}}}
        imported=self.client.post(path+'/import',headers=HEAD,json=legacy)
        self.assertEqual(imported.status_code,200,imported.text)
        self.assertEqual(imported.json()['costs']['100']['cost'],0)
        row=self.client.put(path+'/101',headers=HEAD,json={'cost':17.5})
        self.assertEqual(row.json(),{'cost':17.5,'fulfillment':5,'vat':2,'own_stock':3})
        self.assertEqual(self.client.put(path+'/101',headers=HEAD,json={'cost':-1}).status_code,422)
        self.assertEqual(self.client.put(path+'/101',headers=HEAD,json={'cost':None}).status_code,200)
        self.assertEqual(self.client.post(path+'/import',headers=HEAD,json=legacy).json()['costs']['101']['cost'],None)
        self.assertEqual(self.client.get(other_path).json(),{'costs':{}})

        main.store=Store(Path(self.tmp.name)/'db.sqlite',encryption_key=main.ENCRYPTION_KEY)
        self.assertEqual(self.client.get(path).json()['costs']['101'],{'cost':None,'fulfillment':5,'vat':2,'own_stock':3})
        main.store.create_user('other-costs',hash_password(ADMIN_PASSWORD),'user')
        with TestClient(main.app) as other:
            self.login(other,'other-costs',ADMIN_PASSWORD)
            self.assertEqual(other.get(path).status_code,404)
            self.assertEqual(other.put(path+'/100',headers=HEAD,json={'cost':100}).status_code,404)

    def test_sync_and_replenishment_use_account_scope(self):
        account=self.connect()
        scope='account:'+account['account_id']
        self.assertEqual(self.client.post('/api/sync',headers=HEAD,json={}).status_code,200)
        self.assertIsNone(self.wait()['job']['error'])
        data=self.client.get('/api/inventory').json()
        self.assertEqual(data['summary']['available'],10)
        main.store.save(scope,'history',{'since':'2020-01-01T00:00:00+03:00',
            'to':'2030-01-01T00:00:00+03:00','warehouse_attribution':True,'postings':[]})
        r=self.client.post('/api/replenishment',headers=HEAD,json={'window':14})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['items'][0]['total']['state'],'no_orders')

    def test_account_sync_updates_inventory_and_recent_history(self):
        account=self.connect()
        scope='account:'+account['account_id']
        now=datetime.now(timezone.utc).isoformat()
        sources={scheme:{'ok':True,'last_success_at':now} for scheme in ('fbo','fbs')}
        main.store.save(scope,'history',{'sources':sources,'postings':[]})

        with patch.object(FakeOzon,'postings',autospec=True,return_value={
            'postings':[],'sources':sources,
        }) as postings, patch.object(FakeOzon,'daily_sales',create=True) as orders:
            self.assertEqual(self.client.post('/api/account/sync',headers=HEAD,json={}).status_code,200)
            self.assertIsNone(self.wait()['job']['error'])
        self.assertEqual(postings.call_args.args[1],2)
        orders.assert_not_called()
        self.assertEqual(self.client.get('/api/inventory').json()['summary']['available'],10)

    def test_chart_uses_saved_days_and_throttles_current_day_refresh(self):
        from datetime import timedelta

        account=self.connect()
        scope='account:'+account['account_id']
        first,today=main.sales_chart_period(14)
        gap=first+timedelta(days=2)
        yesterday=today-timedelta(days=1)
        delivered={'FBS':{'ok':True,'postings':[]}}
        current_check=datetime.now(timezone.utc)
        main.store.save(scope,'sales_analytics',{
            'date_to':today.isoformat(),
            'orders_checked_at':current_check.isoformat(),
            'orders_live_day':today.isoformat(),
            'rows':[{'date':(first+timedelta(days=i)).isoformat(),'ordered_units':7}
                    for i in range(15) if first+timedelta(days=i)!=gap],
            'by_sku':[],
            'delivery_days':{yesterday.isoformat():delivered},
        })

        def daily_sales(start,end,progress):
            return {'rows':[{'date':(start+timedelta(days=i)).isoformat(),'ordered_units':3}
                            for i in range((end-start).days+1)],'by_sku':[]}

        def refresh(backfill):
            return self.client.post('/api/sales/sync',headers=HEAD,json={'days':14,'backfill':backfill}).json()

        with patch.object(FakeOzon,'daily_sales',create=True,side_effect=daily_sales) as orders, \
                patch.object(FakeOzon,'current_day_orders',create=True,return_value=(
                    {'date':today.isoformat(),'ordered_units':3},[],
                )) as live, \
                patch.object(main,'delivered_snapshot',return_value={}) as deliveries, \
                patch.object(main,'download_digitization_day') as finance:
            self.assertFalse(refresh(False)['started'])
            self.assertTrue(refresh(True)['started'])
            self.assertIsNone(self.wait()['job']['error'])
            self.assertEqual(orders.call_args.args[:2],(gap,gap))
            orders.assert_called_once()
            deliveries.assert_called_once()
            self.assertFalse(refresh(True)['started'])
            self.assertFalse(refresh(False)['started'])

            data=main.store.latest(scope,'sales_analytics')
            data['orders_checked_at']=(current_check-timedelta(minutes=10)).isoformat()
            main.store.save(scope,'sales_analytics',data)
            self.assertTrue(refresh(False)['started'])
            self.assertIsNone(self.wait()['job']['error'])
            orders.assert_called_once()
            live.assert_called_once()
            self.assertEqual(live.call_args.args[0],today)
            self.assertFalse(refresh(False)['started'])
            deliveries.assert_called_once()
            finance.assert_not_called()
        data=main.store.latest(scope,'sales_analytics')
        self.assertEqual(data['delivery_days'][yesterday.isoformat()],delivered)
        self.assertEqual(data['rows'][0]['ordered_units'],7)
        self.assertEqual(data['rows'][-1]['ordered_units'],3)

    def test_sales_refresh_shares_one_snapshot_with_shipment_history(self):
        # The live graph and shipment counts must use the same Ozon response,
        # and a sales job also updates the /api/history endpoint.
        from datetime import timedelta

        account=self.connect()
        scope='account:'+account['account_id']
        first,today=main.sales_chart_period(14)
        snapshot={
            'since':(today-timedelta(days=16)).isoformat()+'T00:00:00+03:00',
            'to':today.isoformat()+'T23:59:59+03:00',
            'sources':{'fbo':{'ok':True},'fbs':{'ok':True}},
            'errors':[],
            'postings':[
                {'number':'one','scheme':'FBO','status':'delivered',
                 'created_at':today.isoformat()+'T09:00:00+03:00',
                 'products':[{'sku':'100','offer_id':'A','quantity':2}]},
                {'number':'two','scheme':'FBS','status':'cancelled',
                 'created_at':today.isoformat()+'T10:00:00+03:00',
                 'products':[{'sku':'100','offer_id':'A','quantity':1}]}
            ]
        }
        def from_snapshot(api, day, progress, history=None):
            self.assertIs(history,snapshot,'graph and history must use the same fetched snapshot')
            self.assertEqual(day,today)
            return ({'date':today.isoformat(),'ordered_units':3,
                     'ordered_revenue':532},[
                {'date':today.isoformat(),'sku':'100','ordered_units':3,'ordered_revenue':532}
            ])

        with patch.object(FakeOzon,'postings',autospec=True,return_value=snapshot) as postings, \
             patch.object(FakeOzon,'current_day_orders',create=True,new=from_snapshot):
            started=self.client.post('/api/sales/sync',headers=HEAD,
                                     json={'days':14,'backfill':False})
            self.assertEqual(started.status_code,200,started.text)
            self.assertTrue(started.json()['started'])
            self.assertIsNone(self.wait()['job']['error'])
            postings.assert_called_once()
            self.assertEqual(postings.call_args.args[1],16)

        history=self.client.get('/api/history').json()
        self.assertEqual(len(history['postings']),2)
        self.assertEqual(sum(p['products'][0]['quantity'] for p in history['postings']),3)
        orders=self.client.get('/api/sales').json()
        self.assertEqual(orders['rows'][-1]['ordered_units'],3)
        self.assertEqual(main.store.latest(scope,'history')['postings'][0]['status'],'cancelled')

    def test_digitization_downloads_yesterday_at_eight_and_manual_history_once(self):
        from datetime import timedelta

        account=self.connect()
        scope='account:'+account['account_id']
        now=datetime.now(main.MOSCOW_TZ)
        yesterday=now.date()-timedelta(days=1)
        older=yesterday-timedelta(days=1)
        at_eight=now.replace(hour=8,minute=0,second=0,microsecond=0)
        body={'date_from':older.isoformat(),'date_to':yesterday.isoformat(),'refresh':True}
        with patch.object(FakeOzon,'_as_date',create=True,side_effect=lambda day: day), \
                patch.object(FakeOzon,'_closed_last_day',create=True,side_effect=lambda day: (day,False)), \
                patch.object(main,'download_digitization_day',return_value={}) as download:
            main.schedule_morning_digitization(at_eight-timedelta(seconds=1))
            download.assert_not_called()

            # Simulate an early manual request before the 08:00 Moscow cutoff.
            # After 08:00, manual sync is intentionally allowed to retry yesterday.
            with patch.object(main,'manual_digitization_latest_day',return_value=older):
                self.assertEqual(self.client.post('/api/digitization/sync',headers=HEAD,json=body).status_code,200)
                self.assertIsNone(self.wait()['job']['error'])
            self.assertEqual([call.args[1] for call in download.call_args_list],[older])

            main.runtime_accounts.clear()
            main.schedule_morning_digitization(at_eight)
            self.assertIsNone(self.wait()['job']['error'])
            self.assertEqual([call.args[1] for call in download.call_args_list],[older,yesterday])

            main.schedule_morning_digitization(at_eight+timedelta(minutes=1))
            self.assertEqual(self.client.post('/api/digitization/sync',headers=HEAD,json=body).status_code,200)
            self.assertIsNone(self.wait()['job']['error'])
            self.assertEqual(download.call_count,2)
        self.assertEqual(main.store.digitization_missing_days(scope,older.isoformat(),yesterday.isoformat()),[])

    def test_ozon_waiting_is_a_normal_running_job_with_retry_deadline(self):
        # An active 429 wait is a calm running state, not a failed job.
        from contextlib import contextmanager
        from datetime import timedelta
        import threading

        self.connect()
        day=datetime.now(main.MOSCOW_TZ).date()-timedelta(days=3)
        entered=threading.Event()
        release=threading.Event()

        @contextmanager
        def recovery(api,progress,on_wait=None,on_resume=None):
            api.on_wait=on_wait
            api.on_resume=on_resume
            yield

        def download(api, day_value, progress):
            api.on_wait(1562)
            progress('Ozon временно ограничил частоту запросов. Загрузка продолжится автоматически.')
            entered.set()
            if not release.wait(timeout=5):
                raise RuntimeError('Timed out waiting for test release')
            api.on_resume()
            progress('Ограничение Ozon снято, продолжаем загрузку…')
            return {}

        with patch.object(FakeOzon,'_as_date',create=True,side_effect=lambda value:value), \
             patch.object(FakeOzon,'_closed_last_day',create=True,side_effect=lambda value:(value,False)), \
             patch.object(FakeOzon,'auto_retry_429',create=True,new=recovery), \
             patch.object(main,'download_digitization_day',side_effect=download):
            try:
                response=self.client.post('/api/digitization/sync',headers=HEAD,json={
                    'date_from':day.isoformat(),'date_to':day.isoformat()
                })
                self.assertEqual(response.status_code,200,response.text)
                self.assertTrue(entered.wait(timeout=5))
                job=self.client.get('/api/state').json()['job']
                self.assertTrue(job['running'])
                self.assertEqual(job['kind'],'digitization')
                self.assertIsNone(job['error'])
                self.assertNotIn('429',job['message'])
                self.assertIsNotNone(job['retry_at'])
                delay=(datetime.fromisoformat(job['retry_at'])-datetime.now(timezone.utc)).total_seconds()
                self.assertGreater(delay,1500)
            finally:
                release.set()
            result=self.wait()['job']
            self.assertFalse(result['running'])
            self.assertIsNone(result['retry_at'])
            self.assertIsNone(result['error'])

    def test_failed_morning_digitization_is_not_retried_that_day(self):
        from datetime import timedelta

        self.connect()
        at_eight=datetime.now(main.MOSCOW_TZ).replace(hour=8,minute=0,second=0,microsecond=0)
        with patch.object(FakeOzon,'_as_date',create=True,side_effect=lambda day: day), \
                patch.object(FakeOzon,'_closed_last_day',create=True,side_effect=lambda day: (day,False)), \
                patch.object(main,'download_digitization_day',side_effect=ApiError('Ozon недоступен')) as download:
            main.schedule_morning_digitization(at_eight)
            self.assertEqual(self.wait()['job']['error'],'Ozon недоступен')
            main.runtime_accounts.clear()
            main.schedule_morning_digitization(at_eight+timedelta(minutes=1))
            download.assert_called_once()

    def test_login_attempts_are_rate_limited(self):
        bad=TestClient(main.app)
        try:
            for _ in range(8):
                r=bad.post('/api/auth/login',headers=HEAD,json={'username':'missing','password':'wrong-password-123'})
                self.assertEqual(r.status_code,401)
            r=bad.post('/api/auth/login',headers=HEAD,json={'username':'missing','password':'wrong-password-123'})
            self.assertEqual(r.status_code,429)
        finally:
            bad.close()


if __name__=='__main__':
    unittest.main()

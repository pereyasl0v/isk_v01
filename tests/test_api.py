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

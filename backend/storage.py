import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from .security import encrypt_payload, decrypt_payload


class Store:
    def __init__(self,path,encryption_key=None):
        self.path=str(path)
        self.encryption_key=encryption_key
        parent=os.path.dirname(self.path)
        if parent:
            os.makedirs(parent,mode=0o700,exist_ok=True)
            try: os.chmod(parent,0o700)
            except OSError: pass
        with self.db() as c:
            c.execute('''CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL,
                at TEXT NOT NULL, payload TEXT NOT NULL)''')
            c.execute('CREATE INDEX IF NOT EXISTS snapshot_lookup ON snapshots(client,kind,id)')
            c.execute('CREATE INDEX IF NOT EXISTS snapshot_time_lookup ON snapshots(client,kind,at)')
            c.execute('''CREATE TABLE IF NOT EXISTS api_cache (
                client TEXT NOT NULL,
                namespace TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                updated_at REAL NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY(client,namespace,cache_key))''')
            c.execute('CREATE INDEX IF NOT EXISTS api_cache_updated ON api_cache(updated_at)')
            c.execute('''CREATE TABLE IF NOT EXISTS digitization_periods (
                client TEXT NOT NULL,
                date_from TEXT NOT NULL,
                date_to TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY(client,date_from,date_to))''')
            c.execute('CREATE INDEX IF NOT EXISTS digitization_period_updated ON digitization_periods(client,updated_at)')
            c.execute('''CREATE TABLE IF NOT EXISTS digitization_days (
                client TEXT NOT NULL,
                day TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY(client,day))''')
            c.execute('CREATE INDEX IF NOT EXISTS digitization_day_updated ON digitization_days(client,updated_at)')
            # API cache is only an acceleration layer. Daily digitization facts are
            # the durable local analytical source and are intentionally not purged.
            c.execute('DELETE FROM api_cache WHERE updated_at < ?', (time.time()-370*86400,))
            c.execute('''CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
                is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)''')
            c.execute('''CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                created_at REAL NOT NULL, last_seen REAL NOT NULL, expires_at REAL NOT NULL,
                active_account_id TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)''')
            c.execute('CREATE INDEX IF NOT EXISTS auth_session_user ON auth_sessions(user_id)')
            c.execute('''CREATE TABLE IF NOT EXISTS ozon_accounts (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
                api_key_ciphertext TEXT, roles_json TEXT NOT NULL DEFAULT '{}',
                connected INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, UNIQUE(user_id,client_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)''')
            c.execute('CREATE INDEX IF NOT EXISTS ozon_account_user ON ozon_accounts(user_id,connected)')
            c.execute('''CREATE TABLE IF NOT EXISTS auth_login_attempts (
                ip TEXT NOT NULL, username TEXT NOT NULL, window_started REAL NOT NULL,
                failed_count INTEGER NOT NULL, locked_until REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(ip,username))''')
            c.execute('''CREATE TABLE IF NOT EXISTS legacy_data_migrations (
                client_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, migrated_at TEXT NOT NULL)''')
            self._migrate_digitization_periods(c)
        try: os.chmod(self.path,0o600)
        except OSError: pass

    def _encode_payload(self,data):
        return encrypt_payload(data,self.encryption_key)

    def _decode_payload(self,value):
        return decrypt_payload(value,self.encryption_key)

    def create_user(self,username,password_hash,role='user'):
        user_id=uuid.uuid4().hex
        created=datetime.now(timezone.utc).isoformat()
        with self.db() as c:
            c.execute('INSERT INTO users(id,username,password_hash,role,is_active,created_at) VALUES (?,?,?,?,1,?)',
                      (user_id,username,password_hash,role,created))
        return self.get_user_by_id(user_id)

    def get_user_by_username(self,username):
        with self.db() as c:
            row=c.execute('SELECT id,username,password_hash,role,is_active,created_at FROM users WHERE username=? COLLATE NOCASE',
                          (str(username),)).fetchone()
        return self._user_row(row)

    def get_user_by_id(self,user_id):
        with self.db() as c:
            row=c.execute('SELECT id,username,password_hash,role,is_active,created_at FROM users WHERE id=?',
                          (str(user_id),)).fetchone()
        return self._user_row(row)

    @staticmethod
    def _user_row(row):
        if not row:return None
        return {'id':row[0],'username':row[1],'password_hash':row[2],'role':row[3],
                'is_active':bool(row[4]),'created_at':row[5]}

    def count_users(self):
        with self.db() as c:return int(c.execute('SELECT COUNT(*) FROM users').fetchone()[0])

    def count_active_admins(self):
        with self.db() as c:return int(c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=1").fetchone()[0])

    def list_users(self):
        with self.db() as c:
            rows=c.execute('SELECT id,username,role,is_active,created_at FROM users ORDER BY created_at,id').fetchall()
        return [{'id':r[0],'username':r[1],'role':r[2],'is_active':bool(r[3]),'created_at':r[4]} for r in rows]

    def set_user_active(self,user_id,active):
        with self.db() as c:
            row=c.execute('SELECT role,is_active FROM users WHERE id=?',(str(user_id),)).fetchone()
            if not row:return False
            if row[0]=='admin' and row[1] and not active:
                admins=c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=1").fetchone()[0]
                if admins<=1:raise ValueError('Нельзя отключить последнего администратора.')
            c.execute('UPDATE users SET is_active=? WHERE id=?',(1 if active else 0,str(user_id)))
            if not active:c.execute('DELETE FROM auth_sessions WHERE user_id=?',(str(user_id),))
        return True

    def create_auth_session(self,token_hash,user_id,active_account_id,ttl_seconds):
        now=time.time()
        with self.db() as c:
            c.execute('''INSERT INTO auth_sessions(token_hash,user_id,created_at,last_seen,expires_at,active_account_id)
                         VALUES (?,?,?,?,?,?)''',
                      (token_hash,str(user_id),now,now,now+int(ttl_seconds),active_account_id))

    def get_auth_session(self,token_hash):
        now=time.time()
        with self.db() as c:
            row=c.execute('''SELECT s.user_id,s.created_at,s.last_seen,s.expires_at,s.active_account_id,
                                    u.username,u.role,u.is_active
                             FROM auth_sessions s JOIN users u ON u.id=s.user_id
                             WHERE s.token_hash=?''',(str(token_hash),)).fetchone()
            if not row:return None
            if float(row[3])<=now or not bool(row[7]):
                c.execute('DELETE FROM auth_sessions WHERE token_hash=?',(str(token_hash),))
                return None
            c.execute('UPDATE auth_sessions SET last_seen=? WHERE token_hash=?',(now,str(token_hash)))
        return {'user_id':row[0],'created_at':row[1],'last_seen':now,'expires_at':row[3],
                'active_account_id':row[4],
                'user':{'id':row[0],'username':row[5],'role':row[6],'is_active':bool(row[7])}}

    def set_session_account(self,token_hash,user_id,account_id):
        with self.db() as c:
            if account_id is not None:
                exists=c.execute('SELECT 1 FROM ozon_accounts WHERE id=? AND user_id=? AND connected=1',
                                 (str(account_id),str(user_id))).fetchone()
                if not exists:return False
            c.execute('UPDATE auth_sessions SET active_account_id=? WHERE token_hash=? AND user_id=?',
                      (account_id,str(token_hash),str(user_id)))
            return c.total_changes>0

    def delete_auth_session(self,token_hash):
        with self.db() as c:c.execute('DELETE FROM auth_sessions WHERE token_hash=?',(str(token_hash),))

    def login_is_locked(self,ip,username,window_seconds=900):
        now=time.time()
        with self.db() as c:
            row=c.execute('SELECT window_started,failed_count,locked_until FROM auth_login_attempts WHERE ip=? AND username=?',
                          (str(ip),str(username).lower())).fetchone()
        if not row:return False
        return float(row[2])>now or (now-float(row[0])<window_seconds and int(row[1])>=8)

    def record_login_failure(self,ip,username,window_seconds=900):
        now=time.time()
        with self.db() as c:
            row=c.execute('SELECT window_started,failed_count FROM auth_login_attempts WHERE ip=? AND username=?',
                          (str(ip),str(username).lower())).fetchone()
            if not row or now-float(row[0])>=window_seconds:started,count=now,1
            else:started,count=float(row[0]),int(row[1])+1
            locked=now+window_seconds if count>=8 else 0
            c.execute('''INSERT INTO auth_login_attempts(ip,username,window_started,failed_count,locked_until)
                         VALUES (?,?,?,?,?) ON CONFLICT(ip,username) DO UPDATE SET
                         window_started=excluded.window_started,failed_count=excluded.failed_count,
                         locked_until=excluded.locked_until''',
                      (str(ip),str(username).lower(),started,count,locked))

    def clear_login_failures(self,ip,username):
        with self.db() as c:
            c.execute('DELETE FROM auth_login_attempts WHERE ip=? AND username=?',
                      (str(ip),str(username).lower()))

    def upsert_ozon_account(self,user_id,client_id,ciphertext,roles):
        now=datetime.now(timezone.utc).isoformat()
        roles_json=json.dumps(roles,ensure_ascii=False,separators=(',',':'))
        with self.db() as c:
            row=c.execute('SELECT id FROM ozon_accounts WHERE user_id=? AND client_id=?',
                          (str(user_id),str(client_id))).fetchone()
            if row:
                account_id=row[0]
                c.execute('''UPDATE ozon_accounts SET api_key_ciphertext=?,roles_json=?,connected=1,updated_at=?
                             WHERE id=? AND user_id=?''',
                          (ciphertext,roles_json,now,account_id,str(user_id)))
            else:
                account_id=uuid.uuid4().hex
                c.execute('''INSERT INTO ozon_accounts(id,user_id,client_id,api_key_ciphertext,roles_json,connected,created_at,updated_at)
                             VALUES (?,?,?,?,?,1,?,?)''',
                          (account_id,str(user_id),str(client_id),ciphertext,roles_json,now,now))
        return self.get_ozon_account(account_id,user_id)

    def get_ozon_account(self,account_id,user_id):
        with self.db() as c:
            row=c.execute('''SELECT id,user_id,client_id,api_key_ciphertext,roles_json,connected,created_at,updated_at
                             FROM ozon_accounts WHERE id=? AND user_id=?''',
                          (str(account_id),str(user_id))).fetchone()
        if not row:return None
        try:roles=json.loads(row[4] or '{}')
        except (ValueError,TypeError):roles={}
        return {'id':row[0],'user_id':row[1],'client_id':row[2],'api_key_ciphertext':row[3],
                'roles':roles,'connected':bool(row[5]),'created_at':row[6],'updated_at':row[7]}

    def list_ozon_accounts(self,user_id):
        with self.db() as c:
            rows=c.execute('''SELECT id,client_id,roles_json,connected,created_at,updated_at
                             FROM ozon_accounts WHERE user_id=? ORDER BY updated_at DESC,id''',
                          (str(user_id),)).fetchall()
        result=[]
        for row in rows:
            try:roles=json.loads(row[2] or '{}')
            except (ValueError,TypeError):roles={}
            result.append({'id':row[0],'client_id':row[1],'roles':roles,'connected':bool(row[3]),
                           'created_at':row[4],'updated_at':row[5]})
        return result

    def disconnect_ozon_account(self,account_id,user_id):
        with self.db() as c:
            c.execute('''UPDATE ozon_accounts SET api_key_ciphertext=NULL,connected=0,updated_at=?
                         WHERE id=? AND user_id=?''',
                      (datetime.now(timezone.utc).isoformat(),str(account_id),str(user_id)))
            return c.total_changes>0

    def migrate_legacy_client_data(self,client_id,account_scope,account_id):
        client_id=str(client_id)
        with self.db() as c:
            done=c.execute('SELECT 1 FROM legacy_data_migrations WHERE client_id=?',(client_id,)).fetchone()
            if done:return False
            c.execute('''INSERT INTO snapshots(client,kind,at,payload)
                         SELECT ?,kind,at,payload FROM snapshots WHERE client=?''',(account_scope,client_id))
            c.execute('''INSERT OR IGNORE INTO api_cache(client,namespace,cache_key,updated_at,payload)
                         SELECT ?,namespace,cache_key,updated_at,payload FROM api_cache WHERE client=?''',
                      (account_scope,client_id))
            c.execute('''INSERT OR IGNORE INTO digitization_periods(client,date_from,date_to,updated_at,payload)
                         SELECT ?,date_from,date_to,updated_at,payload FROM digitization_periods WHERE client=?''',
                      (account_scope,client_id))
            c.execute('''INSERT OR IGNORE INTO digitization_days(client,day,updated_at,payload)
                         SELECT ?,day,updated_at,payload FROM digitization_days WHERE client=?''',
                      (account_scope,client_id))
            c.execute('DELETE FROM snapshots WHERE client=?',(client_id,))
            c.execute('DELETE FROM api_cache WHERE client=?',(client_id,))
            c.execute('DELETE FROM digitization_periods WHERE client=?',(client_id,))
            c.execute('DELETE FROM digitization_days WHERE client=?',(client_id,))
            c.execute('INSERT INTO legacy_data_migrations(client_id,account_id,migrated_at) VALUES (?,?,?)',
                      (client_id,str(account_id),datetime.now(timezone.utc).isoformat()))
            for table in ('snapshots','api_cache','digitization_periods','digitization_days'):
                rows=c.execute(f'SELECT rowid,payload FROM {table} WHERE client=?',(account_scope,)).fetchall()
                for rowid,payload in rows:
                    if not str(payload).startswith('enc:v1:'):
                        try:encoded=self._encode_payload(json.loads(payload))
                        except (ValueError,TypeError):continue
                        c.execute(f'UPDATE {table} SET payload=? WHERE rowid=?',(encoded,rowid))
        return True

    @staticmethod
    def _period_bounds(data):
        if not isinstance(data,dict):
            return None,None
        first=str(data.get('since') or '').strip()
        last=str(data.get('to') or '').strip()
        return (first,last) if first and last else (None,None)

    def _migrate_digitization_periods(self,c):
        # Keep legacy exact-period snapshots for backwards compatibility. Single
        # closed-day snapshots are also promoted into the new daily source.
        rows=c.execute(
            "SELECT client,at,payload FROM snapshots WHERE kind='digitization' ORDER BY id ASC"
        ).fetchall()
        for client,at,payload in rows:
            try:
                data=self._decode_payload(payload)
            except (ValueError,TypeError):
                continue
            first,last=self._period_bounds(data)
            if not first or not last:
                continue
            c.execute('''INSERT INTO digitization_periods(client,date_from,date_to,updated_at,payload)
                         VALUES (?,?,?,?,?)
                         ON CONFLICT(client,date_from,date_to) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload''',
                      (str(client),first,last,str(at),self._encode_payload(data)))
            effective=str(data.get('effective_to') or last)
            if first == effective:
                day_payload=dict(data)
                day_payload['since']=first
                day_payload['to']=first
                day_payload['effective_to']=first
                day_payload['current_day_excluded']=False
                encoded=self._encode_payload(day_payload)
                c.execute('''INSERT INTO digitization_days(client,day,updated_at,payload)
                             VALUES (?,?,?,?)
                             ON CONFLICT(client,day) DO NOTHING''',
                          (str(client),first,str(at),encoded))

    @contextmanager
    def db(self):
        connection=sqlite3.connect(self.path, timeout=30)
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=30000')
        connection.execute('PRAGMA secure_delete=ON')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def save(self,client,kind,data):
        payload=self._encode_payload(data)
        at=datetime.now(timezone.utc).isoformat()
        with self.db() as c:
            c.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                      (client,kind,at,payload))
            if kind=='digitization':
                first,last=self._period_bounds(data)
                if first and last:
                    c.execute('''INSERT INTO digitization_periods(client,date_from,date_to,updated_at,payload)
                                 VALUES (?,?,?,?,?)
                                 ON CONFLICT(client,date_from,date_to) DO UPDATE SET
                                 updated_at=excluded.updated_at,payload=excluded.payload''',
                              (str(client),first,last,at,payload))

    def latest(self,client,kind):
        with self.db() as c:
            row=c.execute('SELECT at,payload FROM snapshots WHERE client=? AND kind=? ORDER BY id DESC LIMIT 1',
                          (client,kind)).fetchone()
        return {'at':row[0],**self._decode_payload(row[1])} if row else None

    def digitization_period(self,client,date_from,date_to):
        with self.db() as c:
            row=c.execute('''SELECT updated_at,payload FROM digitization_periods
                             WHERE client=? AND date_from=? AND date_to=? LIMIT 1''',
                          (str(client),str(date_from),str(date_to))).fetchone()
        if not row:
            return None
        return {'at':row[0],**self._decode_payload(row[1])}

    def digitization_period_count(self,client):
        with self.db() as c:
            row=c.execute('SELECT COUNT(*) FROM digitization_periods WHERE client=?',(str(client),)).fetchone()
        return int(row[0] or 0)

    def save_digitization_day(self,client,day,data):
        day=str(day)
        payload=self._encode_payload(data)
        at=datetime.now(timezone.utc).isoformat()
        with self.db() as c:
            c.execute('''INSERT INTO digitization_days(client,day,updated_at,payload)
                         VALUES (?,?,?,?)
                         ON CONFLICT(client,day) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload''',
                      (str(client),day,at,payload))
        return at

    def digitization_days_between(self,client,date_from,date_to):
        with self.db() as c:
            rows=c.execute('''SELECT day,updated_at,payload FROM digitization_days
                              WHERE client=? AND day>=? AND day<=? ORDER BY day ASC''',
                           (str(client),str(date_from),str(date_to))).fetchall()
        result=[]
        for day,updated_at,payload in rows:
            try:
                data=self._decode_payload(payload)
            except (ValueError,TypeError):
                continue
            result.append({'day':day,'at':updated_at,**data})
        return result

    @staticmethod
    def _iso_days(date_from,date_to):
        try:
            first=date.fromisoformat(str(date_from))
            last=date.fromisoformat(str(date_to))
        except ValueError:
            return []
        result=[]
        current=first
        while current<=last:
            result.append(current.isoformat())
            current+=timedelta(days=1)
        return result

    def digitization_missing_days(self,client,date_from,date_to):
        wanted=self._iso_days(date_from,date_to)
        if not wanted:
            return []
        with self.db() as c:
            rows=c.execute('''SELECT day FROM digitization_days
                              WHERE client=? AND day>=? AND day<=?''',
                           (str(client),str(date_from),str(date_to))).fetchall()
        present={str(row[0]) for row in rows}
        return [day for day in wanted if day not in present]

    def digitization_coverage(self,client,date_from=None,date_to=None):
        with self.db() as c:
            stats=c.execute('''SELECT COUNT(*),MIN(day),MAX(day),MAX(updated_at)
                               FROM digitization_days WHERE client=?''',
                            (str(client),)).fetchone()
        result={
            'days':int(stats[0] or 0),
            'first_day':stats[1],
            'last_day':stats[2],
            'updated_at':stats[3],
        }
        if date_from is not None and date_to is not None:
            wanted=self._iso_days(date_from,date_to)
            missing=self.digitization_missing_days(client,date_from,date_to)
            result.update({
                'requested_days':len(wanted),
                'available_days':max(0,len(wanted)-len(missing)),
                'missing_days':missing,
                'complete':bool(wanted) and not missing,
            })
        return result

    def between(self,client,kind,at_from,at_to,limit=5000):
        with self.db() as c:
            rows=c.execute(
                'SELECT at,payload FROM snapshots WHERE client=? AND kind=? AND at>=? AND at<=? ORDER BY at ASC,id ASC LIMIT ?',
                (client,kind,at_from,at_to,int(limit))
            ).fetchall()
        return [{'at':at,**self._decode_payload(payload)} for at,payload in rows]

    def cache_get(self,client,namespace,cache_key,max_age=None):
        """Read one reusable API response if it is still fresh enough."""
        with self.db() as c:
            row=c.execute(
                'SELECT updated_at,payload FROM api_cache WHERE client=? AND namespace=? AND cache_key=?',
                (str(client),str(namespace),str(cache_key))
            ).fetchone()
            if not row:
                return None
            updated_at,payload=row
            if max_age is not None and time.time()-float(updated_at)>float(max_age):
                c.execute(
                    'DELETE FROM api_cache WHERE client=? AND namespace=? AND cache_key=?',
                    (str(client),str(namespace),str(cache_key))
                )
                return None
        try:
            value=self._decode_payload(payload)
        except (ValueError,TypeError):
            self.cache_delete(client,namespace,cache_key)
            return None
        return value

    def cache_put(self,client,namespace,cache_key,data):
        payload=self._encode_payload(data)
        with self.db() as c:
            c.execute('''INSERT INTO api_cache(client,namespace,cache_key,updated_at,payload)
                         VALUES (?,?,?,?,?)
                         ON CONFLICT(client,namespace,cache_key) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload''',
                      (str(client),str(namespace),str(cache_key),time.time(),payload))

    def cache_delete(self,client,namespace,cache_key):
        with self.db() as c:
            c.execute('DELETE FROM api_cache WHERE client=? AND namespace=? AND cache_key=?',
                      (str(client),str(namespace),str(cache_key)))

    def cache_stats(self,client,namespace=None):
        with self.db() as c:
            if namespace is None:
                row=c.execute('SELECT COUNT(*),COALESCE(SUM(LENGTH(payload)),0) FROM api_cache WHERE client=?',
                              (str(client),)).fetchone()
            else:
                row=c.execute('''SELECT COUNT(*),COALESCE(SUM(LENGTH(payload)),0)
                                 FROM api_cache WHERE client=? AND namespace=?''',
                              (str(client),str(namespace))).fetchone()
        return {'entries':int(row[0] or 0),'bytes':int(row[1] or 0)}

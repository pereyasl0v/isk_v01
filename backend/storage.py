import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone


class Store:
    def __init__(self,path):
        self.path=str(path)
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
            # The cache is only an acceleration layer. Keep roughly one year so
            # historical Seller API reads can be reused without growing forever.
            c.execute('DELETE FROM api_cache WHERE updated_at < ?', (time.time()-370*86400,))
            self._migrate_digitization_periods(c)

    @staticmethod
    def _period_bounds(data):
        if not isinstance(data,dict):
            return None,None
        first=str(data.get('since') or '').strip()
        last=str(data.get('to') or '').strip()
        return (first,last) if first and last else (None,None)

    def _migrate_digitization_periods(self,c):
        # Existing installations already have full digitization snapshots. Index
        # them by requested period so the UI can switch periods without Ozon.
        rows=c.execute(
            "SELECT client,at,payload FROM snapshots WHERE kind='digitization' ORDER BY id ASC"
        ).fetchall()
        for client,at,payload in rows:
            try:
                data=json.loads(payload)
            except (ValueError,TypeError):
                continue
            first,last=self._period_bounds(data)
            if not first or not last:
                continue
            c.execute('''INSERT INTO digitization_periods(client,date_from,date_to,updated_at,payload)
                         VALUES (?,?,?,?,?)
                         ON CONFLICT(client,date_from,date_to) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload''',
                      (str(client),first,last,str(at),payload))

    @contextmanager
    def db(self):
        connection=sqlite3.connect(self.path, timeout=30)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def save(self,client,kind,data):
        payload=json.dumps(data,ensure_ascii=False,allow_nan=False)
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
        return {'at':row[0],**json.loads(row[1])} if row else None

    def digitization_period(self,client,date_from,date_to):
        with self.db() as c:
            row=c.execute('''SELECT updated_at,payload FROM digitization_periods
                             WHERE client=? AND date_from=? AND date_to=? LIMIT 1''',
                          (str(client),str(date_from),str(date_to))).fetchone()
        if not row:
            return None
        return {'at':row[0],**json.loads(row[1])}

    def digitization_period_count(self,client):
        with self.db() as c:
            row=c.execute('SELECT COUNT(*) FROM digitization_periods WHERE client=?',(str(client),)).fetchone()
        return int(row[0] or 0)

    def between(self,client,kind,at_from,at_to,limit=5000):
        with self.db() as c:
            rows=c.execute(
                'SELECT at,payload FROM snapshots WHERE client=? AND kind=? AND at>=? AND at<=? ORDER BY at ASC,id ASC LIMIT ?',
                (client,kind,at_from,at_to,int(limit))
            ).fetchall()
        return [{'at':at,**json.loads(payload)} for at,payload in rows]

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
            value=json.loads(payload)
        except (ValueError,TypeError):
            self.cache_delete(client,namespace,cache_key)
            return None
        return value

    def cache_put(self,client,namespace,cache_key,data):
        payload=json.dumps(data,ensure_ascii=False,allow_nan=False,separators=(',',':'))
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

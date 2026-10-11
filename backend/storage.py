import json
import sqlite3
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
        with self.db() as c:
            c.execute('INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)',
                      (client,kind,datetime.now(timezone.utc).isoformat(),payload))
    def latest(self,client,kind):
        with self.db() as c:
            row=c.execute('SELECT at,payload FROM snapshots WHERE client=? AND kind=? ORDER BY id DESC LIMIT 1',
                          (client,kind)).fetchone()
        return {'at':row[0],**json.loads(row[1])} if row else None
    def between(self,client,kind,at_from,at_to,limit=5000):
        with self.db() as c:
            rows=c.execute(
                'SELECT at,payload FROM snapshots WHERE client=? AND kind=? AND at>=? AND at<=? ORDER BY at ASC,id ASC LIMIT ?',
                (client,kind,at_from,at_to,int(limit))
            ).fetchall()
        return [{'at':at,**json.loads(payload)} for at,payload in rows]

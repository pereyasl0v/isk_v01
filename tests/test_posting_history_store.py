import tempfile
import unittest
from pathlib import Path

from backend.storage import Store


class PostingHistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.tmp.name)/'history.sqlite3')

    def tearDown(self):
        self.tmp.cleanup()

    def test_history_is_cumulative_and_records_observed_status_changes(self):
        first=self.store.save_history('account:test',{
            'since':'2026-10-01T00:00:00+00:00',
            'to':'2026-11-01T00:00:00+00:00',
            'warehouse_attribution':True,
            'sources':{
                'fbo':{'ok':True,'count':1},
                'fbs':{'ok':True,'count':0},
            },
            'errors':[],
            'postings':[{
                'number':'FBO-1','scheme':'FBO','status':'delivering','substatus':'',
                'created_at':'2026-10-15T12:00:00Z','warehouse_id':'10',
                'products':[{'sku':'100','quantity':2}],
            }],
        })
        first_event=first['postings'][0]['status_observations'][0]['observed_at']

        second=self.store.save_history('account:test',{
            'since':'2026-11-01T00:00:00+00:00',
            'to':'2026-11-20T00:00:00+00:00',
            'warehouse_attribution':True,
            'sources':{
                'fbo':{'ok':True,'count':1},
                'fbs':{'ok':True,'count':1},
            },
            'errors':[],
            'postings':[
                {
                    'number':'FBO-1','scheme':'FBO','status':'delivered','substatus':'',
                    'created_at':'2026-10-15T12:00:00Z','warehouse_id':'10',
                    'products':[{'sku':'100','quantity':2}],
                },
                {
                    'number':'FBS-1','scheme':'FBS','status':'awaiting_deliver','substatus':'posting_registered',
                    'in_process_at':'2026-11-18T12:00:00Z','warehouse_id':'20',
                    'products':[{'sku':'200','quantity':1}],
                },
            ],
        })
        self.assertEqual(second['since'],'2026-10-01T00:00:00+00:00')
        self.assertEqual(second['to'],'2026-11-20T00:00:00+00:00')
        self.assertEqual(second['counts'],{'fbo':1,'fbs':1})
        rows={(row['scheme'],row['number']):row for row in second['postings']}
        fbo=rows[('FBO','FBO-1')]
        self.assertEqual(fbo['status'],'delivered')
        self.assertEqual(len(fbo['status_observations']),2)
        self.assertEqual(fbo['status_observations'][0]['observed_at'],first_event)
        self.assertEqual(fbo['status_observations'][1]['status'],'delivered')
        self.assertEqual(fbo['status_observations'][1]['source'],'isk_sync')
        self.assertEqual(rows[('FBS','FBS-1')]['status'],'awaiting_deliver')

    def test_failed_scheme_does_not_delete_its_previously_saved_history(self):
        self.store.save_history('account:test',{
            'since':'2026-10-01T00:00:00+00:00','to':'2026-11-01T00:00:00+00:00',
            'warehouse_attribution':True,
            'sources':{'fbo':{'ok':True},'fbs':{'ok':True}},
            'postings':[
                {'number':'FBO-1','scheme':'FBO','status':'delivered','products':[]},
                {'number':'FBS-1','scheme':'FBS','status':'delivered','products':[]},
            ],
        })
        saved=self.store.save_history('account:test',{
            'since':'2026-11-01T00:00:00+00:00','to':'2026-11-20T00:00:00+00:00',
            'warehouse_attribution':True,
            'sources':{
                'fbo':{'ok':True,'count':0},
                'fbs':{'ok':False,'error':'Ozon HTTP 403.'},
            },
            'errors':['FBS: Ozon HTTP 403.'],
            'postings':[],
        })
        self.assertEqual({row['number'] for row in saved['postings']},{'FBO-1','FBS-1'})
        self.assertFalse(saved['sources']['fbs']['ok'])
        self.assertEqual(saved['sources']['fbs']['last_error'],'Ozon HTTP 403.')
        self.assertTrue(saved['sources']['fbo']['ok'])
        self.assertEqual(self.store.latest('account:test','history')['counts'],{'fbo':1,'fbs':1})


if __name__=='__main__':
    unittest.main()

import unittest
from backend.inventory import summarize, aggregate
from backend.ozon import Ozon, ApiError

def row(warehouse,available,ads=6):
    return {'sku':100,'warehouse_id':warehouse,'offer_id':'A','name':'Товар',
            'available_stock_count':available,'valid_stock_count':0,
            'transit_stock_count':0,'requested_stock_count':0,'ads':ads}

def sample():
    return {'products':[{'id':1,'sku':100}],'stocks':[{}]*113,
            'analytics':[row(1,20),row(2,10)]}

class InventoryTests(unittest.TestCase):
    def test_113_rows_is_not_113_units(self):
        s=summarize(sample())
        self.assertEqual(s['warehouse_rows'],113)
        self.assertEqual(s['available'],30)
        self.assertEqual(s['stocked_skus'],1)
    def test_unavailable_is_not_zero(self):
        s=sample();s['analytics']=None
        self.assertIsNone(summarize(s)['available'])
    def test_global_ads_not_summed_over_warehouses(self):
        r=aggregate(sample())[0]
        self.assertEqual(r['ads'],6)
        self.assertEqual(r['available'],30)

    def test_customer_delivery_and_return_statuses_are_capitalized(self):
        rows = [
            row(1,162) | {'sku':1,'outbound_pending_delivery':10},
            row(2,82) | {'sku':2,'outbound_pending_delivery':9,'outbound_returns_return_to_seller':1},
            row(3,95) | {'sku':3,'outbound_pending_delivery':12},
        ]
        snapshot = {'products':[{'sku':1},{'sku':2},{'sku':3}],
                    'stocks':[], 'analytics':rows}
        summary = summarize(snapshot)
        self.assertEqual(summary['available'],339)
        self.assertEqual(summary['outbound_pending_delivery'],31)
        self.assertEqual(summary['outbound_returns'],1)
        self.assertEqual(summary['capitalization_quantity'],371)
        by_sku = {r['sku']:r for r in aggregate(snapshot)}
        self.assertEqual(by_sku['1']['capitalization_quantity'],172)
        self.assertEqual(by_sku['2']['capitalization_quantity'],92)
        self.assertEqual(by_sku['3']['capitalization_quantity'],107)

    def test_new_ozon_stock_status_fields_are_aggregated_by_sku(self):
        snapshot = {
            'products':[{'sku':1},{'sku':2}],
            'stocks':[],
            'analytics':[
                row(1,10) | {'sku':1,'inbound_replenishment':4,'stock_not_being_sold':2},
                row(2,20) | {'sku':2,'inbound_replenishment':3,'stock_not_being_sold':1},
            ],
        }
        summary = summarize(snapshot)
        self.assertEqual(summary['inbound_replenishment'],7)
        self.assertEqual(summary['stock_not_being_sold'],3)
        by_sku = {item['sku']:item for item in aggregate(snapshot)}
        self.assertEqual(by_sku['1']['inbound_replenishment'],4)
        self.assertEqual(by_sku['2']['stock_not_being_sold'],1)

    def test_missing_new_outbound_fields_are_not_mistaken_for_zero(self):
        snapshot = sample()
        summary = summarize(snapshot)
        self.assertFalse(summary['outbound_fields_available'])
        self.assertIsNone(summary['capitalization_quantity'])
        self.assertIsNone(aggregate(snapshot)[0]['capitalization_quantity'])

    def test_empty_successful_inventory_has_zero_capitalization_quantity(self):
        snapshot = {'products':[], 'stocks':[], 'analytics':[]}
        summary = summarize(snapshot)
        self.assertTrue(summary['outbound_fields_available'])
        self.assertEqual(summary['capitalization_quantity'],0)

    def test_missing_quantity_not_silently_zero(self):
        s=sample();del s['analytics'][0]['available_stock_count']
        with self.assertRaises(ValueError):summarize(s)
    def test_analytics_batch_and_duplicate_guard(self):
        calls=[]
        def fake(path,body):
            calls.append(body)
            return {'items':[row(s,1) | {'sku':int(s)} for s in body['skus']]}
        api=Ozon('1','fake',transport=fake)
        rows=api.analytics([{'sku':i+1} for i in range(101)],[],lambda m:None)
        self.assertEqual(len(rows),101)
        self.assertEqual([len(c['skus']) for c in calls],[100,1])
        api=Ozon('1','fake',transport=lambda p,b:{'items':[row(1,5),row(1,5)]})
        with self.assertRaises(ApiError):api.analytics([{'sku':100}],[],lambda m:None)
    def test_history_loads_both_fbo_and_fbs_with_safe_normalized_fields(self):
        calls=[]
        def fake(path,body):
            calls.append((path,body))
            self.assertFalse(body['with']['legal_info'])
            self.assertFalse(body['with']['financial_data'])
            if path=='/v3/posting/fbo/list':
                if body['cursor']=='':
                    return {'has_next':True,'cursor':'fbo-next','postings':[{
                        'posting_number':'FBO-1','status':'delivering',
                        'created_at':'2026-10-01T12:00:00Z',
                        'analytics_data':{'warehouse_id':10,'warehouse':'Хоругвино','city':'private'},
                        'products':[{'sku':100,'offer_id':'A','name':'Товар','quantity':2}],
                    }]}
                return {'has_next':False,'postings':[{
                    'posting_number':'FBO-2','status':'delivered',
                    'created_at':'2026-10-02T12:00:00Z',
                    'analytics_data':{'warehouse_id':11,'warehouse_name':'Казань'},
                    'products':[{'sku':101,'quantity':1}],
                }]}
            self.assertEqual(path,'/v4/posting/fbs/list')
            return {'has_next':False,'postings':[{
                'posting_number':'FBS-1','status':'awaiting_deliver','substatus':'posting_registered',
                'in_process_at':'2026-10-03T12:00:00Z','shipment_date':'2026-10-04T12:00:00Z',
                'delivery_method':{'warehouse_id':20,'warehouse':'Склад продавца','name':'Способ доставки'},
                'analytics_data':{'warehouse_id':20,'warehouse':'Склад продавца','city':'private'},
                'products':[{'sku':102,'offer_id':'C','name':'Третий товар','quantity':3}],
                'customer':{'name':'private'},'legal_info':{'secret':'private'},
            }]}
        data=Ozon('1','fake',transport=fake).postings(30,lambda _:None)
        self.assertEqual([path for path,_ in calls],[
            '/v3/posting/fbo/list','/v3/posting/fbo/list','/v4/posting/fbs/list'
        ])
        self.assertEqual(calls[1][1]['cursor'],'fbo-next')
        self.assertEqual(data['sources']['fbo']['count'],2)
        self.assertEqual(data['sources']['fbs']['count'],1)
        by_number={row['number']:row for row in data['postings']}
        self.assertEqual(by_number['FBO-1']['scheme'],'FBO')
        self.assertEqual(by_number['FBO-1']['warehouse_name'],'Хоругвино')
        self.assertNotIn('city',by_number['FBO-1'])
        self.assertEqual(by_number['FBS-1']['scheme'],'FBS')
        self.assertEqual(by_number['FBS-1']['substatus'],'posting_registered')
        self.assertIsNone(by_number['FBS-1']['created_at'])
        self.assertEqual(by_number['FBS-1']['in_process_at'],'2026-10-03T12:00:00Z')
        self.assertEqual(by_number['FBS-1']['warehouse_id'],'20')
        self.assertEqual(by_number['FBS-1']['products'][0]['quantity'],3)
        self.assertNotIn('customer',by_number['FBS-1'])
        self.assertNotIn('legal_info',by_number['FBS-1'])
        self.assertTrue(data['warehouse_attribution'])

    def test_history_keeps_successful_scheme_when_other_scheme_is_forbidden(self):
        def fake(path,body):
            if path=='/v4/posting/fbs/list':
                raise ApiError('Ozon HTTP 403.')
            return {'has_next':False,'postings':[{
                'posting_number':'FBO-1','status':'delivered',
                'created_at':'2026-10-01T12:00:00Z',
                'analytics_data':{'warehouse_id':10,'warehouse':'Склад'},
                'products':[{'sku':100,'quantity':1}],
            }]}
        data=Ozon('1','fake',transport=fake).postings(30,lambda _:None)
        self.assertTrue(data['sources']['fbo']['ok'])
        self.assertFalse(data['sources']['fbs']['ok'])
        self.assertEqual(len(data['postings']),1)
        self.assertEqual(data['errors'],['FBS: Ozon HTTP 403.'])

    def test_history_cursor_and_no_personal_fields(self):
        def fake(path,body):
            self.assertFalse(body['with']['legal_info'])
            return {'has_next':False,'postings':[{'posting_number':'X','status':'cancelled',
              'created_at':'2026-10-01T00:00:00Z','legal_info':{'secret':'no'},
              'products':[{'sku':1,'quantity':2,'name':'Test'}]}]}
        data=Ozon('1','fake',transport=fake).postings(30,lambda m:None)
        self.assertNotIn('legal_info',data['postings'][0])
        self.assertEqual(data['postings'][0]['status'],'cancelled')

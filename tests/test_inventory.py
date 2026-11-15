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
    def test_history_cursor_and_no_personal_fields(self):
        def fake(path,body):
            self.assertFalse(body['with']['legal_info'])
            return {'has_next':False,'postings':[{'posting_number':'X','status':'cancelled',
              'created_at':'2026-10-01T00:00:00Z','legal_info':{'secret':'no'},
              'products':[{'sku':1,'quantity':2,'name':'Test'}]}]}
        data=Ozon('1','fake',transport=fake).postings(30,lambda m:None)
        self.assertNotIn('legal_info',data['postings'][0])
        self.assertEqual(data['postings'][0]['status'],'cancelled')

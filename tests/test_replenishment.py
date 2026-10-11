import unittest
from backend.replenishment import calculate
from backend.ozon import Ozon

def row(sku,w,n):
 return {'sku':sku,'warehouse_id':w,'warehouse_name':f'Склад {w}',
         'available_stock_count':n,'name':f'Товар {sku}','offer_id':str(sku)}
def posting(number,warehouse,units,status='delivered',sku=10):
 return {'number':number,'warehouse_id':warehouse,'warehouse_name':f'Склад {warehouse}',
         'created_at':'2026-10-05T12:00:00+03:00','status':status,
         'products':[{'sku':sku,'quantity':units}]}
def sample():
 inv={'at':'2026-10-10T12:00:00+03:00','products':[{'sku':10,'name':'Товар','offer_id':'A'}],
 'stocks':[{'sku':10,'warehouse_id':1},{'sku':10,'warehouse_id':2}],
 'analytics':[row(10,1,20),row(10,2,70)]}
 h={'since':'2026-06-01T00:00:00+03:00','to':'2026-10-10T12:00:00+03:00',
 'warehouse_attribution':True,'postings':[posting('a',1,14),posting('b',2,7)]}
 return inv,h
class ReplenishmentTests(unittest.TestCase):
 def test_two_warehouse_rates_and_pooled(self):
  i,h=sample();p=calculate(i,h,7)['items'][0]
  self.assertEqual([w['rate'] for w in p['warehouses']],[2,1])
  self.assertEqual([w['days_left'] for w in p['warehouses']],[10,70])
  self.assertEqual(p['total']['rate'],3)
  self.assertEqual(p['total']['days_left'],30)
 def test_zero_stock_visible(self):
  i,h=sample();i['analytics'][0]['available_stock_count']=0
  p=calculate(i,h,7)['items'][0]
  self.assertEqual(len(p['warehouses']),2)
  self.assertEqual(next(w for w in p['warehouses'] if w['warehouse_id']=='1')['state'],'empty')
  self.assertIsNone(next(w for w in p['warehouses'] if w['warehouse_id']=='1')['ends_at'])
 def test_all_known_warehouses_no_invented_zero(self):
  i,h=sample();i['analytics'].append(row(20,3,5))
  p=next(p for p in calculate(i,h,7)['items'] if p['sku']=='10')
  self.assertEqual(len(p['warehouses']),3)
  self.assertEqual(p['warehouses'][2]['state'],'unknown_stock')
 def test_unassigned_orders_block_local_not_global(self):
  i,h=sample();h['postings'].append(posting('c',None,7))
  p=calculate(i,h,7)['items'][0]
  self.assertIsNone(p['warehouses'][0]['rate'])
  self.assertEqual(p['total']['rate'],4)
  self.assertEqual(p['missing_warehouse_units'],7)
 def test_legacy_history_requires_reload(self):
  i,h=sample();h.pop('warehouse_attribution')
  r=calculate(i,h,7)
  self.assertTrue(r['warnings'])
  self.assertEqual(r['items'][0]['warehouses'][0]['state'],'unknown_rate')
 def test_cancelled_and_duplicates_not_counted(self):
  i,h=sample();h['postings']+=[posting('c',1,100,'cancelled'),posting('a',1,14)]
  self.assertEqual(calculate(i,h,7)['items'][0]['total']['rate'],3)
 def test_no_orders_not_infinite_or_zero_days(self):
  i,h=sample();h['postings']=[]
  p=calculate(i,h,7)['items'][0]
  self.assertEqual(p['total']['state'],'no_orders')
  self.assertIsNone(p['total']['days_left'])
 def test_insufficient_history(self):
  i,h=sample();h['since']='2026-10-03T12:00:00+03:00'
  p=calculate(i,h,7)
  self.assertFalse(p['enough']);self.assertIsNone(p['items'][0]['total']['rate'])
 def test_missing_warehouse_does_not_erase_analytics_total(self):
  i,h=sample();i['analytics'].pop()
  p=calculate(i,h,7)['items'][0]
  self.assertEqual(p['total']['available'],20)
  self.assertEqual(p['unmatched_stock_warehouses'],1)
 def test_screenshot_regression_226_units_six_per_day(self):
  i,h=sample();i['analytics']=[row(10,1,226)]
  h['postings']=[posting('x',1,84)]
  p=calculate(i,h,14)['items'][0]
  self.assertEqual(p['total']['available'],226)
  self.assertEqual(p['total']['rate'],6)
  self.assertAlmostEqual(p['total']['days_left'],226/6)
 def test_no_analytics_rows_still_unknown(self):
  i,h=sample();i['analytics']=[]
  self.assertEqual(calculate(i,h,7)['items'][0]['total']['state'],'unknown_stock')
 def test_date_calculation(self):
  i,h=sample();p=calculate(i,h,7)['items'][0]
  self.assertEqual(p['total']['ends_at'],'2026-11-09T12:00:00+03:00')
 def test_warehouse_extracted_from_api(self):
  def fake(path,body):
   self.assertTrue(body['with']['analytics_data'])
   return {'has_next':False,'postings':[{'posting_number':'n','status':'delivered',
    'created_at':'2026-10-01T12:00:00Z','analytics_data':{'warehouse_id':123,'warehouse_name':'ОМСК','city':'secret'},
    'products':[{'sku':10,'quantity':1}]}]}
  h=Ozon('1','fake',transport=fake).postings(30,lambda _:None)
  self.assertTrue(h['warehouse_attribution'])
  self.assertEqual(h['postings'][0]['warehouse_id'],'123')
  self.assertNotIn('city',h['postings'][0])

import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from backend.sales_delivery import MOSCOW, build_sales_with_deliveries, delivered_snapshot, local_day
from backend.storage import Store


def entry(scheme,number,sku,quantity):
    return {'scheme':scheme,'number':number,
            'products':[{'sku':str(sku),'quantity':quantity}]}


def ordered():
    return {
        'rows':[
            {'date':'2026-11-19','ordered_units':8,'ordered_revenue':2500.0},
            {'date':'2026-11-20','ordered_units':5,'ordered_revenue':1200.0},
        ],
        'by_sku':[
            {'sku':'101','date':'2026-11-19','ordered_units':3,'ordered_revenue':600.0},
            {'sku':'102','date':'2026-11-19','ordered_units':5,'ordered_revenue':1900.0},
            {'sku':'101','date':'2026-11-20','ordered_units':5,'ordered_revenue':1200.0},
        ],
    }


def checked():
    return {
        '2026-11-19':{
            'FBO':{'ok':True,'postings':[entry('FBO','fbo-1',101,2)]},
            'FBS':{'ok':True,'postings':[entry('FBS','fbs-1',102,1)]},
        },
        '2026-11-20':{
            'FBO':{'ok':True,'postings':[entry('FBO','fbo-2',101,4)]},
            'FBS':{'ok':True,'postings':[]},
        },
    }


class DeliveryAccountingTests(unittest.TestCase):
    def test_totals_count_units_by_scheme_and_sku(self):
        result=build_sales_with_deliveries(ordered(),checked())
        self.assertEqual([row['delivered_units'] for row in result['rows']],[3,4])
        by_sku={(r['sku'],r['date']):r for r in result['by_sku']}
        self.assertEqual(by_sku[('101','2026-11-19')]['delivered_units'],2)
        self.assertEqual(by_sku[('102','2026-11-19')]['delivered_units'],1)
        self.assertEqual(by_sku[('101','2026-11-20')]['delivered_units'],4)
        self.assertEqual(result['delivery_incomplete_days'],[])
        self.assertTrue(result['delivery_complete'])
        self.assertTrue(result['delivered_available'])

    def test_failed_scheme_marks_missing_day_not_zero(self):
        data=checked()
        data['2026-11-19']['FBS']={'ok':False,'postings':[],'error':'403'}
        result=build_sales_with_deliveries(ordered(),data)
        self.assertEqual(result['rows'][0]['delivered_units'],2)
        self.assertTrue(result['rows'][0]['delivery_partial'])
        self.assertEqual(result['rows'][1]['delivered_units'],4)
        self.assertIn('FBS',result['delivered_error'])
        self.assertEqual(result['delivery_incomplete_days'],['2026-11-19'])
        self.assertFalse(result['delivery_complete'])
        self.assertEqual(result['delivery_label'],'Доставлено · неполные данные')

    def test_two_failed_schemes_leave_unknown_not_zero(self):
        data=checked()
        data['2026-11-19']['FBO']={'ok':False,'postings':[],'error':'403'}
        data['2026-11-19']['FBS']={'ok':False,'postings':[],'error':'403'}
        result=build_sales_with_deliveries(ordered(),data)
        self.assertIsNone(result['rows'][0]['delivered_units'])
        self.assertFalse(result['rows'][0]['delivery_partial'])
        self.assertEqual(result['rows'][1]['delivered_units'],4)

    def test_verified_webhook_date_moves_posting_without_duplication(self):
        data=checked()
        event={'scheme':'FBO','posting_number':'fbo-2',
               'delivered_at':'2026-11-19T18:00:00Z'}
        result=build_sales_with_deliveries(ordered(),data,[event])
        self.assertEqual([r['delivered_units'] for r in result['rows']],[7,0])

    def test_webhook_without_known_product_does_not_fabricate_units(self):
        result=build_sales_with_deliveries(ordered(),checked(),[{
            'scheme':'FBO','posting_number':'new',
            'delivered_at':'2026-11-20T11:30:00Z',
        }])
        self.assertEqual(result['rows'][1]['delivered_units'],4)

    def test_webhook_uses_history_to_identify_sku(self):
        result=build_sales_with_deliveries(ordered(),checked(),[{
            'scheme':'FBO','posting_number':'new',
            'delivered_at':'2026-11-20T11:30:00Z',
        }],history={'postings':[entry('FBO','new',102,5)]})
        self.assertEqual(result['rows'][1]['delivered_units'],9)
        rows={(r['sku'],r['date']):r for r in result['by_sku']}
        self.assertEqual(rows[('102','2026-11-20')]['delivered_units'],5)

    def test_moscow_day_uses_time_zone_instead_of_utc_date(self):
        self.assertEqual(local_day('2026-11-19T22:30:00Z'),'2026-11-20')
        self.assertIsNone(local_day('2026-11-19T22:30:00'))

    def test_historical_fbo_is_not_queried_through_unsupported_posting_filter(self):
        class API:
            def __init__(self):
                self.calls=[]
            def delivered_postings_for_day(self,day,scheme):
                self.calls.append(scheme)
                if scheme=='FBO':
                    raise AssertionError('FBO must use Push, not posting date filters')
                return []

        api=API()
        today=datetime.now(MOSCOW).date()
        result=delivered_snapshot(api,today,today,None,lambda _:None)
        self.assertEqual(api.calls,['FBS'])
        self.assertFalse(result[today.isoformat()]['FBO']['ok'])
        self.assertTrue(result[today.isoformat()]['FBS']['ok'])
        self.assertIn('Ozon Push',result[today.isoformat()]['FBO']['error'])

    def test_partial_day_with_zero_available_units_is_unknown_not_zero(self):
        result=build_sales_with_deliveries(ordered(),{
            '2026-11-19':{
                'FBO':{'ok':False,'postings':[],'error':'Push not configured'},
                'FBS':{'ok':True,'postings':[]},
            },
            '2026-11-20':{
                'FBO':{'ok':False,'postings':[],'error':'Push not configured'},
                'FBS':{'ok':True,'postings':[]},
            },
        })
        self.assertIsNone(result['rows'][0]['delivered_units'])
        self.assertIsNone(result['rows'][1]['delivered_units'])
        self.assertTrue(all(row['delivered_units'] is None for row in result['by_sku']))
        self.assertFalse(result['delivered_available'])

    def test_successful_older_days_are_not_fetched_again(self):
        class API:
            calls=[]
            def delivered_postings_for_day(self,day,scheme):
                self.calls.append((day,scheme))
                return []
        api=API()
        # A historical day is reused, avoiding two extra API requests.
        cached={'delivery_days':{
            '2026-01-05':{
                'FBO':{'ok':True,'postings':[]},
                'FBS':{'ok':True,'postings':[]},
            }
        }}
        result=delivered_snapshot(api,date(2026,1,5),date(2026,1,5),
                                 cached,lambda _:None)
        self.assertEqual(api.calls,[])
        self.assertTrue(result['2026-01-05']['FBO']['ok'])


class DeliveryEventStoreTests(unittest.TestCase):
    def test_deduplicated_event_storage(self):
        with tempfile.TemporaryDirectory() as root:
            store=Store(Path(root)/'inventory.sqlite3')
            self.assertTrue(store.save_delivery_event(
                'account:a','event-1','a-1','2026-11-20T12:00:00+00:00',
            ))
            self.assertFalse(store.save_delivery_event(
                'account:a','event-1','a-1','2026-11-20T12:00:00+00:00',
            ))
            self.assertEqual(len(store.delivery_events('account:a')),1)
            self.assertEqual(store.delivery_events('account:b'),[])


if __name__=='__main__':
    unittest.main()

import unittest

from backend.ozon import Ozon, ApiError


def row(sku, day, metrics):
    return {
        'dimensions': [{'id': sku, 'name': 'Товар'}, {'id': day, 'name': day}],
        'metrics': metrics,
    }


class SalesAnalyticsTests(unittest.TestCase):
    def test_ordered_units_are_grouped_by_day_and_sku_without_premium(self):
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            self.assertEqual(path, '/v1/analytics/data')
            self.assertEqual(payload['dimension'], ['sku', 'day'])
            self.assertEqual(payload['metrics'], ['ordered_units', 'revenue'])
            return {'result': {'data': [
                row(1001, '2026-11-19', [7, 2270]),
                row(1002, '2026-11-19', [3, 800]),
                row(1001, '2026-11-21', [2, 500]),
            ]}}

        result = Ozon('123', 'key', transport=transport).daily_sales(
            '2026-11-19', '2026-11-21', lambda _: None,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['rows'], [
            {'date':'2026-11-19','ordered_units':10,'ordered_revenue':3070.0},
            {'date':'2026-11-20','ordered_units':0,'ordered_revenue':0.0},
            {'date':'2026-11-21','ordered_units':2,'ordered_revenue':500.0},
        ])
        self.assertEqual(result['by_sku'][0], {
            'sku':'1001','date':'2026-11-19','ordered_units':7,'ordered_revenue':2270.0,
        })

    def test_duplicate_day_rows_are_summed(self):
        def transport(path, payload):
            return {'result':{'data': [
                row(1001,'2026-11-20',[2,100]),
                row(1001,'2026-11-20',[3,200]),
            ]}}
        result=Ozon('123','key',transport=transport).daily_sales(
            '2026-11-20','2026-11-20',lambda _:None,
        )
        self.assertEqual(result['rows'][0]['ordered_units'],5)
        self.assertEqual(result['by_sku'][0]['ordered_revenue'],300.0)

    def test_bad_free_response_fails_instead_of_mislabeling(self):
        def transport(path,payload):
            return {'result':{'data':[row(1001,'2026-11-20',[9])]}}
        with self.assertRaisesRegex(ApiError,'метрики заказов'):
            Ozon('123','key',transport=transport).daily_sales(
                '2026-11-20','2026-11-20',lambda _:None,
            )

    def test_date_order_and_length_are_validated(self):
        api=Ozon('123','key',transport=lambda *_:{})
        with self.assertRaises(ApiError):
            api.daily_sales('2026-11-21','2026-11-20',lambda _:None)
        with self.assertRaises(ApiError):
            api.daily_sales('2026-08-01','2026-11-20',lambda _:None)


class DeliveredPostingsTests(unittest.TestCase):
    def test_fbo_history_is_not_assigned_to_creation_day(self):
        def transport(path,payload):
            self.fail('Исторический фильтр изменения статуса FBO не документирован')
        with self.assertRaisesRegex(ApiError,'Историческая дата доставки FBO'):
            Ozon('123','key',transport=transport).delivered_postings_for_day(
                '2026-11-20','FBO',
            )

    def test_fbs_deliveries_use_latest_version_and_cursor(self):
        calls=[]

        def transport(path,payload):
            calls.append((path,payload))
            self.assertEqual(path,'/v4/posting/fbs/list')
            self.assertEqual(payload['filter']['statuses'],['delivered'])
            self.assertIn('last_changed_status_date',payload['filter'])
            if not payload['cursor']:
                return {'postings':[
                    {'posting_number':'a','status':'delivered','products':[{'sku':7,'quantity':2}]},
                ],'cursor':'next','has_next':True}
            return {'postings':[
                {'posting_number':'b','status':'delivered','products':[{'sku':8,'quantity':5}]},
            ],'has_next':False}
        data=Ozon('123','key',transport=transport).delivered_postings_for_day(
            '2026-11-20','FBS',
        )
        self.assertEqual(len(calls),2)
        self.assertEqual({p['number'] for p in data},{'a','b'})
        self.assertEqual(sum(p['products'][0]['quantity'] for p in data),7)

    def test_actual_fbs_delivery_date_wins_over_last_change_date(self):
        def transport(path,payload):
            return {'postings':[{
                'posting_number':'a','status':'delivered','products':[{'sku':7,'quantity':2}],
                'fact_delivery_date':'2026-11-19T00:00:00Z',
            }],'has_next':False}
        data=Ozon('123','key',transport=transport).delivered_postings_for_day(
            '2026-11-20','FBS',
        )
        self.assertEqual(data,[])

    def test_cursor_repeat_cannot_create_fake_totals(self):
        def transport(path,payload):
            return {'postings':[], 'cursor':'repeat','has_next':True}
        with self.assertRaisesRegex(ApiError,'курсор'):
            Ozon('123','key',transport=transport).delivered_postings_for_day(
                '2026-11-20','FBS',
            )


if __name__=='__main__':
    unittest.main()

import unittest
from datetime import date

from backend.digitization import summarize
from backend.ozon import Ozon


TYPES = [
    {'id': 1, 'name': 'SaleCommission'},
    {'id': 2, 'name': 'Logistic'},
    {'id': 3, 'name': 'Promotion'},
    {'id': 4, 'name': 'LastMileCourier'},
    {'id': 5, 'name': 'ReturnFlowLogistic'},
    {'id': 6, 'name': 'DeliveryToHandoverPlaceByOzon'},
    {'id': 7, 'name': 'Acquiring'},
    {'id': 8, 'name': 'PickUpPointReturnAcceptance'},
    {'id': 9, 'name': 'PackingFee'},
    {'id': 10, 'name': 'PackageCost'},
    {'id': 11, 'name': 'Storage'},
    {'id': 12, 'name': 'Штраф'},
    {'id': 13, 'name': 'Платная приемка'},
]


def row(type_id, amount, quantity=0, seller_price=0, sku=None):
    return {'type_id': type_id, 'amount': amount, 'quantity': quantity,
            'seller_price': seller_price, 'sku': sku}


class DigitizationTests(unittest.TestCase):
    def test_uploaded_reports_reference_totals(self):
        snapshot = {
            'since': '2026-09-30',
            'to': '2026-10-11',
            'effective_to': '2026-10-10',
            'current_day_excluded': True,
            'accrual_types': TYPES,
            'accrual_rows': [
                row(1, -26779.07, 121, 58489 / 121, 100),
                row(1, 410.55, 1, -805, 101),
                row(2, -6764.76),
                row(3, -1375.00),
                row(4, -815.21),
                row(5, -414.08),
                row(6, -300.00),
                row(7, -184.44),
                row(8, -135.00),
                row(9, -50.00),
                row(10, -25.00),
            ],
            'by_day_fee_rows': [
                row(7, -544.41),
                row(3, -1375.00),
            ],
            'sales_facts': {
                'revenue': 32819.17,
                'partner_programs': 291.48,
                'discount_points': 24960.97,
                'products': [],
            },
            'buyout_products': [
                {'sku': 200, 'quantity': 1, 'seller_price_per_instance': 785, 'amount': 361.1},
                {'sku': 201, 'quantity': 1, 'seller_price_per_instance': 135, 'amount': 99.9},
            ],
            'placement_cost': 0,
            'returns': {'quantity': 15, 'rows': 15, 'by_type': {'FullReturn': 14, 'PartialReturn': 1}},
            'orders': {'amount': 50945, 'quantity': 124, 'errors': []},
        }
        result = summarize(snapshot)
        m = result['metrics']
        self.assertEqual(m['orders_amount'], 50945.0)
        self.assertEqual(m['orders_quantity'], 124)
        self.assertEqual(m['realization'], 58604.0)
        self.assertEqual(m['sales_amount'], 33643.03)
        self.assertEqual(m['sales_quantity'], 122)
        self.assertEqual(m['returns_amount'], 805.0)
        self.assertEqual(m['returns_quantity'], 1)
        self.assertEqual(m['buyout_percent'], 89.05)
        self.assertEqual(m['refusals_returns_quantity'], 15)
        self.assertEqual(m['logistics'], 8429.05)
        self.assertEqual(m['logistics_share'], 14.38)
        self.assertEqual(m['nominal_commission'], 26827.52)
        self.assertEqual(m['nominal_commission_share'], 45.78)
        self.assertEqual(m['acquiring'], 544.41)
        self.assertEqual(m['advertising'], 1375.0)
        self.assertEqual(m['discount_points'], 24960.97)
        self.assertEqual(m['other_deductions'], 75.0)

    def test_machine_names_are_mapped(self):
        snapshot = {
            'accrual_types': TYPES,
            'accrual_rows': [row(2, -100), row(4, -20), row(7, -10), row(3, -30)],
            'by_day_fee_rows': [row(7, -10), row(3, -30)],
            'sales_facts': {},
            'buyout_products': [],
            'orders': {},
        }
        m = summarize(snapshot)['metrics']
        self.assertEqual(m['logistics'], 120.0)
        self.assertEqual(m['acquiring'], 10.0)
        self.assertEqual(m['advertising'], 30.0)
        self.assertEqual(m['other_deductions'], 0.0)

    def test_buyout_commission_does_not_reduce_sales_twice(self):
        snapshot = {
            'accrual_types': TYPES,
            'accrual_rows': [],
            'sales_facts': {'revenue': 0, 'partner_programs': 0, 'discount_points': 0},
            'buyout_products': [{'quantity': 2, 'seller_price_per_instance': 100, 'amount': 150}],
            'orders': {},
        }
        m = summarize(snapshot)['metrics']
        self.assertEqual(m['realization'], 200.0)
        self.assertEqual(m['sales_amount'], 200.0)
        self.assertEqual(m['sales_quantity'], 2)
        self.assertEqual(m['nominal_commission'], 50.0)

    def test_paid_acceptance_and_penalties_are_not_other_deductions(self):
        snapshot = {
            'accrual_types': TYPES,
            'accrual_rows': [row(12, -17), row(13, -23), row(9, -5)],
            'sales_facts': {},
            'buyout_products': [],
            'orders': {},
        }
        m = summarize(snapshot)['metrics']
        self.assertEqual(m['penalties'], 17.0)
        self.assertEqual(m['paid_acceptance'], 23.0)
        self.assertEqual(m['other_deductions'], 5.0)

    def test_long_period_is_split_into_internal_31_day_chunks(self):
        chunks = list(Ozon._date_chunks(date(2026, 8, 1), date(2026, 9, 30)))
        self.assertEqual(chunks, [
            (date(2026, 8, 1), date(2026, 8, 31)),
            (date(2026, 9, 1), date(2026, 9, 30)),
        ])

    def test_redemption_uses_customer_decision_timing(self):
        api = Ozon.__new__(Ozon)
        filters = []
        item_id = 0

        def fake_call(path, payload):
            nonlocal item_id
            self.assertEqual(path, '/v1/returns/list')
            filters.append(next(iter(payload['filter'])))
            item_id += 1
            return {
                'returns': [{'id': item_id, 'type': 'Return', 'product': {'quantity': 1}}],
                'has_next': False,
            }

        api.call = fake_call
        result = api._returns_for_period(
            date(2026, 8, 1), date(2026, 9, 30), lambda _message: None,
        )
        self.assertEqual(result['quantity'], 2)
        self.assertEqual(result['date_filter'], 'visual_status_change_moment')
        self.assertEqual(filters, ['visual_status_change_moment', 'visual_status_change_moment'])


if __name__ == '__main__':
    unittest.main()

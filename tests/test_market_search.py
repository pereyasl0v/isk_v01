import asyncio
import unittest

import httpx
from backend.market_search import extract_products,fetch_wb_top10

class MarketSearchTests(unittest.TestCase):
    def test_prices_from_har_schema(self):
        data={'products':[{'id':542519138,'name':'Щипцы','sizes':[{'price':{'product':35900,'basic':113600}}]}]}
        rows=extract_products(data)
        self.assertEqual(rows[0].price_rub,359)
        self.assertEqual(rows[0].basic_price_rub,1136)

    def test_search_reuses_first_ten_and_source(self):
        def handler(request):
            self.assertEqual(request.url.params['query'],'щипцы свп')
            return httpx.Response(200,json={'products':[{'id':i,'name':'Товар','sizes':[{'price':{'product':9900}}]} for i in range(1,14)]})
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await fetch_wb_top10(client,'щипцы свп',1259570991)
        rows,source=asyncio.run(run())
        self.assertEqual(len(rows),10)
        self.assertEqual(rows[0].id,'1')
        self.assertTrue(source.startswith('https://www.wildberries.ru/'))

if __name__=='__main__':unittest.main()

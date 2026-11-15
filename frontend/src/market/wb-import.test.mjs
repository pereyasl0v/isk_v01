import test from "node:test";
import assert from "node:assert/strict";
import {parseWBCaptureText, normalizedQuery} from "./wb-import.mjs";

const mkProduct = (id, cents) => ({
  id, name: "Щипцы СВП", brand: "Тест",
  sizes: [{price: {basic: cents + 20000, product: cents, wallet: 0}}]
});
const mkEntry = (query, cards, extra = "") => ({
  request: {
    url: "https://www.wildberries.ru/__internal/u-search/exactmatch/ru/common/v18/search"
      + "?appType=64&dest=1259570991&query=" + encodeURIComponent(encodeURIComponent(query))
      + "&resultset=catalog" + extra
  },
  response: {status: 200, content: {text: JSON.stringify({products: cards, metadata: {catalog_type: "preset"}})}}
});

test("decodes WB double-encoded query correctly", () => {
  assert.equal(normalizedQuery("%D1%89%D0%B8%D0%BF%D1%86%D1%8B%20%D1%81%D0%B2%D0%BF"), "щипцы свп");
});

test("reads only top 10 cards from HAR and prices in kopecks", () => {
  const cards = Array.from({length: 12}, (_, i) => mkProduct(i+1000, 35900+i*100));
  const har = {log: {entries: [mkEntry("щипцы свп", cards)]}};
  const result = parseWBCaptureText(JSON.stringify(har), "щипцы свп");
  assert.equal(result.query, "щипцы свп");
  assert.equal(result.products.length, 10);
  assert.equal(result.products[0].price_rub, 359);
  assert.equal(result.products[0].basic_price_rub, 559);
  assert.equal(result.products[9].position, 10);
  assert.equal(result.source, "HAR браузера WB");
});

test("prefers initial no-page search over page=1 and page=2", () => {
  const initial = mkEntry("щипцы свп", [mkProduct(111, 35900)]);
  const page1 = mkEntry("щипцы свп", [mkProduct(222, 36700)], "&page=1");
  const page2 = mkEntry("щипцы свп", [mkProduct(333, 89000)], "&page=2");
  const result = parseWBCaptureText(JSON.stringify({log: {entries:[initial,page1,page2]}}), "щипцы свп");
  assert.equal(result.products[0].id, "111");
});

test("uses matching query when HAR contains several searches", () => {
  const result = parseWBCaptureText(JSON.stringify({log: {entries:[
    mkEntry("скребок", [mkProduct(101, 90000)]),
    mkEntry("щипцы свп", [mkProduct(202, 35000)])
  ]}}), "щипцы свп");
  assert.equal(result.products[0].id, "202");
});

test("reads sanitized JSON created by userscript without dividing rubles again", () => {
  const capture = {query:"щипцы свп",products:[
    {id:"542519138",name:"Щипцы СВП",price_rub:359,basic_price_rub:1136}
  ]};
  const result = parseWBCaptureText(JSON.stringify(capture), "щипцы свп");
  assert.equal(result.products[0].price_rub,359);
  assert.equal(result.products[0].basic_price_rub,1136);
});

test("does not silently invent missing products or prices", () => {
  assert.throws(()=>parseWBCaptureText(JSON.stringify({log:{entries:[]}})), /HAR/);
  assert.throws(()=>parseWBCaptureText(JSON.stringify({foo:"bar"})), /JSON/);
});

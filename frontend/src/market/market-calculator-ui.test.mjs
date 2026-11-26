import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('./MarketCalculator.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./market.css', import.meta.url), 'utf8');

test('add-product action stays visible while scrolling through the product list', () => {
  assert.match(component, /className="mc-section-heading mc-add-product-sticky"/);
  assert.match(component, /onClick=\{addProduct\}><Plus size=\{16\} \/> Добавить товар/);
  assert.match(styles, /\.mc \.mc-add-product-sticky\{[^}]*position:sticky;[^}]*top:10px;[^}]*z-index:30/);
});

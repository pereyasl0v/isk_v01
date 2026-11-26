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


test('each product can collapse to its own cost summary and keeps its cost breakdown inline', () => {
  assert.match(component, /const \[collapsedProductIds, setCollapsedProductIds\] = useState\(\(\) => new Set\(\)\)/);
  assert.match(component, /className=\{"mc-product-card " \+ \(expanded \? "is-expanded" : "is-collapsed"\)\}/);
  assert.match(component, /aria-expanded=\{expanded\} aria-controls=\{fieldsId\}/);
  assert.match(component, /<span className="mc-product-quantity">\{quantity\(product\.quantity\)\} шт\.<\/span>/);
  assert.match(component, /<span className="mc-product-unit-cost">\{unitCost != null \? money\(unitCost\) \+ " \/ шт\."/);
  assert.match(component, /<Breakdown product=\{calculatedProduct\} route=\{route\} showProductTotals=\{true\} \/>/);
  assert.doesNotMatch(component, /<h2>Себестоимость<\/h2>/);
  assert.doesNotMatch(component, /mc-results-section|mc-product-result/);
  assert.match(styles, /\.mc \.mc-product-card\.is-expanded \.mc-product-toggle-icon\{transform:rotate\(180deg\)\}/);
});

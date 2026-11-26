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
  assert.match(component, /<h2>Себестоимость<\/h2>/);
  assert.match(component, /className="mc-results-section"/);
  assert.doesNotMatch(component, /mc-product-result/);
  assert.match(styles, /\.mc \.mc-product-card\.is-expanded \.mc-product-toggle-icon\{transform:rotate\(180deg\)\}/);
});


test('product details come first, route selection follows them, and total cost is shown last', () => {
  const productsIndex = component.indexOf('{draft.products.map(product =>');
  const routeIndex = component.indexOf('<section className="mc-panel mc-route-select-panel">');
  const costIndex = component.indexOf('<section className="mc-results-section">');
  assert.ok(productsIndex >= 0 && routeIndex > productsIndex, 'route selector follows the product fields');
  assert.ok(costIndex > routeIndex, 'cost summary follows route selection and route parameters');
});

test('packaging percentage is a shared general parameter, not a field on the first product', () => {
  const sharedFieldIndex = component.indexOf('label="Вес упаковки от нетто"');
  const productsIndex = component.indexOf('{draft.products.map(product =>');
  assert.ok(sharedFieldIndex >= 0 && sharedFieldIndex < productsIndex);
  assert.match(component, /className="mc-general-parameters"/);
  assert.doesNotMatch(component, /index === 0 && <NumberField label="Вес упаковки от нетто"/);
});


test('form typography is comfortably readable without expanding the layout', () => {
  assert.match(styles, /\.mc \.mc-field>span\{[^}]*font-size:13px/);
  assert.match(styles, /\.mc \.mc-field input,\.mc \.mc-field select\{[^}]*font-size:15px/);
  assert.match(styles, /\.mc \.mc-field em\{[^}]*font-size:12px/);
  assert.match(styles, /\.mc \.mc-product-fields\{gap:8px 12px\}/);
  assert.match(styles, /\.mc \.mc-product-card\{margin-top:10px;padding:13px\}/);
  assert.match(styles, /@media\(max-width:600px\)\{\s*\.mc \.mc-field input,\.mc \.mc-field select\{font-size:16px\}/);
});

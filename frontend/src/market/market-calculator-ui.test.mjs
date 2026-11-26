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


test('each product can collapse to its summary and cost composition lives in the standalone cost section', () => {
  assert.ok(component.includes('const [collapsedProductIds, setCollapsedProductIds] = useState(() => new Set((shipment?.data?.products ?? []).map(product => product.id)))'));
  assert.ok(component.includes('setCollapsedProductIds(new Set((shipment?.data?.products ?? []).map(product => product.id)))'));
  assert.ok(component.includes('}, [shipment?.id, shipmentProductIds]);'));
  assert.ok(component.includes('className={"mc-product-card " + (expanded ? "is-expanded" : "is-collapsed")}'));
  assert.ok(component.includes('aria-expanded={expanded} aria-controls={fieldsId}'));
  const summaryStart = component.indexOf('<span className="mc-product-summary">');
  const summaryEnd = component.indexOf('</span>', summaryStart);
  const productSummary = component.slice(summaryStart, summaryEnd);
  assert.ok(productSummary.includes('<strong>{product.name.trim() || "Новый товар"}</strong>'));
  assert.doesNotMatch(productSummary, /mc-product-quantity|mc-product-unit-cost|quantity\(|unitCost|money\(/);
  assert.ok(component.includes('<div><strong>{product.name.trim() || "Товар"}</strong><span>{quantity(product.quantity)} шт.</span></div>'));
  assert.ok(component.includes('<Breakdown product={product} route={route} showProductTotals={true} />'));
  assert.ok(component.includes('className="mc-cost-products"'));
  assert.ok(component.includes('className="mc-cost-product-heading"'));
  assert.ok(component.includes('<Breakdown product={product} route={route} showProductTotals={true} />'));
  assert.ok(component.includes('<h2>Себестоимость</h2>'));
  assert.ok(component.includes('className="mc-results-section"'));
  assert.doesNotMatch(component, /mc-product-result/);
  const productStart = component.indexOf('{draft.products.map(product =>');
  const routeStart = component.indexOf('<section className="mc-panel mc-route-select-panel">');
  assert.doesNotMatch(component.slice(productStart, routeStart), /<Breakdown/);
  assert.ok(styles.includes('.mc .mc-product-card.is-expanded .mc-product-toggle-icon{transform:rotate(180deg)}'));
  assert.ok(styles.includes('.mc .mc-cost-products{display:grid;gap:10px;margin-top:14px}'));
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

test('Guangzhou delivery has a per-product checkbox and reveals the yuan price only when enabled', () => {
  assert.ok(component.includes('className="mc-checkbox-field"'));
  assert.ok(component.includes('checked={deliveryToGuangzhouEnabled}'));
  assert.ok(component.includes('updateProduct(product.id, "deliveryToGuangzhouEnabled", event.target.checked)'));
  assert.ok(component.includes('{deliveryToGuangzhouEnabled && <NumberField label="Цена за доставку в юанях"'));
  assert.ok(component.includes('const goodsYuan = baseGoodsYuan + (deliveryToGuangzhouEnabled ? n(product.deliveryToGuangzhouYuan) : 0);'));
  assert.ok(component.includes('label="Стоимость товара в рублях в Китае"'));
  assert.ok(styles.includes('.mc .mc-checkbox-field{display:flex;align-items:center;align-self:end;'));
});



test('mobile add-product action sticks below the safe-area-aware navigation bar', () => {
  const mobile = readFileSync(new URL('../mobile.css', import.meta.url), 'utf8');
  assert.match(mobile, /--mobile-app-bar-height: calc\(61px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(mobile, /\.mobile-app-bar \{[^}]*position: sticky;[^}]*z-index: 40;[^}]*height: var\(--mobile-app-bar-height\)/);
  assert.match(mobile, /\.mc \.mc-add-product-sticky \{[^}]*top: calc\(var\(--mobile-app-bar-height\) \+ 6px\);[^}]*z-index: 9/);
});

test('installed web app has a root scope and standalone display for all internal routes', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../../public/assets/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.match(html, /<link rel="manifest" href="\/assets\/manifest.webmanifest"\/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"\/>/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/');
  assert.ok(manifest.icons.some(icon => icon.src === '/assets/apple-touch-icon.png'));
});

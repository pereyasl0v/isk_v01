import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./main.jsx',import.meta.url),'utf8');
const connection=source.split('function Connection(){')[1]?.split('function Logs(){')[0];
const lucideImport=source.match(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/);

test('account directory imports every displayed marketplace menu icon',()=>{
  assert.ok(connection,'Account directory component must exist');
  assert.ok(lucideImport,'lucide-react named imports must exist');
  const imports=new Set(lucideImport[1].split(',').map(name=>name.trim().split(/\s+as\s+/).pop()));
  for(const icon of ['Plus','ChevronDown','ArrowRight','CircleCheck','LogOut','Plug','X']){
    if(new RegExp(`<${icon}(?:\\s|\\/|>)`).test(connection)){
      assert.ok(imports.has(icon),`<${icon}/> is used in Connection but missing from lucide-react import; the page will be blank at runtime`);
    }
  }
});

test('WB flow is a non-functional placeholder, Ozon still uses the existing API',()=>{
  assert.match(connection,/chooseMarketplace\('ozon'\)/);
  assert.match(connection,/chooseMarketplace\('wb'\)/);
  assert.match(connection,/api\('\/connect'/);
  assert.match(connection,/кабинет WB не создаётся/);
});

test('only a green upper-right indicator marks the selected account',()=>{
  const styles=readFileSync(new URL('./accountMarketplace.css',import.meta.url),'utf8');
  assert.match(connection,/selected&&<span className="marketplace-account-indicator"/);
  assert.match(connection,/aria-label="Выбранный кабинет"/);
  assert.match(styles,/\.marketplace-account-indicator\{position:absolute;top:16px;right:16px;/);
  assert.match(styles,/background:#23a36a/);
  assert.doesNotMatch(connection,/Активный|Подключён|>Выбран</);
  assert.doesNotMatch(connection,/marketplace-account-current|marketplace-selected-button|marketplace-active-connection/);
  assert.match(connection,/account\.connected&&isOzon&&!selected&&<button/);
  assert.match(connection,/!account\.connected&&<span className="disconnected-label">Ключ удалён/);
  assert.match(connection,/onClick=\{disconnect\}/);
});

test('Ozon letters are optically centered in every blue square',()=>{
  const styles=readFileSync(new URL('./accountMarketplace.css',import.meta.url),'utf8');
  assert.match(styles,/\.marketplace-symbol-ozon \.marketplace-symbol-text\{[^}]*letter-spacing:0;transform:translate\(-1px,-2px\)/);
  assert.equal((connection.match(/className="marketplace-symbol-text">oz<\/span>/g)||[]).length,3,
    'Ozon labels in menu, account card, and form share the same alignment');
});

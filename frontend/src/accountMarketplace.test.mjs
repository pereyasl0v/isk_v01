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

import base64
import hashlib
import hmac
import logging
import os
import secrets
import sqlite3
import threading
import time
from contextlib import nullcontext
from contextlib import asynccontextmanager
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Annotated
from fastapi import FastAPI, Request, Response, HTTPException, Depends, BackgroundTasks, Path as ApiPath
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field, FiniteFloat, SecretStr
from .security import (SESSION_TTL_SECONDS, decrypt_secret, encrypt_secret, encrypt_wb_token,
                       hash_password, load_encryption_key, token_digest, valid_username, verify_password)
from .ozon import Ozon, ApiError, MOSCOW_TZ
from .wildberries import Wildberries, WildberriesApiError
from .storage import Store
from .inventory import summarize, aggregate
from .replenishment import calculate as replenishment_calculate
from .market_search import router as market_router
from .digitization import summarize as digitization_summarize
from .digitization_cache import combine_digitization_days, download_digitization_day, requested_days, manual_digitization_latest_day
from .product_documents import router as product_documents_router
from .purchase_shipment_documents import router as purchase_shipment_documents_router
from .barcode_archive import router as barcode_archive_router
from .costing import clean_workspace, parse_legacy_xlsx, calculate_workspace
from .preliminary_costing import clean_preliminary_cost, calculate_preliminary_cost
from .sales_delivery import build_sales_with_deliveries, delivered_snapshot
from .sales_finance import add_financial_sales
from .sales_period import sales_chart_period

ROOT=Path(__file__).resolve().parents[1]
DATA=Path(os.environ.get('OZON_FBO_DATA_DIR',str(Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'VKR_Ozon_FBO_Web')))
DATA.mkdir(parents=True,exist_ok=True)
try: os.chmod(DATA,0o700)
except OSError: pass
ENCRYPTION_KEY=load_encryption_key()
store=Store(DATA/'inventory.sqlite3',encryption_key=ENCRYPTION_KEY)
# Deployment controller checks this file from inside the container before
# restarting. It is intentionally not exposed through any HTTP endpoint.
ACTIVE_JOB_MARKER=DATA/'.isk_active_job'
DEPLOY_GATE=DATA/'.isk_deploying'

def update_active_job_marker():
    """Called under the runtime lock after every job state transition."""
    if any(runtime.get('job',{}).get('running') for runtime in runtime_accounts.values()):
        ACTIVE_JOB_MARKER.touch(exist_ok=True)
    else:
        ACTIVE_JOB_MARKER.unlink(missing_ok=True)

@asynccontextmanager
async def lifespan(app):
    # A previous container crash may leave an obsolete marker in the volume.
    # Clearing it on startup is safe because no old in-process jobs survive.
    ACTIVE_JOB_MARKER.unlink(missing_ok=True)
    DEPLOY_GATE.unlink(missing_ok=True)
    stop=threading.Event()
    worker=threading.Thread(target=run_digitization_schedule,args=(stop,),daemon=True)
    worker.start()
    try:
        yield
    finally:
        stop.set()


app=FastAPI(title='Интелектуальная система контроля (ИСК)',version='0.3.0',docs_url=None,redoc_url=None,lifespan=lifespan)
ALLOWED_HOSTS=[v.strip() for v in os.getenv('ISK_ALLOWED_HOSTS','127.0.0.1,localhost,testserver').split(',') if v.strip()]
app.add_middleware(TrustedHostMiddleware,allowed_hosts=ALLOWED_HOSTS)
runtime_accounts={}
lock=threading.RLock()
ALLOWED_ORIGINS={v.strip() for v in os.getenv('ISK_ALLOWED_ORIGINS',
    'http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5173,http://localhost:5173').split(',') if v.strip()}


@app.middleware('http')
async def local_guard(request,call_next):
    if request.url.path.startswith('/api') and request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        if not origin or origin not in ALLOWED_ORIGINS:
            return JSONResponse({'detail':'Недопустимый источник запроса.'},status_code=403)
    response=await call_next(request)
    response.headers['Cache-Control']='no-store'
    response.headers['Pragma']='no-cache'
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request,exc):
    return JSONResponse({'detail':'Проверьте формат введённых данных.'},status_code=422)


def authenticated(request:Request):
    raw=request.cookies.get('isk_session','')
    if not raw:raise HTTPException(401,'Войдите в систему.')
    digest=token_digest(raw)
    session=store.get_auth_session(digest)
    if not session:raise HTTPException(401,'Сессия истекла. Войдите снова.')
    session['token_hash']=digest
    return session


app.include_router(market_router,dependencies=[Depends(authenticated)])
app.include_router(product_documents_router)
app.include_router(purchase_shipment_documents_router)
app.include_router(barcode_archive_router)


def current(request):
    auth=authenticated(request)
    if not ENCRYPTION_KEY:
        raise HTTPException(503,'На сервере не настроен ключ шифрования. Администратор должен установить Docker secret.')
    account_id=auth.get('active_account_id')
    if not account_id:raise HTTPException(409,'Сначала выберите подключённый кабинет Ozon.')
    return account_runtime(account_id,auth['user_id'])


def account_runtime(account_id,user_id):
    account=store.get_ozon_account(account_id,user_id)
    if not account or not account['connected'] or not account['api_key_ciphertext']:
        raise HTTPException(409,'Кабинет Ozon не подключён. Выберите другой кабинет или подключите этот заново.')
    with lock:
        cached=runtime_accounts.get(account_id)
        if cached and cached.get('updated_at')==account['updated_at']:
            return cached
        try:api_key=decrypt_secret(account['api_key_ciphertext'],ENCRYPTION_KEY)
        except Exception:
            raise HTTPException(503,'Не удалось расшифровать ключ Ozon. Проверьте резервную копию ключа шифрования.') from None
        scope='account:'+account_id
        api=Ozon(account['client_id'],api_key,
            cache_get=lambda namespace,key,max_age: store.cache_get(scope,namespace,key,max_age),
            cache_put=lambda namespace,key,value: store.cache_put(scope,namespace,key,value))
        runtime={'user_id':user_id,'account_id':account_id,'client_id':account['client_id'],
            'client':scope,'api':api,'roles':account['roles'],'updated_at':account['updated_at'],
            'job':{'running':False,'message':'Кабинет подключён','error':None},'logs':[]}
        runtime_accounts[account_id]=runtime
        return runtime


def require_admin(request):
    auth=authenticated(request)
    if auth['user']['role']!='admin':raise HTTPException(403,'Доступ разрешён только администратору.')
    return auth


def owned_ozon_account(account_id: str,request: Request):
    auth=authenticated(request)
    if not store.get_ozon_account(account_id,auth["user_id"]):
        raise HTTPException(404,"Кабинет Ozon не найден.")
    return account_id


ProductCostAmount = Annotated[FiniteFloat, Field(ge=0,le=1_000_000_000)]
ProductCostSku = Annotated[str, Field(pattern=r"^[0-9]{1,30}$")]


class ProductCostUpdate(BaseModel):
    cost: ProductCostAmount | None


class LegacyProductCost(BaseModel):
    cost: ProductCostAmount
    fulfillment: ProductCostAmount = 0
    vat: ProductCostAmount = 0
    own_stock: ProductCostAmount = 0


class LegacyProductCosts(BaseModel):
    costs: dict[ProductCostSku,LegacyProductCost] = Field(max_length=20_000)


@app.get("/api/accounts/{account_id}/product-costs")
def digitization_product_costs(account_id: Annotated[str, Depends(owned_ozon_account)]):
    return {"costs":store.digitization_product_costs(account_id)}


@app.put("/api/accounts/{account_id}/product-costs/{sku}")
def update_digitization_product_cost(body: ProductCostUpdate,
                                     account_id: Annotated[str, Depends(owned_ozon_account)],
                                     sku: Annotated[str, ApiPath(pattern=r"^[0-9]{1,30}$")]):
    return store.save_digitization_product_cost(account_id,sku,body.cost)


@app.post("/api/accounts/{account_id}/product-costs/import")
def import_digitization_product_costs(body: LegacyProductCosts,
                                      account_id: Annotated[str, Depends(owned_ozon_account)]):
    store.import_digitization_product_costs(account_id,{sku:data.model_dump() for sku,data in body.costs.items()})
    return {"costs":store.digitization_product_costs(account_id)}


def public_account(account):
    return {'id':account['id'],'marketplace':'ozon',
            'client_id':account['client_id'],'connected':account['connected'],
            'roles':[r.get('name','') for r in account['roles'].get('roles',[])],
            'expires_at':account['roles'].get('expires_at'),'updated_at':account['updated_at']}


def public_wb_account(account):
    return {'id':account['id'],'marketplace':'wb',
            'client_id':account['client_id'],'connected':account['connected'],
            'roles':['Поставки (FBW)'] if account['connected'] else [],
            'expires_at':None,'updated_at':account['updated_at']}


def public_accounts(user_id):
    accounts=[public_account(a) for a in store.list_ozon_accounts(user_id)]
    accounts.extend(public_wb_account(a) for a in store.list_wb_accounts(user_id))
    return sorted(accounts,key=lambda account:account.get('updated_at') or '',reverse=True)


class CostingWorkspaceBody(BaseModel):
    revision:int=Field(ge=0)
    products:list[dict]=Field(default_factory=list)
    shipments:list[dict]=Field(default_factory=list)


class CostingImportBody(BaseModel):
    filename:str=Field(default='legacy.xlsx',max_length=200)
    file_base64:str=Field(min_length=1,max_length=15000000)


class PreliminaryCostBody(BaseModel):
    name:str=Field(min_length=1,max_length=160)
    data:dict


class Connect(BaseModel):
    client_id:str=Field(pattern=r'^\d+$',max_length=30)
    api_key:SecretStr


class ConnectWB(BaseModel):
    client_id:str=Field(pattern=r'^[A-Za-z0-9._-]{1,80}    username:str=Field(min_length=3,max_length=32)
    password:SecretStr=Field(min_length=12,max_length=256)


class NewUser(BaseModel):
    username:str=Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$')
    password:SecretStr=Field(min_length=12,max_length=256)


class UserStatus(BaseModel):
    active:bool


class SelectAccount(BaseModel):
    account_id:str=Field(min_length=1,max_length=64)


class History(BaseModel):
    days:int=Field(default=90,ge=1,le=365)


class DigitizationParams(BaseModel):
    date_from:date
    date_to:date


class SalesParams(BaseModel):
    days:int=Field(default=90,ge=7,le=90)
    backfill:bool=True


@app.get('/api/auth/status')
def auth_status():
    return {'initialized':store.count_users()>0}


@app.post('/api/auth/login')
def auth_login(body:Login,request:Request,response:Response):
    username=body.username.strip()
    ip=request.client.host if request.client else 'unknown'
    if store.login_is_locked(ip,username) or store.login_is_locked(ip,'*'):
        raise HTTPException(429,'Слишком много неудачных попыток. Повторите через 15 минут.')
    user=store.get_user_by_username(username)
    password=body.password.get_secret_value()
    if not user or not user['is_active'] or not verify_password(password,user['password_hash']):
        store.record_login_failure(ip,username)
        store.record_login_failure(ip,'*')
        raise HTTPException(401,'Неверный логин или пароль.')
    store.clear_login_failures(ip,username)
    store.clear_login_failures(ip,'*')
    old_token=request.cookies.get('isk_session','')
    if old_token:store.delete_auth_session(token_digest(old_token))
    accounts=store.list_ozon_accounts(user['id'])
    active=next((a['id'] for a in accounts if a['connected']),None)
    token=secrets.token_urlsafe(48)
    store.create_auth_session(token_digest(token),user['id'],active,SESSION_TTL_SECONDS)
    response.set_cookie('isk_session',token,httponly=True,samesite='strict',
        secure=os.getenv('ISK_SECURE_COOKIE','false').lower() in ('true','1','yes'),
        max_age=SESSION_TTL_SECONDS,path='/')
    return {'ok':True}


@app.post('/api/auth/logout')
def auth_logout(request:Request,response:Response):
    raw=request.cookies.get('isk_session','')
    if raw:store.delete_auth_session(token_digest(raw))
    response.delete_cookie('isk_session',path='/',httponly=True,
        secure=os.getenv('ISK_SECURE_COOKIE','false').lower() in ('true','1','yes'),samesite='strict')
    return {'ok':True}


@app.get('/api/auth/me')
def auth_me(request:Request):
    auth=authenticated(request)
    accounts=store.list_ozon_accounts(auth['user_id'])
    active_id=auth.get('active_account_id')
    active=next((a for a in accounts if a['id']==active_id and a['connected']),None)
    if not active:
        active=next((a for a in accounts if a['connected']),None)
        active_id=active['id'] if active else None
        store.set_session_account(auth['token_hash'],auth['user_id'],active_id)
    return {'user':auth['user'],'accounts':public_accounts(auth['user_id']),
            'active_account_id':active_id,'session_expires_at':auth['expires_at']}


@app.get('/api/costing')
def costing_get(request:Request):
    auth=authenticated(request)
    workspace=store.get_costing_workspace(auth['user_id'])
    return {**workspace,'calculated':calculate_workspace(workspace['products'],workspace['shipments'])}


@app.put('/api/costing')
def costing_save(body:CostingWorkspaceBody,request:Request):
    auth=authenticated(request)
    try:
        workspace=clean_workspace(body.products,body.shipments)
        saved=store.save_costing_workspace(auth['user_id'],body.revision,workspace)
    except ValueError as exc:
        raise HTTPException(409 if 'изменены на другом устройстве' in str(exc) else 422,str(exc)) from None
    return {**saved,'calculated':calculate_workspace(saved['products'],saved['shipments'])}


@app.post('/api/costing/import-xlsx')
def costing_import_xlsx(body:CostingImportBody,request:Request):
    auth=authenticated(request)
    try:
        raw=base64.b64decode(body.file_base64,validate=True)
        if len(raw)>10*1024*1024:
            raise ValueError('Excel-файл больше 10 МБ.')
        imported=parse_legacy_xlsx(raw)
        current=store.get_costing_workspace(auth['user_id'])
        products={str(item['id']):item for item in current['products']}
        products.update({str(item['id']):item for item in imported['products']})
        shipments={str(item['id']):item for item in current['shipments']}
        shipments.update({str(item['id']):item for item in imported['shipments']})
        workspace=clean_workspace(list(products.values()),list(shipments.values()))
        saved=store.save_costing_workspace(auth['user_id'],current['revision'],workspace)
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,str(exc)) from None
    except Exception as exc:
        # Do not expose workbook internals or server paths to the browser.
        raise HTTPException(422,'Не удалось импортировать Excel-файл.') from exc
    return {
        **saved,
        'importedProducts':imported['importedProducts'],
        'importedShipments':imported['importedShipments'],
        'calculated':calculate_workspace(saved['products'],saved['shipments']),
    }


class PurchaseShipmentBody(PreliminaryCostBody):
    request_id: str = Field(min_length=1,max_length=80,pattern=r"^[a-zA-Z0-9-]+$")
    calculation_id: str | None = None


@app.get('/api/purchase-shipments')
def purchase_shipments_list(request:Request):
    auth=authenticated(request)
    return {"items":store.list_purchase_shipments(auth["user_id"])}


@app.get('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_get(shipment_id:str,request:Request):
    auth=authenticated(request)
    shipment=store.get_purchase_shipment(auth["user_id"],shipment_id)
    if not shipment:
        raise HTTPException(404,"Поставка не найдена.")
    return shipment


@app.put('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_update(shipment_id:str,body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        if "selectedRoute" not in data:
            raise ValueError("Выберите маршрут доставки.")
        name=body.name.strip()
        if not name:
            raise ValueError("Укажите название поставки.")
        updated=store.update_purchase_shipment(
            auth["user_id"],shipment_id,name,data,calculate_preliminary_cost(data),
        )
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not updated:
        raise HTTPException(404,"Поставка не найдена.")
    return {"id": shipment_id}


@app.delete('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_delete(shipment_id:str,request:Request):
    auth=authenticated(request)
    if not store.delete_purchase_shipment(auth["user_id"],shipment_id):
        raise HTTPException(404,"Поставка не найдена.")
    return {"ok":True}


@app.post('/api/purchase-shipments',status_code=201)
def purchase_shipments_create(body:PurchaseShipmentBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        if "selectedRoute" not in data:
            raise ValueError("Выберите маршрут доставки.")
        calculated=calculate_preliminary_cost(data)
        record=store.save_preliminary_cost(
            auth["user_id"],body.calculation_id,body.name,data,
            shipment={"id":str(body.request_id),"calculated":calculated},
        )
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not record:
        raise HTTPException(404,"Предварительный расчёт не найден.")
    return record


@app.get('/api/preliminary-costs')
def preliminary_costs_list(request:Request,q:str=''):
    auth=authenticated(request)
    return {'items':store.list_preliminary_costs(auth['user_id'],q[:100])}


@app.get('/api/preliminary-costs/{record_id}')
def preliminary_costs_get(record_id:str,request:Request):
    auth=authenticated(request)
    record=store.get_preliminary_cost(auth['user_id'],record_id)
    if not record:
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.post('/api/preliminary-costs',status_code=201)
def preliminary_costs_create(body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        record=store.save_preliminary_cost(auth['user_id'],None,body.name,data)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.put('/api/preliminary-costs/{record_id}')
def preliminary_costs_update(record_id:str,body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        record=store.save_preliminary_cost(auth['user_id'],record_id,body.name,data)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not record:
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.delete('/api/preliminary-costs/{record_id}')
def preliminary_costs_delete(record_id:str,request:Request):
    auth=authenticated(request)
    if not store.delete_preliminary_cost(auth['user_id'],record_id):
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {'ok':True}


@app.get('/api/admin/users')
def admin_users(request:Request):
    require_admin(request)
    return {'users':store.list_users()}


@app.post('/api/admin/users')
def admin_create_user(body:NewUser,request:Request):
    require_admin(request)
    if not valid_username(body.username):
        raise HTTPException(422,'Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание.')
    try:user=store.create_user(body.username,hash_password(body.password.get_secret_value()),'user')
    except sqlite3.IntegrityError:raise HTTPException(409,'Пользователь с таким логином уже существует.') from None
    return {'user':{k:user[k] for k in ('id','username','role','is_active','created_at')}}


@app.post('/api/admin/users/{user_id}/status')
def admin_user_status(user_id:str,body:UserStatus,request:Request):
    auth=require_admin(request)
    if user_id==auth['user_id'] and not body.active:
        raise HTTPException(409,'Нельзя отключить собственный аккаунт администратора.')
    try:changed=store.set_user_active(user_id,body.active)
    except ValueError as exc:raise HTTPException(409,str(exc)) from None
    if not changed:raise HTTPException(404,'Пользователь не найден.')
    return {'ok':True}


@app.get('/api/accounts')
def accounts(request:Request):
    auth=authenticated(request)
    return {'accounts':public_accounts(auth['user_id']),
            'active_account_id':auth.get('active_account_id')}


@app.post('/api/accounts/select')
def select_account(body:SelectAccount,request:Request):
    auth=authenticated(request)
    if not store.set_session_account(auth['token_hash'],auth['user_id'],body.account_id):
        raise HTTPException(404,'Подключённый кабинет не найден в вашем аккаунте.')
    return {'ok':True,'active_account_id':body.account_id}


@app.post('/api/connect')
def connect(body:Connect,request:Request):
    auth=authenticated(request)
    if not ENCRYPTION_KEY:
        raise HTTPException(503,'Подключение недоступно: настройте ISK encryption key Docker secret.')
    client_id=body.client_id
    api_key=body.api_key.get_secret_value()
    try:
        api=Ozon(client_id,api_key)
        roles=api.roles()
    except ApiError as exc:
        raise HTTPException(400,str(exc)) from None
    ciphertext=encrypt_secret(api_key,ENCRYPTION_KEY)
    account=store.upsert_ozon_account(auth['user_id'],client_id,ciphertext,roles)
    scope='account:'+account['id']
    store.migrate_legacy_client_data(client_id,scope,account['id'])
    store.set_session_account(auth['token_hash'],auth['user_id'],account['id'])
    with lock:runtime_accounts.pop(account['id'],None)
    return {'client_id':client_id,'account_id':account['id'],'expires_at':roles.get('expires_at')}


@app.post('/api/wb/connect')
def connect_wb(body:ConnectWB,request:Request):
    auth=authenticated(request)
    if not ENCRYPTION_KEY:
        raise HTTPException(503,'Подключение WB недоступно: настройте ISK encryption key Docker secret.')
    client_id=body.client_id.strip()
    api_token=body.api_token.get_secret_value().strip()
    try:
        Wildberries(api_token).ping_supplies()
    except WildberriesApiError as exc:
        raise HTTPException(400,str(exc)) from None
    ciphertext=encrypt_wb_token(api_token,ENCRYPTION_KEY)
    account=store.upsert_wb_account(auth['user_id'],client_id,ciphertext)
    return {'client_id':client_id,'account_id':account['id'],'connected':True,
            'marketplace':'wb','scope':'supplies'}


@app.post('/api/wb/disconnect')
def disconnect_wb(body:SelectAccount,request:Request):
    auth=authenticated(request)
    account=store.get_wb_account(body.account_id,auth['user_id'])
    if not account:
        raise HTTPException(404,'Кабинет Wildberries не найден.')
    if not store.disconnect_wb_account(body.account_id,auth['user_id']):
        raise HTTPException(404,'Кабинет Wildberries не найден.')
    return {'ok':True,'data_preserved':True}


@app.post('/api/disconnect')
def disconnect(request:Request):
    auth=authenticated(request)
    account_id=auth.get('active_account_id')
    if not account_id:raise HTTPException(409,'Нет выбранного кабинета.')
    account=store.get_ozon_account(account_id,auth['user_id'])
    if not account:raise HTTPException(404,'Кабинет не найден.')
    with lock:
        running=runtime_accounts.get(account_id,{}).get('job',{}).get('running',False)
        if running:raise HTTPException(409,'Дождитесь завершения загрузки.')
        runtime_accounts.pop(account_id,None)
    store.disconnect_ozon_account(account_id,auth['user_id'])
    store.set_session_account(auth['token_hash'],auth['user_id'],None)
    return {'ok':True,'data_preserved':True}


@app.get('/api/state')
def state(request:Request):
    s=current(request)
    with lock:
        cache=store.cache_stats(s['client'],'ozon_api')
        return {'client_id':s['client_id'],'account_id':s['account_id'],
                'expires_at':s['roles'].get('expires_at'),
                'roles':[r.get('name','') for r in s['roles'].get('roles',[])],
                'job':dict(s['job']),'logs':list(s['logs']),'cache':cache,
                'digitization_periods':store.digitization_period_count(s['client']),
                'digitization_days':store.digitization_coverage(s['client'])}


SALES_REFRESH_INTERVAL = timedelta(minutes=10)


def sync_order_days(api,first,today,previous,progress):
    """Fill missing closed dates without touching the live orders point."""
    rows={row['date']:row for row in previous.get('rows',[])}
    by_sku=list(previous.get('by_sku',[]))
    day=first
    while day<today:
        if day.isoformat() in rows:
            day+=timedelta(days=1)
            continue
        start=day
        while day<today and day.isoformat() not in rows:
            day+=timedelta(days=1)
        loaded=api.daily_sales(start,day-timedelta(days=1),progress)
        rows.update((row['date'],row) for row in loaded['rows'])
        by_sku.extend(loaded['by_sku'])
    return {**previous,'rows':sorted(rows.values(),key=lambda row:row['date']),
            'by_sku':sorted(by_sku,key=lambda row:(str(row['sku']),row['date']))}


def launch(s,kind,days=90,date_from=None,date_to=None,backfill=True,morning=False):
    def progress(message):
        with lock:
            s['job']['message']=message
            s['logs'].append({'at':time.strftime('%H:%M:%S'),'message':message})
            s['logs']=s['logs'][-200:]
    with lock:
        if DEPLOY_GATE.exists():
            raise HTTPException(409,'ИСК устанавливает обновление. Повторите запуск после обновления.')
        if s['job']['running']:
            raise HTTPException(409,'Загрузка уже выполняется.')
        if kind=='sales':
            previous=store.latest(s['client'],'sales_analytics') or {}
            requested_first,today=sales_chart_period(days)
            covered={row['date'] for row in previous.get('rows',[])}
            historical_gap=any(day not in covered for day in requested_days(requested_first,today-timedelta(days=1)))
            checked=previous.get('orders_checked_at')
            now=datetime.now(timezone.utc)
            attempted=s.get('orders_attempted_at')
            refresh_today=(previous.get('orders_live_day')!=today.isoformat()
                           or not checked or now-datetime.fromisoformat(checked)>=SALES_REFRESH_INTERVAL)
            if attempted and now-attempted<SALES_REFRESH_INTERVAL:
                refresh_today=False
            load_history=backfill and historical_gap
            if not (refresh_today or load_history):
                return {'started':False}
            if refresh_today:
                s['orders_attempted_at']=now
            # Retain the widest locally cached window when refreshing a narrow view.
            oldest=min(covered,default=requested_first.isoformat())
            earliest=today-timedelta(days=90)
            sales_first=max(earliest,min(requested_first,date.fromisoformat(oldest)))
        if morning and not store.claim_morning_digitization(s['client'],date_from.isoformat()):
            return {'started':False}
        s['job']={'kind':kind,'running':True,'message':'Подключаемся к Ozon…',
                  'error':None,'retry_at':None}
        update_active_job_marker()
    def sync_kind(kind,days):
        if kind=='inventory':
            products,stocks=s['api'].download(progress)
            warning=None
            try:
                analytics=s['api'].analytics(products,stocks,progress)
                summarize({'products':products,'stocks':stocks,'analytics':analytics})
                requested={str(p['sku']) for p in products if p.get('sku')} | {str(r['sku']) for r in stocks if r.get('sku')}
                returned={str(r['sku']) for r in analytics}
                if requested - returned:
                    warning=f'Нет строк аналитики для {len(requested-returned)} SKU. Итоги охватывают только возвращённые строки; отсутствие не считается нулевым запасом.'
                    progress(warning)
            except (ApiError,KeyError,TypeError,ValueError):
                analytics=None
                warning='Аналитика недоступна или ответ неполный. Доступный остаток неизвестен; смотрите исходные строки.'
                progress(warning)
            fbs_stock_quantity=None
            fbs_stocks=[]
            fbs_stock_error=None
            try:
                fbs=s['api'].fbs_stocks(products,progress)
                fbs_stock_quantity=fbs.get('quantity')
                fbs_stocks=fbs.get('rows') or []
            except ApiError as exc:
                fbs_stock_error=str(exc)
                progress('FBS-остатки недоступны: '+str(exc))
            store.save(s['client'],'inventory',{'products':products,'stocks':stocks,
                        'analytics':analytics,'warning':warning,
                        'fbs_stock_quantity':fbs_stock_quantity,'fbs_stocks':fbs_stocks,
                        'fbs_stock_error':fbs_stock_error})
        elif kind=='sales':
            first_text,today_text=sales_first.isoformat(),today.isoformat()
            orders={key:previous[key] for key in ('orders_live_day','orders_checked_at') if key in previous}
            orders.update(date_from=first_text,date_to=today_text,error=None,
                          rows=[row for row in previous.get('rows',[]) if first_text<=row['date']<=today_text],
                          by_sku=[row for row in previous.get('by_sku',[]) if first_text<=row['date']<=today_text])
            delivery_days={
                day:record for day,record in (previous.get('delivery_days') or {}).items()
                if sales_first.isoformat()<=day<=today.isoformat()
            }

            def save_orders(deliveries):
                store.save(s['client'],'sales_analytics',build_sales_with_deliveries(
                    orders,deliveries,store.delivery_events(s['client']),
                    store.latest(s['client'],'history'),
                ))

            # Refresh posting history alongside the sales period. Today's order
            # totals and shipment counts must be computed from one Ozon response,
            # not two fetches that may see different states or hit rate limits.
            history_data=None
            history_error=None
            previous_history=store.latest(s['client'],'history') or {}
            # Fetch all chosen dates only if the persisted history doesn't
            # cover them yet. Subsequent refreshes fetch just two recent days,
            # greatly reducing Ozon API pressure (particularly on 90-day views).
            covered_since=str(previous_history.get('since') or '')[:10]
            required_since=(requested_first-timedelta(days=1)).isoformat()
            sources=previous_history.get('sources') or {}
            fully_covered=bool(
                covered_since and covered_since<=required_since
                and all((sources.get(scheme) or {}).get('ok') for scheme in ('fbo','fbs'))
            )
            history_days=2 if fully_covered else days+2
            try:
                history_data=s['api'].postings(history_days,progress)
                if history_data.get('errors'):
                    raise ApiError('Неполная история отправлений: '+ '; '.join(history_data['errors']))
            except ApiError as exc:
                history_error=exc
                progress('Историю отправлений пока не удалось обновить: '+str(exc))

            live_error=None
            if refresh_today:
                try:
                    if history_data is not None and history_error is None:
                        row,by_sku=s['api'].current_day_orders(today,progress,history_data)
                    else:
                        raise history_error or ApiError('История отправлений недоступна.')

                    orders['rows']=[saved for saved in orders['rows'] if saved['date']!=today_text]+[row]
                    orders['by_sku']=[saved for saved in orders['by_sku'] if saved['date']!=today_text]+by_sku
                    orders['orders_live_day']=today_text
                    orders['orders_checked_at']=now.isoformat()
                    save_orders(delivery_days)
                except ApiError as exc:
                    live_error=exc
            if load_history:
                orders=sync_order_days(s['api'],requested_first,today,orders,progress)
                save_orders(delivery_days)
                delivery_days.update(delivered_snapshot(s['api'],requested_first,today,previous,progress))
                save_orders(delivery_days)
            if history_data is not None and history_error is None:
                # The existing save_history implementation merges by FBO/FBS
                # number and retains older periods and status observations.
                store.save_history(s['client'],history_data)
                refresh_delivery_from_events(s['client'])
                save_orders(delivery_days)
            if live_error:
                raise live_error
            if history_error:
                progress('История Ozon не обновлена; сохранённые отправления оставлены без изменений.')
        elif kind=='digitization':
            first=s['api']._as_date(date_from)
            requested_last=s['api']._as_date(date_to)
            effective_last,current_day_excluded=s['api']._closed_last_day(requested_last)
            if effective_last < first:
                progress('В выбранном периоде пока нет закрытых дней Ozon.')
            else:
                # Yesterday is scheduled for 08:00 Moscow. If that attempt
                # fails or is missed, allow a manual retry after 08:00.
                manual_last=manual_digitization_latest_day(datetime.now(MOSCOW_TZ))
                target_last=effective_last if morning else min(effective_last,manual_last)
                target_days=store.digitization_missing_days(
                    s['client'],first.isoformat(),target_last.isoformat()
                )
                if target_days:
                    progress(f'Догружаем только отсутствующие дни: {len(target_days)}.')
                for index,day_text in enumerate(target_days,1):
                    day=date.fromisoformat(day_text)
                    progress(f'День {index}/{len(target_days)} · {day_text}')
                    daily=download_digitization_day(s['api'],day,progress)
                    store.save_digitization_day(s['client'],day_text,daily)

                coverage=store.digitization_coverage(
                    s['client'],first.isoformat(),effective_last.isoformat()
                )
                if coverage.get('complete'):
                    rows=store.digitization_days_between(
                        s['client'],first.isoformat(),effective_last.isoformat()
                    )
                    combined=combine_digitization_days(rows,first,requested_last,effective_last)
                    combined['current_day_excluded']=current_day_excluded
                    # If an older exact-period snapshot contains the expensive
                    # placement report, reuse only that component. Daily facts
                    # remain the source for every other metric.
                    exact=store.digitization_period(
                        s['client'],first.isoformat(),requested_last.isoformat()
                    )
                    if exact and exact.get('placement_cost') is not None:
                        combined['placement_cost']=exact.get('placement_cost')
                    store.save(s['client'],'digitization',combined)
                    progress(
                        f'Локальная база готова: {coverage.get("available_days",0)} '
                        f'из {coverage.get("requested_days",0)} дней.'
                    )
                else:
                    progress(
                        f'Локальная база неполная: отсутствует '
                        f'{len(coverage.get("missing_days") or [])} дней.'
                    )
        else:
            history_data=s['api'].postings(days,progress)
            saved_history=store.save_history(s['client'],history_data)
            refresh_delivery_from_events(s['client'])
            for error in history_data.get('errors') or []:
                progress('Часть истории не обновлена: '+str(error))
            progress(
                f"История Ozon сохранена: FBO {saved_history['counts']['fbo']} · "
                f"FBS {saved_history['counts']['fbs']} отправлений."
            )
    def work():
        before=s['api'].cache_counters() if hasattr(s['api'],'cache_counters') else {'hits':0,'api_requests':0}
        try:
            if kind=='account':
                previous=store.latest(s['client'],'history') or {}
                sources=previous.get('sources') or {}
                now=datetime.now(timezone.utc)
                lookback=2
                for scheme in ('fbo','fbs'):
                    last=(sources.get(scheme) or {}).get('last_success_at')
                    if last:
                        elapsed=now-datetime.fromisoformat(last)
                        lookback=max(lookback,elapsed.days+2)
                    else:
                        lookback=max(lookback,180)
                lookback=min(365,lookback)
                for section,period in (('inventory',0),('history',lookback)):
                    sync_kind(section,period)
            else:
                # 429 in digitization pauses and resumes the current HTTP call
                # instead of ending the job and requiring a new period selection.
                # Worker-local context prevents unrelated requests from pausing.
                def on_rate_limit_wait(delay):
                    with lock:
                        s['job']['retry_at']=(
                            datetime.now(timezone.utc)+timedelta(seconds=delay)
                        ).isoformat()

                def on_rate_limit_resume():
                    with lock:
                        s['job']['retry_at']=None

                recovery=(s['api'].auto_retry_429(
                    progress,on_wait=on_rate_limit_wait,on_resume=on_rate_limit_resume
                ) if kind=='digitization' and hasattr(s['api'],'auto_retry_429')
                  else nullcontext())
                with recovery:
                    sync_kind(kind,days)
            after=s['api'].cache_counters() if hasattr(s['api'],'cache_counters') else before
            cache_hits=max(0,int(after.get('hits',0))-int(before.get('hits',0)))
            api_requests=max(0,int(after.get('api_requests',0))-int(before.get('api_requests',0)))
            if cache_hits or kind=='digitization':
                progress(f'Локальный SQL-кэш API: {cache_hits} ответов · новых запросов к Ozon: {api_requests}.')
            progress('Загрузка завершена.')
        except ApiError as exc:
            with lock:
                s['job']['error']=str(exc)
            progress(str(exc))
        except Exception:
            message='Ответ API не соответствует схеме или база недоступна. Предыдущие данные сохранены.'
            with lock:
                s['job']['error']=message
            progress(message)
        finally:
            with lock:
                s['job']['retry_at']=None
                s['job']['running']=False
                update_active_job_marker()
    threading.Thread(target=work,daemon=True).start()
    return {'started':True}

def schedule_morning_digitization(now):
    if not ENCRYPTION_KEY or now.hour<8:
        return
    day=now.date()-timedelta(days=1)
    for account_id,user_id in store.accounts_due_for_digitization(day.isoformat()):
        try:
            launch(account_runtime(account_id,user_id),'digitization',
                   date_from=day,date_to=day,morning=True)
        except HTTPException as exc:
            if exc.status_code!=409:
                logging.getLogger(__name__).warning('Не удалось запустить утреннюю оцифровку: %s',exc.detail)


def run_digitization_schedule(stop):
    while not stop.is_set():
        try:
            schedule_morning_digitization(datetime.now(MOSCOW_TZ))
        except Exception:
            logging.getLogger(__name__).exception('Ошибка расписания оцифровки')
        stop.wait(60-time.time()%60)


@app.post('/api/sync')
def sync(request:Request):
    return launch(current(request),'inventory')

@app.post('/api/account/sync')
def sync_account(request:Request):
    return launch(current(request),'account')


def refresh_delivery_from_events(client):
    previous=store.latest(client,'sales_analytics')
    if previous and previous.get('rows') and previous.get('delivery_days'):
        updated=build_sales_with_deliveries(
            previous,previous['delivery_days'],store.delivery_events(client),
            store.latest(client,'history'),
        )
        store.save(client,'sales_analytics',updated)


def _ozon_webhook_signature(account_id):
    import re
    if not ENCRYPTION_KEY or not re.fullmatch('[0-9a-f]{32}',str(account_id)):
        return None
    return hmac.new(
        ENCRYPTION_KEY, b'isk-ozon-push-fbo-v1:'+str(account_id).encode('ascii'),
        hashlib.sha256
    ).hexdigest()


@app.get('/api/ozon/push/info')
def ozon_push_info(request:Request):
    s=current(request)
    public_url=os.getenv('ISK_PUBLIC_URL','').strip().rstrip('/')
    if not public_url:
        candidates=[origin for origin in ALLOWED_ORIGINS if origin.startswith('https://')]
        if len(candidates)==1:
            public_url=candidates[0].rstrip('/')
    available=public_url.startswith('https://') and ENCRYPTION_KEY is not None
    return {
        'available':available,
        'event_type':'TYPE_FBO_POSTING_STATE_CHANGED',
        'url':(
            f'{public_url}/webhooks/ozon/fbo/{s["account_id"]}/'
            f'{_ozon_webhook_signature(s["account_id"])}'
            if available else None
        ),
        'configured':bool(public_url),
    }


def _enrich_fbo_delivery_event(account_id,event_id,posting_number):
    """Attach safe SKU data after responding to the Ozon push request."""
    client='account:'+account_id
    try:
        with store.db() as db:
            row=db.execute(
                'SELECT client_id,api_key_ciphertext FROM ozon_accounts '
                'WHERE id=? AND connected=1',
                (account_id,),
            ).fetchone()
        if not row or not row[1] or not ENCRYPTION_KEY:
            return
        api=Ozon(row[0],decrypt_secret(row[1],ENCRYPTION_KEY))
        posting=api.fbo_posting_by_number(posting_number)
        store.attach_delivery_event_products(client,event_id,posting['products'])
        refresh_delivery_from_events(client)
    except Exception:
        # Webhook delivery has already been stored durably. Transient Ozon
        # failures are harmless: a later history sync can fill SKU products.
        return


@app.post('/webhooks/ozon/fbo/{account_id}/{signature}')
async def ozon_fbo_webhook(account_id:str,signature:str,request:Request,background_tasks:BackgroundTasks):
    expected=_ozon_webhook_signature(account_id)
    if (not expected or not hmac.compare_digest(signature,expected)):
        raise HTTPException(403,'Доступ запрещён.')
    with store.db() as db:
        account=db.execute(
            'SELECT id FROM ozon_accounts WHERE id=? AND connected=1',
            (account_id,),
        ).fetchone()
    if not account:
        raise HTTPException(404,'Кабинет не найден.')
    payload=await request.body()
    if len(payload)>8192:
        raise HTTPException(413,'Слишком большой запрос.')
    import json
    try:
        event=json.loads(payload)
    except (ValueError,UnicodeDecodeError):
        raise HTTPException(422,'Некорректный JSON.') from None
    if not isinstance(event,dict):
        raise HTTPException(422,'Ожидался объект JSON.')
    if event.get('message_type')!='TYPE_FBO_POSTING_STATE_CHANGED':
        # Ozon checks the URL with a test payload; acknowledge it.
        return {'ok':True}
    if event.get('new_state')!='posting_delivered':
        return {'ok':True}
    uid=str(event.get('uuid') or '')
    posting=str(event.get('posting_number') or '')
    timestamp=str(event.get('changed_state_date') or '')
    if not 1<=len(uid)<=128 or not 1<=len(posting)<=100:
        raise HTTPException(422,'Некорректные идентификаторы уведомления.')
    try:
        delivery_at=datetime.fromisoformat(timestamp.replace('Z','+00:00'))
        if delivery_at.tzinfo is None:
            raise ValueError('Missing timezone')
        delivered_at=delivery_at.astimezone(timezone.utc).isoformat()
    except (ValueError,TypeError):
        raise HTTPException(422,'У события отсутствует корректная дата доставки.') from None
    client='account:'+account_id
    inserted=store.save_delivery_event(client,uid,posting,delivered_at)
    if inserted:
        background_tasks.add_task(_enrich_fbo_delivery_event,account_id,uid,posting)
    # Quantities are fetched from Ozon after acknowledging the notification.
    # The event remains durable if the API is temporarily unavailable.
    return {'ok':True}


@app.post('/api/sales/sync')
def sync_sales(body:SalesParams,request:Request):
    return launch(current(request),'sales',body.days,backfill=body.backfill)

@app.get('/api/sales')
def sales(request:Request):
    client=current(request)['client']
    data=store.latest(client,'sales_analytics')
    if not data or not data.get('rows'):
        return {'at':(data or {}).get('at'),'date_from':None,'date_to':None,
                'rows':[],'by_sku':[],'error':(data or {}).get('error')}
    first=data.get('date_from')
    last=data.get('date_to')
    if not first or not last:
        return {**data,'rows':[],'by_sku':[]}
    daily=store.digitization_days_between(client,first,last)
    return add_financial_sales(data,daily)

@app.post('/api/history/sync')
def sync_history(body:History,request:Request):
    return launch(current(request),'history',body.days)

@app.post('/api/digitization/sync')
def sync_digitization(body:DigitizationParams,request:Request):
    if body.date_to < body.date_from:
        raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
    return launch(current(request),'digitization',date_from=body.date_from,date_to=body.date_to)

@app.get('/api/inventory')
def inventory(request:Request):
    data=store.latest(current(request)['client'],'inventory')
    if not data:
        return {'at':None,'products':[],'stocks':[],'analytics':None,'summary':None,'aggregated':[],
                'fbs_stock_quantity':None,'fbs_stocks':[],'fbs_stock_error':None}
    return {**data,'summary':summarize(data),'aggregated':aggregate(data)}

@app.get('/api/inventory/history')
def inventory_history(date_from:date,date_to:date,request:Request):
    if date_to < date_from:
        raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
    if (date_to-date_from).days > 366:
        raise HTTPException(422,'История остатков запрашивается максимум за 367 дней.')
    start=datetime.combine(date_from,dt_time.min,tzinfo=MOSCOW_TZ).astimezone(timezone.utc).isoformat()
    end=datetime.combine(date_to,dt_time.max,tzinfo=MOSCOW_TZ).astimezone(timezone.utc).isoformat()
    rows=store.between(current(request)['client'],'inventory',start,end)
    daily={}
    for data in rows:
        try:
            day=datetime.fromisoformat(data['at']).astimezone(MOSCOW_TZ).date().isoformat()
            daily[day]={'at':data['at'],'summary':summarize(data),'aggregated':aggregate(data),
                        'fbs_stock_quantity':data.get('fbs_stock_quantity'),
                        'fbs_stocks':data.get('fbs_stocks') or []}
        except (ValueError,KeyError,TypeError):
            continue
    return {'days':[{'date':day,**daily[day]} for day in sorted(daily)]}

@app.get('/api/history')
def history(request:Request):
    data=store.latest(current(request)['client'],'history')
    if not data:
        return {'at':None,'postings':[]}
    postings=sorted(
        data.get('postings') or [],
        key=lambda row:str(row.get('created_at') or row.get('in_process_at') or ''),
        reverse=True,
    )
    return {**data,'postings':postings}

@app.get('/api/digitization')
def digitization(request:Request,date_from:date|None=None,date_to:date|None=None):
    client=current(request)['client']
    if (date_from is None) != (date_to is None):
        raise HTTPException(422,'Укажите обе даты периода.')
    if date_from is not None and date_to is not None:
        if date_to < date_from:
            raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
        effective_last,current_day_excluded=Ozon._closed_last_day(date_to)
        if effective_last >= date_from:
            coverage=store.digitization_coverage(
                client,date_from.isoformat(),effective_last.isoformat()
            )
            if coverage.get('complete'):
                rows=store.digitization_days_between(
                    client,date_from.isoformat(),effective_last.isoformat()
                )
                data=combine_digitization_days(rows,date_from,date_to,effective_last)
                data['current_day_excluded']=current_day_excluded
                exact=store.digitization_period(client,date_from.isoformat(),date_to.isoformat())
                if exact and exact.get('placement_cost') is not None:
                    data['placement_cost']=exact.get('placement_cost')
                try:
                    result=digitization_summarize(data)
                    return {
                        **result,'available':True,
                        'cache':{
                            'source':'sqlite-daily','hit':True,
                            'updated_at':coverage.get('updated_at'),
                            **coverage,
                        },
                    }
                except (ValueError,KeyError,TypeError):
                    raise HTTPException(422,'Не удалось обработать локальные дневные данные Ozon.') from None
        else:
            coverage={'days':0,'requested_days':0,'available_days':0,'missing_days':[],'complete':False}

        # Exact old snapshots remain readable while the installation is being
        # migrated. New calculations prefer digitization_days whenever coverage
        # is complete.
        legacy=store.digitization_period(client,date_from.isoformat(),date_to.isoformat())
        if legacy:
            try:
                result=digitization_summarize(legacy)
                return {
                    **result,'available':True,
                    'cache':{
                        'source':'legacy-period','hit':True,'updated_at':legacy.get('at'),
                        **coverage,
                    },
                }
            except (ValueError,KeyError,TypeError):
                pass
        return {
            'available':False,'at':None,'since':date_from.isoformat(),'to':date_to.isoformat(),
            'effective_to':effective_last.isoformat() if effective_last>=date_from else None,
            'metrics':None,'components':{},'operation_types':[],
            'products':[],'warnings':[],'methodology':'Не все дни выбранного периода есть в локальной базе.',
            'cache':{'source':'sqlite-daily','hit':False,**coverage},
        }

    data=store.latest(client,'digitization')
    if not data:
        return {'available':False,'at':None,'since':None,'to':None,'metrics':None,'components':{},'operation_types':[],
                'products':[],'warnings':[],'methodology':'Загрузите данные за выбранный период.',
                'cache':{'source':'sqlite-daily','hit':False,**store.digitization_coverage(client)}}
    try:
        result=digitization_summarize(data)
        return {**result,'available':True,'cache':{'source':'sqlite-daily','hit':True,'updated_at':data.get('at'),
                                                  **store.digitization_coverage(client)}}
    except (ValueError,KeyError,TypeError):
        raise HTTPException(422,'Не удалось обработать финансовый снимок Ozon.') from None

class ReplenishmentParams(BaseModel):
    window:int=Field(default=30)

@app.post('/api/replenishment')
def replenishment(body:ReplenishmentParams,request:Request):
    client=current(request)['client']
    inventory=store.latest(client,'inventory')
    history=store.latest(client,'history')
    if not inventory or inventory.get('analytics') is None:
        raise HTTPException(409,'Сначала загрузите остатки Ozon.')
    if not history:
        raise HTTPException(409,'Сначала загрузите историю отправлений.')
    try:
        return replenishment_calculate(inventory,history,body.window)
    except (ValueError,KeyError,TypeError):
        raise HTTPException(422,'Не удалось рассчитать прогноз: проверьте период и полноту данных.') from None

DIST=ROOT/'frontend'/'dist'
if (DIST/'assets').exists():
    app.mount('/assets',StaticFiles(directory=DIST/'assets'),name='assets')

@app.get('/{path:path}')
def spa(path:str):
    if path.startswith('api/'):
        raise HTTPException(404,'Метод не найден.')
    if not (DIST/'index.html').exists():
        raise HTTPException(503,'Сначала соберите frontend: npm ci && npm run build')
    return FileResponse(DIST/'index.html')
,max_length=80)
    api_token:SecretStr=Field(min_length=20,max_length=4096)


class Login(BaseModel):
    username:str=Field(min_length=3,max_length=32)
    password:SecretStr=Field(min_length=12,max_length=256)


class NewUser(BaseModel):
    username:str=Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$')
    password:SecretStr=Field(min_length=12,max_length=256)


class UserStatus(BaseModel):
    active:bool


class SelectAccount(BaseModel):
    account_id:str=Field(min_length=1,max_length=64)


class History(BaseModel):
    days:int=Field(default=90,ge=1,le=365)


class DigitizationParams(BaseModel):
    date_from:date
    date_to:date


class SalesParams(BaseModel):
    days:int=Field(default=90,ge=7,le=90)
    backfill:bool=True


@app.get('/api/auth/status')
def auth_status():
    return {'initialized':store.count_users()>0}


@app.post('/api/auth/login')
def auth_login(body:Login,request:Request,response:Response):
    username=body.username.strip()
    ip=request.client.host if request.client else 'unknown'
    if store.login_is_locked(ip,username) or store.login_is_locked(ip,'*'):
        raise HTTPException(429,'Слишком много неудачных попыток. Повторите через 15 минут.')
    user=store.get_user_by_username(username)
    password=body.password.get_secret_value()
    if not user or not user['is_active'] or not verify_password(password,user['password_hash']):
        store.record_login_failure(ip,username)
        store.record_login_failure(ip,'*')
        raise HTTPException(401,'Неверный логин или пароль.')
    store.clear_login_failures(ip,username)
    store.clear_login_failures(ip,'*')
    old_token=request.cookies.get('isk_session','')
    if old_token:store.delete_auth_session(token_digest(old_token))
    accounts=store.list_ozon_accounts(user['id'])
    active=next((a['id'] for a in accounts if a['connected']),None)
    token=secrets.token_urlsafe(48)
    store.create_auth_session(token_digest(token),user['id'],active,SESSION_TTL_SECONDS)
    response.set_cookie('isk_session',token,httponly=True,samesite='strict',
        secure=os.getenv('ISK_SECURE_COOKIE','false').lower() in ('true','1','yes'),
        max_age=SESSION_TTL_SECONDS,path='/')
    return {'ok':True}


@app.post('/api/auth/logout')
def auth_logout(request:Request,response:Response):
    raw=request.cookies.get('isk_session','')
    if raw:store.delete_auth_session(token_digest(raw))
    response.delete_cookie('isk_session',path='/',httponly=True,
        secure=os.getenv('ISK_SECURE_COOKIE','false').lower() in ('true','1','yes'),samesite='strict')
    return {'ok':True}


@app.get('/api/auth/me')
def auth_me(request:Request):
    auth=authenticated(request)
    accounts=store.list_ozon_accounts(auth['user_id'])
    active_id=auth.get('active_account_id')
    active=next((a for a in accounts if a['id']==active_id and a['connected']),None)
    if not active:
        active=next((a for a in accounts if a['connected']),None)
        active_id=active['id'] if active else None
        store.set_session_account(auth['token_hash'],auth['user_id'],active_id)
    return {'user':auth['user'],'accounts':[public_account(a) for a in accounts],
            'active_account_id':active_id,'session_expires_at':auth['expires_at']}


@app.get('/api/costing')
def costing_get(request:Request):
    auth=authenticated(request)
    workspace=store.get_costing_workspace(auth['user_id'])
    return {**workspace,'calculated':calculate_workspace(workspace['products'],workspace['shipments'])}


@app.put('/api/costing')
def costing_save(body:CostingWorkspaceBody,request:Request):
    auth=authenticated(request)
    try:
        workspace=clean_workspace(body.products,body.shipments)
        saved=store.save_costing_workspace(auth['user_id'],body.revision,workspace)
    except ValueError as exc:
        raise HTTPException(409 if 'изменены на другом устройстве' in str(exc) else 422,str(exc)) from None
    return {**saved,'calculated':calculate_workspace(saved['products'],saved['shipments'])}


@app.post('/api/costing/import-xlsx')
def costing_import_xlsx(body:CostingImportBody,request:Request):
    auth=authenticated(request)
    try:
        raw=base64.b64decode(body.file_base64,validate=True)
        if len(raw)>10*1024*1024:
            raise ValueError('Excel-файл больше 10 МБ.')
        imported=parse_legacy_xlsx(raw)
        current=store.get_costing_workspace(auth['user_id'])
        products={str(item['id']):item for item in current['products']}
        products.update({str(item['id']):item for item in imported['products']})
        shipments={str(item['id']):item for item in current['shipments']}
        shipments.update({str(item['id']):item for item in imported['shipments']})
        workspace=clean_workspace(list(products.values()),list(shipments.values()))
        saved=store.save_costing_workspace(auth['user_id'],current['revision'],workspace)
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,str(exc)) from None
    except Exception as exc:
        # Do not expose workbook internals or server paths to the browser.
        raise HTTPException(422,'Не удалось импортировать Excel-файл.') from exc
    return {
        **saved,
        'importedProducts':imported['importedProducts'],
        'importedShipments':imported['importedShipments'],
        'calculated':calculate_workspace(saved['products'],saved['shipments']),
    }


class PurchaseShipmentBody(PreliminaryCostBody):
    request_id: str = Field(min_length=1,max_length=80,pattern=r"^[a-zA-Z0-9-]+$")
    calculation_id: str | None = None


@app.get('/api/purchase-shipments')
def purchase_shipments_list(request:Request):
    auth=authenticated(request)
    return {"items":store.list_purchase_shipments(auth["user_id"])}


@app.get('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_get(shipment_id:str,request:Request):
    auth=authenticated(request)
    shipment=store.get_purchase_shipment(auth["user_id"],shipment_id)
    if not shipment:
        raise HTTPException(404,"Поставка не найдена.")
    return shipment


@app.put('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_update(shipment_id:str,body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        if "selectedRoute" not in data:
            raise ValueError("Выберите маршрут доставки.")
        name=body.name.strip()
        if not name:
            raise ValueError("Укажите название поставки.")
        updated=store.update_purchase_shipment(
            auth["user_id"],shipment_id,name,data,calculate_preliminary_cost(data),
        )
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not updated:
        raise HTTPException(404,"Поставка не найдена.")
    return {"id": shipment_id}


@app.delete('/api/purchase-shipments/{shipment_id}')
def purchase_shipments_delete(shipment_id:str,request:Request):
    auth=authenticated(request)
    if not store.delete_purchase_shipment(auth["user_id"],shipment_id):
        raise HTTPException(404,"Поставка не найдена.")
    return {"ok":True}


@app.post('/api/purchase-shipments',status_code=201)
def purchase_shipments_create(body:PurchaseShipmentBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        if "selectedRoute" not in data:
            raise ValueError("Выберите маршрут доставки.")
        calculated=calculate_preliminary_cost(data)
        record=store.save_preliminary_cost(
            auth["user_id"],body.calculation_id,body.name,data,
            shipment={"id":str(body.request_id),"calculated":calculated},
        )
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not record:
        raise HTTPException(404,"Предварительный расчёт не найден.")
    return record


@app.get('/api/preliminary-costs')
def preliminary_costs_list(request:Request,q:str=''):
    auth=authenticated(request)
    return {'items':store.list_preliminary_costs(auth['user_id'],q[:100])}


@app.get('/api/preliminary-costs/{record_id}')
def preliminary_costs_get(record_id:str,request:Request):
    auth=authenticated(request)
    record=store.get_preliminary_cost(auth['user_id'],record_id)
    if not record:
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.post('/api/preliminary-costs',status_code=201)
def preliminary_costs_create(body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        record=store.save_preliminary_cost(auth['user_id'],None,body.name,data)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.put('/api/preliminary-costs/{record_id}')
def preliminary_costs_update(record_id:str,body:PreliminaryCostBody,request:Request):
    auth=authenticated(request)
    try:
        data=clean_preliminary_cost(body.data)
        record=store.save_preliminary_cost(auth['user_id'],record_id,body.name,data)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from None
    if not record:
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {**record,'calculated':calculate_preliminary_cost(record['data'])}


@app.delete('/api/preliminary-costs/{record_id}')
def preliminary_costs_delete(record_id:str,request:Request):
    auth=authenticated(request)
    if not store.delete_preliminary_cost(auth['user_id'],record_id):
        raise HTTPException(404,'Предварительный расчёт не найден.')
    return {'ok':True}


@app.get('/api/admin/users')
def admin_users(request:Request):
    require_admin(request)
    return {'users':store.list_users()}


@app.post('/api/admin/users')
def admin_create_user(body:NewUser,request:Request):
    require_admin(request)
    if not valid_username(body.username):
        raise HTTPException(422,'Логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание.')
    try:user=store.create_user(body.username,hash_password(body.password.get_secret_value()),'user')
    except sqlite3.IntegrityError:raise HTTPException(409,'Пользователь с таким логином уже существует.') from None
    return {'user':{k:user[k] for k in ('id','username','role','is_active','created_at')}}


@app.post('/api/admin/users/{user_id}/status')
def admin_user_status(user_id:str,body:UserStatus,request:Request):
    auth=require_admin(request)
    if user_id==auth['user_id'] and not body.active:
        raise HTTPException(409,'Нельзя отключить собственный аккаунт администратора.')
    try:changed=store.set_user_active(user_id,body.active)
    except ValueError as exc:raise HTTPException(409,str(exc)) from None
    if not changed:raise HTTPException(404,'Пользователь не найден.')
    return {'ok':True}


@app.get('/api/accounts')
def accounts(request:Request):
    auth=authenticated(request)
    return {'accounts':[public_account(a) for a in store.list_ozon_accounts(auth['user_id'])],
            'active_account_id':auth.get('active_account_id')}


@app.post('/api/accounts/select')
def select_account(body:SelectAccount,request:Request):
    auth=authenticated(request)
    if not store.set_session_account(auth['token_hash'],auth['user_id'],body.account_id):
        raise HTTPException(404,'Подключённый кабинет не найден в вашем аккаунте.')
    return {'ok':True,'active_account_id':body.account_id}


@app.post('/api/connect')
def connect(body:Connect,request:Request):
    auth=authenticated(request)
    if not ENCRYPTION_KEY:
        raise HTTPException(503,'Подключение недоступно: настройте ISK encryption key Docker secret.')
    client_id=body.client_id
    api_key=body.api_key.get_secret_value()
    try:
        api=Ozon(client_id,api_key)
        roles=api.roles()
    except ApiError as exc:
        raise HTTPException(400,str(exc)) from None
    ciphertext=encrypt_secret(api_key,ENCRYPTION_KEY)
    account=store.upsert_ozon_account(auth['user_id'],client_id,ciphertext,roles)
    scope='account:'+account['id']
    store.migrate_legacy_client_data(client_id,scope,account['id'])
    store.set_session_account(auth['token_hash'],auth['user_id'],account['id'])
    with lock:runtime_accounts.pop(account['id'],None)
    return {'client_id':client_id,'account_id':account['id'],'expires_at':roles.get('expires_at')}


@app.post('/api/disconnect')
def disconnect(request:Request):
    auth=authenticated(request)
    account_id=auth.get('active_account_id')
    if not account_id:raise HTTPException(409,'Нет выбранного кабинета.')
    account=store.get_ozon_account(account_id,auth['user_id'])
    if not account:raise HTTPException(404,'Кабинет не найден.')
    with lock:
        running=runtime_accounts.get(account_id,{}).get('job',{}).get('running',False)
        if running:raise HTTPException(409,'Дождитесь завершения загрузки.')
        runtime_accounts.pop(account_id,None)
    store.disconnect_ozon_account(account_id,auth['user_id'])
    store.set_session_account(auth['token_hash'],auth['user_id'],None)
    return {'ok':True,'data_preserved':True}


@app.get('/api/state')
def state(request:Request):
    s=current(request)
    with lock:
        cache=store.cache_stats(s['client'],'ozon_api')
        return {'client_id':s['client_id'],'account_id':s['account_id'],
                'expires_at':s['roles'].get('expires_at'),
                'roles':[r.get('name','') for r in s['roles'].get('roles',[])],
                'job':dict(s['job']),'logs':list(s['logs']),'cache':cache,
                'digitization_periods':store.digitization_period_count(s['client']),
                'digitization_days':store.digitization_coverage(s['client'])}


SALES_REFRESH_INTERVAL = timedelta(minutes=10)


def sync_order_days(api,first,today,previous,progress):
    """Fill missing closed dates without touching the live orders point."""
    rows={row['date']:row for row in previous.get('rows',[])}
    by_sku=list(previous.get('by_sku',[]))
    day=first
    while day<today:
        if day.isoformat() in rows:
            day+=timedelta(days=1)
            continue
        start=day
        while day<today and day.isoformat() not in rows:
            day+=timedelta(days=1)
        loaded=api.daily_sales(start,day-timedelta(days=1),progress)
        rows.update((row['date'],row) for row in loaded['rows'])
        by_sku.extend(loaded['by_sku'])
    return {**previous,'rows':sorted(rows.values(),key=lambda row:row['date']),
            'by_sku':sorted(by_sku,key=lambda row:(str(row['sku']),row['date']))}


def launch(s,kind,days=90,date_from=None,date_to=None,backfill=True,morning=False):
    def progress(message):
        with lock:
            s['job']['message']=message
            s['logs'].append({'at':time.strftime('%H:%M:%S'),'message':message})
            s['logs']=s['logs'][-200:]
    with lock:
        if DEPLOY_GATE.exists():
            raise HTTPException(409,'ИСК устанавливает обновление. Повторите запуск после обновления.')
        if s['job']['running']:
            raise HTTPException(409,'Загрузка уже выполняется.')
        if kind=='sales':
            previous=store.latest(s['client'],'sales_analytics') or {}
            requested_first,today=sales_chart_period(days)
            covered={row['date'] for row in previous.get('rows',[])}
            historical_gap=any(day not in covered for day in requested_days(requested_first,today-timedelta(days=1)))
            checked=previous.get('orders_checked_at')
            now=datetime.now(timezone.utc)
            attempted=s.get('orders_attempted_at')
            refresh_today=(previous.get('orders_live_day')!=today.isoformat()
                           or not checked or now-datetime.fromisoformat(checked)>=SALES_REFRESH_INTERVAL)
            if attempted and now-attempted<SALES_REFRESH_INTERVAL:
                refresh_today=False
            load_history=backfill and historical_gap
            if not (refresh_today or load_history):
                return {'started':False}
            if refresh_today:
                s['orders_attempted_at']=now
            # Retain the widest locally cached window when refreshing a narrow view.
            oldest=min(covered,default=requested_first.isoformat())
            earliest=today-timedelta(days=90)
            sales_first=max(earliest,min(requested_first,date.fromisoformat(oldest)))
        if morning and not store.claim_morning_digitization(s['client'],date_from.isoformat()):
            return {'started':False}
        s['job']={'kind':kind,'running':True,'message':'Подключаемся к Ozon…',
                  'error':None,'retry_at':None}
        update_active_job_marker()
    def sync_kind(kind,days):
        if kind=='inventory':
            products,stocks=s['api'].download(progress)
            warning=None
            try:
                analytics=s['api'].analytics(products,stocks,progress)
                summarize({'products':products,'stocks':stocks,'analytics':analytics})
                requested={str(p['sku']) for p in products if p.get('sku')} | {str(r['sku']) for r in stocks if r.get('sku')}
                returned={str(r['sku']) for r in analytics}
                if requested - returned:
                    warning=f'Нет строк аналитики для {len(requested-returned)} SKU. Итоги охватывают только возвращённые строки; отсутствие не считается нулевым запасом.'
                    progress(warning)
            except (ApiError,KeyError,TypeError,ValueError):
                analytics=None
                warning='Аналитика недоступна или ответ неполный. Доступный остаток неизвестен; смотрите исходные строки.'
                progress(warning)
            fbs_stock_quantity=None
            fbs_stocks=[]
            fbs_stock_error=None
            try:
                fbs=s['api'].fbs_stocks(products,progress)
                fbs_stock_quantity=fbs.get('quantity')
                fbs_stocks=fbs.get('rows') or []
            except ApiError as exc:
                fbs_stock_error=str(exc)
                progress('FBS-остатки недоступны: '+str(exc))
            store.save(s['client'],'inventory',{'products':products,'stocks':stocks,
                        'analytics':analytics,'warning':warning,
                        'fbs_stock_quantity':fbs_stock_quantity,'fbs_stocks':fbs_stocks,
                        'fbs_stock_error':fbs_stock_error})
        elif kind=='sales':
            first_text,today_text=sales_first.isoformat(),today.isoformat()
            orders={key:previous[key] for key in ('orders_live_day','orders_checked_at') if key in previous}
            orders.update(date_from=first_text,date_to=today_text,error=None,
                          rows=[row for row in previous.get('rows',[]) if first_text<=row['date']<=today_text],
                          by_sku=[row for row in previous.get('by_sku',[]) if first_text<=row['date']<=today_text])
            delivery_days={
                day:record for day,record in (previous.get('delivery_days') or {}).items()
                if sales_first.isoformat()<=day<=today.isoformat()
            }

            def save_orders(deliveries):
                store.save(s['client'],'sales_analytics',build_sales_with_deliveries(
                    orders,deliveries,store.delivery_events(s['client']),
                    store.latest(s['client'],'history'),
                ))

            # Refresh posting history alongside the sales period. Today's order
            # totals and shipment counts must be computed from one Ozon response,
            # not two fetches that may see different states or hit rate limits.
            history_data=None
            history_error=None
            previous_history=store.latest(s['client'],'history') or {}
            # Fetch all chosen dates only if the persisted history doesn't
            # cover them yet. Subsequent refreshes fetch just two recent days,
            # greatly reducing Ozon API pressure (particularly on 90-day views).
            covered_since=str(previous_history.get('since') or '')[:10]
            required_since=(requested_first-timedelta(days=1)).isoformat()
            sources=previous_history.get('sources') or {}
            fully_covered=bool(
                covered_since and covered_since<=required_since
                and all((sources.get(scheme) or {}).get('ok') for scheme in ('fbo','fbs'))
            )
            history_days=2 if fully_covered else days+2
            try:
                history_data=s['api'].postings(history_days,progress)
                if history_data.get('errors'):
                    raise ApiError('Неполная история отправлений: '+ '; '.join(history_data['errors']))
            except ApiError as exc:
                history_error=exc
                progress('Историю отправлений пока не удалось обновить: '+str(exc))

            live_error=None
            if refresh_today:
                try:
                    if history_data is not None and history_error is None:
                        row,by_sku=s['api'].current_day_orders(today,progress,history_data)
                    else:
                        raise history_error or ApiError('История отправлений недоступна.')

                    orders['rows']=[saved for saved in orders['rows'] if saved['date']!=today_text]+[row]
                    orders['by_sku']=[saved for saved in orders['by_sku'] if saved['date']!=today_text]+by_sku
                    orders['orders_live_day']=today_text
                    orders['orders_checked_at']=now.isoformat()
                    save_orders(delivery_days)
                except ApiError as exc:
                    live_error=exc
            if load_history:
                orders=sync_order_days(s['api'],requested_first,today,orders,progress)
                save_orders(delivery_days)
                delivery_days.update(delivered_snapshot(s['api'],requested_first,today,previous,progress))
                save_orders(delivery_days)
            if history_data is not None and history_error is None:
                # The existing save_history implementation merges by FBO/FBS
                # number and retains older periods and status observations.
                store.save_history(s['client'],history_data)
                refresh_delivery_from_events(s['client'])
                save_orders(delivery_days)
            if live_error:
                raise live_error
            if history_error:
                progress('История Ozon не обновлена; сохранённые отправления оставлены без изменений.')
        elif kind=='digitization':
            first=s['api']._as_date(date_from)
            requested_last=s['api']._as_date(date_to)
            effective_last,current_day_excluded=s['api']._closed_last_day(requested_last)
            if effective_last < first:
                progress('В выбранном периоде пока нет закрытых дней Ozon.')
            else:
                # Yesterday is scheduled for 08:00 Moscow. If that attempt
                # fails or is missed, allow a manual retry after 08:00.
                manual_last=manual_digitization_latest_day(datetime.now(MOSCOW_TZ))
                target_last=effective_last if morning else min(effective_last,manual_last)
                target_days=store.digitization_missing_days(
                    s['client'],first.isoformat(),target_last.isoformat()
                )
                if target_days:
                    progress(f'Догружаем только отсутствующие дни: {len(target_days)}.')
                for index,day_text in enumerate(target_days,1):
                    day=date.fromisoformat(day_text)
                    progress(f'День {index}/{len(target_days)} · {day_text}')
                    daily=download_digitization_day(s['api'],day,progress)
                    store.save_digitization_day(s['client'],day_text,daily)

                coverage=store.digitization_coverage(
                    s['client'],first.isoformat(),effective_last.isoformat()
                )
                if coverage.get('complete'):
                    rows=store.digitization_days_between(
                        s['client'],first.isoformat(),effective_last.isoformat()
                    )
                    combined=combine_digitization_days(rows,first,requested_last,effective_last)
                    combined['current_day_excluded']=current_day_excluded
                    # If an older exact-period snapshot contains the expensive
                    # placement report, reuse only that component. Daily facts
                    # remain the source for every other metric.
                    exact=store.digitization_period(
                        s['client'],first.isoformat(),requested_last.isoformat()
                    )
                    if exact and exact.get('placement_cost') is not None:
                        combined['placement_cost']=exact.get('placement_cost')
                    store.save(s['client'],'digitization',combined)
                    progress(
                        f'Локальная база готова: {coverage.get("available_days",0)} '
                        f'из {coverage.get("requested_days",0)} дней.'
                    )
                else:
                    progress(
                        f'Локальная база неполная: отсутствует '
                        f'{len(coverage.get("missing_days") or [])} дней.'
                    )
        else:
            history_data=s['api'].postings(days,progress)
            saved_history=store.save_history(s['client'],history_data)
            refresh_delivery_from_events(s['client'])
            for error in history_data.get('errors') or []:
                progress('Часть истории не обновлена: '+str(error))
            progress(
                f"История Ozon сохранена: FBO {saved_history['counts']['fbo']} · "
                f"FBS {saved_history['counts']['fbs']} отправлений."
            )
    def work():
        before=s['api'].cache_counters() if hasattr(s['api'],'cache_counters') else {'hits':0,'api_requests':0}
        try:
            if kind=='account':
                previous=store.latest(s['client'],'history') or {}
                sources=previous.get('sources') or {}
                now=datetime.now(timezone.utc)
                lookback=2
                for scheme in ('fbo','fbs'):
                    last=(sources.get(scheme) or {}).get('last_success_at')
                    if last:
                        elapsed=now-datetime.fromisoformat(last)
                        lookback=max(lookback,elapsed.days+2)
                    else:
                        lookback=max(lookback,180)
                lookback=min(365,lookback)
                for section,period in (('inventory',0),('history',lookback)):
                    sync_kind(section,period)
            else:
                # 429 in digitization pauses and resumes the current HTTP call
                # instead of ending the job and requiring a new period selection.
                # Worker-local context prevents unrelated requests from pausing.
                def on_rate_limit_wait(delay):
                    with lock:
                        s['job']['retry_at']=(
                            datetime.now(timezone.utc)+timedelta(seconds=delay)
                        ).isoformat()

                def on_rate_limit_resume():
                    with lock:
                        s['job']['retry_at']=None

                recovery=(s['api'].auto_retry_429(
                    progress,on_wait=on_rate_limit_wait,on_resume=on_rate_limit_resume
                ) if kind=='digitization' and hasattr(s['api'],'auto_retry_429')
                  else nullcontext())
                with recovery:
                    sync_kind(kind,days)
            after=s['api'].cache_counters() if hasattr(s['api'],'cache_counters') else before
            cache_hits=max(0,int(after.get('hits',0))-int(before.get('hits',0)))
            api_requests=max(0,int(after.get('api_requests',0))-int(before.get('api_requests',0)))
            if cache_hits or kind=='digitization':
                progress(f'Локальный SQL-кэш API: {cache_hits} ответов · новых запросов к Ozon: {api_requests}.')
            progress('Загрузка завершена.')
        except ApiError as exc:
            with lock:
                s['job']['error']=str(exc)
            progress(str(exc))
        except Exception:
            message='Ответ API не соответствует схеме или база недоступна. Предыдущие данные сохранены.'
            with lock:
                s['job']['error']=message
            progress(message)
        finally:
            with lock:
                s['job']['retry_at']=None
                s['job']['running']=False
                update_active_job_marker()
    threading.Thread(target=work,daemon=True).start()
    return {'started':True}

def schedule_morning_digitization(now):
    if not ENCRYPTION_KEY or now.hour<8:
        return
    day=now.date()-timedelta(days=1)
    for account_id,user_id in store.accounts_due_for_digitization(day.isoformat()):
        try:
            launch(account_runtime(account_id,user_id),'digitization',
                   date_from=day,date_to=day,morning=True)
        except HTTPException as exc:
            if exc.status_code!=409:
                logging.getLogger(__name__).warning('Не удалось запустить утреннюю оцифровку: %s',exc.detail)


def run_digitization_schedule(stop):
    while not stop.is_set():
        try:
            schedule_morning_digitization(datetime.now(MOSCOW_TZ))
        except Exception:
            logging.getLogger(__name__).exception('Ошибка расписания оцифровки')
        stop.wait(60-time.time()%60)


@app.post('/api/sync')
def sync(request:Request):
    return launch(current(request),'inventory')

@app.post('/api/account/sync')
def sync_account(request:Request):
    return launch(current(request),'account')


def refresh_delivery_from_events(client):
    previous=store.latest(client,'sales_analytics')
    if previous and previous.get('rows') and previous.get('delivery_days'):
        updated=build_sales_with_deliveries(
            previous,previous['delivery_days'],store.delivery_events(client),
            store.latest(client,'history'),
        )
        store.save(client,'sales_analytics',updated)


def _ozon_webhook_signature(account_id):
    import re
    if not ENCRYPTION_KEY or not re.fullmatch('[0-9a-f]{32}',str(account_id)):
        return None
    return hmac.new(
        ENCRYPTION_KEY, b'isk-ozon-push-fbo-v1:'+str(account_id).encode('ascii'),
        hashlib.sha256
    ).hexdigest()


@app.get('/api/ozon/push/info')
def ozon_push_info(request:Request):
    s=current(request)
    public_url=os.getenv('ISK_PUBLIC_URL','').strip().rstrip('/')
    if not public_url:
        candidates=[origin for origin in ALLOWED_ORIGINS if origin.startswith('https://')]
        if len(candidates)==1:
            public_url=candidates[0].rstrip('/')
    available=public_url.startswith('https://') and ENCRYPTION_KEY is not None
    return {
        'available':available,
        'event_type':'TYPE_FBO_POSTING_STATE_CHANGED',
        'url':(
            f'{public_url}/webhooks/ozon/fbo/{s["account_id"]}/'
            f'{_ozon_webhook_signature(s["account_id"])}'
            if available else None
        ),
        'configured':bool(public_url),
    }


def _enrich_fbo_delivery_event(account_id,event_id,posting_number):
    """Attach safe SKU data after responding to the Ozon push request."""
    client='account:'+account_id
    try:
        with store.db() as db:
            row=db.execute(
                'SELECT client_id,api_key_ciphertext FROM ozon_accounts '
                'WHERE id=? AND connected=1',
                (account_id,),
            ).fetchone()
        if not row or not row[1] or not ENCRYPTION_KEY:
            return
        api=Ozon(row[0],decrypt_secret(row[1],ENCRYPTION_KEY))
        posting=api.fbo_posting_by_number(posting_number)
        store.attach_delivery_event_products(client,event_id,posting['products'])
        refresh_delivery_from_events(client)
    except Exception:
        # Webhook delivery has already been stored durably. Transient Ozon
        # failures are harmless: a later history sync can fill SKU products.
        return


@app.post('/webhooks/ozon/fbo/{account_id}/{signature}')
async def ozon_fbo_webhook(account_id:str,signature:str,request:Request,background_tasks:BackgroundTasks):
    expected=_ozon_webhook_signature(account_id)
    if (not expected or not hmac.compare_digest(signature,expected)):
        raise HTTPException(403,'Доступ запрещён.')
    with store.db() as db:
        account=db.execute(
            'SELECT id FROM ozon_accounts WHERE id=? AND connected=1',
            (account_id,),
        ).fetchone()
    if not account:
        raise HTTPException(404,'Кабинет не найден.')
    payload=await request.body()
    if len(payload)>8192:
        raise HTTPException(413,'Слишком большой запрос.')
    import json
    try:
        event=json.loads(payload)
    except (ValueError,UnicodeDecodeError):
        raise HTTPException(422,'Некорректный JSON.') from None
    if not isinstance(event,dict):
        raise HTTPException(422,'Ожидался объект JSON.')
    if event.get('message_type')!='TYPE_FBO_POSTING_STATE_CHANGED':
        # Ozon checks the URL with a test payload; acknowledge it.
        return {'ok':True}
    if event.get('new_state')!='posting_delivered':
        return {'ok':True}
    uid=str(event.get('uuid') or '')
    posting=str(event.get('posting_number') or '')
    timestamp=str(event.get('changed_state_date') or '')
    if not 1<=len(uid)<=128 or not 1<=len(posting)<=100:
        raise HTTPException(422,'Некорректные идентификаторы уведомления.')
    try:
        delivery_at=datetime.fromisoformat(timestamp.replace('Z','+00:00'))
        if delivery_at.tzinfo is None:
            raise ValueError('Missing timezone')
        delivered_at=delivery_at.astimezone(timezone.utc).isoformat()
    except (ValueError,TypeError):
        raise HTTPException(422,'У события отсутствует корректная дата доставки.') from None
    client='account:'+account_id
    inserted=store.save_delivery_event(client,uid,posting,delivered_at)
    if inserted:
        background_tasks.add_task(_enrich_fbo_delivery_event,account_id,uid,posting)
    # Quantities are fetched from Ozon after acknowledging the notification.
    # The event remains durable if the API is temporarily unavailable.
    return {'ok':True}


@app.post('/api/sales/sync')
def sync_sales(body:SalesParams,request:Request):
    return launch(current(request),'sales',body.days,backfill=body.backfill)

@app.get('/api/sales')
def sales(request:Request):
    client=current(request)['client']
    data=store.latest(client,'sales_analytics')
    if not data or not data.get('rows'):
        return {'at':(data or {}).get('at'),'date_from':None,'date_to':None,
                'rows':[],'by_sku':[],'error':(data or {}).get('error')}
    first=data.get('date_from')
    last=data.get('date_to')
    if not first or not last:
        return {**data,'rows':[],'by_sku':[]}
    daily=store.digitization_days_between(client,first,last)
    return add_financial_sales(data,daily)

@app.post('/api/history/sync')
def sync_history(body:History,request:Request):
    return launch(current(request),'history',body.days)

@app.post('/api/digitization/sync')
def sync_digitization(body:DigitizationParams,request:Request):
    if body.date_to < body.date_from:
        raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
    return launch(current(request),'digitization',date_from=body.date_from,date_to=body.date_to)

@app.get('/api/inventory')
def inventory(request:Request):
    data=store.latest(current(request)['client'],'inventory')
    if not data:
        return {'at':None,'products':[],'stocks':[],'analytics':None,'summary':None,'aggregated':[],
                'fbs_stock_quantity':None,'fbs_stocks':[],'fbs_stock_error':None}
    return {**data,'summary':summarize(data),'aggregated':aggregate(data)}

@app.get('/api/inventory/history')
def inventory_history(date_from:date,date_to:date,request:Request):
    if date_to < date_from:
        raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
    if (date_to-date_from).days > 366:
        raise HTTPException(422,'История остатков запрашивается максимум за 367 дней.')
    start=datetime.combine(date_from,dt_time.min,tzinfo=MOSCOW_TZ).astimezone(timezone.utc).isoformat()
    end=datetime.combine(date_to,dt_time.max,tzinfo=MOSCOW_TZ).astimezone(timezone.utc).isoformat()
    rows=store.between(current(request)['client'],'inventory',start,end)
    daily={}
    for data in rows:
        try:
            day=datetime.fromisoformat(data['at']).astimezone(MOSCOW_TZ).date().isoformat()
            daily[day]={'at':data['at'],'summary':summarize(data),'aggregated':aggregate(data),
                        'fbs_stock_quantity':data.get('fbs_stock_quantity'),
                        'fbs_stocks':data.get('fbs_stocks') or []}
        except (ValueError,KeyError,TypeError):
            continue
    return {'days':[{'date':day,**daily[day]} for day in sorted(daily)]}

@app.get('/api/history')
def history(request:Request):
    data=store.latest(current(request)['client'],'history')
    if not data:
        return {'at':None,'postings':[]}
    postings=sorted(
        data.get('postings') or [],
        key=lambda row:str(row.get('created_at') or row.get('in_process_at') or ''),
        reverse=True,
    )
    return {**data,'postings':postings}

@app.get('/api/digitization')
def digitization(request:Request,date_from:date|None=None,date_to:date|None=None):
    client=current(request)['client']
    if (date_from is None) != (date_to is None):
        raise HTTPException(422,'Укажите обе даты периода.')
    if date_from is not None and date_to is not None:
        if date_to < date_from:
            raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
        effective_last,current_day_excluded=Ozon._closed_last_day(date_to)
        if effective_last >= date_from:
            coverage=store.digitization_coverage(
                client,date_from.isoformat(),effective_last.isoformat()
            )
            if coverage.get('complete'):
                rows=store.digitization_days_between(
                    client,date_from.isoformat(),effective_last.isoformat()
                )
                data=combine_digitization_days(rows,date_from,date_to,effective_last)
                data['current_day_excluded']=current_day_excluded
                exact=store.digitization_period(client,date_from.isoformat(),date_to.isoformat())
                if exact and exact.get('placement_cost') is not None:
                    data['placement_cost']=exact.get('placement_cost')
                try:
                    result=digitization_summarize(data)
                    return {
                        **result,'available':True,
                        'cache':{
                            'source':'sqlite-daily','hit':True,
                            'updated_at':coverage.get('updated_at'),
                            **coverage,
                        },
                    }
                except (ValueError,KeyError,TypeError):
                    raise HTTPException(422,'Не удалось обработать локальные дневные данные Ozon.') from None
        else:
            coverage={'days':0,'requested_days':0,'available_days':0,'missing_days':[],'complete':False}

        # Exact old snapshots remain readable while the installation is being
        # migrated. New calculations prefer digitization_days whenever coverage
        # is complete.
        legacy=store.digitization_period(client,date_from.isoformat(),date_to.isoformat())
        if legacy:
            try:
                result=digitization_summarize(legacy)
                return {
                    **result,'available':True,
                    'cache':{
                        'source':'legacy-period','hit':True,'updated_at':legacy.get('at'),
                        **coverage,
                    },
                }
            except (ValueError,KeyError,TypeError):
                pass
        return {
            'available':False,'at':None,'since':date_from.isoformat(),'to':date_to.isoformat(),
            'effective_to':effective_last.isoformat() if effective_last>=date_from else None,
            'metrics':None,'components':{},'operation_types':[],
            'products':[],'warnings':[],'methodology':'Не все дни выбранного периода есть в локальной базе.',
            'cache':{'source':'sqlite-daily','hit':False,**coverage},
        }

    data=store.latest(client,'digitization')
    if not data:
        return {'available':False,'at':None,'since':None,'to':None,'metrics':None,'components':{},'operation_types':[],
                'products':[],'warnings':[],'methodology':'Загрузите данные за выбранный период.',
                'cache':{'source':'sqlite-daily','hit':False,**store.digitization_coverage(client)}}
    try:
        result=digitization_summarize(data)
        return {**result,'available':True,'cache':{'source':'sqlite-daily','hit':True,'updated_at':data.get('at'),
                                                  **store.digitization_coverage(client)}}
    except (ValueError,KeyError,TypeError):
        raise HTTPException(422,'Не удалось обработать финансовый снимок Ozon.') from None

class ReplenishmentParams(BaseModel):
    window:int=Field(default=30)

@app.post('/api/replenishment')
def replenishment(body:ReplenishmentParams,request:Request):
    client=current(request)['client']
    inventory=store.latest(client,'inventory')
    history=store.latest(client,'history')
    if not inventory or inventory.get('analytics') is None:
        raise HTTPException(409,'Сначала загрузите остатки Ozon.')
    if not history:
        raise HTTPException(409,'Сначала загрузите историю отправлений.')
    try:
        return replenishment_calculate(inventory,history,body.window)
    except (ValueError,KeyError,TypeError):
        raise HTTPException(422,'Не удалось рассчитать прогноз: проверьте период и полноту данных.') from None

DIST=ROOT/'frontend'/'dist'
if (DIST/'assets').exists():
    app.mount('/assets',StaticFiles(directory=DIST/'assets'),name='assets')

@app.get('/{path:path}')
def spa(path:str):
    if path.startswith('api/'):
        raise HTTPException(404,'Метод не найден.')
    if not (DIST/'index.html').exists():
        raise HTTPException(503,'Сначала соберите frontend: npm ci && npm run build')
    return FileResponse(DIST/'index.html')

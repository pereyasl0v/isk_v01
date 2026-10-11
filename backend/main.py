import os
import secrets
import threading
import time
from datetime import date, datetime, time as dt_time, timezone
from pathlib import Path
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field, SecretStr
from .ozon import Ozon, ApiError, MOSCOW_TZ
from .storage import Store
from .inventory import summarize, aggregate
from .replenishment import calculate as replenishment_calculate
from .digitization import summarize as digitization_summarize

ROOT=Path(__file__).resolve().parents[1]
DATA=Path(os.environ.get('OZON_FBO_DATA_DIR',str(Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'VKR_Ozon_FBO_Web')))
DATA.mkdir(parents=True,exist_ok=True)
store=Store(DATA/'inventory.sqlite3')
app=FastAPI(title='Интелектуальная система контроля (ИСК)',version='0.1.0',docs_url=None,redoc_url=None)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','testserver'])
sessions={}
lock=threading.RLock()
ALLOWED_ORIGINS={'http://127.0.0.1:8000','http://localhost:8000',
                 'http://127.0.0.1:5173','http://localhost:5173'}

@app.middleware('http')
async def local_guard(request,call_next):
    if request.url.path.startswith('/api') and request.method not in ('GET','HEAD'):
        if request.headers.get('origin') not in ALLOWED_ORIGINS or request.headers.get('x-local-app')!='fbo':
            return JSONResponse({'detail':'Недопустимый источник запроса.'},status_code=403)
    response=await call_next(request)
    response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['X-Frame-Options']='DENY'
    return response

@app.exception_handler(RequestValidationError)
async def validation_error(request,exc):
    return JSONResponse({'detail':'Проверьте формат введённых данных.'},status_code=422)

def current(request):
    token=request.cookies.get('fbo_session','')
    with lock:
        s=sessions.get(token)
        if not s or time.time()-s['used']>8*3600:
            sessions.pop(token,None)
            raise HTTPException(401,'Подключите кабинет Ozon.')
        s['used']=time.time()
        return s

class Connect(BaseModel):
    client_id:str=Field(pattern=r'^\d+$',max_length=30)
    api_key:SecretStr

class History(BaseModel):
    days:int=Field(default=90,ge=1,le=365)

class DigitizationParams(BaseModel):
    date_from:date
    date_to:date

@app.post('/api/connect')
def connect(body:Connect,request:Request,response:Response):
    try:
        api=Ozon(body.client_id,body.api_key.get_secret_value())
        roles=api.roles()
    except ApiError as exc:
        raise HTTPException(400,str(exc)) from None
    with lock:
        old=sessions.get(request.cookies.get('fbo_session',''))
        if old and old['job']['running']:
            raise HTTPException(409,'Дождитесь завершения загрузки.')
        sessions.pop(request.cookies.get('fbo_session',''),None)
        for k in list(sessions):
            if time.time()-sessions[k]['used']>8*3600 and not sessions[k]['job']['running']:
                sessions.pop(k)
        token=secrets.token_urlsafe(32)
        sessions[token]={'client':body.client_id,'api':api,'roles':roles,'used':time.time(),
            'job':{'running':False,'message':'Кабинет подключён','error':None},'logs':[]}
    response.set_cookie('fbo_session',token,httponly=True,samesite='strict',max_age=8*3600)
    return {'client_id':body.client_id,'expires_at':roles.get('expires_at')}

@app.post('/api/disconnect')
def disconnect(request:Request,response:Response):
    s=current(request)
    with lock:
        if s['job']['running']:
            raise HTTPException(409,'Дождитесь завершения загрузки.')
        sessions.pop(request.cookies.get('fbo_session',''),None)
    response.delete_cookie('fbo_session')
    return {'ok':True}

@app.get('/api/state')
def state(request:Request):
    s=current(request)
    with lock:
        return {'client_id':s['client'],'expires_at':s['roles'].get('expires_at'),
                'roles':[r.get('name','') for r in s['roles'].get('roles',[])],
                'job':dict(s['job']),'logs':list(s['logs'])}

def launch(s,kind,days=90,date_from=None,date_to=None):
    def progress(message):
        with lock:
            s['job']['message']=message
            s['logs'].append({'at':time.strftime('%H:%M:%S'),'message':message})
            s['logs']=s['logs'][-200:]
    with lock:
        if s['job']['running']:
            raise HTTPException(409,'Загрузка уже выполняется.')
        s['job']={'running':True,'message':'Подключаемся к Ozon…','error':None}
    def work():
        try:
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
            elif kind=='digitization':
                store.save(s['client'],'digitization',s['api'].finance_transactions(date_from,date_to,progress))
            else:
                store.save(s['client'],'history',s['api'].postings(days,progress))
            progress('Загрузка завершена. Снимок сохранён.')
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
                s['job']['running']=False
    threading.Thread(target=work,daemon=True).start()
    return {'started':True}

@app.post('/api/sync')
def sync(request:Request):
    return launch(current(request),'inventory')

@app.post('/api/history/sync')
def sync_history(body:History,request:Request):
    return launch(current(request),'history',body.days)

@app.post('/api/digitization/sync')
def sync_digitization(body:DigitizationParams,request:Request):
    if body.date_to < body.date_from:
        raise HTTPException(422,'Дата окончания не может быть раньше даты начала.')
    if (body.date_to-body.date_from).days > 30:
        raise HTTPException(422,'Выберите период не больше 31 дня.')
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
                        'fbs_stock_quantity':data.get('fbs_stock_quantity')}
        except (ValueError,KeyError,TypeError):
            continue
    return {'days':[{'date':day,**daily[day]} for day in sorted(daily)]}

@app.get('/api/history')
def history(request:Request):
    data=store.latest(current(request)['client'],'history')
    if not data:
        return {'at':None,'postings':[]}
    postings=sorted(data.get('postings') or [],key=lambda row:str(row.get('created_at') or ''),reverse=True)
    return {**data,'postings':postings}

@app.get('/api/digitization')
def digitization(request:Request):
    data=store.latest(current(request)['client'],'digitization')
    if not data:
        return {'at':None,'since':None,'to':None,'metrics':None,'components':{},'operation_types':[],
                'products':[],'warnings':[],'methodology':'Загрузите данные за выбранный период.'}
    try:
        return digitization_summarize(data)
    except (ValueError,KeyError,TypeError):
        raise HTTPException(422,'Не удалось обработать финансовый снимок Ozon.') from None

class ReplenishmentParams(BaseModel):
    window:int=Field(default=14)

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

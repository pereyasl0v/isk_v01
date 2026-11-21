import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive, Plus, Trash2, Save, RotateCcw, Search, X,
  Package, AlertCircle, ChevronDown,
} from "lucide-react";
import { DEFAULT_PACKAGING_WEIGHT_PERCENT, grossWeightWithPackaging, DEFAULT_CONTAINER_VOLUME_M3, DEFAULT_ROSTOV_USD_RATE, rostovFreightRateRubPerM3, batchNetWeightKg, batchVolumeM3, calculatePreliminaryCost, createDraft, createProduct, n } from "./preliminary-costing.mjs";

export async function request(path, method = "GET", body) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Local-App": "fbo" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Не удалось выполнить запрос.");
  return data;
}

export const money = value => new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(Number.isFinite(Number(value)) ? Number(value) : 0) + " ₽";
const volumeFormat = new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 8 });
const quantity = value => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n(value));
const percent = value => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n(value)) + "%";
const formatDate = value => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};
const calculationTitle = products => {
  const names = products.map(item => item.name.trim()).filter(Boolean);
  return (names.slice(0, 2).join(", ") + (names.length > 2 ? " +" + (names.length - 2) : "")).slice(0, 150);
};

function NumberField({ label, value, onChange, unit, step = "any", min = 0, help }) {
  return <label className="mc-field">
    <span>{label}</span>
    <div className="mc-input-wrap">
      <input type="number" min={min} step={step} value={value ?? ""} onChange={event => onChange(event.target.value)} />
      {unit && <small>{unit}</small>}
    </div>
    {help && <em>{help}</em>}
  </label>;
}

function BatchOutput({ label, value }) {
  return <label className="mc-field">
    <span>{label}</span>
    <output>{value}</output>
  </label>;
}

function TextField({ label, value, onChange, placeholder = "", maxLength }) {
  return <label className="mc-field">
    <span>{label}</span>
    <input type="text" value={value ?? ""} placeholder={placeholder} maxLength={maxLength} onChange={event => onChange(event.target.value)} />
  </label>;
}

export const routeNames = { route1: "Через Ростов", route2: "Через Южные ворота" };

function Breakdown({ product, route, showProductTotals }) {
  const cost = product[route];
  const expenses = route === "route1" ? [
    ["Товар и доставка до Саши", cost.goodsRub],
    ["Доставка до Ростова", cost.freightToRostovRub],
    ["Пошлина на товар", cost.dutyGoodsRub],
    ["Пошлина на доставку", cost.dutyFreightRub],
    ["НДС на товар", cost.vatGoodsRub],
    ["НДС на доставку", cost.vatFreightRub],
    ["Мой налог", cost.ownTaxRub],
  ] : [
    ["Первая оплата поставщику", cost.purchaseRub],
    ["Доля автодоставки и упаковки", cost.transportRub],
  ];
  return <details className="mc-breakdown">
    <summary>Состав себестоимости <ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="mc-breakdown-grid mc-single-route">
      <div>
        {expenses.map(([label, value]) => <div className="mc-breakdown-row" key={label}><span>{label}</span><b>{money(value)}</b></div>)}
        {route === "route2" && <div className="mc-breakdown-row"><span>Доля веса партии</span><b>{percent(cost.allocationShare * 100)}</b></div>}
        {showProductTotals && <div className="mc-breakdown-total"><span>Итого за партию</span><b>{money(cost.totalRub)}</b></div>}
      </div>
    </div>
  </details>;
}

export default function MarketCalculator() {
  const [draft, setDraft] = useState(() => createDraft());
  const [recordId, setRecordId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formingShipment, setFormingShipment] = useState(false);
  const shipmentAttempt = useRef(null);
  const navigate = useNavigate();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveItems, setArchiveItems] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [loadingId, setLoadingId] = useState(null);

  const validProducts = draft.products.filter(product => product.name.trim() && n(product.quantity) >= 1);
  const route = draft.selectedRoute;
  const validContainerVolume = route !== "route1" || n(draft.route1.containerVolumeM3) > 0;
  const yuanRate = route === "route1" ? draft.route1.yuanToRubRate : draft.route2.purchaseYuanToRubRate;
  const calculationDraft = useMemo(() => ({
    ...draft,
    products: route && validContainerVolume ? draft.products.filter(product => product.name.trim() && n(product.quantity) >= 1) : [],
  }), [draft, route, validContainerVolume]);
  const calculated = useMemo(() => calculatePreliminaryCost(calculationDraft), [calculationDraft]);

  const updateProduct = (id, key, value) => {
    setDraft(current => ({
      ...current,
      products: current.products.map(product => product.id === id ? { ...product, [key]: value } : product),
    }));
    setNotice("");
    setError("");
  };

  const updateRoute = (route, key, value) => {
    setDraft(current => ({ ...current, [route]: { ...current[route], [key]: value } }));
    setNotice("");
    setError("");
  };

  const addProduct = () => {
    if (draft.products.length >= 100) {
      setError("В одном расчёте можно добавить не более 100 товаров.");
      return;
    }
    setDraft(current => ({ ...current, products: [...current.products, createProduct()] }));
    setNotice("");
  };

  const removeProduct = id => {
    if (draft.products.length === 1) {
      setDraft(current => ({ ...current, products: [createProduct()] }));
      setNotice("");
      return;
    }
    setDraft(current => ({ ...current, products: current.products.filter(product => product.id !== id) }));
    setNotice("");
  };

  const reset = () => {
    setDraft(createDraft());
    setRecordId(null);
    setNotice("Создан новый расчёт. Предыдущая сохранённая запись осталась в архиве.");
    setError("");
  };

  const save = async () => {
    if (!validProducts.length) {
      setError("Добавь хотя бы один товар и укажи его наименование и количество.");
      return;
    }
    if (validProducts.length !== draft.products.length) {
      setError("Заполни наименование и количество во всех строках или удали пустые товары.");
      return;
    }
    const title = calculationTitle(validProducts);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = { name: title, data: draft };
      const result = recordId
        ? await request("/preliminary-costs/" + encodeURIComponent(recordId), "PUT", body)
        : await request("/preliminary-costs", "POST", body);
      setRecordId(result.id);
      setNotice(recordId ? "Изменения сохранены в архиве расчётов." : "Расчёт сохранён в архиве.");
    } catch (requestError) {
      setError(requestError.message || "Не удалось сохранить расчёт.");
    } finally {
      setSaving(false);
    }
  };

  const formShipment = async () => {
    if (saving || formingShipment || !route || !validContainerVolume || !validProducts.length) return;
    if (validProducts.length !== draft.products.length) {
      setError("Заполните наименование и количество у всех товаров или удалите пустые строки.");
      return;
    }
    if (shipmentAttempt.current?.draft !== draft) {
      shipmentAttempt.current = { draft, id: createProduct().id };
    }
    setFormingShipment(true);
    setError("");
    setNotice("");
    try {
      const shipment = await request("/purchase-shipments", "POST", {
        request_id: shipmentAttempt.current.id,
        calculation_id: recordId,
        name: calculationTitle(validProducts),
        data: draft,
      });
      navigate("/purchase-shipments/" + encodeURIComponent(shipment.id));
    } catch (requestError) {
      setError(requestError.message || "Не удалось сформировать поставку.");
    } finally {
      setFormingShipment(false);
    }
  };

  useEffect(() => {
    if (!archiveOpen) return undefined;
    let active = true;
    const timer = window.setTimeout(async () => {
      setArchiveLoading(true);
      setArchiveError("");
      try {
        const result = await request("/preliminary-costs?q=" + encodeURIComponent(archiveQuery));
        if (active) setArchiveItems(result.items || []);
      } catch (requestError) {
        if (active) setArchiveError(requestError.message || "Не удалось загрузить архив.");
      } finally {
        if (active) setArchiveLoading(false);
      }
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [archiveOpen, archiveQuery]);

  const openArchive = () => {
    setArchiveQuery("");
    setArchiveError("");
    setArchiveOpen(true);
  };

  const loadArchived = async id => {
    setLoadingId(id);
    setArchiveError("");
    try {
      const result = await request("/preliminary-costs/" + encodeURIComponent(id));
      const { yuanToRubRate: oldCommonRate, ...saved } = result.data;
      const route1 = result.data.route1;
      setDraft({
        ...saved,
        selectedRoute: saved.selectedRoute ?? "",
        packagingWeightPercent: result.data.packagingWeightPercent ?? DEFAULT_PACKAGING_WEIGHT_PERCENT,
        route1: {
          ...route1,
          yuanToRubRate: oldCommonRate ?? route1.yuanToRubRate,
          containerCostUsd: route1.containerCostUsd ?? route1.freightRateRubPerM3 * DEFAULT_CONTAINER_VOLUME_M3 / DEFAULT_ROSTOV_USD_RATE,
          containerVolumeM3: route1.containerVolumeM3 ?? DEFAULT_CONTAINER_VOLUME_M3,
        },
        route2: {
          ...saved.route2,
          purchaseYuanToRubRate: oldCommonRate ?? saved.route2.purchaseYuanToRubRate,
          freightYuanToRubRate: oldCommonRate ?? saved.route2.freightYuanToRubRate,
        },
      });
      setRecordId(result.id);
      setArchiveOpen(false);
      const notices = [];

      if (result.data.packagingWeightPercent == null) {
        notices.push("Расчёт обновлён: брутто учитывает 10% упаковки. Ранее введённые дополнительные расходы исключены.");
      }
      setNotice(notices.join(" ") || "Открыт сохранённый расчёт.");
      setError("");
    } catch (requestError) {
      setArchiveError(requestError.message || "Не удалось открыть расчёт.");
    } finally {
      setLoadingId(null);
    }
  };

  const deleteArchived = async item => {
    if (!window.confirm("Удалить расчёт «" + item.name + "» из архива?")) return;
    try {
      await request("/preliminary-costs/" + encodeURIComponent(item.id), "DELETE");
      setArchiveItems(current => current.filter(row => row.id !== item.id));
      if (recordId === item.id) setRecordId(null);
      setNotice("Расчёт удалён из архива.");
    } catch (requestError) {
      setArchiveError(requestError.message || "Не удалось удалить расчёт.");
    }
  };

  const multipleProducts = calculated.products.length > 1;
  const result = calculated.summary?.[route];

  return <div className="mc-page">
    <div className="mc-header">
      <div className="mc-heading-copy">
        <h1>Предварительная себестоимость</h1>
        {recordId && <span className="mc-record-state">Редактируется запись из архива</span>}
      </div>
      <div className="mc-header-actions">
        <button type="button" className="mc-button mc-button-light" onClick={openArchive}><Archive size={16} /> Архив расчётов</button>
        <button type="button" className="mc-button mc-button-primary" onClick={save} disabled={saving || formingShipment || !validProducts.length || !route || !validContainerVolume}><Save size={16} /> {saving ? "Сохраняем…" : recordId ? "Сохранить изменения" : "Сохранить расчёт"}</button>
        <button type="button" className="mc-icon-button" onClick={reset} title="Новый расчёт" aria-label="Новый расчёт"><RotateCcw size={17} /></button>
      </div>
    </div>

    {error && <div className="mc-alert mc-alert-error" role="alert"><AlertCircle size={17} />{error}</div>}
    {notice && <div className="mc-alert mc-alert-success" role="status">{notice}</div>}

    <section className="mc-panel">
      <label className="mc-field mc-route-select">
        <span>Маршрут доставки</span>
        <select value={route} onChange={event => setDraft(current => ({ ...current, selectedRoute: event.target.value }))}>
          <option value="">Выберите маршрут</option>
          {Object.entries(routeNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
      </label>
    </section>

    <section className="mc-panel">
      <div className="mc-section-heading">
        <div><h2>Общие параметры</h2></div>
        <button type="button" className="mc-button mc-button-light" onClick={addProduct}><Plus size={16} /> Добавить товар</button>
      </div>

      {draft.products.map((product, index) => {
        const volume = batchVolumeM3(product);
        const netWeight = batchNetWeightKg(product);
        const goodsYuan = n(product.unitPriceYuan) * n(product.quantity);
        return <article className="mc-product-card" key={product.id}>
        <div className="mc-product-heading">
          <strong>{product.name.trim() || "Новый товар"}</strong>
          <button type="button" className="mc-remove-button" onClick={() => removeProduct(product.id)} title="Удалить товар" aria-label="Удалить товар"><Trash2 size={16} /></button>
        </div>
        <div className="mc-product-fields">
          <TextField label="Наименование товара" value={product.name} onChange={value => updateProduct(product.id, "name", value)} placeholder="Например, Щипцы СВП" maxLength={300} />
          <TextField label="Артикул / код" value={product.article} onChange={value => updateProduct(product.id, "article", value)} placeholder="Необязательно" maxLength={80} />
          <NumberField label="Количество" value={product.quantity} onChange={value => updateProduct(product.id, "quantity", value)} unit="шт." step="1" min="1" />
          <NumberField label="Цена за 1 штуку" value={product.unitPriceYuan} onChange={value => updateProduct(product.id, "unitPriceYuan", value)} unit="¥" />
          <NumberField label="Длина одной штуки" value={product.lengthCm || ""} onChange={value => updateProduct(product.id, "lengthCm", value)} unit="см" />
          <NumberField label="Ширина одной штуки" value={product.widthCm || ""} onChange={value => updateProduct(product.id, "widthCm", value)} unit="см" />
          <NumberField label="Высота одной штуки" value={product.heightCm || ""} onChange={value => updateProduct(product.id, "heightCm", value)} unit="см" />
          <NumberField label="Вес нетто одной штуки" value={product.unitNetWeightG} onChange={value => updateProduct(product.id, "unitNetWeightG", value)} unit="г" help="Для расчёта маршрута через Южные ворота" />
          {index === 0 && <NumberField label="Вес упаковки от нетто" value={draft.packagingWeightPercent} onChange={value => setDraft(current => ({ ...current, packagingWeightPercent: value }))} unit="%" help="Для всех товаров. Брутто = нетто + вес упаковки." />}
        </div>
        <div className="mc-field-grid mc-batch-totals" aria-label="Параметры партии">
          <BatchOutput label="Объём партии" value={volume > 0 ? volumeFormat.format(volume) + " м³" : "—"} />
          <BatchOutput label="Вес нетто партии" value={netWeight > 0 ? volumeFormat.format(netWeight) + " кг" : "—"} />
          <BatchOutput label="Вес брутто партии" value={netWeight > 0 ? volumeFormat.format(grossWeightWithPackaging(netWeight, draft.packagingWeightPercent)) + " кг" : "—"} />
          <BatchOutput label="Стоимость товара в юанях" value={volumeFormat.format(goodsYuan) + " ¥"} />
          {route && <BatchOutput label="Стоимость товара в рублях без доставки и надбавок" value={money(goodsYuan * n(yuanRate))} />}
        </div>
      </article>;
      })}
    </section>

    {route === "route1" &&
      <section className="mc-panel mc-route-panel mc-route-rostov">
        <div className="mc-route-heading">
          <span className="mc-route-number">МАРШРУТ 1</span>
          <h2>Через Ростов</h2>
          <p>Китай → Ростов</p>
        </div>
        <div className="mc-field-grid">
          <NumberField label="Курс юаня" value={draft.route1.yuanToRubRate} onChange={value => updateRoute("route1", "yuanToRubRate", value)} unit="₽ за ¥" />
          <NumberField label="Наценка к оплате товара" value={draft.route1.purchaseMarkupPercent} onChange={value => updateRoute("route1", "purchaseMarkupPercent", value)} unit="%" step="0.1" />
          <NumberField label="Стоимость перевозки контейнера" value={draft.route1.containerCostUsd} onChange={value => updateRoute("route1", "containerCostUsd", value)} unit="$" />
          <NumberField label="Полезный объём контейнера" value={draft.route1.containerVolumeM3} onChange={value => updateRoute("route1", "containerVolumeM3", value)} unit="м³" />
          <NumberField label="Курс доллара для Ростова" value={draft.route1.usdToRubRate ?? DEFAULT_ROSTOV_USD_RATE} onChange={value => updateRoute("route1", "usdToRubRate", value)} unit="₽ за $" />
          <BatchOutput label="Доставка до Ростова, ₽/м³" value={validContainerVolume ? money(rostovFreightRateRubPerM3(draft.route1)) : "—"} />
          <NumberField label="Доля доставки под пошлину" value={draft.route1.dutyableFreightPercent} onChange={value => updateRoute("route1", "dutyableFreightPercent", value)} unit="%" step="0.1" />
          <NumberField label="НДС" value={draft.route1.vatPercent} onChange={value => updateRoute("route1", "vatPercent", value)} unit="%" step="0.1" />
          <NumberField label="Мой налог" value={draft.route1.ownTaxPercent} onChange={value => updateRoute("route1", "ownTaxPercent", value)} unit="%" step="0.1" help="По формуле из файла «2»" />
        </div>
      </section>}

    {route === "route2" && <section className="mc-panel mc-route-panel mc-route-south">
        <div className="mc-route-heading">
          <span className="mc-route-number">МАРШРУТ 2</span>
          <h2>Через Южные ворота</h2>
          <p>Китай → Южные ворота (Москва)</p>
        </div>
        <div className="mc-field-grid">
          <NumberField label="Курс юаня для оплаты товара" value={draft.route2.purchaseYuanToRubRate} onChange={value => updateRoute("route2", "purchaseYuanToRubRate", value)} unit="₽ за ¥" />
          <NumberField label="Курс юаня на момент отправки" value={draft.route2.freightYuanToRubRate} onChange={value => updateRoute("route2", "freightYuanToRubRate", value)} unit="₽ за ¥" />
          <NumberField label="Курс доллара в юани" value={draft.route2.usdToYuanRate} onChange={value => updateRoute("route2", "usdToYuanRate", value)} unit="¥ за $" />
          <NumberField label="Автодоставка за килограмм" value={draft.route2.autoFreightUsdPerKg} onChange={value => updateRoute("route2", "autoFreightUsdPerKg", value)} unit="$ / кг" />
          <NumberField label="Упаковка за коробку" value={draft.route2.packagingPerBoxUsd} onChange={value => updateRoute("route2", "packagingPerBoxUsd", value)} unit="$" />
          <NumberField label="Количество коробок" value={draft.route2.boxCount} onChange={value => updateRoute("route2", "boxCount", value)} unit="шт." step="1" />
        </div>
      </section>}

    {route && <section className="mc-results-section">
      <div className="mc-results-heading">
        <div><h2>Себестоимость</h2></div>
      </div>
      {result && <article className={"mc-result-card " + (route === "route1" ? "mc-result-rostov" : "mc-result-south")}>
        <div className="mc-result-top"><span>{routeNames[route]}</span></div>
        <strong>{money(result.averageCostPerUnit)} <small>{multipleProducts ? "/ шт. в среднем" : "/ шт."}</small></strong>
        <div className="mc-result-total"><span>Полная стоимость партии</span><b>{money(result.totalRub)}</b></div>
      </article>}

      {calculated.warnings.length > 0 && <div className="mc-alert mc-alert-warning"><AlertCircle size={17} /><div>{calculated.warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div></div>}

      {calculated.products.map(product => <article className="mc-product-result" key={product.id}>
        <div className="mc-product-result-heading">
          <h3>{product.name.trim() || "Без названия"}</h3>
          <p>{product.article && <span>Артикул {product.article}</span>}<span>{quantity(product.quantity)} шт.</span></p>
        </div>
        {multipleProducts && <p className="mc-unit-difference">{money(product[route].costPerUnit)} / шт.</p>}
        <Breakdown product={product} route={route} showProductTotals={multipleProducts} />
      </article>)}
      {result && <div className="mc-header-actions mt-4">
        <button type="button" className="mc-button mc-button-primary" disabled={saving || formingShipment} onClick={formShipment}>
          <Package size={16} /> {formingShipment ? "Формируем…" : "Сформировать поставку"}
        </button>
      </div>}
      {!calculated.products.length && <div className="mc-empty-results"><Package size={27} /><strong>{validContainerVolume ? "Добавь товары, чтобы увидеть себестоимость" : "Укажите полезный объём контейнера больше нуля"}</strong><span>Результаты пересчитываются автоматически при изменении параметров.</span></div>}
    </section>}

    {archiveOpen && <div className="mc-archive-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setArchiveOpen(false); }}>
      <section className="mc-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="mc-archive-title">
        <div className="mc-archive-header">
          <div><h2 id="mc-archive-title">Архив предварительных расчётов</h2><p>Сохранённые варианты закупки. Открой расчёт, чтобы изменить цены, вес, тарифы или маршрут.</p></div>
          <button type="button" className="mc-archive-close" aria-label="Закрыть архив" onClick={() => setArchiveOpen(false)}><X size={19} /></button>
        </div>
        <label className="mc-archive-search"><Search size={18} /><input type="search" value={archiveQuery} maxLength={100} onChange={event => setArchiveQuery(event.target.value)} placeholder="Поиск по названию расчёта или товара…" autoFocus /></label>
        <div className="mc-archive-list" aria-live="polite">
          {archiveLoading && <div className="mc-archive-state">Загружаем архив…</div>}
          {!archiveLoading && archiveError && <div className="mc-archive-error">{archiveError}</div>}
          {!archiveLoading && !archiveError && !archiveItems.length && <div className="mc-archive-empty"><Archive size={28} /><strong>{archiveQuery ? "Ничего не найдено" : "Архив пока пуст"}</strong><span>{archiveQuery ? "Попробуй изменить поисковый запрос." : "Сохрани предварительный расчёт — он появится здесь."}</span></div>}
          {!archiveLoading && archiveItems.map(item => <div className="mc-archive-item" key={item.id}>
            <button type="button" className="mc-archive-item-main" onClick={() => loadArchived(item.id)} disabled={loadingId === item.id}>
              <strong>{item.name}</strong>
              <span>Изменён: {formatDate(item.updated_at)}</span>
              <em>{loadingId === item.id ? "Открываем…" : "Открыть и редактировать"}</em>
            </button>
            <button type="button" className="mc-archive-delete" title="Удалить расчёт" aria-label={"Удалить " + item.name} onClick={() => deleteArchived(item)}><Trash2 size={16} /></button>
          </div>)}
        </div>
        <div className="mc-archive-footer"><span>{archiveItems.length} расчётов в списке</span><button type="button" className="mc-button mc-button-primary" onClick={() => { reset(); setArchiveOpen(false); }}>Новый расчёт</button></div>
      </section>
    </div>}
  </div>;
}

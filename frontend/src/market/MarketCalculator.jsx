import { useEffect, useMemo, useState } from "react";
import {
  Archive, Plus, Trash2, Save, RotateCcw, Search, X,
  Package, CheckCircle2, AlertCircle, ChevronDown,
} from "lucide-react";
import { batchNetWeightKg, batchVolumeM3, calculatePreliminaryCost, createDraft, createProduct, n } from "./preliminary-costing.mjs";

async function request(path, method = "GET", body) {
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

const money = value => new Intl.NumberFormat("ru-RU", {
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

function SelectField({ label, value, onChange, options, help }) {
  return <label className="mc-field">
    <span>{label}</span>
    <div className="mc-select-wrap">
      <select value={value} onChange={event => onChange(event.target.value)}>
        {options.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select>
      <ChevronDown size={15} />
    </div>
    {help && <em>{help}</em>}
  </label>;
}

function Breakdown({ product }) {
  const a = product.route1;
  const b = product.route2;
  return <details className="mc-breakdown">
    <summary>Состав себестоимости <ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="mc-breakdown-grid">
      <div>
        <h4>Через Ростов</h4>
        {[
          ["Товар и доставка до Саши", a.goodsRub],
          ["Доставка до Ростова", a.freightToRostovRub],
          ["Пошлина на товар", a.dutyGoodsRub],
          ["Пошлина на доставку", a.dutyFreightRub],
          ["НДС на товар", a.vatGoodsRub],
          ["НДС на доставку", a.vatFreightRub],
          ["Мой налог", a.ownTaxRub],
          ["Доставка и погрузка до СПб", a.allocatedAdditionalRub],
        ].map(([label, value]) => <div className="mc-breakdown-row" key={label}><span>{label}</span><b>{money(value)}</b></div>)}
        <div className="mc-breakdown-total"><span>Итого за партию</span><b>{money(a.totalRub)}</b></div>
        <div className="mc-breakdown-total"><span>За 1 шт.</span><b>{money(a.costPerUnit)}</b></div>
      </div>
      <div>
        <h4>Через Южные ворота</h4>
        {[
          ["Первая оплата поставщику", b.purchaseRub],
          ["Доля автодоставки и упаковки", b.transportRub],
          ["Доставка до СПб, дом, грузчики и упаковка", b.sharedExpensesRub],
        ].map(([label, value]) => <div className="mc-breakdown-row" key={label}><span>{label}</span><b>{money(value)}</b></div>)}
        <div className="mc-breakdown-row"><span>Доля веса партии</span><b>{percent(b.allocationShare * 100)}</b></div>
        <div className="mc-breakdown-total"><span>Итого за партию</span><b>{money(b.totalRub)}</b></div>
        <div className="mc-breakdown-total"><span>За 1 шт.</span><b>{money(b.costPerUnit)}</b></div>
      </div>
    </div>
  </details>;
}

export default function MarketCalculator() {
  const [draft, setDraft] = useState(() => createDraft());
  const [recordId, setRecordId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveItems, setArchiveItems] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [loadingId, setLoadingId] = useState(null);

  const validProducts = draft.products.filter(product => product.name.trim() && n(product.quantity) >= 1);
  const calculationDraft = useMemo(() => ({
    ...draft,
    products: draft.products.filter(product => product.name.trim() && n(product.quantity) >= 1),
  }), [draft]);
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
      const legacyRates = result.data.yuanToRubRate == null;
      setDraft({ ...result.data, yuanToRubRate: result.data.yuanToRubRate ?? result.data.route1.yuanToRubRate });
      setRecordId(result.id);
      setArchiveOpen(false);
      setNotice(legacyRates ? "Для обоих маршрутов применён сохранённый курс Ростова." : "Открыт сохранённый расчёт.");
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

  const route1Cheaper = calculated.summary?.cheaperRoute === "rostov";
  const route2Cheaper = calculated.summary?.cheaperRoute === "south_gates";

  return <div className="mc-page">
    <div className="mc-header">
      <div className="mc-heading-copy">
        <h1>Предварительная себестоимость</h1>
        {recordId && <span className="mc-record-state">Редактируется запись из архива</span>}
      </div>
      <div className="mc-header-actions">
        <button type="button" className="mc-button mc-button-light" onClick={openArchive}><Archive size={16} /> Архив расчётов</button>
        <button type="button" className="mc-button mc-button-primary" onClick={save} disabled={saving || !validProducts.length}><Save size={16} /> {saving ? "Сохраняем…" : recordId ? "Сохранить изменения" : "Сохранить расчёт"}</button>
        <button type="button" className="mc-icon-button" onClick={reset} title="Новый расчёт" aria-label="Новый расчёт"><RotateCcw size={17} /></button>
      </div>
    </div>

    {error && <div className="mc-alert mc-alert-error" role="alert"><AlertCircle size={17} />{error}</div>}
    {notice && <div className="mc-alert mc-alert-success" role="status"><CheckCircle2 size={17} />{notice}</div>}

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
          {index === 0 && <NumberField label="Курс юаня" value={draft.yuanToRubRate} onChange={value => setDraft(current => ({ ...current, yuanToRubRate: value }))} unit="₽ за ¥" help="Для всех товаров и обоих маршрутов" />}
        </div>
        <div className="mc-field-grid mc-batch-totals" aria-label="Параметры партии">
          <BatchOutput label="Объём партии" value={volume > 0 ? volumeFormat.format(volume) + " м³" : "—"} />
          <BatchOutput label="Вес нетто партии" value={netWeight > 0 ? volumeFormat.format(netWeight) + " кг" : "—"} />
          <BatchOutput label="Стоимость товара в юанях" value={volumeFormat.format(goodsYuan) + " ¥"} />
          <BatchOutput label="Стоимость товара в рублях без доставки и надбавок" value={money(goodsYuan * n(draft.yuanToRubRate))} />
        </div>
        <details className="mc-formula-note">
          <summary>Дополнительные параметры товара</summary>
          <div className="mc-field-grid mc-batch-totals">
            <NumberField label="Доставка до Саши, всего" value={product.deliveryToSashaYuan} onChange={value => updateProduct(product.id, "deliveryToSashaYuan", value)} unit="¥" help="Для маршрута через Ростов" />
            <NumberField label="Доставка до Гуанчжоу, всего" value={product.deliveryToGuangzhouYuan} onChange={value => updateProduct(product.id, "deliveryToGuangzhouYuan", value)} unit="¥" help="Для маршрута через Южные ворота" />
            <NumberField label="Пошлина по товару" value={product.dutyPercent} onChange={value => updateProduct(product.id, "dutyPercent", value)} unit="%" step="0.1" />
            <NumberField label="Вес брутто всей партии" value={product.grossWeightKg} onChange={value => updateProduct(product.id, "grossWeightKg", value)} unit="кг" />
          </div>
        </details>
      </article>;
      })}
    </section>

    <div className="mc-routes-grid">
      <section className="mc-panel mc-route-panel mc-route-rostov">
        <div className="mc-route-heading">
          <span className="mc-route-number">МАРШРУТ 1</span>
          <h2>Через Ростов</h2>
          <p>Китай → Ростов → Санкт-Петербург</p>
        </div>
        <div className="mc-field-grid">
          <NumberField label="Наценка к оплате товара" value={draft.route1.purchaseMarkupPercent} onChange={value => updateRoute("route1", "purchaseMarkupPercent", value)} unit="%" step="0.1" />
          <NumberField label="Доставка до Ростова" value={draft.route1.freightRateRubPerM3} onChange={value => updateRoute("route1", "freightRateRubPerM3", value)} unit="₽ / м³" help="В файле «2»: 17 000 × 95 ÷ 65, где 95 ₽ за $ — курс доллара" />
          <NumberField label="Доля доставки под пошлину" value={draft.route1.dutyableFreightPercent} onChange={value => updateRoute("route1", "dutyableFreightPercent", value)} unit="%" step="0.1" />
          <NumberField label="НДС" value={draft.route1.vatPercent} onChange={value => updateRoute("route1", "vatPercent", value)} unit="%" step="0.1" />
          <NumberField label="Мой налог" value={draft.route1.ownTaxPercent} onChange={value => updateRoute("route1", "ownTaxPercent", value)} unit="%" step="0.1" help="По формуле из файла «2»" />
          <SelectField label="Распределение доп. расходов" value={draft.route1.allocationMethod} onChange={value => updateRoute("route1", "allocationMethod", value)} options={[["volume", "По объёму"], ["weight", "По весу"], ["quantity", "По количеству"], ["value", "По стоимости товара"]]} />
          <NumberField label="Ростов → Санкт-Петербург" value={draft.route1.deliveryToSpbRub} onChange={value => updateRoute("route1", "deliveryToSpbRub", value)} unit="₽" />
          <NumberField label="Погрузка" value={draft.route1.loadersRub} onChange={value => updateRoute("route1", "loadersRub", value)} unit="₽" />
          <NumberField label="Разгрузка" value={draft.route1.unloadersRub} onChange={value => updateRoute("route1", "unloadersRub", value)} unit="₽" />
          <NumberField label="Прочие расходы" value={draft.route1.otherRub} onChange={value => updateRoute("route1", "otherRub", value)} unit="₽" />
        </div>
      </section>

      <section className="mc-panel mc-route-panel mc-route-south">
        <div className="mc-route-heading">
          <span className="mc-route-number">МАРШРУТ 2</span>
          <h2>Через Южные ворота</h2>
          <p>Китай → Южные ворота → Москва → Санкт-Петербург</p>
        </div>
        <div className="mc-field-grid">
          <NumberField label="Курс доллара в юани" value={draft.route2.usdToYuanRate} onChange={value => updateRoute("route2", "usdToYuanRate", value)} unit="¥ за $" />
          <NumberField label="Автодоставка за килограмм" value={draft.route2.autoFreightUsdPerKg} onChange={value => updateRoute("route2", "autoFreightUsdPerKg", value)} unit="$ / кг" />
          <NumberField label="Упаковка за коробку" value={draft.route2.packagingPerBoxUsd} onChange={value => updateRoute("route2", "packagingPerBoxUsd", value)} unit="$" />
          <NumberField label="Количество коробок" value={draft.route2.boxCount} onChange={value => updateRoute("route2", "boxCount", value)} unit="шт." step="1" />
          <NumberField label="Вес брутто всей поставки" value={draft.route2.grossWeightKg} onChange={value => updateRoute("route2", "grossWeightKg", value)} unit="кг" help="Если оставить 0, будет использован вес нетто товаров" />
          <NumberField label="Москва → Санкт-Петербург" value={draft.route2.deliveryToSpbRub} onChange={value => updateRoute("route2", "deliveryToSpbRub", value)} unit="₽" />
          <NumberField label="Доставка до дома" value={draft.route2.deliveryToHomeRub} onChange={value => updateRoute("route2", "deliveryToHomeRub", value)} unit="₽" />
          <NumberField label="Грузчики" value={draft.route2.loadersRub} onChange={value => updateRoute("route2", "loadersRub", value)} unit="₽" />
          <NumberField label="Упаковка в России" value={draft.route2.packingRub} onChange={value => updateRoute("route2", "packingRub", value)} unit="₽" />
          <NumberField label="Прочие расходы" value={draft.route2.otherRub} onChange={value => updateRoute("route2", "otherRub", value)} unit="₽" />
        </div>
      </section>
    </div>

    <section className="mc-results-section">
      <div className="mc-results-heading">
        <div><h2>Сравнение себестоимости</h2></div>
      </div>
      {calculated.summary && <div className="mc-comparison-grid">
        <article className={"mc-result-card mc-result-rostov" + (route1Cheaper ? " mc-result-best" : "")}>
          <div className="mc-result-top"><span>Китай → Ростов → СПб</span>{route1Cheaper && <b>ВЫГОДНЕЕ</b>}</div>
          <strong>{money(calculated.summary.route1.averageCostPerUnit)} <small>/ шт. в среднем</small></strong>
          <div className="mc-result-total"><span>Полная стоимость партии</span><b>{money(calculated.summary.route1.totalRub)}</b></div>
        </article>
        <article className={"mc-result-card mc-result-south" + (route2Cheaper ? " mc-result-best" : "")}>
          <div className="mc-result-top"><span>Китай → Южные ворота → СПб</span>{route2Cheaper && <b>ВЫГОДНЕЕ</b>}</div>
          <strong>{money(calculated.summary.route2.averageCostPerUnit)} <small>/ шт. в среднем</small></strong>
          <div className="mc-result-total"><span>Полная стоимость партии</span><b>{money(calculated.summary.route2.totalRub)}</b></div>
        </article>
      </div>}

      {calculated.summary && <div className="mc-result-difference">
        {calculated.summary.cheaperRoute
          ? <><CheckCircle2 size={17} /> Разница между маршрутами на всю партию: <b>{money(calculated.summary.differenceRub)}</b>. Выгоднее {route1Cheaper ? "маршрут через Ростов" : "маршрут через Южные ворота"}.</>
          : <>При текущих параметрах стоимость двух маршрутов одинаковая.</>}
      </div>}

      {calculated.warnings.length > 0 && <div className="mc-alert mc-alert-warning"><AlertCircle size={17} /><div>{calculated.warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div></div>}

      {calculated.products.map(product => <article className="mc-product-result" key={product.id}>
        <div className="mc-product-result-heading">
          <h3>{product.name.trim() || "Без названия"}</h3>
          <p>{product.article && <span>Артикул {product.article}</span>}<span>{quantity(product.quantity)} шт.</span></p>
        </div>
        <dl className="mc-unit-costs">
          <div><dt>Через Ростов</dt><dd>{money(product.route1.costPerUnit)} / шт.</dd></div>
          <div><dt>Через Южные ворота</dt><dd>{money(product.route2.costPerUnit)} / шт.</dd></div>
        </dl>
        {product.differencePerUnit !== 0 && <p className="mc-unit-difference">
          {product.differencePerUnit > 0 ? "Южные ворота дешевле на " : "Ростов дешевле на "}
          <strong>{money(Math.abs(product.differencePerUnit))} / шт.</strong>
        </p>}
        <Breakdown product={product} />
      </article>)}
      {!calculated.products.length && <div className="mc-empty-results"><Package size={27} /><strong>Добавь товары, чтобы увидеть сравнение</strong><span>Результаты пересчитываются автоматически при изменении параметров.</span></div>}
    </section>

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

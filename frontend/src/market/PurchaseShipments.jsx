import ScrollTable from "../ScrollTable";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Calculator, CalendarDays, Download, FileText, Package, Paperclip, Pencil, Trash2, Truck, Upload } from "lucide-react";
import MarketCalculator, { money, request, routeNames } from "./MarketCalculator";

const basePath = "/purchase-shipments";
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Moscow",
});
const units = new Intl.NumberFormat("ru-RU");
const shipmentPath = id => basePath + "/" + encodeURIComponent(id);
const sizeText = bytes => bytes >= 1024 * 1024
  ? (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " МБ"
  : Math.max(1, Math.ceil(bytes / 1024)) + " КБ";
const documentDate = value => value
  ? new Date(value).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })
  : "—";

async function documentResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Не удалось выполнить действие.");
  return data;
}

function ShipmentDocuments({ shipmentId }) {
  const fileInput = useRef(null);
  const path = basePath + "/" + encodeURIComponent(shipmentId) + "/documents";
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch("/api" + path, { credentials: "same-origin" })
      .then(documentResponse)
      .then(data => { if (active) setDocuments(data.documents || []); })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path]);

  async function reload() {
    const data = await documentResponse(
      await fetch("/api" + path, { credentials: "same-origin" })
    );
    setDocuments(data.documents || []);
  }

  async function uploadFiles(files) {
    if (!files?.length) return;
    setError("");
    setMessage("");
    setBusy(true);
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 15 * 1024 * 1024) throw new Error("Файл " + file.name + " больше 15 МБ.");
        if (!file.size) throw new Error("Файл " + file.name + " пустой.");
        await documentResponse(await fetch("/api" + path, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
          },
          body: file,
        }));
        count++;
      }
      setMessage(count === 1 ? "Файл прикреплён." : "Прикреплено файлов: " + count + ".");
    } catch (err) {
      setError(err.message);
    } finally {
      try { await reload(); } catch (err) { setError(err.message); }
      setBusy(false);
    }
  }

  async function removeFile(document) {
    if (busy || !window.confirm("Удалить файл «" + document.name + "»?")) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await documentResponse(await fetch("/api" + path + "/" + encodeURIComponent(document.id), {
        method: "DELETE",
        credentials: "same-origin",
      }));
      await reload();
      setMessage("Файл удалён.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="shipment-documents">
    <div className="shipment-documents-heading">
      <div>
        <h2>Документы поставки</h2>
        <p>Накладные, чеки, счета, акты и другие файлы</p>
      </div>
      <span className="shipment-documents-count">{documents.length} / 40 файлов</span>
    </div>
    {loading ? <p className="shipment-documents-empty">Загружаем документы…</p> : documents.length ? (
      <ul className="shipment-document-list">
        {documents.map(doc => <li className="shipment-document" key={doc.id}>
          <FileText size={21} className="shipment-document-icon" />
          <div className="shipment-document-info">
            <strong title={doc.name}>{doc.name}</strong>
            <small>{sizeText(doc.size)} · {documentDate(doc.added_at)}</small>
          </div>
          <a href={path + "/" + encodeURIComponent(doc.id)} aria-label={"Скачать " + doc.name} title="Скачать">
            <Download size={17} />
          </a>
          <button type="button" disabled={busy} onClick={() => removeFile(doc)}
            aria-label={"Удалить " + doc.name} title="Удалить">
            <Trash2 size={17} />
          </button>
        </li>)}
      </ul>
    ) : <div className="shipment-documents-empty"><Paperclip size={18} /> Пока нет прикреплённых документов</div>}
    <input
      ref={fileInput}
      type="file"
      multiple
      accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.xml,.odt,.ods,.jpg,.jpeg,.png,.webp,.zip"
      className="shipment-hidden-file-input"
      aria-label="Выбрать документы поставки"
      onChange={event => {
        const files = event.target.files;
        uploadFiles(files);
        event.target.value = "";
      }}
    />
    <button type="button" className="mc-button mc-button-light shipment-upload-button"
      disabled={busy || documents.length >= 40} onClick={() => fileInput.current?.click()}>
      <Upload size={16} /> {busy ? "Загрузка…" : "Прикрепить документы"}
    </button>
    <p className="shipment-document-hint">PDF, Word, Excel, CSV, изображения и ZIP · до 15 МБ на файл</p>
    {error && <p className="mc-alert mc-alert-error" role="alert">{error}</p>}
    {message && <p className="mc-alert mc-alert-success" role="status">{message}</p>}
  </section>;
}

function ShipmentActions({ item, deleting, onDelete }) {
  return <div className="shipment-actions">
    <Link className="mc-button mc-button-light" to={shipmentPath(item.id) + "/edit"}>
      <Pencil size={15} /> Редактировать
    </Link>
    <button type="button" className="mc-button shipment-delete" disabled={deleting}
      onClick={() => onDelete(item)} aria-label={"Удалить поставку «" + item.name + "»"}>
      <Trash2 size={15} /> Удалить
    </button>
  </div>;
}

export default function PurchaseShipments({ editing = false }) {
  const { shipmentId } = useParams();
  const navigate = useNavigate();
  const path = shipmentId ? shipmentPath(shipmentId) : basePath;
  const [response, setResponse] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    let active = true;
    request(path).then(
      data => { if (active) setResponse({ path, editing, data }); },
      error => { if (active) setResponse({ path, editing, error: error.message }); },
    );
    return () => { active = false; };
  }, [path, editing]);

  const current = response?.path === path && response.editing === editing ? response : null;
  const shipment = shipmentId ? current?.data : null;
  const items = current?.data?.items;
  const route = shipment?.data.selectedRoute;
  const total = shipment?.calculated.summary[route];

  async function remove(item) {
    if (deletingId || !window.confirm(`Удалить поставку «${item.name}»?`)) return;
    setDeletingId(item.id);
    setDeleteError(null);
    try {
      await request(shipmentPath(item.id), "DELETE");
      if (shipmentId) navigate(basePath, { replace: true });
      else setResponse(previous => previous?.path === basePath && previous.data
        ? { ...previous, data: { items: previous.data.items.filter(row => row.id !== item.id) } }
        : previous);
    } catch (error) {
      setDeleteError({ path, message: error.message });
    } finally {
      setDeletingId(null);
    }
  }

  if (editing && shipment) return <div className="mc"><MarketCalculator key={shipment.id} shipment={shipment} /></div>;

  return <div className="mc"><div className="mc-page shipments-page">
    <div className="shipment-heading">
      <div>
        {shipmentId && <Link className="shipment-back" to={basePath}><ArrowLeft size={15} /> Все поставки</Link>}
        <h1>{shipment?.name || "Поставки"}</h1>
      </div>
      {shipment && <ShipmentActions item={shipment} deleting={Boolean(deletingId)} onDelete={remove} />}
      {!shipmentId && <Link className="mc-button mc-button-light" to="/market-calculator"><Calculator size={16} /> Перейти к расчётам</Link>}
    </div>
    {!current && <p role="status">Загружаем…</p>}
    {current?.error && <p className="mc-alert mc-alert-error" role="alert">{current.error}</p>}
    {deleteError?.path === path && <p className="mc-alert mc-alert-error" role="alert">{deleteError.message}</p>}
    {items?.length === 0 && <div className="shipment-empty">
      <Package size={30} /><h2>Поставок пока нет</h2>
      <p>Сформируйте первую поставку из расчёта себестоимости.</p>
    </div>}
    {items?.length > 0 && <ul className="shipment-grid">
      {items.map(item => <li key={item.id} className="shipment-card">
        <div className="shipment-card-heading">
          <span className="shipment-icon"><Truck size={20} /></span>
          <div>
            <Link className="shipment-title" to={shipmentPath(item.id)}>{item.name}</Link>
            <p>{routeNames[item.route]}</p>
          </div>
        </div>
        <dl className="shipment-stats">
          <div><dt>Количество</dt><dd>{units.format(item.quantity)} шт.</dd></div>
          <div><dt>Стоимость партии</dt><dd>{money(item.total)}</dd></div>
        </dl>
        <time className="shipment-date" dateTime={item.created_at}><CalendarDays size={15} />{dateFormat.format(new Date(item.created_at))}</time>
        <div className="shipment-card-footer">
          <Link className="shipment-open" to={shipmentPath(item.id)}>Открыть <ArrowRight size={15} /></Link>
          <ShipmentActions item={item} deleting={Boolean(deletingId)} onDelete={remove} />
        </div>
      </li>)}
    </ul>}
    {shipment && <>
      <section className="shipment-detail">
        <div className="shipment-detail-summary">
          <div>
            <span className="shipment-date"><Truck size={16} />{routeNames[route]}</span>
            <time className="shipment-date" dateTime={shipment.created_at}><CalendarDays size={15} />{dateFormat.format(new Date(shipment.created_at))}</time>
          </div>
          <dl className="shipment-stats">
            <div><dt>Количество</dt><dd>{units.format(total.totalQuantity)} шт.</dd></div>
            <div><dt>Стоимость партии</dt><dd>{money(total.totalRub)}</dd></div>
          </dl>
        </div>
        <ScrollTable label="Товары поставки" stickyColumn><table>
          <thead><tr><th>Товар</th><th>Артикул</th><th>Количество, шт.</th><th>За штуку</th><th>За партию</th></tr></thead>
          <tbody>{shipment.calculated.products.map(product => <tr key={product.id}>
            <td>{product.name}</td><td>{product.article || "—"}</td><td>{units.format(product.quantity)}</td>
            <td>{money(product[route].costPerUnit)}</td><td>{money(product[route].totalRub)}</td>
          </tr>)}</tbody>
        </table></ScrollTable>
      </section>
      <ShipmentDocuments shipmentId={shipment.id} />
    </>}
  </div></div>;
}

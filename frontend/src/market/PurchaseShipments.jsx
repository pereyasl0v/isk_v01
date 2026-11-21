import ScrollTable from "../ScrollTable";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Calculator, CalendarDays, Package, Pencil, Trash2, Truck } from "lucide-react";
import MarketCalculator, { money, request, routeNames } from "./MarketCalculator";

const basePath = "/purchase-shipments";
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Moscow",
});
const units = new Intl.NumberFormat("ru-RU");
const shipmentPath = id => basePath + "/" + encodeURIComponent(id);

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
    {shipment && <section className="shipment-detail">
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
    </section>}
  </div></div>;
}

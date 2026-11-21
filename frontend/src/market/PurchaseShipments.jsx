import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { money, request, routeNames } from "./MarketCalculator";

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Moscow",
});

export default function PurchaseShipments() {
  const { shipmentId } = useParams();
  const path = shipmentId ? "/purchase-shipments/" + encodeURIComponent(shipmentId) : "/purchase-shipments";
  const [response, setResponse] = useState(null);

  useEffect(() => {
    let active = true;
    request(path).then(
      data => { if (active) setResponse({ path, data }); },
      error => { if (active) setResponse({ path, error: error.message }); },
    );
    return () => { active = false; };
  }, [path]);

  const current = response?.path === path ? response : null;
  const shipment = shipmentId ? current?.data : null;
  const items = current?.data?.items;
  const route = shipment?.data.selectedRoute;
  const total = shipment?.calculated.summary[route];

  return <div className="mc"><div className="mc-page">
    <div className="mc-header">
      <div className="mc-heading-copy"><h1>{shipment?.name || "Поставки"}</h1></div>
      <div className="mc-header-actions">
        {shipmentId
          ? <Link className="mc-button mc-button-light" to="/purchase-shipments">Все поставки</Link>
          : <Link className="mc-button mc-button-light" to="/market-calculator">Перейти к расчётам</Link>}
      </div>
    </div>
    {!current && <p role="status">Загружаем…</p>}
    {current?.error && <p className="mc-alert mc-alert-error" role="alert">{current.error}</p>}
    {items && <section className="mc-panel">
      {!items.length ? <p>Поставок пока нет. Сформируйте поставку из расчёта себестоимости.</p> :
        <ul className="divide-y">
          {items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <Link className="font-semibold text-emerald-900 hover:underline" to={"/purchase-shipments/" + encodeURIComponent(item.id)}>{item.name}</Link>
            <time dateTime={item.created_at}>{dateFormat.format(new Date(item.created_at))}</time>
          </li>)}
        </ul>}
    </section>}
    {shipment && <section className="mc-panel">
      <div className="mc-section-heading"><h2>{routeNames[route]}</h2>
        <time dateTime={shipment.created_at}>{dateFormat.format(new Date(shipment.created_at))}</time>
      </div>
      <p className="mb-4">Полная стоимость партии <strong>{money(total.totalRub)}</strong></p>
      <div className="table-scroll"><table>
        <thead><tr><th>Товар</th><th>Артикул</th><th>Количество, шт.</th><th>За штуку</th><th>За партию</th></tr></thead>
        <tbody>{shipment.calculated.products.map(product => <tr key={product.id}>
          <td>{product.name}</td><td>{product.article || "—"}</td><td>{product.quantity}</td>
          <td>{money(product[route].costPerUnit)}</td><td>{money(product[route].totalRub)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </div></div>;
}

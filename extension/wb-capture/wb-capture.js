(() => {
  "use strict";

  // Runs in the page's MAIN world so it can observe ordinary WB fetch/XHR responses.
  // It only exports public product fields; no cookies, request headers or tokens.
  let latest = null;
  let button = null;

  const getSearch = input => {
    try {
      const url = new URL(String(input), location.href);
      if (!/\/(?:__internal\/u-search\/)?exactmatch\/ru\/common\/v\d+\/search$/i.test(url.pathname)) return null;
      const page = url.searchParams.get("page");
      if (page && page !== "1") return null;
      let query = String(url.searchParams.get("query") || "").replace(/\+/g, " ");
      for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(query); i++) {
        try { query = decodeURIComponent(query); } catch { break; }
      }
      query = query.trim().replace(/\s+/g, " ");
      if (!query) return null;
      return {query, priority: page ? 1 : 2};
    } catch {
      return null;
    }
  };

  const toRub = value => {
    const number = Number(value);
    return value == null || !Number.isFinite(number) || number <= 0
      ? null
      : Math.round(number) / 100;
  };

  function processResponse(requestUrl, data) {
    const request = getSearch(requestUrl);
    if (!request) return;

    const cards = data?.products ?? data?.data?.products;
    if (!Array.isArray(cards) || !cards.length) return;

    const products = cards.slice(0, 10).map((card, index) => {
      const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
      const selected = sizes.find(size => size?.price?.product != null)
        || sizes.find(size => size?.price);
      const price = selected?.price || {};
      return {
        position: index + 1,
        id: String(card.id ?? card.nmId ?? ""),
        name: String(card.name ?? "Без названия"),
        brand: String(card.brand ?? ""),
        price_rub: toRub(price.product ?? card.salePriceU),
        basic_price_rub: toRub(price.basic ?? card.priceU)
      };
    }).filter(product => product.id && product.price_rub !== null)
      .map((product, index) => ({...product, position: index + 1}));

    if (!products.length) return;
    if (latest?.query === request.query && latest.priority > request.priority) return;

    latest = {
      source: "market-calculate-browser",
      query: request.query,
      captured_at: new Date().toISOString(),
      products,
      priority: request.priority
    };

    if (button) {
      button.disabled = false;
      button.textContent = "↓ Сохранить ТОП-10 (" + products.length + ")";
      button.title = "Поиск: " + request.query;
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      const requestUrl = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (getSearch(requestUrl) && response.ok) {
        response.clone().json()
          .then(data => processResponse(requestUrl, data))
          .catch(() => {});
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this.__marketCalculateUrl = String(url);
    return originalOpen.call(this, method, url, ...args);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (getSearch(this.__marketCalculateUrl)) {
      this.addEventListener("load", function() {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const data = this.responseType === "json"
            ? this.response
            : JSON.parse(this.responseText);
          processResponse(this.__marketCalculateUrl, data);
        } catch {}
      }, {once: true});
    }
    return originalSend.apply(this, args);
  };

  function addExportButton() {
    if (!document.body || document.getElementById("market-calculate-wb-export")) return;

    button = document.createElement("button");
    button.id = "market-calculate-wb-export";
    button.disabled = !latest;
    button.textContent = latest
      ? "↓ Сохранить ТОП-10 (" + latest.products.length + ")"
      : "Откройте поиск WB";
    button.title = "Экспорт первых 10 карточек поисковой выдачи";
    button.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "padding:12px 16px",
      "border:0",
      "border-radius:12px",
      "background:#6a21d8",
      "color:#fff",
      "font:600 14px Arial,sans-serif",
      "box-shadow:0 4px 20px #3335",
      "cursor:pointer"
    ].join(";");

    button.addEventListener("click", () => {
      if (!latest) return;
      const safeData = {
        source: latest.source,
        query: latest.query,
        captured_at: latest.captured_at,
        products: latest.products
      };
      const blob = new Blob([JSON.stringify(safeData, null, 2)], {
        type: "application/json"
      });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = "wb-top10-" + Date.now() + ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    });

    document.body.appendChild(button);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addExportButton, {once: true});
  } else {
    addExportButton();
  }
})();

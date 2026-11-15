(() => {
  "use strict";

  const BUTTON_ID = "market-calculate-ozon-export";
  let button = null;

  function queryFromUrl() {
    try {
      const url = new URL(location.href);
      return (url.searchParams.get("text") || url.searchParams.get("query") || "").trim();
    } catch { return ""; }
  }

  function productIdFromUrl(href) {
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/\/product\/.*?-(\d+)(?:\/|$)/i)
        || url.pathname.match(/\/product\/(\d+)(?:\/|$)/i);
      return match ? match[1] : "";
    } catch { return ""; }
  }

  function parseRub(text) {
    if (!text) return null;
    const match = String(text).match(/([\d\u00a0\u202f ]+(?:[,.]\d{1,2})?)\s*₽/);
    if (!match) return null;
    const value = Number(match[1].replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  }

  function cardFor(anchor) {
    let node = anchor;
    for (let depth = 0; node && node !== document.body && depth < 9; depth++, node = node.parentElement) {
      const text = node.innerText || "";
      if (text.length > 1200) continue;
      const productLinks = [...node.querySelectorAll('a[href*="/product/"]')];
      const uniqueIds = new Set(productLinks.map(link => productIdFromUrl(link.href)).filter(Boolean));
      if (uniqueIds.size <= 1 && parseRub(text)) return node;
    }
    return anchor.parentElement || anchor;
  }

  function titleFor(anchor, card) {
    const imageAlt = card.querySelector("img[alt]")?.getAttribute("alt")?.trim();
    const aria = anchor.getAttribute("aria-label")?.trim();
    const title = anchor.getAttribute("title")?.trim();
    const anchorText = (anchor.innerText || "").trim().replace(/\s+/g, " ");
    const candidate = imageAlt || aria || title || anchorText;
    if (candidate && candidate.length > 3 && !/^\d/.test(candidate)) return candidate.slice(0, 240);
    const lines = (card.innerText || "").split(/\n+/).map(x=>x.trim()).filter(Boolean);
    return (lines.find(line=>line.length>8 && !/₽|балл|достав|оцен|отзыв|рейтинг/i.test(line)) || "Товар Ozon").slice(0,240);
  }

  function collectProducts() {
    const anchors = [...document.querySelectorAll('a[href*="/product/"]')];
    const seen = new Set();
    const products = [];
    for (const anchor of anchors) {
      const id = productIdFromUrl(anchor.href);
      if (!id || seen.has(id)) continue;
      const card = cardFor(anchor);
      const price = parseRub(card.innerText || "");
      if (price === null) continue;
      const url = new URL(anchor.href, location.href);
      url.search = "";
      url.hash = "";
      products.push({
        position: products.length + 1,
        id,
        name: titleFor(anchor, card),
        brand: "",
        url: url.href,
        price_rub: price
      });
      seen.add(id);
      if (products.length === 10) break;
    }
    return products;
  }

  function setButtonState() {
    if (!button) return;
    const query = queryFromUrl();
    button.disabled = !query;
    const label = query ? "↓ Сохранить ТОП-10 Ozon" : "Откройте поиск Ozon";
    if (button.textContent !== label) button.textContent = label;
  }

  function ensureButton() {
    if (!document.body) return;
    if (document.getElementById(BUTTON_ID)) {
      button = document.getElementById(BUTTON_ID);
      setButtonState();
      return;
    }
    button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Откройте поиск Ozon";
    button.disabled = true;
    button.title = "Сохранить первые 10 видимых карточек Ozon";
    button.style.cssText = [
      "position:fixed","right:16px","bottom:16px","z-index:2147483647",
      "padding:12px 16px","border:0","border-radius:12px",
      "background:#075bca","color:#fff","font:600 14px Arial,sans-serif",
      "box-shadow:0 4px 20px #3335","cursor:pointer"
    ].join(";");

    button.addEventListener("click", () => {
      const query = queryFromUrl();
      const products = collectProducts();
      if (!products.length) {
        button.textContent = "Карточки не распознаны";
        setTimeout(setButtonState, 2200);
        return;
      }
      const payload = {
        source: "market-calculate-ozon-browser",
        query,
        captured_at: new Date().toISOString(),
        products
      };
      const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = "ozon-top10-" + Date.now() + ".json";
      link.click();
      setTimeout(()=>URL.revokeObjectURL(blobUrl),1500);
      button.textContent = "Сохранено: " + products.length + " карточек";
      setTimeout(setButtonState,2500);
    });

    document.body.appendChild(button);
    setButtonState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded",ensureButton,{once:true});
  } else ensureButton();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) ensureButton();
    else setButtonState();
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();

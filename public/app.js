const {
  parseMoney,
  money,
  formatMoney,
  formatYearMonth,
  formatShortDate,
  isoDate,
  currentMonth,
  daysInMonth,
  shiftMonth,
  describePayoff,
  monthSummary,
  buildAdvice,
} = window.GiderCalc;

const STORAGE_KEY = "gider-defteri-v1";
const SESSION_KEY = "gider-oturum";
const UI_KEY = "gider-defteri-ui";

const CATEGORIES = [
  { id: "market", name: "Market", color: "#d6ff3f" },
  { id: "yemek", name: "Yemek", color: "#ffb020" },
  { id: "ulasim", name: "Ulaşım", color: "#5ec8ff" },
  { id: "fatura", name: "Fatura", color: "#c9a6ff" },
  { id: "eglence", name: "Eğlence", color: "#ff4d8d" },
  { id: "saglik", name: "Sağlık", color: "#3dffe8" },
  { id: "giyim", name: "Giyim", color: "#ff8a3d" },
  { id: "kisisel", name: "Kişisel", color: "#8b7cff" },
  { id: "diger", name: "Diğer", color: "#9aa0b5" },
];

const FIXED_CATS = [
  { id: "kira", name: "Kira", color: "#8a5a2b" },
  { id: "fatura", name: "Fatura", color: "#6b5b95" },
  { id: "abonelik", name: "Abonelik", color: "#2c5f8a" },
  { id: "ulasim", name: "Ulaşım", color: "#2f7d4f" },
  { id: "diger", name: "Diğer", color: "#6d675f" },
];

const VIEWS = {
  dashboard: renderDashboard,
  overview: renderOverview,
  expenses: renderExpenses,
  fixed: renderFixed,
  debts: renderDebts,
  settings: renderSettings,
};

let state = defaultState();
let ui = loadUi();
let toastTimer = 0;
let currentUser = null;
let saveChain = Promise.resolve();

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function moneyToInput(n) {
  if (!n) return "";
  const hasCents = Math.round(Math.abs(n) * 100) % 100 !== 0;
  return hasCents ? String(n).replace(".", ",") : String(n);
}

function catName(list, id) {
  return list.find((item) => item.id === id)?.name || "Diğer";
}

function labelMap() {
  return Object.fromEntries(CATEGORIES.map((item) => [item.id, item.name]));
}

function defaultState() {
  return { version: 1, salary: 0, extras: [], fixed: [], expenses: [], debts: [] };
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad");
  const salaryValue = parseMoney(data.salary ?? 0);
  const salary = Number.isFinite(salaryValue) && salaryValue > 0 ? salaryValue : 0;
  const fixed = (Array.isArray(data.fixed) ? data.fixed : []).map((item) => {
    const amount = parseMoney(item?.amount);
    const name = cleanText(item?.name, 40);
    const category = FIXED_CATS.some((cat) => cat.id === item?.category) ? item.category : "diger";
    if (!name || !Number.isFinite(amount) || amount <= 0) return null;
    return { id: cleanText(item.id, 80) || uid(), name, amount, category };
  }).filter(Boolean);
  const expenses = (Array.isArray(data.expenses) ? data.expenses : []).map((item) => {
    const amount = parseMoney(item?.amount);
    const date = String(item?.date ?? "");
    const category = CATEGORIES.some((cat) => cat.id === item?.category) ? item.category : "diger";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0) return null;
    return {
      id: cleanText(item.id, 80) || uid(),
      date,
      category,
      amount,
      note: cleanText(item?.note, 120),
    };
  }).filter(Boolean);
  const debts = (Array.isArray(data.debts) ? data.debts : []).map((item) => {
    const remaining = parseMoney(item?.remaining);
    const paymentRaw = item?.monthlyPayment;
    const monthlyPayment = paymentRaw === "" || paymentRaw == null ? 0 : parseMoney(paymentRaw);
    const rateRaw = item?.annualRate;
    const annualRate = rateRaw === "" || rateRaw == null ? 0 : parseMoney(rateRaw);
    const name = cleanText(item?.name, 40);
    if (!name || !Number.isFinite(remaining) || remaining <= 0) return null;
    if (!Number.isFinite(monthlyPayment) || monthlyPayment < 0) return null;
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) return null;
    return {
      id: cleanText(item.id, 80) || uid(),
      name,
      remaining,
      monthlyPayment,
      annualRate,
    };
  }).filter(Boolean);
  const extras = (Array.isArray(data.extras) ? data.extras : []).map((item) => {
    const amount = parseMoney(item?.amount);
    const name = cleanText(item?.name, 40);
    const month = String(item?.month ?? "");
    if (!name || !/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(amount) || amount <= 0) return null;
    return { id: cleanText(item.id, 80) || uid(), name, amount, month };
  }).filter(Boolean);
  return { version: 1, salary, extras, fixed, expenses, debts };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function isBlankLedger(data) {
  return !data || (!data.salary && !(data.extras || []).length && !(data.fixed || []).length && !(data.expenses || []).length && !(data.debts || []).length);
}

function saveState() {
  if (!currentUser) return;
  if (currentUser.provider === "google" || currentUser.provider === "apple") {
    try {
      localStorage.setItem(accountKey(currentUser), JSON.stringify(state));
    } catch {
      toast("Kayıt bu tarayıcıya yazılamadı.");
    }
    return;
  }
  if (currentUser.provider === "local") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      toast("Kayıt bu tarayıcıya yazılamadı.");
    }
    return;
  }
  const snapshot = JSON.parse(JSON.stringify(state));
  saveChain = saveChain.then(() => persistLedger(snapshot)).catch(() => {});
}

function accountKey(user) {
  return `gider-defteri:${user.provider}:${user.id}`;
}

function readSession() {
  try {
    const data = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!data?.id || (data.provider !== "google" && data.provider !== "apple")) return null;
    return data;
  } catch {
    return null;
  }
}

function parseJwt(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(atob(part).split("").map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  return JSON.parse(json);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.ready === "1") resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.ready = "1";
      resolve();
    };
    script.onerror = () => reject(new Error("script"));
    document.head.appendChild(script);
  });
}

function authConfig() {
  return window.GIDER_CONFIG || {};
}

function enterClientAccount(user) {
  currentUser = {
    id: user.id,
    email: user.email || "",
    name: user.name || user.email || "Hesap",
    provider: user.provider,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
  try {
    const raw = localStorage.getItem(accountKey(currentUser));
    state = raw ? normalizeState(JSON.parse(raw)) : defaultState();
  } catch {
    state = defaultState();
  }
  if (isBlankLedger(state)) {
    const legacy = loadState();
    if (!isBlankLedger(legacy)) {
      state = legacy;
      saveState();
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  document.getElementById("gate").hidden = true;
  document.getElementById("app").hidden = false;
  const logout = document.getElementById("logout");
  if (logout) logout.hidden = false;
  render();
}

async function startGoogle() {
  const clientId = authConfig().googleClientId;
  if (!clientId) {
    showGate("Google kaydı için bir Google istemci anahtarı gerekiyor. Anahtar eklenince bu düğme hesabı açar.", { google: true, apple: true });
    return;
  }
  await loadScript("https://accounts.google.com/gsi/client");
  const client = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "openid email profile",
    prompt: "select_account",
    callback: async (tokenResponse) => {
      if (!tokenResponse.access_token) {
        showGate("Google girişi tamamlanamadı. Tekrar dene.", { google: true, apple: true });
        return;
      }
      const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      }).then((response) => response.json());
      if (!profile.sub) {
        showGate("Google hesabı okunamadı.", { google: true, apple: true });
        return;
      }
      enterClientAccount({
        id: profile.sub,
        email: profile.email || "",
        name: profile.name || profile.email || "Google hesabı",
        provider: "google",
      });
    },
  });
  client.requestAccessToken();
}

async function startApple() {
  const clientId = authConfig().appleClientId;
  if (!clientId) {
    showGate("Apple kaydı için bir Apple istemci anahtarı gerekiyor. Anahtar eklenince bu düğme hesabı açar.", { google: true, apple: true });
    return;
  }
  await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/tr_TR/appleid.auth.js");
  window.AppleID.auth.init({
    clientId,
    scope: "name email",
    redirectURI: authConfig().appleRedirectURI || location.href.split("?")[0],
    usePopup: true,
  });
  try {
    const result = await window.AppleID.auth.signIn();
    const payload = parseJwt(result.authorization.id_token);
    const given = result.user?.name;
    const name = [given?.firstName, given?.lastName].filter(Boolean).join(" ");
    enterClientAccount({
      id: payload.sub,
      email: payload.email || "",
      name: name || payload.email || "Apple hesabı",
      provider: "apple",
    });
  } catch {
    showGate("Apple girişi tamamlanamadı. Tekrar dene.", { google: true, apple: true });
  }
}

async function persistLedger(snapshot) {
  try {
    const response = await fetch("/api/ledger", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    if (response.status === 401) {
      toast("Oturumun kapandı. Tekrar gir.");
      return;
    }
    if (!response.ok) toast("Kayıt hesabına yazılamadı.");
  } catch {
    toast("Kayıt hesabına yazılamadı.");
  }
}

function loadUi() {
  const base = {
    view: "dashboard",
    month: currentMonth(),
    category: "market",
    fixedCategory: "kira",
    filter: "all",
    editing: null,
    focusForm: false,
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(UI_KEY) || "null");
    if (!saved) return base;
    if (Object.prototype.hasOwnProperty.call(VIEWS, saved.view)) base.view = saved.view;
    if (/^\d{4}-\d{2}$/.test(saved.month || "")) base.month = saved.month;
    if (CATEGORIES.some((cat) => cat.id === saved.category)) base.category = saved.category;
    if (FIXED_CATS.some((cat) => cat.id === saved.fixedCategory)) base.fixedCategory = saved.fixedCategory;
  } catch {
    /* oturum kaydı yoksa özetten başla */
  }
  return base;
}

function saveUi() {
  try {
    sessionStorage.setItem(UI_KEY, JSON.stringify({
      view: ui.view,
      month: ui.month,
      category: ui.category,
      fixedCategory: ui.fixedCategory,
    }));
  } catch {
    /* oturum kaydı zorunlu değil */
  }
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function showFormError(form, message) {
  const el = form.querySelector(".error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function summary() {
  return monthSummary(state, ui.month, new Date());
}

function editingItem(type, list) {
  if (!ui.editing || ui.editing.type !== type) return null;
  return list.find((item) => item.id === ui.editing.id) || null;
}

function defaultExpenseDate() {
  const today = new Date();
  if (ui.month === currentMonth(today)) return isoDate(today);
  const day = Math.min(today.getDate(), daysInMonth(ui.month));
  return `${ui.month}-${String(day).padStart(2, "0")}`;
}

function chips(list, selected) {
  const buttons = list.map((cat) => `
    <button type="button" data-cat="${esc(cat.id)}" aria-pressed="${cat.id === selected ? "true" : "false"}">${esc(cat.name)}</button>
  `).join("");
  return `<div class="chips" data-cats>
    <input type="hidden" name="category" value="${esc(selected)}">
    ${buttons}
  </div>`;
}

function expenseForm() {
  const editing = editingItem("expense", state.expenses);
  const selected = editing ? editing.category : ui.category;
  return `
    <form id="expense-form" class="card form" novalidate>
      <h2>${editing ? "Harcamayı düzelt" : "Bugün ne gitti?"}</h2>
      <label class="field">Tutar
        <input name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 250" value="${esc(moneyToInput(editing?.amount))}">
      </label>
      <fieldset class="field">
        <legend>Kategori</legend>
        ${chips(CATEGORIES, selected)}
      </fieldset>
      <div class="form-grid even">
        <label class="field">Tarih
          <input type="date" name="date" value="${esc(editing?.date || defaultExpenseDate())}">
        </label>
        <label class="field">Not
          <input name="note" maxlength="120" autocomplete="off" placeholder="İsteğe bağlı" value="${esc(editing?.note || "")}">
        </label>
      </div>
      <p class="error" hidden></p>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${editing ? "Güncelle" : "Kaydet"}</button>
        ${editing ? '<button type="button" class="btn btn-ghost" data-cancel-edit>Vazgeç</button>' : ""}
      </div>
    </form>
  `;
}

function fixedForm() {
  const editing = editingItem("fixed", state.fixed);
  const selected = editing ? editing.category : ui.fixedCategory;
  return `
    <form id="fixed-form" class="card form" novalidate>
      <h2>${editing ? "Sabit gideri düzenle" : "Sabit gider ekle"}</h2>
      <p class="hint">Kira, fatura, abonelik. Tutar her ay maaşından düşülür.</p>
      <label class="field">Ad
        <input name="name" maxlength="40" autocomplete="off" placeholder="Örn. Kira" value="${esc(editing?.name || "")}">
      </label>
      <label class="field">Aylık tutar
        <input name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 15000" value="${esc(moneyToInput(editing?.amount))}">
      </label>
      <fieldset class="field">
        <legend>Tür</legend>
        ${chips(FIXED_CATS, selected)}
      </fieldset>
      <p class="error" hidden></p>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${editing ? "Güncelle" : "Kaydet"}</button>
        ${editing ? '<button type="button" class="btn btn-ghost" data-cancel-edit>Vazgeç</button>' : ""}
      </div>
    </form>
  `;
}

function debtForm() {
  const editing = editingItem("debt", state.debts);
  return `
    <form id="debt-form" class="card form" novalidate>
      <h2>${editing ? "Borcu düzenle" : "Borç ekle"}</h2>
      <p class="hint">Kalan borcu ve ayda ödeyeceğin tutarı yaz. Kapanış ayını hesaplarım. Ödedikçe kalan borcu güncelle.</p>
      <label class="field">Ad
        <input name="name" maxlength="40" autocomplete="off" placeholder="Örn. Kredi kartı" value="${esc(editing?.name || "")}">
      </label>
      <div class="form-grid two">
        <label class="field">Kalan borç
          <input name="remaining" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 20000" value="${esc(moneyToInput(editing?.remaining))}">
        </label>
        <label class="field">Aylık ödeme
          <input name="monthlyPayment" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 2000" value="${esc(moneyToInput(editing?.monthlyPayment))}">
        </label>
      </div>
      <label class="field">Yıllık faiz %
        <input name="annualRate" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Bilmiyorsan 0" value="${esc(editing ? moneyToInput(editing.annualRate) : "")}">
      </label>
      <p class="plan" data-debt-preview>Kalan borç ve taksiti yazınca kapanış tarihini göstereceğim.</p>
      <p class="error" hidden></p>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${editing ? "Güncelle" : "Kaydet"}</button>
        ${editing ? '<button type="button" class="btn btn-ghost" data-cancel-edit>Vazgeç</button>' : ""}
      </div>
    </form>
  `;
}

function entryActions(type, item, label) {
  return `
    <button type="button" class="linkish" data-edit-${type}="${esc(item.id)}" aria-label="${esc(label)} kaydını düzenle">Düzenle</button>
    <button type="button" class="linkish danger" data-delete-${type}="${esc(item.id)}" aria-label="${esc(label)} kaydını sil">Sil</button>
  `;
}

function monthTitle(month) {
  const [year, mon] = month.split("-").map(Number);
  return formatYearMonth(new Date(year, mon - 1, 1));
}

function trackedMonths() {
  const keys = new Set();
  let cursor = currentMonth();
  for (let i = 0; i < 12; i += 1) {
    keys.add(cursor);
    cursor = shiftMonth(cursor, -1);
  }
  for (const item of state.expenses) if (item.date) keys.add(item.date.slice(0, 7));
  for (const item of state.extras || []) if (item.month) keys.add(item.month);
  return [...keys].filter((key) => /^\d{4}-\d{2}$/.test(key)).sort().reverse();
}

function topCategory(data) {
  const top = Object.entries(data.byCategory).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "Henüz yok";
  return `${catName(CATEGORIES, top[0])} ${formatMoney(top[1])}`;
}

function compareCard(month, data, kicker) {
  return `
    <article class="card compare-card">
      <p class="eyebrow">${esc(kicker)}</p>
      <h2>${esc(monthTitle(month))}</h2>
      <p class="compare-num">${esc(formatMoney(data.spent))}</p>
      <p class="meta">harcanan</p>
      <ul class="compare-list">
        <li><span>gelir</span><b>${esc(formatMoney(data.income))}</b></li>
        <li><span>ekstra</span><b>${esc(formatMoney(data.extraTotal))}</b></li>
        <li><span>kalan</span><b>${esc(formatMoney(data.remaining))}</b></li>
        <li><span>en çok</span><b>${esc(topCategory(data))}</b></li>
      </ul>
    </article>
  `;
}

function renderDashboard() {
  const selected = summary();
  const previousMonth = shiftMonth(ui.month, -1);
  const previous = monthSummary(state, previousMonth, new Date());
  const delta = money(selected.spent - previous.spent);
  const deltaText = delta === 0
    ? "Harcaman geçen ayla aynı."
    : delta > 0
      ? `Geçen aya göre ${formatMoney(delta)} daha çok gitmiş.`
      : `Geçen aya göre ${formatMoney(Math.abs(delta))} daha az gitmiş.`;
  const pills = trackedMonths().map((month) => `
    <button type="button" class="month-pill" data-pick-month="${esc(month)}" aria-pressed="${month === ui.month ? "true" : "false"}">${esc(monthTitle(month))}</button>
  `).join("");
  const series = trackedMonths().slice(0, 6).reverse();
  const maxSpent = Math.max(...series.map((month) => monthSummary(state, month, new Date()).spent), 1);
  const bars = series.map((month) => {
    const spent = monthSummary(state, month, new Date()).spent;
    const height = Math.max(8, Math.round((spent / maxSpent) * 100));
    return `
      <button type="button" class="col ${month === ui.month ? "on" : ""}" data-pick-month="${esc(month)}">
        <span class="col-bar" style="height:${height}%"></span>
        <span class="col-label">${esc(monthTitle(month).split(" ")[0].slice(0, 3))}</span>
      </button>
    `;
  }).join("");
  return `
    <div class="stack">
      <section class="card">
        <h2>Aylara bak</h2>
        <p class="hint">Bir aya bas. Hemen önceki ay da yanında durur, kıyasla.</p>
        <div class="month-pills">${pills}</div>
      </section>
      <section class="card">
        <h2>Harcama grafiği</h2>
        <div class="cols">${bars}</div>
      </section>
      <p class="delta">${esc(deltaText)}</p>
      <div class="compare">
        ${compareCard(ui.month, selected, "Seçili ay")}
        ${compareCard(previousMonth, previous, "Bir önceki")}
      </div>
      <button type="button" class="btn btn-primary" data-nav="overview">Bu ayın günlüğüne geç</button>
    </div>
  `;
}

function renderOverview() {
  const data = summary();
  const advice = buildAdvice(data, labelMap());
  const figure = advice.amount === null
    ? `<p class="hero-num hero-text">${esc(advice.amountText)}</p>`
    : `<p class="hero-num">${esc(formatMoney(advice.amount))}</p>`;
  const parts = [
    { key: "fixed", label: "Sabit gider", value: Math.max(0, data.fixedTotal), className: "seg-fixed" },
    { key: "debt", label: "Borç taksiti", value: Math.max(0, data.debtPayment), className: "seg-debt" },
    { key: "spent", label: "Günlük harcama", value: Math.max(0, data.spent), className: "seg-spent" },
    { key: "left", label: "Kalan", value: Math.max(0, data.remaining), className: "seg-left" },
  ];
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  const bar = parts.filter((part) => part.value > 0).map((part) => (
    `<span class="${part.className}" style="width:${(part.value / total) * 100}%"></span>`
  )).join("");
  const legend = parts.map((part) => {
    const share = data.income > 0 ? ` · %${Math.round((part.value / data.income) * 100)}` : "";
    return `<li><i class="${part.className}"></i>${esc(part.label)} ${esc(formatMoney(part.value))}${esc(share)}</li>`;
  }).join("");
  const categories = Object.entries(data.byCategory)
    .map(([id, amount]) => ({ id, amount, name: catName(CATEGORIES, id), color: CATEGORIES.find((cat) => cat.id === id)?.color || "#6d675f" }))
    .sort((a, b) => b.amount - a.amount);
  const maxCategory = categories[0]?.amount || 1;
  const categoryHtml = categories.map((cat) => {
    const share = data.spent ? Math.round((cat.amount / data.spent) * 100) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(cat.name)}</span>
        <span class="track"><span class="fill" style="width:${(cat.amount / maxCategory) * 100}%;background:${esc(cat.color)}"></span></span>
        <b>${esc(formatMoney(cat.amount))} · %${share}</b>
      </div>
    `;
  }).join("");
  const recent = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 6);
  const debtTotal = money(state.debts.reduce((sum, debt) => sum + debt.remaining, 0));

  return `
    <div class="stack">
      <section class="card hero" data-tone="${esc(advice.tone)}">
        <p class="eyebrow">${esc(advice.eyebrow)}</p>
        ${figure}
        <p class="detail">${esc(advice.detail)}</p>
        ${advice.tone === "setup" ? '<button type="button" class="btn btn-primary" data-nav="settings">Geliri yaz</button>' : ""}
      </section>
      ${expenseForm()}
      ${data.hasIncome ? `
        <div class="stats">
          <article class="stat"><span>Gelir</span><b>${esc(formatMoney(data.income))}</b></article>
          <article class="stat"><span>Sabit + borç</span><b>${esc(formatMoney(data.committed))}</b></article>
          <article class="stat ${data.overspent ? "bad" : ""}"><span>Bu ay harcanan</span><b>${esc(formatMoney(data.spent))}</b></article>
        </div>
        <section class="card">
          <h2>Para nereye gidiyor</h2>
          ${data.extraTotal > 0 ? `<p class="hint">Maaş ${esc(formatMoney(data.salary))} + bu ay ekstra ${esc(formatMoney(data.extraTotal))}.</p>` : ""}
          <div class="split" aria-hidden="true">${bar}</div>
          <ul class="legend">${legend}</ul>
          ${debtTotal > 0 ? `<p class="hint" style="margin-top:12px">Toplam kalan borç ${esc(formatMoney(debtTotal))}.</p>` : ""}
        </section>
      ` : ""}
      ${categories.length ? `<section class="card"><h2>Kategoriler</h2>${categoryHtml}</section>` : ""}
      <section class="card">
        <div class="section-head">
          <h2>Son harcamalar</h2>
          ${recent.length ? '<button type="button" class="linkish" data-nav="expenses">Tümü</button>' : ""}
        </div>
        ${recent.length ? `<ul class="entries">${recent.map(expenseItem).join("")}</ul>` : '<p class="empty">Bu ay daha bi şey yok. Yukarıdan yaz.</p>'}
      </section>
    </div>
  `;
}

function expenseItem(item) {
  const note = item.note ? ` · ${item.note}` : "";
  return `
    <li class="entry">
      <div>
        <div class="name">${esc(catName(CATEGORIES, item.category))}</div>
        <p class="meta">${esc(formatShortDate(item.date))}${esc(note)}</p>
        <div>${entryActions("expense", item, catName(CATEGORIES, item.category))}</div>
      </div>
      <div class="amt">${esc(formatMoney(item.amount))}</div>
    </li>
  `;
}

function renderExpenses() {
  const data = summary();
  const items = [...data.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const visible = ui.filter === "all" ? items : items.filter((item) => item.category === ui.filter);
  const filters = [{ id: "all", name: "Tümü" }, ...CATEGORIES].map((cat) => `
    <button type="button" data-filter="${esc(cat.id)}" aria-pressed="${ui.filter === cat.id ? "true" : "false"}">${esc(cat.name)}</button>
  `).join("");
  return `
    <div class="stack">
      ${expenseForm()}
      <section class="card">
        <div class="section-head">
          <h2>Bu ay ${esc(formatMoney(data.spent))}</h2>
        </div>
        ${items.length ? `<div class="filters" data-filters>${filters}</div>` : ""}
        ${visible.length ? `<ul class="entries">${visible.map(expenseItem).join("")}</ul>` : `<p class="empty">${items.length ? "Bu kategoride harcama yok." : "Bu ay henüz harcama yok."}</p>`}
      </section>
    </div>
  `;
}

function renderFixed() {
  const total = money(state.fixed.reduce((sum, item) => sum + item.amount, 0));
  const items = [...state.fixed].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "tr"));
  return `
    <div class="stack">
      ${fixedForm()}
      <section class="card">
        <h2>Her ay ${esc(formatMoney(total))}</h2>
        ${items.length ? `<ul class="entries">${items.map((item) => `
          <li class="entry">
            <div>
              <div class="name">${esc(item.name)}</div>
              <p class="meta">${esc(catName(FIXED_CATS, item.category))}</p>
              <div>${entryActions("fixed", item, item.name)}</div>
            </div>
            <div class="amt">${esc(formatMoney(item.amount))}</div>
          </li>
        `).join("")}</ul>` : '<p class="empty">Henüz sabit gider yok.</p>'}
      </section>
    </div>
  `;
}

function renderDebts() {
  const totalRemaining = money(state.debts.reduce((sum, item) => sum + item.remaining, 0));
  const totalPayment = money(state.debts.reduce((sum, item) => sum + item.monthlyPayment, 0));
  const plans = state.debts.map((debt) => describePayoff(debt.remaining, debt.monthlyPayment, debt.annualRate));
  const latest = plans.filter((plan) => Number.isFinite(plan.months) && plan.months > 0).sort((a, b) => b.months - a.months)[0];
  const blocked = plans.some((plan) => plan.impossible && plan.monthlyInterest > 0);
  const items = [...state.debts].sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name, "tr"));
  return `
    <div class="stack">
      ${debtForm()}
      <section class="card">
        <h2>Toplam kalan ${esc(formatMoney(totalRemaining))}</h2>
        <p class="hint">Aylık taksit ${esc(formatMoney(totalPayment))}. Bu tutar da maaşından düşülür.${latest ? ` En geç biten borç: ${esc(latest.payoffLabel)}.` : ""}${blocked ? " Bazı taksitler faizi karşılamıyor." : ""}</p>
        ${items.length ? items.map(debtCard).join("") : '<p class="empty">Kredi kartı veya kredi ekle. Ayda ne kadar ödersen o tarihte bittiğini göstereyim.</p>'}
      </section>
    </div>
  `;
}

function debtCard(debt) {
  const plan = describePayoff(debt.remaining, debt.monthlyPayment || 0, debt.annualRate);
  const rateLine = debt.annualRate > 0
    ? `<p class="meta">Yıllık faiz %${esc(String(debt.annualRate).replace(".", ","))} · aylık faiz yaklaşık ${esc(formatMoney(plan.monthlyInterest))}</p>`
    : "";
  return `
    <article class="card debt" style="margin-top:12px;box-shadow:none">
      <div class="debt-top">
        <h3>${esc(debt.name)}</h3>
        <b>${esc(formatMoney(debt.remaining))}</b>
      </div>
      ${rateLine}
      <label class="field" style="margin-top:12px">Ayda şu kadar ödersem
        <input class="whatif" data-whatif="${esc(debt.id)}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(moneyToInput(debt.monthlyPayment))}" placeholder="Örn. 2500">
      </label>
      <p class="${plan.impossible ? "bad-text" : "plan"}" data-whatif-out="${esc(debt.id)}">${esc(plan.message)}</p>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-apply-payment="${esc(debt.id)}" hidden>Bu taksiti kaydet</button>
        <button type="button" class="btn btn-ghost" data-edit-debt="${esc(debt.id)}">Düzenle</button>
        <button type="button" class="btn btn-ghost btn-danger" data-delete-debt="${esc(debt.id)}" aria-label="${esc(debt.name)} kaydını sil">Sil</button>
      </div>
    </article>
  `;
}

function extraForm() {
  const editing = editingItem("extra", state.extras || []);
  const monthName = monthTitle(editing?.month || ui.month);
  return `
    <form id="extra-form" class="card form" novalidate>
      <h2>${editing ? "Ekstra geliri düzelt" : "Ekstra para geldi mi?"}</h2>
      <p class="hint">Freelance, ikramiye, satılan bir şey. Bu kayıt ${esc(monthName)} ayına yazılır, maaşın üstüne eklenir.</p>
      <label class="field">Nereden
        <input name="name" maxlength="40" autocomplete="off" placeholder="Örn. Freelance" value="${esc(editing?.name || "")}">
      </label>
      <label class="field">Tutar
        <input name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 3000" value="${esc(moneyToInput(editing?.amount))}">
      </label>
      <p class="error" hidden></p>
      <div class="actions">
        <button type="submit" class="btn btn-primary">${editing ? "Güncelle" : "Ekle"}</button>
        ${editing ? '<button type="button" class="btn btn-ghost" data-cancel-edit>Vazgeç</button>' : ""}
      </div>
    </form>
  `;
}

function renderSettings() {
  const monthExtras = (state.extras || []).filter((item) => item.month === ui.month);
  const extraTotal = money(monthExtras.reduce((sum, item) => sum + item.amount, 0));
  return `
    <div class="stack">
      <form id="salary-form" class="card form" novalidate>
        <h2>Aylık net maaş</h2>
        <p class="hint">Her ay eline geçen tutar. Üstüne o ay gelen ekstra para eklenir, sonra sabit gider ve taksit düşülür.</p>
        <label class="field">Tutar
          <input name="salary" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="Örn. 45000" value="${esc(moneyToInput(state.salary))}">
        </label>
        <p class="error" hidden></p>
        <button type="submit" class="btn btn-primary">Kaydet</button>
      </form>
      ${extraForm()}
      <section class="card">
        <h2>${esc(monthTitle(ui.month))} ekstra ${esc(formatMoney(extraTotal))}</h2>
        ${monthExtras.length ? `<ul class="entries">${monthExtras.map((item) => `
          <li class="entry">
            <div>
              <div class="name">${esc(item.name)}</div>
              <div>${entryActions("extra", item, item.name)}</div>
            </div>
            <div class="amt">${esc(formatMoney(item.amount))}</div>
          </li>
        `).join("")}</ul>` : '<p class="empty">Bu ay ekstra gelir yok.</p>'}
      </section>
      <section class="card">
        <h2>Yedek</h2>
        <p class="hint">${currentUser?.provider === "google" || currentUser?.provider === "apple" ? `Bu defter ${esc(currentUser.name || "bu hesaba")} ait. Çıkış yapınca başka hesapla girince onun defteri açılır.` : currentUser?.provider === "local" ? "Kayıtlar bu tarayıcıda durur. Başka cihazda görmek için yedeği indir, orada içe aktar." : `Kayıtlar bu hesaba yazılır${currentUser?.email ? ` (${esc(currentUser.email)})` : ""}. İstediğin cihazdan aynı hesapla girince aynı defteri görürsün. Yine de arada bir yedek indir.`}</p>
        <div class="actions">
          <button type="button" class="btn btn-primary" data-export>Dışa aktar</button>
          <button type="button" class="btn btn-ghost" data-import>İçe aktar</button>
          <button type="button" class="btn btn-danger" data-reset>Tümünü sil</button>
        </div>
        <input id="import-file" type="file" accept="application/json,.json" hidden>
      </section>
    </div>
  `;
}

function render() {
  const [year, month] = ui.month.split("-").map(Number);
  document.getElementById("month-label").textContent = formatYearMonth(new Date(year, month - 1, 1));
  const snap = summary();
  document.getElementById("salary-link").textContent = snap.hasIncome ? `Gelir ${formatMoney(snap.income)}` : "Gelir gir";
  const account = document.getElementById("account-label");
  if (account && currentUser) account.textContent = currentUser.name || currentUser.email || "Hesabın";
  document.getElementById("back-today").hidden = ui.month === currentMonth();
  document.querySelectorAll(".tabbar [data-nav]").forEach((btn) => {
    const on = btn.dataset.nav === ui.view;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  document.getElementById("view").innerHTML = VIEWS[ui.view]();
  saveUi();
  const preview = document.querySelector("[data-debt-preview]");
  if (preview && ui.editing?.type === "debt") updateDebtPreview(document.getElementById("debt-form"));
  if (ui.focusForm) {
    ui.focusForm = false;
    const form = document.querySelector("#view form");
    form?.scrollIntoView({ block: "nearest" });
    form?.querySelector("input")?.focus();
  }
}

function validAmount(value, label) {
  const amount = parseMoney(value);
  if (!Number.isFinite(amount) || amount <= 0) return { error: `${label} 0'dan büyük olmalı.` };
  if (amount > 100000000) return { error: "Tutar çok büyük." };
  return { amount };
}

function saveExpense(form) {
  const amountResult = validAmount(form.amount.value, "Tutar");
  if (amountResult.error) return showFormError(form, amountResult.error);
  const date = form.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showFormError(form, "Tarih seç.");
  const category = form.category.value;
  if (!CATEGORIES.some((cat) => cat.id === category)) return showFormError(form, "Kategori seç.");
  const note = cleanText(form.note.value, 120);
  const editing = editingItem("expense", state.expenses);
  if (ui.editing?.type === "expense" && !editing) return showFormError(form, "Kayıt bulunamadı.");
  const item = { id: editing?.id || uid(), date, category, amount: amountResult.amount, note };
  if (editing) Object.assign(editing, item);
  else state.expenses.push(item);
  ui.category = category;
  ui.month = date.slice(0, 7);
  ui.editing = null;
  saveState();
  toast(editing ? "Harcama güncellendi." : "Harcama kaydedildi.");
  render();
}

function saveFixed(form) {
  const name = cleanText(form.name.value, 40);
  if (!name) return showFormError(form, "Bir ad yaz.");
  const amountResult = validAmount(form.amount.value, "Tutar");
  if (amountResult.error) return showFormError(form, amountResult.error);
  const category = form.category.value;
  if (!FIXED_CATS.some((cat) => cat.id === category)) return showFormError(form, "Tür seç.");
  const editing = editingItem("fixed", state.fixed);
  if (ui.editing?.type === "fixed" && !editing) return showFormError(form, "Kayıt bulunamadı.");
  const item = { id: editing?.id || uid(), name, amount: amountResult.amount, category };
  if (editing) Object.assign(editing, item);
  else state.fixed.push(item);
  ui.fixedCategory = category;
  ui.editing = null;
  saveState();
  toast(editing ? "Sabit gider güncellendi." : "Sabit gider kaydedildi.");
  render();
}

function saveDebt(form) {
  const name = cleanText(form.name.value, 40);
  if (!name) return showFormError(form, "Bir ad yaz.");
  const remainingResult = validAmount(form.remaining.value, "Kalan borç");
  if (remainingResult.error) return showFormError(form, remainingResult.error);
  const paymentRaw = form.monthlyPayment.value.trim();
  const monthlyPayment = paymentRaw === "" ? 0 : parseMoney(paymentRaw);
  if (!Number.isFinite(monthlyPayment) || monthlyPayment < 0) return showFormError(form, "Aylık ödeme 0 veya daha büyük olmalı.");
  if (monthlyPayment > 100000000) return showFormError(form, "Tutar çok büyük.");
  const rateRaw = form.annualRate.value.trim();
  const annualRate = rateRaw === "" ? 0 : parseMoney(rateRaw);
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) return showFormError(form, "Faiz 0 ile 100 arasında olmalı.");
  const editing = editingItem("debt", state.debts);
  if (ui.editing?.type === "debt" && !editing) return showFormError(form, "Kayıt bulunamadı.");
  const item = {
    id: editing?.id || uid(),
    name,
    remaining: remainingResult.amount,
    monthlyPayment,
    annualRate,
  };
  if (editing) Object.assign(editing, item);
  else state.debts.push(item);
  ui.editing = null;
  saveState();
  toast(editing ? "Borç güncellendi." : "Borç kaydedildi.");
  render();
}

function saveSalary(form) {
  const raw = form.salary.value.trim();
  if (!raw) return showFormError(form, "Maaş yaz.");
  const salary = parseMoney(raw);
  if (!Number.isFinite(salary) || salary <= 0) return showFormError(form, "Maaş 0'dan büyük olmalı.");
  if (salary > 100000000) return showFormError(form, "Tutar çok büyük.");
  state.salary = salary;
  saveState();
  ui.view = "overview";
  toast("Maaş kaydedildi.");
  render();
}

function saveExtra(form) {
  const name = cleanText(form.name.value, 40);
  if (!name) return showFormError(form, "Nereden geldiğini yaz.");
  const amountResult = validAmount(form.amount.value, "Tutar");
  if (amountResult.error) return showFormError(form, amountResult.error);
  const editing = editingItem("extra", state.extras || []);
  if (ui.editing?.type === "extra" && !editing) return showFormError(form, "Kayıt bulunamadı.");
  const item = {
    id: editing?.id || uid(),
    name,
    amount: amountResult.amount,
    month: editing?.month || ui.month,
  };
  if (editing) Object.assign(editing, item);
  else state.extras.push(item);
  ui.editing = null;
  saveState();
  toast(editing ? "Ekstra gelir güncellendi." : "Ekstra gelir eklendi.");
  render();
}

function updateWhatIf(input) {
  const debt = state.debts.find((item) => item.id === input.dataset.whatif);
  const out = document.querySelector(`[data-whatif-out="${input.dataset.whatif}"]`);
  const apply = document.querySelector(`[data-apply-payment="${input.dataset.whatif}"]`);
  if (!debt || !out) return;
  const payment = parseMoney(input.value);
  if (!Number.isFinite(payment) || payment < 0) {
    out.textContent = "Tutar yaz.";
    out.className = "bad-text";
    if (apply) apply.hidden = true;
    return;
  }
  const plan = describePayoff(debt.remaining, payment, debt.annualRate);
  out.textContent = plan.message;
  out.className = plan.impossible ? "bad-text" : "plan";
  if (apply) apply.hidden = !(payment > 0) || money(payment) === money(debt.monthlyPayment);
}

function updateDebtPreview(form) {
  const out = form.querySelector("[data-debt-preview]");
  if (!out) return;
  const remaining = parseMoney(form.remaining.value);
  const payment = parseMoney(form.monthlyPayment.value);
  const rateRaw = form.annualRate.value.trim();
  const rate = rateRaw === "" ? 0 : parseMoney(rateRaw);
  if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isFinite(payment)) {
    out.textContent = "Kalan borç ve taksiti yazınca kapanış tarihini göstereceğim.";
    out.className = "plan";
    return;
  }
  const plan = describePayoff(remaining, payment, Number.isFinite(rate) ? rate : 0);
  out.textContent = plan.message;
  out.className = plan.impossible ? "bad-text" : "plan";
}

function removeItem(listName, id, message) {
  const list = state[listName];
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return;
  const item = list[index];
  const label = item.name || catName(CATEGORIES, item.category);
  if (!window.confirm(`${label} silinsin mi?`)) return;
  list.splice(index, 1);
  if (ui.editing?.id === id) ui.editing = null;
  saveState();
  toast(message);
  render();
}

function onClick(event) {
  if (event.target.closest("#login-google")) {
    event.preventDefault();
    startGoogle();
    return;
  }
  if (event.target.closest("#login-apple")) {
    event.preventDefault();
    startApple();
    return;
  }
  const picked = event.target.closest("[data-pick-month]");
  if (picked) {
    ui.month = picked.dataset.pickMonth;
    ui.editing = null;
    render();
    return;
  }
  if (event.target.closest("#logout")) {
    if (currentUser?.provider === "google" || currentUser?.provider === "apple") {
      localStorage.removeItem(SESSION_KEY);
      currentUser = null;
      state = defaultState();
      showGate("Çıkış yapıldı. Başka bir Google veya Apple hesabıyla girebilirsin.", { google: true, apple: true });
      return;
    }
    fetch("/api/logout", { method: "POST" }).finally(() => {
      location.href = "/";
    });
    return;
  }
  const monthBtn = event.target.closest("[data-month]");
  if (monthBtn) {
    const delta = Number(monthBtn.dataset.month);
    ui.month = delta === 0 ? currentMonth() : shiftMonth(ui.month, delta);
    ui.editing = null;
    render();
    return;
  }
  const nav = event.target.closest("[data-nav]");
  if (nav && Object.prototype.hasOwnProperty.call(VIEWS, nav.dataset.nav)) {
    ui.view = nav.dataset.nav;
    ui.editing = null;
    render();
    return;
  }
  const cat = event.target.closest("[data-cat]");
  if (cat) {
    const group = cat.closest("[data-cats]");
    group.querySelectorAll("[data-cat]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn === cat));
    });
    const input = group.querySelector('input[name="category"]');
    if (input) input.value = cat.dataset.cat;
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    ui.filter = filter.dataset.filter;
    render();
    return;
  }
  if (event.target.closest("[data-cancel-edit]")) {
    ui.editing = null;
    render();
    return;
  }
  const edit = event.target.closest("[data-edit-expense], [data-edit-fixed], [data-edit-debt]");
  if (edit) {
    const type = edit.hasAttribute("data-edit-expense")
      ? "expense"
      : edit.hasAttribute("data-edit-fixed")
        ? "fixed"
        : edit.hasAttribute("data-edit-extra")
          ? "extra"
          : "debt";
    const id = edit.dataset.editExpense || edit.dataset.editFixed || edit.dataset.editExtra || edit.dataset.editDebt;
    ui.view = type === "expense" ? (ui.view === "overview" ? "overview" : "expenses") : type === "fixed" ? "fixed" : type === "extra" ? "settings" : "debts";
    ui.editing = { type, id };
    ui.focusForm = true;
    render();
    return;
  }
  const delExpense = event.target.closest("[data-delete-expense]");
  if (delExpense) return removeItem("expenses", delExpense.dataset.deleteExpense, "Harcama silindi.");
  const delFixed = event.target.closest("[data-delete-fixed]");
  if (delFixed) return removeItem("fixed", delFixed.dataset.deleteFixed, "Sabit gider silindi.");
  const delDebt = event.target.closest("[data-delete-debt]");
  if (delDebt) return removeItem("debts", delDebt.dataset.deleteDebt, "Borç silindi.");
  const delExtra = event.target.closest("[data-delete-extra]");
  if (delExtra) return removeItem("extras", delExtra.dataset.deleteExtra, "Ekstra gelir silindi.");
  const apply = event.target.closest("[data-apply-payment]");
  if (apply) {
    const debt = state.debts.find((item) => item.id === apply.dataset.applyPayment);
    const input = document.querySelector(`[data-whatif="${apply.dataset.applyPayment}"]`);
    const payment = parseMoney(input?.value);
    if (!debt || !Number.isFinite(payment) || payment <= 0) {
      toast("Geçerli bir taksit yaz.");
      return;
    }
    debt.monthlyPayment = payment;
    saveState();
    toast("Taksit güncellendi. Günlük limit yeniden hesaplandı.");
    render();
    return;
  }
  if (event.target.closest("[data-export]")) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `gider-defteri-${isoDate(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast("Yedek indirildi.");
    return;
  }
  if (event.target.closest("[data-import]")) {
    document.getElementById("import-file")?.click();
    return;
  }
  if (event.target.closest("[data-reset]")) {
    if (!window.confirm("Maaş, harcamalar, sabit giderler ve borçlar silinecek.")) return;
    state = defaultState();
    ui.editing = null;
    ui.view = "settings";
    saveState();
    toast("Defter temizlendi.");
    render();
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === "expense-form") saveExpense(form);
  else if (form.id === "fixed-form") saveFixed(form);
  else if (form.id === "debt-form") saveDebt(form);
  else if (form.id === "salary-form") saveSalary(form);
  else if (form.id === "extra-form") saveExtra(form);
}

function onInput(event) {
  const whatif = event.target.closest("[data-whatif]");
  if (whatif) {
    updateWhatIf(whatif);
    return;
  }
  const form = event.target.closest("#debt-form");
  if (form) updateDebtPreview(form);
}

async function onChange(event) {
  if (event.target.id !== "import-file") return;
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const next = normalizeState(JSON.parse(await file.text()));
    if (!window.confirm("Hesabındaki kayıtlar bu dosyayla değişecek.")) return;
    state = next;
    ui.editing = null;
    saveState();
    toast("Veriler yüklendi.");
    render();
  } catch {
    toast("Bu dosya okunamadı.");
  }
}

function onKeydown(event) {
  if (event.key !== "Enter" || !event.target.matches("[data-whatif]")) return;
  event.preventDefault();
  const button = document.querySelector(`[data-apply-payment="${event.target.dataset.whatif}"]`);
  if (button && !button.hidden) button.click();
}

document.addEventListener("click", onClick);
document.addEventListener("submit", onSubmit);
document.addEventListener("input", onInput);
document.addEventListener("change", onChange);
document.addEventListener("keydown", onKeydown);

function showGate(message, providers) {
  document.getElementById("app").hidden = true;
  document.getElementById("gate").hidden = false;
  const note = document.getElementById("login-note");
  note.hidden = !message;
  note.textContent = message || "";
  const google = document.getElementById("login-google");
  const apple = document.getElementById("login-apple");
  google.hidden = providers ? !providers.google : false;
  apple.hidden = providers ? !providers.apple : false;
  const dev = document.getElementById("login-dev");
  if (dev) dev.hidden = !providers?.dev;
}

function openClientGate(message) {
  currentUser = null;
  document.getElementById("app").hidden = true;
  showGate(message || "Google veya Apple hesabınla kaydol. Çıkış yapınca başka hesapla girebilirsin.", { google: true, apple: true });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  let me = null;
  try {
    const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
    const type = response.headers.get("content-type") || "";
    if (response.ok && type.includes("json")) me = await response.json();
  } catch {
    me = null;
  }
  if (!me) {
    const session = readSession();
    if (session) enterClientAccount(session);
    else openClientGate("");
    return;
  }
  if (!me.user) {
    let message = "";
    if (params.get("auth") === "failed") message = "Giriş tamamlanamadı. Tekrar dene.";
    else if (params.get("auth") === "missing") message = "Bu giriş yöntemi henüz açılmadı.";
    else if (!me.providers?.google && !me.providers?.apple) message = "Google ve Apple girişi için site yöneticisinin anahtarları eklemesi gerekiyor.";
    showGate(message, me.providers);
    return;
  }
  currentUser = me.user;
  try {
    const response = await fetch("/api/ledger");
    if (!response.ok) throw new Error("ledger");
    state = normalizeState(await response.json());
  } catch {
    state = defaultState();
    toast("Defter yüklenemedi.");
  }
  if (isBlankLedger(state)) {
    const legacy = loadState();
    if (!isBlankLedger(legacy)) {
      state = legacy;
      saveState();
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  document.getElementById("gate").hidden = true;
  document.getElementById("app").hidden = false;
  history.replaceState({}, "", location.pathname);
  render();
}

boot();

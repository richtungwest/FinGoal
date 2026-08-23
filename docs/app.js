'use strict';
/* FinGoal Web — 与安卓/iOS 数据互通（同一份 R2 账本 JSON） */

// ───────────────────────── 工具 ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eDay = d => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
const fromEpoch = e => { const d = new Date(Date.UTC(1970, 0, 1)); d.setUTCDate(d.getUTCDate() + e); return d; };
const todayE = () => eDay(new Date());
const fmtDate = e => { const d = fromEpoch(e); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const pad = n => String(n).padStart(2, '0');
let toastTimer = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600); }
function copyText(text) {
  const done = () => toast('共享码已复制 ✓');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请长按手动复制'); }
  document.body.removeChild(ta);
}

// ───────────────────────── 数据状态 ─────────────────────────
const DEFAULT_CATEGORIES = [
  { id: 1, name: '餐饮', type: 'EXPENSE', icon: '🍜', isSystem: true },
  { id: 2, name: '交通', type: 'EXPENSE', icon: '🚌', isSystem: true },
  { id: 3, name: '购物', type: 'EXPENSE', icon: '🛍️', isSystem: true },
  { id: 4, name: '居住', type: 'EXPENSE', icon: '🏠', isSystem: true },
  { id: 5, name: '娱乐', type: 'EXPENSE', icon: '🎮', isSystem: true },
  { id: 6, name: '医疗', type: 'EXPENSE', icon: '💊', isSystem: true },
  { id: 7, name: '教育', type: 'EXPENSE', icon: '📚', isSystem: true },
  { id: 8, name: '其他', type: 'EXPENSE', icon: '📦', isSystem: true },
  { id: 9, name: '工资', type: 'INCOME', icon: '💼', isSystem: true },
  { id: 10, name: '奖金', type: 'INCOME', icon: '🎁', isSystem: true },
  { id: 11, name: '理财', type: 'INCOME', icon: '📈', isSystem: true },
  { id: 12, name: '其他收入', type: 'INCOME', icon: '💰', isSystem: true },
];
const EMPTY = () => ({
  settings: { ledgerName: '我的家庭账本', memberName: '我', ledgerId: '', r2AccessKey: '', r2SecretKey: '', themeStyle: 'MINIMAL', reportUnit: 'MONTH' },
  goals: [], milestones: [], transactions: [], categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORIES)), plan: null,
});
let S = load();
function load() {
  try { const raw = localStorage.getItem('fingoal'); if (raw) return Object.assign(EMPTY(), JSON.parse(raw)); } catch (e) {}
  return EMPTY();
}
function save() { localStorage.setItem('fingoal', JSON.stringify(S)); }
const nextId = arr => arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;

// ───────────────────────── 货币（与 Android Money 一致） ─────────────────────────
const Money = {
  defaultCurrencyCode() { try { const r = new Intl.NumberFormat(navigator.language, { style: 'currency', currencyDisplay: 'code' }).resolvedOptions(); return r.currency || 'CNY'; } catch (e) { return 'CNY'; } },
  currencySymbol(code) { try { const p = new Intl.NumberFormat(navigator.language, { style: 'currency', currency: code }).formatToParts(0); const s = p.find(x => x.type === 'currency'); return s ? s.value : '¥'; } catch (e) { return '¥'; } },
  fractionDigits(code) { return { JPY: 0, KRW: 0 }.hasOwnProperty(code) ? 0 : 2; },
  format(cents, code) {
    code = code || Money.defaultCurrencyCode();
    const digits = Money.fractionDigits(code);
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents) / Math.pow(10, digits);
    return sign + Money.currencySymbol(code) + abs.toLocaleString(navigator.language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  formatCompact(cents, code) {
    code = code || Money.defaultCurrencyCode();
    if (code !== 'CNY') return Money.format(cents, code);
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    if (abs >= 1e9) return sign + Money.currencySymbol(code) + (abs / 1e8 / 100).toFixed(1).replace(/\.0$/, '') + '亿';
    if (abs >= 1e5) return sign + Money.currencySymbol(code) + (abs / 1e6).toFixed(1).replace(/\.0$/, '') + '万';
    return Money.format(cents, code);
  },
  parseToCents(text, code) {
    code = code || Money.defaultCurrencyCode();
    const digits = Money.fractionDigits(code);
    const clean = String(text || '').trim().replace(/,/g, '');
    const n = parseFloat(clean);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * Math.pow(10, digits));
  },
  wholeUnits(cents, code) { return Math.floor(Math.abs(cents) / Math.pow(10, Money.fractionDigits(code || 'CNY'))); },
};

// ───────────────────────── 领域逻辑（移植自 Android） ─────────────────────────
const GoalMath = {
  progress(saved, target) { return target > 0 ? Math.min(1, Math.max(0, saved / target)) : 0; },
  remainingCents(saved, target) { return Math.max(target - saved, 0); },
  remainingDays(targetE, todayE_) { return Math.max(targetE - (todayE_ ?? todayE()), 0); },
  remainingMonths(targetE, todayE_) { const d = Math.max(targetE - (todayE_ ?? todayE()), 0); return Math.ceil(d / 30); },
  requiredMonthlyCents(saved, target, targetE, todayE_) { const m = GoalMath.remainingMonths(targetE, todayE_); const r = GoalMath.remainingCents(saved, target); return m > 0 ? Math.ceil(r / m) : r; },
  paceStatus(saved, target, targetE, monthly) {
    if (saved >= target) return 'COMPLETED';
    const months = Math.max(GoalMath.remainingMonths(targetE, todayE()), 1);
    const need = Math.max(GoalMath.remainingCents(saved, target), 1) / months;
    if (monthly <= 0) return 'CRITICAL';
    const ratio = monthly / need;
    if (ratio >= 1.1) return 'AHEAD';
    if (ratio >= 0.85) return 'ON_TRACK';
    if (ratio >= 0.5) return 'BEHIND';
    return 'CRITICAL';
  },
};
const PlanMath = {
  disposableIncome(p) { return p ? p.monthlyIncomeCents - (p.expenseHousingCents + p.expenseFoodCents + p.expenseClothingCents + p.expenseTransportCents + p.expenseOtherCents) : 0; },
};
const Report = {
  build(txns, categories, startE, endE) {
    const w = txns.filter(t => t.occurredAt >= startE && t.occurredAt <= endE);
    const income = w.filter(t => t.type === 'INCOME').reduce((a, t) => a + t.amountCents, 0);
    const expense = w.filter(t => t.type === 'EXPENSE').reduce((a, t) => a + t.amountCents, 0);
    const net = income - expense;
    const rate = income > 0 ? net / income : 0;
    const byCat = type => {
      const map = {};
      w.filter(t => t.type === type && t.categoryId != null).forEach(t => {
        const c = categories.find(c => c.id === t.categoryId);
        const name = c ? c.name : '未分类';
        map[name] = (map[name] || 0) + t.amountCents;
      });
      return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, amt]) => [name, amt]);
    };
    return { income, expense, net, rate, expenseByCategory: byCat('EXPENSE'), incomeByCategory: byCat('INCOME') };
  },
  monthlySaving(goalId, txns) {
    const g = txns.filter(t => t.goalId === goalId);
    if (!g.length) return 0;
    const first = Math.min(...g.map(t => t.occurredAt));
    const months = Math.max(Math.floor((todayE() - first) / 30), 1) + 1;
    return g.reduce((a, t) => a + (t.type === 'INCOME' ? t.amountCents : -t.amountCents), 0) / months;
  },
};
const PaceLabels = { AHEAD: '超前于计划', ON_TRACK: '在轨道上', BEHIND: '有点落后', CRITICAL: '需要加把劲', COMPLETED: '已达成 🎉' };
const PaceColors = { AHEAD: '#1F9D61', ON_TRACK: '#0E7C66', BEHIND: '#E09E3E', CRITICAL: '#D05252', COMPLETED: '#1F9D61' };
const MilestonePlan = { pcts: [0.2, 0.4, 0.6, 0.8, 1.0], generate(target) { return MilestonePlan.pcts.map((p, i) => ({ targetCents: Math.round(target * p), percent: p, name: `${Math.round(p * 100)}%` })); } };

// ───────────────────────── 状态派生 ─────────────────────────
function activeGoal() {
  const act = S.goals.filter(g => g.status === 'ACTIVE');
  return act.find(g => g.isPrimary) || act[0] || null;
}
function goalTxns(id) { return S.transactions.filter(t => t.goalId === id); }
function monthsToGoalFor(goal) {
  if (!goal) return null;
  const p = S.plan; if (!p) return null;
  const disp = PlanMath.disposableIncome(p); if (disp <= 0) return null;
  const rem = GoalMath.remainingCents(goal.savedCents, goal.targetCents);
  return Math.ceil(rem / disp);
}

// ───────────────────────── R2 SigV4 同步（移植自 Android R2Sync.kt） ─────────────────────────
const R2C = { ACCOUNT_ID: 'fcab58950326b72968a092be2c33c667', BUCKET: 'project', REGION: 'auto', SERVICE: 's3', get HOST() { return this.ACCOUNT_ID + '.r2.cloudflarestorage.com'; }, ledgerKey(id) { return 'ledgers/' + id + '.json'; } };
async function sha256Hex(bytes) { const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
function toHex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
const te = new TextEncoder();
async function sigv4(method, uri, headers, payload, ak, sk, dateTime) {
  const date = dateTime.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const sorted = Object.keys(headers).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  const canonicalHeaders = sorted.map(k => `${k.toLowerCase()}:${String(headers[k]).trim()}`).join('\n') + '\n';
  const signedHeaders = sorted.map(k => k.toLowerCase()).join(';');
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${R2C.REGION}/${R2C.SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, await sha256Hex(te.encode(canonicalRequest))].join('\n');
  const kDate = await hmacSha256(te.encode('AWS4' + sk), te.encode(date));
  const kRegion = await hmacSha256(kDate, te.encode(R2C.REGION));
  const kService = await hmacSha256(kRegion, te.encode(R2C.SERVICE));
  const kSigning = await hmacSha256(kService, te.encode('aws4_request'));
  const signature = toHex(await hmacSha256(kSigning, te.encode(stringToSign)));
  return `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
async function r2Request(method, key, content) {
  const s = S.settings;
  if (!s.r2AccessKey || !s.r2SecretKey) throw new Error('请先在账本设置里填写 R2 密钥');
  if (!s.ledgerId) throw new Error('账本 ID 为空，请先保存账本设置');
  const payload = content ? te.encode(content) : new Uint8Array(0);
  const dateTime = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const uri = `/${R2C.BUCKET}/${key}`;
  const headers = { host: R2C.HOST, 'x-amz-date': dateTime, 'x-amz-content-sha256': await sha256Hex(payload) };
  if (content) headers['content-type'] = 'application/json';
  const auth = await sigv4(method, uri, headers, payload, s.r2AccessKey, s.r2SecretKey, dateTime);
  const res = await fetch(`https://${R2C.HOST}${uri}`, { method, headers: { Authorization: auth, 'x-amz-date': dateTime, 'x-amz-content-sha256': headers['x-amz-content-sha256'], 'content-type': headers['content-type'], }, body: content || undefined });
  if (res.status === 404) return null;
  if (!res.ok) { let t = ''; try { t = await res.text(); } catch (e) {} throw new Error(`同步失败 HTTP ${res.status} ${t.slice(0, 120)}`); }
  return content ? '' : await res.text();
}
async function syncToCloud() {
  const snap = exportSnapshot();
  const json = JSON.stringify(snap);
  await r2Request('PUT', R2C.ledgerKey(S.settings.ledgerId), json);
  toast('已上传到云端 ✓');
}
async function syncFromCloud() {
  const json = await r2Request('GET', R2C.ledgerKey(S.settings.ledgerId), null);
  if (json == null) throw new Error('云端没有该账本，请先在另一台设备上传');
  importSnapshot(JSON.parse(json));
  toast('已从云端恢复 ✓');
  render();
}
function exportSnapshot() {
  const s = S.settings;
  return { version: 1, ledgerId: s.ledgerId, updatedAt: Date.now(), ledgerName: s.ledgerName, reportUnit: s.reportUnit, isPro: false, goals: S.goals, milestones: S.milestones, transactions: S.transactions, categories: S.categories, plan: S.plan };
}
function importSnapshot(snap) {
  const loc = S.settings;
  S.goals = snap.goals || []; S.milestones = snap.milestones || []; S.transactions = snap.transactions || []; S.categories = snap.categories && snap.categories.length ? snap.categories : DEFAULT_CATEGORIES.slice();
  S.plan = snap.plan || null;
  S.settings.ledgerName = snap.ledgerName || loc.ledgerName;
  S.settings.ledgerId = snap.ledgerId || loc.ledgerId;
  S.settings.reportUnit = snap.reportUnit || loc.reportUnit;
  save();
}

// ───────────────────────── 主题 ─────────────────────────
const THEMES = [
  { key: 'MINIMAL', label: '极简翡翠', emoji: '🍃', light: '#0E7C66', dark: '#A9F2DF' },
  { key: 'MIDNIGHT_GOLD', label: '午夜鎏金', emoji: '🌙', light: '#9A741F', dark: '#D4AF37' },
  { key: 'MISTED_BLUE', label: '雾蓝', emoji: '🌫️', light: '#5E7FA3', dark: '#8AA6C4' },
];
const THEME_CSS = { MINIMAL: 'minimal', MIDNIGHT_GOLD: 'midnight', MISTED_BLUE: 'misted' };
function applyTheme() {
  const t = S.settings.themeStyle || 'MINIMAL';
  document.documentElement.setAttribute('data-theme', THEME_CSS[t] || 'minimal');
  document.querySelector('meta[name="theme-color"]').content = t === 'MIDNIGHT_GOLD' ? '#0A1326' : t === 'MISTED_BLUE' ? '#0D1620' : '#0E7C66';
}

// ───────────────────────── 视图渲染 ─────────────────────────
let view = 'home';
function setView(v) { view = v; render(); }
function render() {
  applyTheme();
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const c = $('#content');
  if (view === 'home') c.innerHTML = renderHome();
  else if (view === 'report') c.innerHTML = renderReport();
  else if (view === 'goals') c.innerHTML = renderGoals();
  else c.innerHTML = renderLedger();
}

function heroHTML() {
  const goal = activeGoal();
  const g = S.settings;
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  if (!goal) return `<div class="card center">还没有目标 🎯</div>`;
  const prog = GoalMath.progress(goal.savedCents, goal.targetCents);
  const rem = GoalMath.remainingCents(goal.savedCents, goal.targetCents);
  const days = GoalMath.remainingDays(goal.targetDate, todayE());
  const months = GoalMath.remainingMonths(goal.targetDate, todayE());
  const disp = S.plan ? PlanMath.disposableIncome(S.plan) : 0;
  const m2g = monthsToGoalFor(goal);
  const ahead = m2g != null && m2g < months;
  let msg, msgColor;
  if (!S.plan) { msg = '设置月收支，看看离目标还有多远'; }
  else if (goal.savedCents >= goal.targetCents) { msg = '目标已达成 🎉'; }
  else if (m2g == null) { msg = '可支配收入不足，无法达成目标'; }
  else if (ahead) { msg = `比计划提前 ${months - m2g} 个月`; }
  else if (m2g > months) { msg = `比计划晚 ${m2g - months} 个月`; }
  else { msg = '刚好按时达成'; }
  const flat = document.documentElement.dataset.theme === 'minimal';
  const fill = `<div class="row"><div style="font-weight:700">${goal.emoji} ${esc(goal.name)}</div><div class="pct">${Math.round(prog * 100)}%</div></div>
    <div class="pbar"><div style="width:${Math.max(prog * 100, 2)}%"></div></div>
    <div class="row sub"><span>还差 ${Money.formatCompact(rem, code)}</span><span>剩余 ${days} 天 · ${months} 个月</span></div>
    <hr><div class="sub">本月可存</div><div class="amount hl">${Money.format(disp, code)}</div>
    ${m2g != null ? `<div class="sub">按此进度，约 ${m2g} 个月达成目标</div>` : ''}
    <div style="font-weight:700;margin-top:4px">${msg}</div>
    <div class="sub" style="margin-top:4px">目标月储蓄 ${Money.format(GoalMath.requiredMonthlyCents(goal.savedCents, goal.targetCents, goal.targetDate), code)} · 剩余 ${months} 个月</div>`;
  return `<div class="hero ${flat ? 'flat' : 'grad'}">${fill}</div>`;
}
function renderHome() {
  const goal = activeGoal();
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const txns = [...S.transactions].sort((a, b) => b.occurredAt - a.occurredAt || b.id - a.id).slice(0, 6);
  const rows = txns.length ? txns.map(txnRow).join('') : `<div class="empty"><div class="e">📝</div><div>还没有记录</div><div class="hint">点右下角 ＋ 记下第一笔</div></div>`;
  return `${heroHTML()}
    <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 10px"><b>最近交易</b><button class="btn ghost" style="width:auto;padding:8px 14px" data-act="add-txn">＋ 记一笔</button></div>
    <div class="card" style="padding:4px 16px">${rows}</div>
    ${goal && !S.plan ? `<button class="btn primary" data-act="plan">设置月收支</button>` : goal ? `<button class="btn primary" data-act="plan">编辑月收支</button>` : ''}`;
}
function txnRow(t) {
  const c = S.categories.find(c => c.id === t.categoryId);
  const icon = c ? c.icon : '💸';
  const name = t.note || (c ? c.name : (t.type === 'INCOME' ? '收入' : '支出'));
  return `<div class="txn">
    <div class="icon">${icon}</div>
    <div class="mid"><div class="n">${esc(name)}</div><div class="d">${fmtDate(t.occurredAt)}${t.memberName ? ' · ' + esc(t.memberName) : ''}</div></div>
    <div class="amt ${t.type === 'INCOME' ? 'in' : ''}">${t.type === 'INCOME' ? '+' : '-'}${Money.format(t.amountCents, S.plan?.currencyCode || Money.defaultCurrencyCode())}</div>
    <div class="act"><button data-act="edit-txn" data-id="${t.id}">✏️</button><button data-act="del-txn" data-id="${t.id}">🗑️</button></div>
  </div>`;
}

function renderGoals() {
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  if (!S.goals.length) return `<div class="empty"><div class="e">🎯</div><div>还没有目标</div><div class="hint">点下面按钮，设定你的第一个目标</div></div><button class="btn primary" data-act="new-goal">＋ 新建目标</button>`;
  const list = S.goals.map(g => {
    const prog = GoalMath.progress(g.savedCents, g.targetCents);
    const txs = goalTxns(g.id);
    const monthly = Report.monthlySaving(g.id, S.transactions);
    const pace = GoalMath.paceStatus(g.savedCents, g.targetCents, g.targetDate, monthly);
    const badge = g.isPrimary ? `<span class="badge">★ 主目标</span>` : `<button class="btn ghost" style="width:auto;padding:6px 12px;font-size:12px" data-act="set-primary" data-id="${g.id}">设为主目标</button>`;
    return `<div class="card goal-card" data-act="open-goal" data-id="${g.id}" style="cursor:pointer">
      <div class="emoji">${g.emoji}</div>
      <div class="info"><div class="name">${esc(g.name)} ${badge}</div>
        <div class="pbar"><div style="width:${Math.max(prog * 100, 2)}%;background:${esc(g.colorHex)}"></div></div>
        <div class="row"><b>${Math.round(prog * 100)}%</b><span class="hint">还差 ${Money.formatCompact(GoalMath.remainingCents(g.savedCents, g.targetCents), code)}</span></div>
      </div>
    </div>`;
  }).join('');
  return `<div class="page-title">我的目标 <span style="font-size:12px;color:var(--sub)">${S.goals.length}/3</span></div>${list}<button class="btn primary" data-act="new-goal">＋ 新建目标</button>`;
}

function renderReport() {
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const now = new Date();
  const y = REPORT_Y, m = REPORT_M;
  const startE = eDay(new Date(y, m - 1, 1));
  const endE = eDay(new Date(y, m, 0));
  const prevStart = eDay(new Date(y, m - 2, 1));
  const prevEnd = eDay(new Date(y, m - 1, 0));
  const r = Report.build(S.transactions, S.categories, startE, endE);
  const p = Report.build(S.transactions, S.categories, prevStart, prevEnd);
  const disp = S.plan ? PlanMath.disposableIncome(S.plan) : 0;
  const saveable = disp - r.expense;
  const prevSaveable = disp - p.expense;
  const goal = activeGoal();
  const rem = goal ? GoalMath.remainingCents(goal.savedCents, goal.targetCents) : 0;
  const totalM = goal ? GoalMath.remainingMonths(goal.targetDate) : 0;
  const m2g = saveable > 0 ? Math.ceil(rem / saveable) : null;
  let msg = '', sc = 'var(--sub)';
  if (saveable < 0) { msg = '本月支出超出可支配，需要控制'; sc = 'var(--danger)'; }
  else if (m2g == null) { msg = '本月可存为 0，无法推算'; }
  else if (totalM - m2g > 0) { msg = `比计划提前 ${totalM - m2g} 个月`; sc = 'var(--success)'; }
  else if (totalM - m2g < 0) { msg = `比计划晚 ${m2g - totalM} 个月`; sc = 'var(--danger)'; }
  else { msg = '刚好按计划'; }
  const dlt = (cur, pre) => pre === 0 ? null : (cur - pre) / pre;
  const dl = (cur, pre, inv) => {
    const d = dlt(cur, pre); if (d == null) return `<span class="delta flat">新增</span>`;
    if (Math.abs(d * 100) < 0.5) return `<span class="delta flat">持平</span>`;
    const up = inv ? d < 0 : d > 0;
    return `<span class="delta ${up ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'} ${Math.abs(Math.round(d * 100))}%</span>`;
  };
  const catCard = (title, items, prevItems, inv) => {
    const pm = {}; (prevItems || []).forEach(([n, v]) => pm[n] = v);
    const body = items.length ? items.map(([n, v]) => `<div class="layrow"><span class="l">${esc(n)}</span><span style="display:flex;gap:8px;align-items:center">${dl(v, pm[n], inv)}<b>${Money.format(v, code)}</b></span></div>`).join('') : '<div class="hint">暂无</div>';
    return `<div class="card"><h3>${title}</h3>${body}</div>`;
  };
  const rateDl = dl(Math.round(r.rate * 1000), Math.round(p.rate * 1000), false);
  const statRow = (v, l, ch, col) => `<div class="stat"><div class="v" style="color:${col || 'inherit'}">${v}</div><div class="l">${l}</div>${ch}</div>`;
  return `<div class="page-title">报告</div>
    <div class="row" style="align-items:center;margin-bottom:10px">
      <button class="btn ghost" style="width:auto;padding:6px 12px" data-act="report-prev">◀</button>
      <b style="flex:1;text-align:center">${y}年${m}月</b>
      <button class="btn ghost" style="width:auto;padding:6px 12px" data-act="report-next">▶</button>
    </div>
    <div class="card"><h3>本月可存</h3>
      <div class="big" style="color:${saveable >= 0 ? 'var(--success)' : 'var(--danger)'}">${Money.format(saveable, code)}</div>
      <div class="hint" style="margin-top:2px">上月可存 ${Money.format(prevSaveable, code)} ${dl(saveable, prevSaveable, false)}</div>
      ${m2g != null ? `<div class="hint">按此进度，约 ${m2g} 个月达成目标</div>` : ''}
      <div style="font-weight:700;color:${sc};margin-top:4px">${msg}</div>
      <hr style="border:none;border-top:1px solid var(--border);margin:10px 0">
      <div class="layrow"><span class="l">目标月储蓄（总目标）</span><b>${Money.format(goal ? GoalMath.requiredMonthlyCents(goal.savedCents, goal.targetCents, goal.targetDate) : 0, code)}</b></div>
      <div class="layrow"><span class="l">计划可支配（最好情况）</span><b>${Money.format(disp, code)}</b></div>
      <div class="layrow"><span class="l">本月支出（实际情况）</span><b>${Money.format(r.expense, code)}</b></div>
    </div>
    <div class="card"><div class="statgrid">
      ${statRow(Money.format(r.net, code), '实际结余', dl(r.net, p.net, false), r.net >= 0 ? 'var(--success)' : 'var(--danger)')}
      ${statRow(Math.round(r.rate * 100) + '%', '储蓄率', rateDl)}
      ${statRow(Money.format(r.income, code), '收入', dl(r.income, p.income, false))}
      ${statRow(Money.format(r.expense, code), '支出', dl(r.expense, p.expense, true))}
    </div></div>
    ${catCard('支出汇总', r.expenseByCategory, p.expenseByCategory, true)}
    ${catCard('收入汇总', r.incomeByCategory, p.incomeByCategory, false)}`;
}
let REPORT_Y = new Date().getFullYear(), REPORT_M = new Date().getMonth() + 1;

function renderLedger() {
  const s = S.settings;
  const themeRows = THEMES.map(t => {
    const on = s.themeStyle === t.key;
    return `<div class="theme-row ${on ? 'on' : ''}" data-act="set-theme" data-theme="${t.key}">
      <span style="font-size:20px">${t.emoji}</span><b style="flex:1">${t.label}</b>
      <span class="sw" style="background:${t.light}"></span><span class="sw" style="background:${t.dark}"></span>${on ? ' ✓' : ''}
    </div>`;
  }).join('');
  return `<div class="page-title">账本设置</div>
    <div class="card"><h3>外观主题</h3>${themeRows}<div class="hint">可随时切换，立即生效（浅色/深色跟随系统）</div></div>
    <div class="card"><h3>家庭账本</h3>
      <div class="field"><label>账本名称</label><input id="f-ledgername" value="${esc(s.ledgerName)}"></div>
      <div class="field"><label>成员名（本机）</label><input id="f-member" value="${esc(s.memberName)}"><div class="hint">记账时自动标记是谁记的</div></div>
      <div class="field"><label>账本 ID（共享码）</label><input id="f-ledgerid" value="${esc(s.ledgerId)}"><div class="hint">加入已有账本时粘贴另一台的 ID；留空自动新建</div></div>
      ${s.ledgerId
        ? `<div class="primary-dist" style="margin-top:6px">🔗 当前共享码：<b style="user-select:all;word-break:break-all">${esc(s.ledgerId)}</b><br><button class="btn ghost" style="width:auto;padding:6px 12px;font-size:12px;margin-top:6px" data-act="copy-id">📋 复制共享码</button></div>`
        : '<div class="hint">保存设置后自动生成共享码，可在其他设备填入加入同一账本</div>'}
    </div>
    <div class="card"><h3>云同步（Cloudflare R2）</h3>
      <div class="field"><label>R2 Access Key</label><input id="f-ak" value="${esc(s.r2AccessKey)}"></div>
      <div class="field"><label>R2 Secret Key</label><input id="f-sk" value="${esc(s.r2SecretKey)}"><div class="hint">密钥只存本机，不会上传；两台设备填相同账本 ID + 密钥即可同步</div></div>
      <button class="btn primary" data-act="save-ledger">保存设置</button>
    </div>
    <div class="card"><h3>同步</h3>
      <div style="display:flex;gap:8px">
        <button class="btn" data-act="sync-up">上传到云端</button>
        <button class="btn" data-act="sync-down">从云端恢复</button>
      </div>
      <div class="hint" style="margin-top:8px">建议：一台设备先「上传」，另一台再「下载」。</div>
    </div>`;
}

// ───────────────────────── 弹层（表单） ─────────────────────────
function openSheet(html) { $('#sheet').innerHTML = `<button id="sheet-close" data-act="close-sheet">✕</button>${html}`; $('#sheet-overlay').classList.remove('hidden'); }
function closeSheet() { $('#sheet-overlay').classList.add('hidden'); }

function sheetAddTxn(editId) {
  const t = editId != null ? S.transactions.find(x => x.id === editId) : null;
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const goal = activeGoal();
  const cats = S.categories.filter(c => c.type === (t ? t.type : 'EXPENSE'));
  const catChips = cats.map(c => `<span class="chip ${t && t.categoryId === c.id ? 'on' : ''}" data-role="cat" data-id="${c.id}">${c.icon} ${esc(c.name)}</span>`).join('');
  const goalsOpts = S.goals.filter(g => g.status === 'ACTIVE').map(g => `<option value="${g.id}" ${t && t.goalId === g.id ? 'selected' : ''}>${g.emoji} ${esc(g.name)}</option>`).join('');
  openSheet(`<h2>${t ? '编辑交易' : '记一笔'}</h2>
    <div class="seg"><span class="chip ${!t || t.type === 'EXPENSE' ? 'on' : ''}" data-role="type" data-v="EXPENSE">支出</span><span class="chip ${t && t.type === 'INCOME' ? 'on' : ''}" data-role="type" data-v="INCOME">收入</span></div>
    <div class="field"><label>金额</label><input id="f-amt" type="number" inputmode="decimal" placeholder="0.00" value="${t ? Money.decimalText(t.amountCents, code) : ''}"></div>
    <div class="field"><label>分类</label><div id="cat-row" style="display:flex;flex-wrap:wrap;gap:8px">${catChips}</div></div>
    <div class="field"><label>关联目标（可选）</label><select id="f-goal"><option value="">不关联</option>${goalsOpts}</select></div>
    <div class="field"><label>备注</label><input id="f-note" placeholder="例如：午饭" value="${esc(t ? t.note : '')}"></div>
    <div class="field"><label>日期</label><input id="f-date" type="date" value="${fmtDate(t ? t.occurredAt : todayE())}"></div>
    <div id="primary-dist"></div>
    <button class="btn primary" data-act="save-txn" data-id="${editId ?? ''}">保存</button>`);
  $('#f-amt').oninput = updatePrimaryDist;
  $('#f-goal').onchange = updatePrimaryDist;
  updatePrimaryDist();
}
function updatePrimaryDist() {
  const el = $('#primary-dist'); if (!el) return;
  const goal = activeGoal(); if (!goal) { el.innerHTML = ''; return; }
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const cents = Money.parseToCents($('#f-amt')?.value || '', code);
  const linked = $('#f-goal')?.value === String(goal.id);
  const delta = linked && cents ? (document.querySelector('[data-role=type].on')?.dataset.v === 'INCOME' ? cents : -cents) : 0;
  const after = goal.savedCents + delta;
  const rem = GoalMath.remainingCents(after, goal.targetCents);
  el.innerHTML = `<div class="primary-dist">🎯 主目标 · ${goal.emoji} ${esc(goal.name)}：${linked ? '记完这笔，' : ''}距离目标还差 ${Money.format(rem, code)}</div>`;
}
function sheetNewGoal(editId) {
  const g = editId != null ? S.goals.find(x => x.id === editId) : null;
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const emojis = ['🎯', '✈️', '🛡️', '💳', '🎁', '🏠', '🚗', '📱', '💍', '🎓'];
  const colors = ['#0E7C66', '#1565C0', '#EF6C00', '#6A1B9A', '#D05252', '#2E7D32', '#00838F', '#37474F'];
  const eRow = emojis.map(e => `<span class="chip ${g && g.emoji === e ? 'on' : ''}" data-role="emoji" data-v="${e}" style="flex:0 0 auto;min-width:44px">${e}</span>`).join('');
  const cRow = colors.map(c => `<span class="chip ${g && g.colorHex === c ? 'on' : ''}" data-role="color" data-v="${c}" style="flex:0 0 auto;min-width:44px;background:${c};color:#fff">✓</span>`).join('');
  openSheet(`<h2>${g ? '编辑目标' : '新建目标'}</h2>
    <div class="field"><label>图标</label><div style="display:flex;flex-wrap:wrap;gap:8px">${eRow}</div></div>
    <div class="field"><label>颜色</label><div style="display:flex;flex-wrap:wrap;gap:8px">${cRow}</div></div>
    <div class="field"><label>目标名称</label><input id="f-gname" value="${esc(g ? g.name : '')}"></div>
    <div class="field"><label>目标金额（元）</label><input id="f-gtarget" type="number" inputmode="decimal" value="${g ? Money.decimalText(g.targetCents, code) : ''}"></div>
    <div class="field"><label>已存金额（元，可跳过）</label><input id="f-gsaved" type="number" inputmode="decimal" value="${g ? Money.decimalText(g.savedCents, code) : ''}"></div>
    <div class="field"><label>目标日期</label><input id="f-gdate" type="date" value="${fmtDate(g ? g.targetDate : todayE() + 365)}"></div>
    <button class="btn primary" data-act="save-goal" data-id="${editId ?? ''}">${g ? '保存' : '创建目标'}</button>`);
}
function sheetPlan() {
  const p = S.plan;
  const code = p?.currencyCode || Money.defaultCurrencyCode();
  const f = (key, label, v) => `<div class="field"><label>${label}</label><input id="f-${key}" type="number" inputmode="decimal" value="${v}"></div>`;
  openSheet(`<h2>月收支设置</h2>
    <div class="field"><label>货币</label><select id="f-cur">${['CNY', 'EUR', 'USD', 'JPY'].map(c => `<option ${c === code ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    ${f('inc', '每月固定收入（元）', p ? Money.decimalText(p.monthlyIncomeCents, code) : '')}
    ${f('h', '住（房租/月供）', p ? Money.decimalText(p.expenseHousingCents, code) : '')}
    ${f('fo', '食（餐费）', p ? Money.decimalText(p.expenseFoodCents, code) : '')}
    ${f('cl', '衣（服饰）', p ? Money.decimalText(p.expenseClothingCents, code) : '')}
    ${f('tr', '行（交通）', p ? Money.decimalText(p.expenseTransportCents, code) : '')}
    ${f('ot', '其他固定支出', p ? Money.decimalText(p.expenseOtherCents, code) : '')}
    <button class="btn primary" data-act="save-plan">保存</button>`);
}
function sheetGoalDetail(id) {
  const g = S.goals.find(x => x.id === id); if (!g) return;
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const prog = GoalMath.progress(g.savedCents, g.targetCents);
  const cells = Array.from({ length: 48 }, (_, i) => {
    const filled = Math.round(prog * 48);
    if (i < filled) return `<span class="cell on" style="background:${esc(g.colorHex)}"></span>`;
    if (i === filled) return `<span class="cell cur"></span>`;
    return `<span class="cell"></span>`;
  }).join('');
  const txs = goalTxns(g.id).sort((a, b) => b.occurredAt - a.occurredAt);
  const rows = txs.length ? txs.map(txnRow).join('') : '<div class="hint">还没有关联交易，点记账存入目标</div>';
  openSheet(`<h2>${g.emoji} ${esc(g.name)}</h2>
    <div class="card" style="text-align:center">
      <div class="gridcells" style="justify-content:center">${cells}</div>
      <div class="big" style="color:${esc(g.colorHex)}">${Math.round(prog * 100)}%</div>
      <div class="hint">还差 ${Money.formatCompact(GoalMath.remainingCents(g.savedCents, g.targetCents), code)} · 目标 ${Money.formatCompact(g.targetCents, code)} · ${fmtDate(g.targetDate)}</div>
    </div>
    <div class="card"><h3>关联交易</h3>${rows}</div>
    <div style="display:flex;gap:8px">
      <button class="btn" data-act="add-txn">记账</button>
      <button class="btn" data-act="edit-goal" data-id="${g.id}">编辑</button>
      ${g.isPrimary ? '' : `<button class="btn" data-act="set-primary" data-id="${g.id}">设为主目标</button>`}
    </div>`);
}

// ───────────────────────── 事件（事件委托） ─────────────────────────
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]');
  if (nav) { setView(nav.dataset.view); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = (el.dataset.id === '' || el.dataset.id == null) ? null : Number(el.dataset.id);
  if (act === 'close-sheet') return closeSheet();
  if (act === 'set-theme') { S.settings.themeStyle = el.dataset.theme; save(); applyTheme(); document.querySelectorAll('.theme-row').forEach(r => r.classList.toggle('on', r.dataset.theme === el.dataset.theme)); render(); return; }
  if (act === 'copy-id') { copyText(S.settings.ledgerId || ''); return; }
  if (act === 'save-txn') return doSaveTxn(id);
  if (act === 'save-goal') return doSaveGoal(id);
  if (act === 'save-plan') return doSavePlan();
  if (act === 'save-ledger') return doSaveLedger();
  if (act === 'sync-up') return doSyncUp();
  if (act === 'sync-down') return doSyncDown();
  if (act === 'add-txn') return sheetAddTxn(null);
  if (act === 'edit-txn') return sheetAddTxn(id);
  if (act === 'del-txn') return doDelTxn(id);
  if (act === 'new-goal') return sheetNewGoal(null);
  if (act === 'edit-goal') return sheetNewGoal(id);
  if (act === 'set-primary') { S.goals.forEach(g => g.isPrimary = g.id === id); save(); render(); toast('已设为主目标'); return; }
  if (act === 'open-goal') return sheetGoalDetail(id);
  if (act === 'plan') return sheetPlan();
  if (act === 'report-prev') { if (--REPORT_M === 0) { REPORT_M = 12; REPORT_Y--; } render(); return; }
  if (act === 'report-next') { if (++REPORT_M === 13) { REPORT_M = 1; REPORT_Y++; } render(); return; }
});
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-role]');
  if (chip) {
    const role = chip.dataset.role;
    if (role === 'type') { document.querySelectorAll('[data-role=type]').forEach(c => c.classList.toggle('on', c === chip)); rebuildCats(); updatePrimaryDist(); }
    else if (role === 'cat') { document.querySelectorAll('[data-role=cat]').forEach(c => c.classList.toggle('on', c === chip)); }
    else if (role === 'emoji' || role === 'color') { document.querySelectorAll(`[data-role=${role}]`).forEach(c => c.classList.toggle('on', c === chip)); }
  }
});
function rebuildCats() {
  const type = document.querySelector('[data-role=type].on')?.dataset.v || 'EXPENSE';
  const row = $('#cat-row'); if (!row) return;
  row.innerHTML = S.categories.filter(c => c.type === type).map(c => `<span class="chip" data-role="cat" data-id="${c.id}">${c.icon} ${esc(c.name)}</span>`).join('');
}
function doSaveTxn(editId) {
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const cents = Money.parseToCents($('#f-amt').value, code);
  if (!cents) return toast('请输入大于 0 的有效金额');
  const type = document.querySelector('[data-role=type].on')?.dataset.v || 'EXPENSE';
  const catId = Number(document.querySelector('[data-role=cat].on')?.dataset.id ?? '0') || null;
  const goalId = $('#f-goal').value ? Number($('#f-goal').value) : null;
  const note = $('#f-note').value.trim();
  const occurredAt = eDay(new Date($('#f-date').value + 'T00:00:00'));
  if (editId != null) {
    const old = S.transactions.find(t => t.id === editId);
    if (old.goalId) adjustGoal(old.goalId, old.type === 'INCOME' ? -old.amountCents : old.amountCents);
    Object.assign(old, { type, amountCents: cents, categoryId: catId, goalId, note, occurredAt, memberName: S.settings.memberName || old.memberName });
    if (goalId) adjustGoal(goalId, type === 'INCOME' ? cents : -cents);
  } else {
    const t = { id: nextId(S.transactions), type, amountCents: cents, categoryId: catId, goalId, note, occurredAt, createdAt: Date.now(), memberName: S.settings.memberName || '我' };
    S.transactions.push(t);
    if (goalId) adjustGoal(goalId, type === 'INCOME' ? cents : -cents);
  }
  save(); closeSheet(); render(); toast('已保存 ✓');
}
function adjustGoal(goalId, delta) {
  const g = S.goals.find(x => x.id === goalId); if (!g) return;
  g.savedCents = Math.max(0, g.savedCents + delta);
  if (g.savedCents >= g.targetCents) g.status = 'COMPLETED';
  else if (g.status === 'COMPLETED') g.status = 'ACTIVE';
}
function doDelTxn(id) {
  const t = S.transactions.find(x => x.id === id); if (!t) return;
  if (!confirm('确定删除这笔交易吗？删除后目标进度会回退。')) return;
  if (t.goalId) adjustGoal(t.goalId, t.type === 'INCOME' ? -t.amountCents : t.amountCents);
  S.transactions = S.transactions.filter(x => x.id !== id);
  save(); render(); toast('已删除');
}
function doSaveGoal(editId) {
  const code = S.plan?.currencyCode || Money.defaultCurrencyCode();
  const target = Money.parseToCents($('#f-gtarget').value, code);
  if (!target) return toast('请输入有效的目标金额');
  const saved = Money.parseToCents($('#f-gsaved').value, code) || 0;
  const name = $('#f-gname').value.trim() || '我的目标';
  const emoji = document.querySelector('[data-role=emoji].on')?.dataset.v || '🎯';
  const colorHex = document.querySelector('[data-role=color].on')?.dataset.v || '#0E7C66';
  const targetDate = eDay(new Date($('#f-gdate').value + 'T00:00:00'));
  if (editId != null) {
    const g = S.goals.find(x => x.id === editId);
    Object.assign(g, { name, emoji, colorHex, targetCents: target, savedCents: saved, targetDate });
  } else {
    if (S.goals.filter(g => g.status === 'ACTIVE').length >= 3) return toast('最多只能有 3 个活跃目标');
    const g = { id: nextId(S.goals), name, emoji, colorHex, targetCents: target, savedCents: saved, startDate: todayE(), targetDate, status: 'ACTIVE', category: 'custom', isPrimary: S.goals.length === 0 };
    S.goals.push(g);
    MilestonePlan.generate(target).forEach((m, i) => S.milestones.push({ id: nextId(S.milestones), goalId: g.id, name: m.name, targetCents: m.targetCents, achieved: saved >= m.targetCents, achievedAt: null, sortOrder: i }));
  }
  save(); closeSheet(); render(); toast('已保存 ✓');
}
function doSavePlan() {
  const code = $('#f-cur').value;
  const v = key => Money.parseToCents($('#f-' + key).value, code) || 0;
  S.plan = { id: 1, currencyCode: code, monthlyIncomeCents: v('inc'), expenseHousingCents: v('h'), expenseFoodCents: v('fo'), expenseClothingCents: v('cl'), expenseTransportCents: v('tr'), expenseOtherCents: v('ot') };
  save(); closeSheet(); render(); toast('月收支已保存 ✓');
}
function doSaveLedger() {
  const s = S.settings;
  const newId = $('#f-ledgerid').value.trim();
  s.ledgerName = $('#f-ledgername').value.trim() || '我的家庭账本';
  s.memberName = $('#f-member').value.trim() || '我';
  s.r2AccessKey = $('#f-ak').value.trim();
  s.r2SecretKey = $('#f-sk').value.trim();
  if (!s.ledgerId) s.ledgerId = newId || crypto.randomUUID();
  save(); render(); toast('已保存 ✓');
}
async function doSyncUp() { try { await syncToCloud(); } catch (err) { toast(err.message); } }
async function doSyncDown() { try { await syncFromCloud(); } catch (err) { toast(err.message); } }

// Money.decimalText helper
Money.decimalText = (cents, code) => (Math.abs(cents) / Math.pow(10, Money.fractionDigits(code || 'CNY'))).toString();

// PWA service worker
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(() => {}); }

render();

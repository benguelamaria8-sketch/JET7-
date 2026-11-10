// JET7 2.0 — armazenamento em Postgres (Supabase). Só é usado quando existe DATABASE_URL.
// O servidor continua a trabalhar com o estado em memória (como na 1.x); esta camada guarda-o na BD
// em lote (a cada FLUSH_MS), só com as linhas que mudaram, e com um pool pequeno (max 3) por causa dos 512 MB do Render Free.
'use strict';
const { Pool } = require('pg');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY, email text UNIQUE NOT NULL, pass text NOT NULL,
     data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`,
  // uid '' = dono do servidor; senão o id do cliente. enc = {iv, tag, data} (AES-256-GCM com MASTER_KEY)
  `CREATE TABLE IF NOT EXISTS api_keys (
     uid text NOT NULL DEFAULT '', exchange text NOT NULL, enc jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (uid, exchange))`,
  `CREATE TABLE IF NOT EXISTS trades (
     id bigserial PRIMARY KEY, uid text NOT NULL DEFAULT '', k text NOT NULL, at timestamptz NOT NULL,
     type text, status text, source text, symbol text, buy_exchange text, sell_exchange text,
     amount double precision, net_profit double precision, net_pct double precision, data jsonb NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trades_uid_k ON trades (uid, k)`,
  `CREATE INDEX IF NOT EXISTS trades_uid_at ON trades (uid, at DESC)`,
  `CREATE INDEX IF NOT EXISTS trades_type_at ON trades (type, at DESC)`,
  `CREATE TABLE IF NOT EXISTS payments (
     id text PRIMARY KEY, email text, plan text, amount double precision, status text, tx_id text,
     created_at timestamptz, paid_at timestamptz, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS licenses (
     key text PRIMARY KEY, email text, plan text, order_id text, issued_at timestamptz, expires_at timestamptz,
     revoked boolean NOT NULL DEFAULT false, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS licenses_email ON licenses (email)`,
  `CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb, updated_at timestamptz NOT NULL DEFAULT now())`,
  // dia em UTC; uid '' = dono. Recalculado a partir de trades (hoje e ontem) a cada 15 min
  `CREATE TABLE IF NOT EXISTS daily_stats (
     day date NOT NULL, uid text NOT NULL DEFAULT '', type text NOT NULL, status text NOT NULL,
     n integer NOT NULL DEFAULT 0, net_profit double precision NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (day, uid, type, status))`
];

const tradeKey = t => [t.at, t.id || t.symbol || '', t.type || '', t.status || ''].join('|');
const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
// nunca deixar sair o URL da BD (com palavra-passe) em mensagens de erro
const safeMsg = m => String(m || '').replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://***').slice(0, 200);
const num = v => (typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null));

// tira do URL os parâmetros ssl (o pg trata sslmode=require como verify-full, que falha com o certificado da Supabase)
function cleanUrl(u) {
  try { const x = new URL(u); for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) x.searchParams.delete(p); return x.toString(); }
  catch { return u; }
}

function createPgStore({ url, ssl = true, flushMs = 2500, log = console }) {
  const pool = new Pool({
    connectionString: cleanUrl(url), ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 30000, application_name: 'jet7-server'
  });
  pool.on('error', e => { st.lastError = 'pool: ' + safeMsg(e.message); });
  const st = { ready: false, ok: null, lastOk: null, lastError: null, lastFlushAt: null, flushes: 0, writes: 0, migratedFrom: null, lastBackupAt: null, lastBackupError: null, lastStatsAt: null };
  const q = (text, params) => pool.query(text, params);

  // ---------- filas de escrita ----------
  const tradeQ = [];               // { uid, t }
  const settingQ = new Map();      // key -> value
  const keyQ = new Map();          // uid|exchange -> enc | null (apagar)
  const saved = { pay: new Map(), lic: new Map(), users: new Map() }; // id -> JSON gravado (só reenvia o que mudou)
  let providers = { pay: () => null, users: () => null };
  let flushTimer = null, flushing = null;
  const MAX_TRADE_Q = 20000;

  function schedule() { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, flushMs); }
  function queueTrade(uid, t) { tradeQ.push({ uid: uid || '', t }); if (tradeQ.length > MAX_TRADE_Q) tradeQ.splice(0, tradeQ.length - MAX_TRADE_Q); schedule(); }
  function setSetting(key, value) { settingQ.set(key, value); schedule(); }
  function putKey(uid, exchange, enc) { keyQ.set((uid || '') + '|' + exchange, enc); schedule(); }
  function delKey(uid, exchange) { keyQ.set((uid || '') + '|' + exchange, null); schedule(); }
  function setProviders(p) { providers = { ...providers, ...p }; }

  async function insertTrades(batch) {
    // INSERT com várias linhas por pedido (até 200), duplicados ignorados
    for (let i = 0; i < batch.length; i += 200) {
      const part = batch.slice(i, i + 200), vals = [], params = [];
      for (const { uid, t } of part) {
        const b = params.length;
        params.push(uid, tradeKey(t), iso(t.at) || new Date().toISOString(), t.type || null, t.status || null, t.source || null, t.symbol || null,
          t.buyExchange || t.exchange || null, t.sellExchange || null, num(t.amount), num(t.netProfit), num(t.netPct), JSON.stringify(t));
        vals.push('(' + Array.from({ length: 13 }, (_, j) => '$' + (b + j + 1)).join(',') + ')');
      }
      await q(`INSERT INTO trades (uid,k,at,type,status,source,symbol,buy_exchange,sell_exchange,amount,net_profit,net_pct,data) VALUES ${vals.join(',')} ON CONFLICT (uid,k) DO NOTHING`, params);
      st.writes += part.length;
    }
  }
  async function upsertRows(table, cols, conflict, rows) {
    // a chave de conflito é sempre a 1.ª coluna: sem duplicados no mesmo INSERT (fica a última versão)
    rows = [...new Map(rows.map(r => [r[0], r])).values()];
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100), vals = [], params = [];
      for (const r of part) { const b = params.length; params.push(...r); vals.push('(' + r.map((_, j) => '$' + (b + j + 1)).join(',') + ', now())'); }
      const upd = cols.filter(c => c !== conflict).map(c => `${c}=EXCLUDED.${c}`).concat('updated_at=now()').join(',');
      await q(`INSERT INTO ${table} (${cols.join(',')},updated_at) VALUES ${vals.join(',')} ON CONFLICT (${conflict}) DO UPDATE SET ${upd}`, params);
      st.writes += part.length;
    }
  }
  const payRow = o => [o.id, o.email || null, o.plan || null, num(o.amount), o.status || null, o.txId || null, iso(o.createdAt), iso(o.paidAt), JSON.stringify(o)];
  const licRow = l => [l.key, l.email || null, l.plan || null, l.orderId || null, iso(l.issuedAt), iso(l.expiresAt), !!l.revoked, JSON.stringify(l)];
  // utilizador sem chaves (vão para api_keys) e sem histórico (vai para trades)
  const userData = u => { const { keys, hist, pass, ...rest } = u; return rest; };
  const userRow = u => [u.id, u.email, u.pass, JSON.stringify(userData(u)), iso(u.createdAt)];

  function diff(map, list, idOf, toRow) {
    const rows = [];
    for (const x of list || []) { const id = idOf(x); if (!id) continue; const r = toRow(x), j = r[r.length - 1]; if (map.get(id) !== j) rows.push({ id, r, j }); }
    return rows;
  }

  async function flush() {
    if (!st.ready) { schedule(); return; }
    if (flushing) { await flushing; return flush(); }
    flushing = (async () => {
      try {
        if (tradeQ.length) { const batch = tradeQ.splice(0, tradeQ.length); try { await insertTrades(batch); } catch (e) { tradeQ.unshift(...batch); throw e; } }
        if (settingQ.size) {
          const rows = [...settingQ.entries()]; settingQ.clear();
          try { await upsertRows('settings', ['key', 'value'], 'key', rows.map(([k, v]) => [k, JSON.stringify(v ?? null)])); }
          catch (e) { for (const [k, v] of rows) if (!settingQ.has(k)) settingQ.set(k, v); throw e; }
        }
        if (keyQ.size) {
          const rows = [...keyQ.entries()]; keyQ.clear();
          try {
            for (const [k, enc] of rows) {
              const [uid, ex] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
              if (enc) await q(`INSERT INTO api_keys (uid,exchange,enc,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (uid,exchange) DO UPDATE SET enc=EXCLUDED.enc, updated_at=now()`, [uid, ex, JSON.stringify(enc)]);
              else await q(`DELETE FROM api_keys WHERE uid=$1 AND exchange=$2`, [uid, ex]);
              st.writes++;
            }
          } catch (e) { for (const [k, v] of rows) if (!keyQ.has(k)) keyQ.set(k, v); throw e; }
        }
        const pay = providers.pay();
        if (pay) {
          const po = diff(saved.pay, pay.orders, o => o.id, payRow);
          if (po.length) { await upsertRows('payments', ['id', 'email', 'plan', 'amount', 'status', 'tx_id', 'created_at', 'paid_at', 'data'], 'id', po.map(x => x.r)); for (const x of po) saved.pay.set(x.id, x.j); }
          const pl = diff(saved.lic, pay.licenses, l => l.key, licRow);
          if (pl.length) { await upsertRows('licenses', ['key', 'email', 'plan', 'order_id', 'issued_at', 'expires_at', 'revoked', 'data'], 'key', pl.map(x => x.r)); for (const x of pl) saved.lic.set(x.id, x.j); }
        }
        const users = providers.users();
        if (users) {
          const pu = [];
          for (const u of users) { const r = userRow(u), j = r[2] + '\u0000' + r[3]; if (saved.users.get(u.id) !== j) pu.push({ id: u.id, r, j }); }
          if (pu.length) { await upsertRows('users', ['id', 'email', 'pass', 'data', 'created_at'], 'id', pu.map(x => x.r)); for (const x of pu) saved.users.set(x.id, x.j); }
        }
        st.ok = true; st.lastOk = new Date().toISOString(); st.lastError = null; st.lastFlushAt = st.lastOk; st.flushes++;
      } catch (e) { st.ok = false; st.lastError = safeMsg(e.message); log.warn('[db] ' + st.lastError); schedule(); }
    })();
    try { await flushing; } finally { flushing = null; }
  }

  // ---------- arranque ----------
  async function init() {
    for (const s of SCHEMA) await q(s);
    st.ok = true; st.lastOk = new Date().toISOString();
  }
  // "vazia" = nunca migrou e ainda sem contas, pedidos nem licenças (simulações novas não impedem a migração)
  async function isEmpty() {
    const r = await q(`SELECT (SELECT count(*) FROM settings WHERE key='migrated') AS m, (SELECT count(*) FROM users) + (SELECT count(*) FROM payments) + (SELECT count(*) FROM licenses) AS n`);
    return Number(r.rows[0].m) === 0 && Number(r.rows[0].n) === 0;
  }
  const insertSettingIfMissing = (k, v) => q(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, JSON.stringify(v)]);
  // importação única dos dados da 1.x (Gists e ficheiros locais)
  async function importLegacy({ history = [], autobot = null, payments = null, users = [], ownerKeys = {}, simInventory = null, from = 'gist' }) {
    const trades = history.map(t => ({ uid: '', t }));
    for (const u of users) for (const t of u.hist || []) trades.push({ uid: u.id, t });
    if (trades.length) await insertTrades(trades);
    if (autobot) { await insertSettingIfMissing('autobot', autobot); await insertSettingIfMissing('stopped', { stopped: !!autobot.stopped }); }
    if (simInventory) await insertSettingIfMissing('sim_inventory', simInventory);
    if (payments) {
      if (payments.orders?.length) await upsertRows('payments', ['id', 'email', 'plan', 'amount', 'status', 'tx_id', 'created_at', 'paid_at', 'data'], 'id', payments.orders.filter(o => o.id).map(payRow));
      if (payments.licenses?.length) await upsertRows('licenses', ['key', 'email', 'plan', 'order_id', 'issued_at', 'expires_at', 'revoked', 'data'], 'key', payments.licenses.filter(l => l.key).map(licRow));
    }
    const ok = users.filter(u => u.id && u.email && u.pass);
    if (ok.length) await upsertRows('users', ['id', 'email', 'pass', 'data', 'created_at'], 'id', ok.map(userRow));
    for (const u of ok) for (const [ex, enc] of Object.entries(u.keys || {})) await q(`INSERT INTO api_keys (uid,exchange,enc) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, ex, JSON.stringify(enc)]);
    for (const [ex, enc] of Object.entries(ownerKeys || {})) await q(`INSERT INTO api_keys (uid,exchange,enc) VALUES ('',$1,$2) ON CONFLICT DO NOTHING`, [ex, JSON.stringify(enc)]);
    const info = { at: new Date().toISOString(), from, trades: trades.length, users: ok.length, orders: payments?.orders?.length || 0, licenses: payments?.licenses?.length || 0, ownerKeys: Object.keys(ownerKeys || {}).length };
    await upsertRows('settings', ['key', 'value'], 'key', [['migrated', JSON.stringify(info)]]);
    st.migratedFrom = info;
    return info;
  }
  async function loadAll({ histMax = 1000, userHistMax = 200, ordersMax = 2000 } = {}) {
    const settings = {};
    for (const r of (await q(`SELECT key, value FROM settings`)).rows) settings[r.key] = r.value;
    const hist = (await q(`SELECT data FROM trades WHERE uid='' ORDER BY at DESC, id DESC LIMIT $1`, [histMax])).rows.map(r => r.data);
    const orders = (await q(`SELECT data FROM payments ORDER BY created_at DESC NULLS LAST LIMIT $1`, [ordersMax])).rows.map(r => r.data);
    const licenses = (await q(`SELECT data FROM licenses ORDER BY issued_at DESC NULLS LAST`)).rows.map(r => r.data);
    const keys = (await q(`SELECT uid, exchange, enc FROM api_keys`)).rows;
    const users = (await q(`SELECT id, email, pass, data FROM users ORDER BY created_at NULLS LAST`)).rows.map(r => ({ ...r.data, id: r.id, email: r.email, pass: r.pass, keys: {}, hist: [] }));
    const byId = new Map(users.map(u => [u.id, u]));
    const ownerKeys = {};
    for (const k of keys) { if (!k.uid) ownerKeys[k.exchange] = k.enc; else if (byId.has(k.uid)) byId.get(k.uid).keys[k.exchange] = k.enc; }
    if (users.length) {
      const uh = (await q(`SELECT uid, data FROM trades WHERE uid <> '' AND at > now() - interval '60 days' ORDER BY at DESC, id DESC LIMIT $1`, [Math.min(users.length * userHistMax, 50000)])).rows;
      for (const r of uh) { const u = byId.get(r.uid); if (u && u.hist.length < userHistMax) u.hist.push(r.data); }
    }
    for (const o of orders) saved.pay.set(o.id, payRow(o)[8]);
    for (const l of licenses) saved.lic.set(l.key, licRow(l)[7]);
    for (const u of users) { const r = userRow(u); saved.users.set(u.id, r[2] + '\u0000' + r[3]); }
    if (settings.migrated) st.migratedFrom = settings.migrated;
    if (settings.last_backup_at) st.lastBackupAt = settings.last_backup_at.at || null;
    st.ready = true;
    return { settings, hist, pay: { orders, licenses }, users, ownerKeys };
  }

  // ---------- estatísticas diárias, limpeza e contagens ----------
  async function refreshDailyStats(full = false) {
    const since = full ? new Date(0) : new Date(Date.now() - 86400000); since.setUTCHours(0, 0, 0, 0);   // full: todos os dias (após a migração)
    await q(`INSERT INTO daily_stats (day, uid, type, status, n, net_profit, updated_at)
             SELECT (at AT TIME ZONE 'UTC')::date, uid, COALESCE(type,'taker'), COALESCE(status,''), count(*), COALESCE(sum(net_profit),0), now()
             FROM trades WHERE at >= $1 GROUP BY 1,2,3,4
             ON CONFLICT (day, uid, type, status) DO UPDATE SET n=EXCLUDED.n, net_profit=EXCLUDED.net_profit, updated_at=now()`, [since.toISOString()]);
    st.lastStatsAt = new Date().toISOString();
  }
  async function dailyStats(days = 30, uid = '') {
    const r = await q(`SELECT to_char(day,'YYYY-MM-DD') AS day, type, status, n, net_profit FROM daily_stats WHERE uid=$1 AND day >= (now() AT TIME ZONE 'UTC')::date - $2::int ORDER BY day DESC, type, status`, [uid, days]);
    return r.rows.map(x => ({ day: x.day, type: x.type, status: x.status, n: Number(x.n), netProfit: Number(x.net_profit) }));
  }
  async function prune(keepDays) {
    if (!(keepDays > 0)) return 0;
    const r = await q(`DELETE FROM trades WHERE at < now() - ($1::int * interval '1 day')`, [Math.round(keepDays)]);
    return r.rowCount || 0;
  }
  async function counts() {
    const r = await q(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM api_keys) k, (SELECT count(*) FROM trades) t, (SELECT count(*) FROM payments) p, (SELECT count(*) FROM licenses) l, (SELECT count(*) FROM settings) s, (SELECT count(*) FROM daily_stats) d`);
    const x = r.rows[0];
    return { users: +x.u, api_keys: +x.k, trades: +x.t, payments: +x.p, licenses: +x.l, settings: +x.s, daily_stats: +x.d };
  }
  async function allDailyStats() {
    return (await q(`SELECT to_char(day,'YYYY-MM-DD') AS day, uid, type, status, n, net_profit FROM daily_stats ORDER BY day DESC LIMIT 20000`)).rows
      .map(x => ({ day: x.day, uid: x.uid, type: x.type, status: x.status, n: Number(x.n), netProfit: Number(x.net_profit) }));
  }
  async function ping() { const t = Date.now(); await q('SELECT 1'); return Date.now() - t; }
  function status() {
    return { ready: st.ready, ok: st.ok, lastOk: st.lastOk, lastError: st.lastError, lastFlushAt: st.lastFlushAt, flushes: st.flushes, writes: st.writes,
      pending: { trades: tradeQ.length, settings: settingQ.size, keys: keyQ.size }, pool: { max: 3, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      migratedFrom: st.migratedFrom, lastBackupAt: st.lastBackupAt, lastBackupError: st.lastBackupError, lastStatsAt: st.lastStatsAt };
  }
  async function close() { clearTimeout(flushTimer); flushTimer = null; await flush().catch(() => {}); await pool.end(); }

  return { init, isEmpty, importLegacy, loadAll, queueTrade, setSetting, putKey, delKey, setProviders, flush, refreshDailyStats, dailyStats, allDailyStats, prune, counts, ping, status, state: st, close, tradeKey };
}

module.exports = { createPgStore, tradeKey, cleanUrl };

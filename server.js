require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();

// Убедимся, что папка data существует
fs.mkdirSync('./data', { recursive: true });
const db = new Database('./data/market.db');
// Настройки
const ADMIN_ID = process.env.ADMIN_DISCORD_ID;
const STARTING_DIAMONDS = parseInt(process.env.STARTING_DIAMONDS) || 0;
const DRIFT_INTERVAL_MS = 5000;
const DRIFT_FACTOR = 0.0008;            // усиленное случайное колебание (±0.08% за тик)
const PRICE_LOW = 3;
const PRICE_HIGH = 5;
const RETURN_STRENGTH = 0.005;
const MARKET_OPEN_HOUR = 7;
const MARKET_CLOSE_HOUR = 19;
const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY || 'default_change_me';

// === База данных ===
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT,
    avatar TEXT,
    diamond_balance REAL DEFAULT 0,
    share_balance REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pool (
    id INTEGER PRIMARY KEY CHECK(id=1),
    diamonds REAL,
    shares REAL
  );
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT,
    impact REAL,
    applied INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT,
    expired INTEGER
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price REAL NOT NULL,
    timestamp INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );
  CREATE TABLE IF NOT EXISTS pending_balances (
    discord_id TEXT PRIMARY KEY,
    diamond_balance REAL DEFAULT 0,
    share_balance REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    remaining_percent REAL,
    step_per_tick REAL,
    ticks_left INTEGER
  );
`);

// Миграция для старых баз
const newsCols = db.prepare("PRAGMA table_info('news')").all().map(c => c.name);
if (!newsCols.includes('applied')) {
  db.exec('ALTER TABLE news ADD COLUMN applied INTEGER DEFAULT 0');
}

// Хранилище сессий
class SQLiteStore extends session.Store {
  get(sid, cb) {
    const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
    cb(null, row ? JSON.parse(row.sess) : null);
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie.maxAge || 86400000;
    const expired = Date.now() + maxAge;
    db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expired);
    cb(null);
  }
  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb(null);
  }
}

// Настройки
const getSetting = (key, defaultValue) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
};
const setSetting = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};

if (!getSetting('market_open', null)) setSetting('market_open', 'false');
if (!getSetting('last_price', null)) setSetting('last_price', '0');

// Инициализация пула (цена ~4 алмаза)
const poolRow = db.prepare('SELECT * FROM pool WHERE id=1').get();
if (!poolRow) {
  db.prepare('INSERT OR IGNORE INTO users(discord_id, username, avatar, diamond_balance, share_balance) VALUES (?, ?, ?, ?, ?)').run(ADMIN_ID, 'Admin', '', 2000000, 1000000);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance - 1000000, share_balance = share_balance - 250000 WHERE discord_id = ?').run(ADMIN_ID);
  db.prepare('INSERT INTO pool (id, diamonds, shares) VALUES (1, 1000000, 250000)').run();
}

// Passport
passport.serializeUser((user, done) => done(null, user.discord_id));
passport.deserializeUser((id, done) => {
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
  done(null, user);
});

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify']
  },
  (accessToken, refreshToken, profile, done) => {
    const { id, username, avatar } = profile;
    let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
    if (!user) {
      const pending = db.prepare('SELECT * FROM pending_balances WHERE discord_id = ?').get(id);
      let extraDiamonds = 0, extraShares = 0;
      if (pending) {
        extraDiamonds = pending.diamond_balance || 0;
        extraShares = pending.share_balance || 0;
        db.prepare('DELETE FROM pending_balances WHERE discord_id = ?').run(id);
      }
      db.prepare('INSERT INTO users(discord_id, username, avatar, diamond_balance, share_balance) VALUES (?, ?, ?, ?, ?)').run(id, username, avatar, STARTING_DIAMONDS + extraDiamonds, extraShares);
      user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
    } else {
      db.prepare('UPDATE users SET username = ?, avatar = ? WHERE discord_id = ?').run(username, avatar, id);
      user.username = username;
      user.avatar = avatar;
    }
    return done(null, user);
  }
));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth/discord');
}

function isMarketOpen() {
  return getSetting('market_open', 'false') === 'true';
}

function getCurrentPrice() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  return pool.diamonds / pool.shares;
}

function recordPrice() {
  const price = getCurrentPrice();
  setSetting('last_price', price.toString());
  db.prepare('INSERT INTO price_history (price) VALUES (?)').run(price);
}

function applyNewsImpact(impact) {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + impact / 100);
  recordPrice();

  const correction = -impact * (0.3 + Math.random() * 0.5);
  if (Math.abs(correction) > 0.1) {
    const totalTicks = 360;
    const stepPerTick = correction / totalTicks;
    db.prepare('INSERT INTO corrections (remaining_percent, step_per_tick, ticks_left) VALUES (?, ?, ?)').run(correction, stepPerTick, totalTicks);
  }
}

function processPendingNews() {
  const pendingNews = db.prepare('SELECT * FROM news WHERE applied = 0').all();
  for (const news of pendingNews) {
    db.prepare('UPDATE news SET applied = 1 WHERE id = ?').run(news.id);
    applyNewsImpact(news.impact);
  }
}

function applyCorrections() {
  const corrections = db.prepare('SELECT * FROM corrections').all();
  for (const corr of corrections) {
    const remaining = corr.remaining_percent - corr.step_per_tick;
    const ticksLeft = corr.ticks_left - 1;
    if (ticksLeft <= 0) {
      db.prepare('DELETE FROM corrections WHERE id = ?').run(corr.id);
      db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + corr.remaining_percent / 100);
    } else {
      db.prepare('UPDATE corrections SET remaining_percent = ?, ticks_left = ? WHERE id = ?').run(remaining, ticksLeft, corr.id);
      db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + corr.step_per_tick / 100);
    }
    recordPrice();
  }
}

function applyMeanReversion() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const price = pool.diamonds / pool.shares;
  if (price < PRICE_LOW) {
    const deviation = PRICE_LOW - price;
    const factor = Math.min(deviation * 0.005, 0.01);
    db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + factor);
  } else if (price > PRICE_HIGH) {
    const deviation = price - PRICE_HIGH;
    const factor = Math.min(deviation * 0.005, 0.01);
    db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 - factor);
  }
  recordPrice();
}

function applyDrift() {
  if (!isMarketOpen()) return;
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const drift = (Math.random() - 0.5) * 2 * DRIFT_FACTOR;
  const newDiamonds = pool.diamonds * (1 + drift);
  if (newDiamonds > 0) {
    db.prepare('UPDATE pool SET diamonds = ? WHERE id=1').run(newDiamonds);
  }
  recordPrice();
  applyMeanReversion();
  applyCorrections();
}

function checkSchedule() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const gmt3 = new Date(utc + (3 * 3600000));
  const hours = gmt3.getHours();
  const minutes = gmt3.getMinutes();
  if (hours === MARKET_OPEN_HOUR && minutes === 0 && !isMarketOpen()) {
    setSetting('market_open', 'true');
    processPendingNews();
    console.log('Рынок открыт автоматически (7:00 GMT+3)');
  } else if (hours === MARKET_CLOSE_HOUR && minutes === 0 && isMarketOpen()) {
    setSetting('market_open', 'false');
    console.log('Рынок закрыт автоматически (19:00 GMT+3)');
  }
}

setInterval(applyDrift, DRIFT_INTERVAL_MS);
setInterval(checkSchedule, 30000);

// Маршруты
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.get('/', ensureAuth, (req, res) => {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const price = getCurrentPrice();
  const lastPrice = parseFloat(getSetting('last_price', price.toString()));
  const priceChange = price - lastPrice;
  const user = req.user;
  const news = db.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 10').all();
  const totalShares = pool.shares + db.prepare('SELECT COALESCE(SUM(share_balance),0) as total FROM users').get().total;
  const majorShareholders = db.prepare('SELECT username, share_balance FROM users WHERE share_balance > 0 AND share_balance / ? > 0.01 ORDER BY share_balance DESC').all(totalShares);
  const marketOpen = isMarketOpen();

  res.render('index', {
    user, price: price.toFixed(4), lastPrice: lastPrice.toFixed(4), priceChange,
    pool, news, majorShareholders,
    isAdmin: user.discord_id === ADMIN_ID, marketOpen
  });
});

app.post('/buy', ensureAuth, (req, res) => {
  if (!isMarketOpen()) return res.send('Рынок закрыт.');
  const sharesToBuy = parseFloat(req.body.shares);
  if (isNaN(sharesToBuy) || sharesToBuy <= 0) return res.redirect('/');
  const user = req.user;
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  if (sharesToBuy >= pool.shares) return res.send('Недостаточно акций в пуле.');
  const cost = (pool.diamonds * sharesToBuy) / (pool.shares - sharesToBuy);
  if (user.diamond_balance < cost) return res.send('Недостаточно алмазов.');
  db.prepare('UPDATE pool SET diamonds = diamonds + ?, shares = shares - ? WHERE id=1').run(cost, sharesToBuy);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance - ?, share_balance = share_balance + ? WHERE discord_id = ?').run(cost, sharesToBuy, user.discord_id);
  recordPrice();
  res.redirect('/');
});

app.post('/sell', ensureAuth, (req, res) => {
  if (!isMarketOpen()) return res.send('Рынок закрыт.');
  const sharesToSell = parseFloat(req.body.shares);
  if (isNaN(sharesToSell) || sharesToSell <= 0) return res.redirect('/');
  const user = req.user;
  if (user.share_balance < sharesToSell) return res.send('Недостаточно акций.');
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const revenue = (pool.diamonds * sharesToSell) / (pool.shares + sharesToSell);
  if (revenue > pool.diamonds) return res.send('В пуле недостаточно алмазов.');
  db.prepare('UPDATE pool SET diamonds = diamonds - ?, shares = shares + ? WHERE id=1').run(revenue, sharesToSell);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance + ?, share_balance = share_balance - ? WHERE discord_id = ?').run(revenue, sharesToSell, user.discord_id);
  recordPrice();
  res.redirect('/');
});

app.get('/admin', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).send('Доступ запрещён');
  const users = db.prepare('SELECT * FROM users ORDER BY diamond_balance DESC').all();
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const news = db.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 20').all();
  const pending = db.prepare('SELECT * FROM pending_balances').all();
  const marketOpen = isMarketOpen();
  res.render('admin', { users, pool, news, pending, marketOpen, isAdmin: true });
});

app.post('/admin/market', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const action = req.body.action;
  if (action === 'open') {
    setSetting('market_open', 'true');
    processPendingNews();
  } else if (action === 'close') {
    setSetting('market_open', 'false');
  }
  res.redirect('/admin');
});

app.post('/admin/reset', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { code } = req.body;
  if (code !== 'RESET_THE_ZONE') return res.send('Неверное кодовое слово.');
  db.exec(`
    DELETE FROM users WHERE discord_id != '${ADMIN_ID}';
    DELETE FROM pool;
    DELETE FROM news;
    DELETE FROM price_history;
    DELETE FROM pending_balances;
    DELETE FROM sessions;
    DELETE FROM corrections;
    UPDATE users SET diamond_balance = 2000000, share_balance = 1000000 WHERE discord_id = '${ADMIN_ID}';
  `);
  db.prepare('INSERT INTO pool (id, diamonds, shares) VALUES (1, 1000000, 250000)').run();
  setSetting('market_open', 'false');
  setSetting('last_price', '0');
  res.redirect('/admin');
});

app.post('/admin/news', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { title, body, impact } = req.body;
  const impactNum = parseFloat(impact);
  if (!title || isNaN(impactNum)) return res.redirect('/admin');
  const applied = isMarketOpen() ? 1 : 0;
  db.prepare('INSERT INTO news (title, body, impact, applied) VALUES (?, ?, ?, ?)').run(title, body, impactNum, applied);
  if (applied) applyNewsImpact(impactNum);
  res.redirect('/admin');
});

app.post('/admin/transfer', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { from, to, type, amount } = req.body;
  const amt = parseFloat(amount);
  if (!from || !to || isNaN(amt) || amt <= 0) return res.redirect('/admin');
  const fromUser = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(from);
  const toUser = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(to);
  if (!fromUser || !toUser) return res.send('Один из пользователей не найден.');
  if (type === 'diamonds') {
    if (fromUser.diamond_balance < amt) return res.send('Недостаточно алмазов.');
    db.prepare('UPDATE users SET diamond_balance = diamond_balance - ? WHERE discord_id = ?').run(amt, from);
    db.prepare('UPDATE users SET diamond_balance = diamond_balance + ? WHERE discord_id = ?').run(amt, to);
  } else if (type === 'shares') {
    if (fromUser.share_balance < amt) return res.send('Недостаточно акций.');
    db.prepare('UPDATE users SET share_balance = share_balance - ? WHERE discord_id = ?').run(amt, from);
    db.prepare('UPDATE users SET share_balance = share_balance + ? WHERE discord_id = ?').run(amt, to);
  }
  res.redirect('/admin');
});

app.post('/admin/setbalance', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { discord_id, field, value } = req.body;
  const val = parseFloat(value);
  if (!discord_id || isNaN(val)) return res.redirect('/admin');
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
  if (!user) return res.send('Пользователь не найден.');
  if (field === 'diamonds') db.prepare('UPDATE users SET diamond_balance = ? WHERE discord_id = ?').run(val, discord_id);
  else if (field === 'shares') db.prepare('UPDATE users SET share_balance = ? WHERE discord_id = ?').run(val, discord_id);
  res.redirect('/admin');
});

app.post('/admin/pending', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { discord_id, type, amount } = req.body;
  const amt = parseFloat(amount);
  if (!discord_id || isNaN(amt) || amt <= 0) return res.redirect('/admin');
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
  if (user) {
    if (type === 'diamonds') db.prepare('UPDATE users SET diamond_balance = diamond_balance + ? WHERE discord_id = ?').run(amt, discord_id);
    else if (type === 'shares') db.prepare('UPDATE users SET share_balance = share_balance + ? WHERE discord_id = ?').run(amt, discord_id);
  } else {
    const pending = db.prepare('SELECT * FROM pending_balances WHERE discord_id = ?').get(discord_id);
    if (pending) {
      if (type === 'diamonds') db.prepare('UPDATE pending_balances SET diamond_balance = diamond_balance + ? WHERE discord_id = ?').run(amt, discord_id);
      else if (type === 'shares') db.prepare('UPDATE pending_balances SET share_balance = share_balance + ? WHERE discord_id = ?').run(amt, discord_id);
    } else {
      const initDiamonds = type === 'diamonds' ? amt : 0;
      const initShares = type === 'shares' ? amt : 0;
      db.prepare('INSERT INTO pending_balances (discord_id, diamond_balance, share_balance) VALUES (?, ?, ?)').run(discord_id, initDiamonds, initShares);
    }
  }
  res.redirect('/admin');
});

app.post('/admin/pool', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { diamonds, shares } = req.body;
  const d = parseFloat(diamonds), s = parseFloat(shares);
  if (isNaN(d) || isNaN(s) || d <= 0 || s <= 0) return res.redirect('/admin');
  db.prepare('UPDATE pool SET diamonds = ?, shares = ? WHERE id=1').run(d, s);
  recordPrice();
  res.redirect('/admin');
});

app.post('/api/bot/news', (req, res) => {
  const { secret, title, body, impact } = req.body;
  if (secret !== BOT_SECRET_KEY) return res.status(403).json({ error: 'Invalid secret' });
  const impactNum = parseFloat(impact);
  if (!title || isNaN(impactNum)) return res.status(400).json({ error: 'Missing fields' });
  const applied = isMarketOpen() ? 1 : 0;
  db.prepare('INSERT INTO news (title, body, impact, applied) VALUES (?, ?, ?, ?)').run(title, body, impactNum, applied);
  if (applied) applyNewsImpact(impactNum);
  res.json({ success: true });
});

app.get('/api/price-history', ensureAuth, (req, res) => {
  const { interval, type } = req.query;
  if (!interval || !type) return res.status(400).json({ error: 'interval and type required' });
  const now = Math.floor(Date.now() / 1000);
  let since;
  const candleIntervals = ['5m','15m','30m','1h','4h','12h','1d'];
  const lineIntervals = ['1h','4h','12h','1d','1w','1M','1y','all'];

  if (type === 'candle') {
    if (!candleIntervals.includes(interval)) return res.status(400).json({ error: 'Invalid candle interval' });
    const periodMap = { '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '12h':43200, '1d':86400 };
    const periodSec = periodMap[interval];
    since = now - periodSec * 200;
    if (since < 0) since = 0;
    const rows = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(since);
    const candles = [];
    let currentCandle = null;
    for (const row of rows) {
      const bucket = row.timestamp - (row.timestamp % periodSec);
      if (!currentCandle || currentCandle.time !== bucket) {
        if (currentCandle) candles.push(currentCandle);
        currentCandle = { time: bucket, open: row.price, high: row.price, low: row.price, close: row.price };
      } else {
        if (row.price > currentCandle.high) currentCandle.high = row.price;
        if (row.price < currentCandle.low) currentCandle.low = row.price;
        currentCandle.close = row.price;
      }
    }
    if (currentCandle) candles.push(currentCandle);
    return res.json({ type: 'candle', data: candles });
  }
  else if (type === 'line') {
    if (!lineIntervals.includes(interval)) return res.status(400).json({ error: 'Invalid line interval' });
    switch (interval) {
      case '1h': since = now - 3600; break;
      case '4h': since = now - 14400; break;
      case '12h': since = now - 43200; break;
      case '1d': since = now - 86400; break;
      case '1w': since = now - 604800; break;
      case '1M': since = now - 2592000; break;
      case '1y': since = now - 31536000; break;
      case 'all': since = 0; break;
      default: since = now - 86400;
    }
    let rows = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(since);
    if (rows.length > 1500) {
      const step = Math.floor(rows.length / 1500);
      rows = rows.filter((_, i) => i % step === 0);
    }
    const data = rows.map(r => ({ time: r.timestamp, value: r.price }));
    return res.json({ type: 'line', data });
  }
  return res.status(400).json({ error: 'Invalid type' });
});

app.get('/shareholders', ensureAuth, (req, res) => {
  const pool = db.prepare('SELECT shares FROM pool WHERE id=1').get();
  const totalShares = pool.shares + db.prepare('SELECT COALESCE(SUM(share_balance),0) as total FROM users').get().total;
  const shareholders = db.prepare('SELECT username, share_balance FROM users WHERE share_balance > 0 AND share_balance / ? > 0.01 ORDER BY share_balance DESC').all(totalShares);
  res.render('shareholders', { shareholders, totalShares, isAdmin: req.user.discord_id === ADMIN_ID });
});

app.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));

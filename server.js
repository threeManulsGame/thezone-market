require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('market.db');

// Настройки
const ADMIN_ID = process.env.ADMIN_DISCORD_ID;
const STARTING_DIAMONDS = parseInt(process.env.STARTING_DIAMONDS) || 1000;
const DRIFT_INTERVAL_MS = 5000;
const DRIFT_FACTOR = 0.0005;

// === База данных: создание таблиц ===
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
`);

// Кастомное хранилище сессий
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

// Инициализация пула и админа при первом запуске
const poolRow = db.prepare('SELECT * FROM pool WHERE id=1').get();
if (!poolRow) {
  const insertUser = db.prepare('INSERT OR IGNORE INTO users(discord_id, username, avatar, diamond_balance, share_balance) VALUES (?, ?, ?, ?, ?)');
  insertUser.run(ADMIN_ID, 'Admin', '', 2000000, 1000000);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance - 1000000, share_balance = share_balance - 1000000 WHERE discord_id = ?').run(ADMIN_ID);
  db.prepare('INSERT INTO pool (id, diamonds, shares) VALUES (1, 1000000, 1000000)').run();
}

// Passport настройки
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
      db.prepare('INSERT INTO users(discord_id, username, avatar, diamond_balance, share_balance) VALUES (?, ?, ?, ?, ?)').run(id, username, avatar, STARTING_DIAMONDS, 0);
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

// === Маршруты ===
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Главная страница
app.get('/', ensureAuth, (req, res) => {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const price = pool.diamonds / pool.shares;
  const user = req.user;
  const news = db.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 10').all();

  const totalShares = pool.shares + db.prepare('SELECT COALESCE(SUM(share_balance),0) as total FROM users').get().total;
  const majorShareholders = db.prepare('SELECT username, share_balance FROM users WHERE share_balance > 0 AND share_balance / ? > 0.01 ORDER BY share_balance DESC').all(totalShares);

  res.render('index', {
    user,
    price: price.toFixed(4),
    pool,
    news,
    majorShareholders,
    isAdmin: user.discord_id === ADMIN_ID
  });
});

// Покупка акций
app.post('/buy', ensureAuth, (req, res) => {
  const sharesToBuy = parseFloat(req.body.shares);
  if (isNaN(sharesToBuy) || sharesToBuy <= 0) return res.redirect('/');

  const user = req.user;
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  if (sharesToBuy >= pool.shares) return res.send('Недостаточно акций в пуле.');

  const x = pool.diamonds, y = pool.shares;
  const cost = (x * sharesToBuy) / (y - sharesToBuy);
  if (user.diamond_balance < cost) return res.send('Недостаточно алмазов.');

  db.prepare('UPDATE pool SET diamonds = diamonds + ?, shares = shares - ? WHERE id=1').run(cost, sharesToBuy);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance - ?, share_balance = share_balance + ? WHERE discord_id = ?').run(cost, sharesToBuy, user.discord_id);
  recordPrice();
  res.redirect('/');
});

// Продажа акций
app.post('/sell', ensureAuth, (req, res) => {
  const sharesToSell = parseFloat(req.body.shares);
  if (isNaN(sharesToSell) || sharesToSell <= 0) return res.redirect('/');

  const user = req.user;
  if (user.share_balance < sharesToSell) return res.send('Недостаточно акций.');

  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const x = pool.diamonds, y = pool.shares;
  const revenue = (x * sharesToSell) / (y + sharesToSell);
  if (revenue > pool.diamonds) return res.send('В пуле недостаточно алмазов для выкупа.');

  db.prepare('UPDATE pool SET diamonds = diamonds - ?, shares = shares + ? WHERE id=1').run(revenue, sharesToSell);
  db.prepare('UPDATE users SET diamond_balance = diamond_balance + ?, share_balance = share_balance - ? WHERE discord_id = ?').run(revenue, sharesToSell, user.discord_id);
  recordPrice();
  res.redirect('/');
});

// Админ-панель
app.get('/admin', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).send('Доступ запрещён');
  const users = db.prepare('SELECT * FROM users ORDER BY diamond_balance DESC').all();
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  res.render('admin', { users, pool, news: db.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 20').all() });
});

// Добавление новости
app.post('/admin/news', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { title, body, impact } = req.body;
  const impactNum = parseFloat(impact);
  if (!title || isNaN(impactNum)) return res.redirect('/admin');

  db.prepare('INSERT INTO news (title, body, impact) VALUES (?, ?, ?)').run(title, body, impactNum);
  db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + impactNum / 100);
  recordPrice();
  res.redirect('/admin');
});

// Перевод алмазов/акций
app.post('/admin/transfer', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { from, to, type, amount } = req.body;
  const amt = parseFloat(amount);
  if (!from || !to || isNaN(amt) || amt <= 0) return res.redirect('/admin');

  const fromUser = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(from);
  const toUser = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(to);
  if (!fromUser || !toUser) return res.send('Пользователь не найден');

  if (type === 'diamonds') {
    if (fromUser.diamond_balance < amt) return res.send('Недостаточно алмазов у отправителя');
    db.prepare('UPDATE users SET diamond_balance = diamond_balance - ? WHERE discord_id = ?').run(amt, from);
    db.prepare('UPDATE users SET diamond_balance = diamond_balance + ? WHERE discord_id = ?').run(amt, to);
  } else if (type === 'shares') {
    if (fromUser.share_balance < amt) return res.send('Недостаточно акций у отправителя');
    db.prepare('UPDATE users SET share_balance = share_balance - ? WHERE discord_id = ?').run(amt, from);
    db.prepare('UPDATE users SET share_balance = share_balance + ? WHERE discord_id = ?').run(amt, to);
  }
  res.redirect('/admin');
});

// Прямое изменение баланса
app.post('/admin/setbalance', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { discord_id, field, value } = req.body;
  const val = parseFloat(value);
  if (!discord_id || isNaN(val)) return res.redirect('/admin');
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
  if (!user) return res.send('Пользователь не найден');
  if (field === 'diamonds') db.prepare('UPDATE users SET diamond_balance = ? WHERE discord_id = ?').run(val, discord_id);
  else if (field === 'shares') db.prepare('UPDATE users SET share_balance = ? WHERE discord_id = ?').run(val, discord_id);
  res.redirect('/admin');
});

// Ручное управление пулом
app.post('/admin/pool', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { diamonds, shares } = req.body;
  const d = parseFloat(diamonds), s = parseFloat(shares);
  if (isNaN(d) || isNaN(s) || d <= 0 || s <= 0) return res.redirect('/admin');
  db.prepare('UPDATE pool SET diamonds = ?, shares = ? WHERE id=1').run(d, s);
  recordPrice();
  res.redirect('/admin');
});

// Список акционеров >1%
app.get('/shareholders', ensureAuth, (req, res) => {
  const pool = db.prepare('SELECT shares FROM pool WHERE id=1').get();
  const totalShares = pool.shares + db.prepare('SELECT COALESCE(SUM(share_balance),0) as total FROM users').get().total;
  const shareholders = db.prepare('SELECT username, share_balance FROM users WHERE share_balance > 0 AND share_balance / ? > 0.01 ORDER BY share_balance DESC').all(totalShares);
  res.render('shareholders', { shareholders, totalShares, isAdmin: req.user.discord_id === ADMIN_ID });
});

// === API для графика ===
app.get('/api/price-history', ensureAuth, (req, res) => {
  const { interval, type } = req.query; // interval: 5m,15m,30m,1h,4h,12h,1d / 1h,4h,12h,1d,1w,1M,1y,all
  if (!interval || !type) return res.status(400).json({ error: 'interval and type required' });

  const now = Math.floor(Date.now() / 1000);
  let since;
  const candleIntervals = ['5m','15m','30m','1h','4h','12h','1d'];
  const lineIntervals = ['1h','4h','12h','1d','1w','1M','1y','all'];

  if (type === 'candle') {
    if (!candleIntervals.includes(interval)) return res.status(400).json({ error: 'Invalid candle interval' });
    // Определяем период в секундах
    const periodMap = { '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '12h':43200, '1d':86400 };
    const periodSec = periodMap[interval];
    // Берём данные за последние 200 свечей
    since = now - periodSec * 200;
    if (since < 0) since = 0;
    const rows = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(since);
    // Группируем в свечи
    const candles = [];
    let currentCandle = null;
    for (const row of rows) {
      const bucket = row.timestamp - (row.timestamp % periodSec);
      if (!currentCandle || currentCandle.time !== bucket) {
        if (currentCandle) candles.push(currentCandle);
        currentCandle = {
          time: bucket,
          open: row.price,
          high: row.price,
          low: row.price,
          close: row.price
        };
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
    let since;
    const nowDate = new Date();
    switch (interval) {
      case '1h': since = Math.floor(Date.now()/1000) - 3600; break;
      case '4h': since = Math.floor(Date.now()/1000) - 14400; break;
      case '12h': since = Math.floor(Date.now()/1000) - 43200; break;
      case '1d': since = Math.floor(Date.now()/1000) - 86400; break;
      case '1w': since = Math.floor(Date.now()/1000) - 604800; break;
      case '1M': since = Math.floor(Date.now()/1000) - 2592000; break; // ~30 дней
      case '1y': since = Math.floor(Date.now()/1000) - 31536000; break; // 365 дней
      case 'all': since = 0; break;
      default: since = Math.floor(Date.now()/1000) - 86400;
    }
    let rows = db.prepare('SELECT price, timestamp FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(since);
    if (rows.length === 0) return res.json({ type: 'line', data: [] });

    // Если точек > 1500, прореживаем
    if (rows.length > 1500) {
      const step = Math.floor(rows.length / 1500);
      rows = rows.filter((_, i) => i % step === 0);
    }
    const data = rows.map(r => ({ time: r.timestamp, value: r.price }));
    return res.json({ type: 'line', data });
  } else {
    return res.status(400).json({ error: 'Invalid type' });
  }
});

// === Вспомогательные функции ===
function recordPrice() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const price = pool.diamonds / pool.shares;
  db.prepare('INSERT INTO price_history (price) VALUES (?)').run(price);
}

function applyDrift() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const drift = (Math.random() - 0.5) * 2 * DRIFT_FACTOR;
  const newDiamonds = pool.diamonds * (1 + drift);
  if (newDiamonds > 0) {
    db.prepare('UPDATE pool SET diamonds = ? WHERE id=1').run(newDiamonds);
    recordPrice();
  }
}
setInterval(applyDrift, DRIFT_INTERVAL_MS);

app.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));

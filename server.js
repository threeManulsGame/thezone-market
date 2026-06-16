require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const db = new Database('market.db');

// Настройки
const ADMIN_ID = process.env.ADMIN_DISCORD_ID;
const STARTING_DIAMONDS = parseInt(process.env.STARTING_DIAMONDS) || 1000;
const DRIFT_INTERVAL_MS = 5000;
const DRIFT_FACTOR = 0.0002; // ослабленный дрейф
const PRICE_LOW = 3;
const PRICE_HIGH = 5;
const RETURN_STRENGTH = 0.001; // сила притяжения при выходе за границы
const MARKET_OPEN_HOUR = 7;  // GMT+3
const MARKET_CLOSE_HOUR = 19; // GMT+3
const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY || 'default_change_me';

// === БД ===
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
  CREATE TABLE IF NOT EXISTS pending_balances (
    discord_id TEXT PRIMARY KEY,
    diamond_balance REAL DEFAULT 0,
    share_balance REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Инициализация настроек
const getSetting = (key, defaultValue) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
};
const setSetting = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};

// Установка начальных значений при первом запуске
if (!db.prepare('SELECT * FROM settings WHERE key = ?').get('market_open')) {
  setSetting('market_open', 'false'); // изначально закрыта
}
if (!db.prepare('SELECT * FROM settings WHERE key = ?').get('last_price')) {
  setSetting('last_price', '0');
}

// Создание пула с ценой 4 алмаза, если его нет
const poolRow = db.prepare('SELECT * FROM pool WHERE id=1').get();
if (!poolRow) {
  // 250k акций и 1M алмазов => цена 4
  db.prepare('INSERT OR IGNORE INTO users(discord_id, username, avatar, diamond_balance, share_balance) VALUES (?, ?, ?, ?, ?)').run(ADMIN_ID, 'Admin', '', 2000000, 1000000);
  // Перемещаем в пул
  db.prepare('UPDATE users SET diamond_balance = diamond_balance - 1000000, share_balance = share_balance - 250000 WHERE discord_id = ?').run(ADMIN_ID);
  db.prepare('INSERT INTO pool (id, diamonds, shares) VALUES (1, 1000000, 250000)').run();
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

// Получить цену
function getCurrentPrice() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  return pool.diamonds / pool.shares;
}

// Авторизация
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// Главная
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
    user,
    price: price.toFixed(4),
    lastPrice: lastPrice.toFixed(4),
    priceChange,
    pool,
    news,
    majorShareholders,
    isAdmin: user.discord_id === ADMIN_ID,
    marketOpen
  });
});

// Покупка (только когда рынок открыт)
app.post('/buy', ensureAuth, (req, res) => {
  if (!isMarketOpen()) return res.send('Рынок сейчас закрыт.');
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

// Продажа
app.post('/sell', ensureAuth, (req, res) => {
  if (!isMarketOpen()) return res.send('Рынок сейчас закрыт.');
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

// Админка
app.get('/admin', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).send('Доступ запрещён');
  const users = db.prepare('SELECT * FROM users ORDER BY diamond_balance DESC').all();
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const news = db.prepare('SELECT * FROM news ORDER BY created_at DESC LIMIT 20').all();
  const pending = db.prepare('SELECT * FROM pending_balances').all();
  const marketOpen = isMarketOpen();
  res.render('admin', { users, pool, news, pending, marketOpen, isAdmin: true });
});

// Управление рынком (открыть/закрыть)
app.post('/admin/market', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const action = req.body.action;
  if (action === 'open') setSetting('market_open', 'true');
  else if (action === 'close') setSetting('market_open', 'false');
  res.redirect('/admin');
});

// Полный сброс с кодовым словом
app.post('/admin/reset', ensureAuth, (req, res) => {
  if (req.user.discord_id !== ADMIN_ID) return res.status(403).end();
  const { code } = req.body;
  if (code !== 'RESET_THE_ZONE') return res.send('Неверное кодовое слово.');
  // Полная очистка
  db.exec(`
    DELETE FROM users WHERE discord_id != ?;
    DELETE FROM pool;
    DELETE FROM news;
    DELETE FROM price_history;
    DELETE FROM pending_balances;
    DELETE FROM sessions;
    UPDATE users SET diamond_balance = 2000000, share_balance = 1000000 WHERE discord_id = ?;
  `);
  // Восстановить пул
  db.prepare('INSERT INTO pool (id, diamonds, shares) VALUES (1, 1000000, 250000)').run();
  // Сбросить настройки
  setSetting('market_open', 'false');
  setSetting('last_price', '0');
  res.redirect('/admin');
});

// Добавление новости (админ)
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

// Остальные маршруты (transfer, setbalance, pending, pool) – без изменений, только проверка isMarketOpen для transfer? Но transfer и setbalance админские, их оставим без ограничений.
app.post('/admin/transfer', ensureAuth, (req, res) => { /* ... код как раньше ... */ });
app.post('/admin/setbalance', ensureAuth, (req, res) => { /* ... */ });
app.post('/admin/pending', ensureAuth, (req, res) => { /* ... */ });
app.post('/admin/pool', ensureAuth, (req, res) => { /* ... */ });

// API для бота: добавление новости из Discord
app.post('/api/bot/news', (req, res) => {
  const { secret, title, body, impact } = req.body;
  if (secret !== BOT_SECRET_KEY) return res.status(403).json({ error: 'Invalid secret' });
  const impactNum = parseFloat(impact);
  if (!title || isNaN(impactNum)) return res.status(400).json({ error: 'Missing fields' });
  db.prepare('INSERT INTO news (title, body, impact) VALUES (?, ?, ?)').run(title, body, impactNum);
  db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + impactNum / 100);
  recordPrice();
  res.json({ success: true });
});

// API для графика
app.get('/api/price-history', ensureAuth, (req, res) => { /* как раньше */ });

// API текущего состояния рынка
app.get('/api/market-status', (req, res) => {
  res.json({ open: isMarketOpen(), price: getCurrentPrice() });
});

// Запись цены
function recordPrice() {
  const price = getCurrentPrice();
  setSetting('last_price', price.toString());
  db.prepare('INSERT INTO price_history (price) VALUES (?)').run(price);
}

// Применение притяжения к коридору 3-5
function applyMeanReversion() {
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const price = pool.diamonds / pool.shares;
  if (price < PRICE_LOW) {
    const deviation = PRICE_LOW - price;
    const factor = Math.min(deviation * 0.005, 0.01); // плавно
    db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 + factor);
  } else if (price > PRICE_HIGH) {
    const deviation = price - PRICE_HIGH;
    const factor = Math.min(deviation * 0.005, 0.01);
    db.prepare('UPDATE pool SET diamonds = diamonds * ? WHERE id=1').run(1 - factor);
  }
  recordPrice();
}

// Случайный дрейф
function applyDrift() {
  if (!isMarketOpen()) return; // дрейф только во время работы рынка
  const pool = db.prepare('SELECT * FROM pool WHERE id=1').get();
  const drift = (Math.random() - 0.5) * 2 * DRIFT_FACTOR;
  const newDiamonds = pool.diamonds * (1 + drift);
  if (newDiamonds > 0) {
    db.prepare('UPDATE pool SET diamonds = ? WHERE id=1').run(newDiamonds);
    recordPrice();
    applyMeanReversion();
  }
}
setInterval(applyDrift, DRIFT_INTERVAL_MS);

// Автоматическое открытие/закрытие по расписанию
function checkSchedule() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const gmt3 = new Date(utc + (3 * 3600000));
  const hours = gmt3.getHours();
  const minutes = gmt3.getMinutes();
  // Проверяем каждые 30 секунд, открытие в 7:00, закрытие в 19:00
  if (hours === MARKET_OPEN_HOUR && minutes === 0 && !isMarketOpen()) {
    setSetting('market_open', 'true');
    console.log('Рынок открыт по расписанию');
  } else if (hours === MARKET_CLOSE_HOUR && minutes === 0 && isMarketOpen()) {
    setSetting('market_open', 'false');
    console.log('Рынок закрыт по расписанию');
  }
}
setInterval(checkSchedule, 30000);

app.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));

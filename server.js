// server.js
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;
const URI  = process.env.MONGODB_URI || "";

// ---------------------------------------------------------------------------
// CORS whitelist (radi i za file:// jer origin bude null).
// Ako menjaš frontend domen, samo dodaj u niz.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://uess.onrender.com',       // tvoj frontend (static)
  'https://euroguess.onrender.com'   // sam backend (ok je dozvoliti)
];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // npr. file://, mobilna app, curl
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));
app.options('*', cors());             // preflight
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// === Leaderboard (Top 10) ===
app.get('/leaderboard', async (_req, res) => {
  try {
    const top = await User.find({}, { _id: 0, username: 1, balance: 1 })
      .sort({ balance: -1, username: 1 })
      .limit(10)
      .lean();
    res.json(top);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ---------------------------------------------------------------------------
// Mongo konekcija
// ---------------------------------------------------------------------------
mongoose.connect(URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connect error:", err.message));

mongoose.connection.once("open", async () => {
  try {
    const db  = mongoose.connection.db;
    const cnt = await db.collection("players").countDocuments();
    console.log("Connected DB:", db.databaseName, "players count:", cnt);
  } catch (e) {
    console.error("Count error:", e.message);
  }
});

// ---------------------------------------------------------------------------
// Modeli
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passHash: { type: String, required: true },
  balance:  { type: Number, default: 0 }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function signToken(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }
  return jwt.sign({ uid: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// AUTH (register / login / me / balance)
// ---------------------------------------------------------------------------
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const uname = String(username).toLowerCase().trim();
    const exists = await User.findOne({ username: uname });
    if (exists) return res.status(409).json({ error: 'Username already exists' });

    const passHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username: uname, passHash, balance: 0 });
    const token = signToken(user);

    res.json({ token, user: { username: user.username, balance: user.balance } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Register failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uname = String(username || '').toLowerCase().trim();

    const user = await User.findOne({ username: uname });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.passHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({ token, user: { username: user.username, balance: user.balance } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/me', auth, async (req, res) => {
  const u = await User.findById(req.userId).lean();
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, balance: u.balance });
});

app.post('/me/balance/add', auth, async (req, res) => {
  const { points } = req.body || {};
  const inc = Number(points) || 0;
  if (inc <= 0) return res.status(400).json({ error: 'Bad points' });

  const u = await User.findByIdAndUpdate(
    req.userId,
    { $inc: { balance: inc } },
    { new: true }
  ).lean();

  res.json({ balance: u.balance });
});

// ---------------------------------------------------------------------------
// PLAYERS
// ---------------------------------------------------------------------------
app.get("/players/raw", async (_req, res) => {
  try {
    const col  = mongoose.connection.db.collection("players");
    const docs = await col.find({}).toArray();
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch players (raw)" });
  }
});

app.get("/players", async (req, res) => {
  try {
    const col = mongoose.connection.db.collection("players");
    const q = (req.query.q || "").trim();

    const pipeline = [
      { $addFields: {
          name: { $ifNull: ["$FullNameVerified", { $ifNull: ["$fullNameVerified", { $ifNull: ["$NameVerified", null] }] }] }
        }
      },
      { $match: { GP: { $gte: 10 } } },
    ];

    if (q) {
      const re = new RegExp(`(^|\\s)${esc(q)}`, "i");
      pipeline.push({ $match: { name: { $regex: re } } });
    }

    pipeline.push({
      $project: {
        _id: 0,
        name: 1,
        team:    "$TeamFullName",
        country: "$Country",
        position:"$Position",
        stats: {
          pts:      "$PTS",
          twoPct:   "$2P",
          threePct: "$3P",
          tr:       "$TR",
          ast:      "$AST"
        }
      }
    });

    pipeline.push({ $sort: { name: 1 } });

    const docs = await col.aggregate(pipeline).toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});

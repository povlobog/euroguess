// server.js
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 8080;
const URI  = process.env.MONGODB_URI || "";

// ---------------------------------------------------------------------------
// CORS: dozvoli sve (radi i za file:// tj. Origin: null, i za preflight)
// U produkciji možeš zameniti sa whitelist logikom.
// ---------------------------------------------------------------------------
app.use(cors());
app.options('*', cors());
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

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
// Rute: health
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Rute: AUTH (register/login/me/balance)
// ---------------------------------------------------------------------------

// REGISTER
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const uname = (username || '').toLowerCase().trim();
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

// LOGIN
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uname = (username || '').toLowerCase().trim();

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

// ME
app.get('/me', auth, async (req, res) => {
  const u = await User.findById(req.userId).lean();
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, balance: u.balance });
});

// ADD BALANCE (pozivaš kada korisnik pogodi igrača)
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
// Rute: PLAYERS (tvoja logika za igru)
// ---------------------------------------------------------------------------

// Debug: vrati dokumente kako su u bazi (nemoj koristiti u frontendu)
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

// Produkcijska ruta:
// - GP >= 10
// - opcioni ?q= prefiks (početak bilo koje reči u imenu)
// - vraća samo polja potrebna frontendu i bez _id
app.get("/players", async (req, res) => {
  try {
    const col = mongoose.connection.db.collection("players");
    const q = (req.query.q || "").trim();

    const pipeline = [
      // Koalesciraj ime u polje "name" (pokrivamo varijante naziva u tvojoj bazi)
      {
        $addFields: {
          name: {
            $ifNull: [
              "$FullNameVerified",
              { $ifNull: ["$fullNameVerified", { $ifNull: ["$NameVerified", null] }] }
            ]
          }
        }
      },
      // Minimalno 10 utakmica
      { $match: { GP: { $gte: 10 } } },
    ];

    // Ako je ?q= zadat — prefiks bilo koje reči (case-insensitive)
    if (q) {
      const re = new RegExp(`(^|\\s)${esc(q)}`, "i");
      pipeline.push({ $match: { name: { $regex: re } } });
    }

    // Vrati samo polja koja front koristi, bez _id
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

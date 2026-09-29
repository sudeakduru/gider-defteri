const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const pg = require("pg");
const PgSession = require("connect-pg-simple")(session);
const { importPKCS8, SignJWT, createRemoteJWKSet, jwtVerify } = require("jose");

const { parseMoney } = require("./public/calc.js");

const PORT = Number(process.env.PORT) || 3000;
const PRODUCTION = process.env.NODE_ENV === "production";
const CATEGORIES = ["market", "yemek", "ulasim", "fatura", "eglence", "saglik", "giyim", "kisisel", "diger"];
const FIXED_CATS = ["kira", "fatura", "abonelik", "ulasim", "diger"];

const memory = { users: new Map(), ledgers: new Map() };
let pool = null;

function blankLedger() {
  return { version: 1, salary: 0, extras: [], fixed: [], expenses: [], debts: [] };
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeLedger(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return blankLedger();
  const salaryValue = parseMoney(data.salary ?? 0);
  const salary = Number.isFinite(salaryValue) && salaryValue > 0 ? salaryValue : 0;
  const fixed = (Array.isArray(data.fixed) ? data.fixed : []).map((item) => {
    const amount = parseMoney(item?.amount);
    const name = cleanText(item?.name, 40);
    const category = FIXED_CATS.includes(item?.category) ? item.category : "diger";
    if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
    return { id: cleanText(item.id, 80) || crypto.randomUUID(), name, amount, category };
  }).filter(Boolean);
  const expenses = (Array.isArray(data.expenses) ? data.expenses : []).map((item) => {
    const amount = parseMoney(item?.amount);
    const date = String(item?.date ?? "");
    const category = CATEGORIES.includes(item?.category) ? item.category : "diger";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
    return {
      id: cleanText(item.id, 80) || crypto.randomUUID(),
      date,
      category,
      amount,
      note: cleanText(item?.note, 120),
    };
  }).filter(Boolean);
  const debts = (Array.isArray(data.debts) ? data.debts : []).map((item) => {
    const remaining = parseMoney(item?.remaining);
    const monthlyPayment = item?.monthlyPayment == null || item.monthlyPayment === "" ? 0 : parseMoney(item.monthlyPayment);
    const annualRate = item?.annualRate == null || item.annualRate === "" ? 0 : parseMoney(item.annualRate);
    const name = cleanText(item?.name, 40);
    if (!name || !Number.isFinite(remaining) || remaining <= 0 || remaining > 100000000) return null;
    if (!Number.isFinite(monthlyPayment) || monthlyPayment < 0 || monthlyPayment > 100000000) return null;
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) return null;
    return {
      id: cleanText(item.id, 80) || crypto.randomUUID(),
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
    if (!name || !/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
    return { id: cleanText(item.id, 80) || crypto.randomUUID(), name, amount, month };
  }).filter(Boolean);
  return { version: 1, salary, extras, fixed, expenses, debts };
}

function googleReady() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function appleReady() {
  return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

function devReady() {
  return !PRODUCTION && process.env.ALLOW_DEV_LOGIN === "1";
}

function publicBase(req) {
  const configured = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    if (PRODUCTION) {
      console.error("DATABASE_URL gerekli.");
      process.exit(1);
    }
    console.warn("DATABASE_URL yok. Kayıtlar bu çalıştırma bitince silinir.");
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  const needsSsl = /render\.com|sslmode=require/i.test(connectionString);
  pool = new pg.Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      provider TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ledgers (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveUser(user) {
  if (!pool) {
    memory.users.set(user.id, user);
    return;
  }
  await pool.query(
    `INSERT INTO users (id, email, name, provider)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
    [user.id, user.email || null, user.name || null, user.provider]
  );
}

async function readLedger(userId) {
  if (!pool) return memory.ledgers.get(userId) || blankLedger();
  const result = await pool.query("SELECT data FROM ledgers WHERE user_id = $1", [userId]);
  return result.rows[0] ? normalizeLedger(result.rows[0].data) : blankLedger();
}

async function writeLedger(userId, data) {
  const clean = normalizeLedger(data);
  if (!pool) {
    memory.ledgers.set(userId, clean);
    return clean;
  }
  await pool.query(
    `INSERT INTO ledgers (user_id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, JSON.stringify(clean)]
  );
  return clean;
}

function login(req, res, user) {
  req.session.regenerate(async (error) => {
    if (error) {
      res.redirect("/?auth=failed");
      return;
    }
    try {
      await saveUser(user);
      req.session.user = user;
      req.session.save(() => res.redirect("/"));
    } catch (err) {
      console.error(err);
      res.redirect("/?auth=failed");
    }
  });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireUser(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: "Giriş gerekli" });
    return;
  }
  next();
}

const hits = new Map();
function limitAuth(req, res, next) {
  const now = Date.now();
  const bucket = (hits.get(req.ip) || []).filter((time) => now - time < 10 * 60 * 1000);
  if (bucket.length >= 40) {
    res.status(429).send("Çok fazla deneme. Biraz sonra tekrar dene.");
    return;
  }
  bucket.push(now);
  hits.set(req.ip, bucket);
  next();
}

function rememberState(req) {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  return state;
}

async function appleClientSecret() {
  const privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const key = await importPKCS8(privateKey, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID })
    .setIssuer(process.env.APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime("180d")
    .setAudience("https://appleid.apple.com")
    .setSubject(process.env.APPLE_CLIENT_ID)
    .sign(key);
}

const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function main() {
  if (PRODUCTION && !process.env.SESSION_SECRET) {
    console.error("SESSION_SECRET gerekli.");
    process.exit(1);
  }
  await initDb();

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const sessionOptions = {
    name: "gider.sid",
    secret: process.env.SESSION_SECRET || "yerel-gelistirme-anahtari",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: PRODUCTION,
      sameSite: PRODUCTION ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  };
  if (pool) {
    sessionOptions.store = new PgSession({ pool, createTableIfMissing: true });
  }
  app.use(session(sessionOptions));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    res.json({
      user: req.session.user || null,
      providers: { google: googleReady(), apple: appleReady(), dev: devReady() },
    });
  });

  app.get("/api/ledger", requireUser, asyncRoute(async (req, res) => {
    res.json(await readLedger(req.session.user.id));
  }));

  app.put("/api/ledger", requireUser, asyncRoute(async (req, res) => {
    const raw = JSON.stringify(req.body || {});
    if (raw.length > 1_000_000) {
      res.status(413).json({ error: "Defter çok büyük." });
      return;
    }
    res.json(await writeLedger(req.session.user.id, req.body));
  }));

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("gider.sid");
      res.json({ ok: true });
    });
  });

  app.get("/auth/google", limitAuth, (req, res) => {
    if (!googleReady()) {
      res.redirect("/?auth=missing");
      return;
    }
    const state = rememberState(req);
    const redirectUri = `${publicBase(req)}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    req.session.save(() => {
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });
  });

  app.get("/auth/google/callback", limitAuth, async (req, res) => {
    try {
      if (!googleReady() || !req.query.code || !safeEqual(req.query.state, req.session.oauthState)) {
        res.redirect("/?auth=failed");
        return;
      }
      const redirectUri = `${publicBase(req)}/auth/google/callback`;
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const token = await tokenResponse.json();
      if (!token.access_token) {
        res.redirect("/?auth=failed");
        return;
      }
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const profile = await profileResponse.json();
      if (!profile.sub) {
        res.redirect("/?auth=failed");
        return;
      }
      login(req, res, {
        id: `google:${profile.sub}`,
        email: profile.email || "",
        name: profile.name || profile.email || "Google kullanıcısı",
        provider: "google",
      });
    } catch (error) {
      console.error(error);
      res.redirect("/?auth=failed");
    }
  });

  app.get("/auth/apple", limitAuth, (req, res) => {
    if (!appleReady()) {
      res.redirect("/?auth=missing");
      return;
    }
    const state = rememberState(req);
    const redirectUri = `${publicBase(req)}/auth/apple/callback`;
    const params = new URLSearchParams({
      client_id: process.env.APPLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "form_post",
      scope: "name email",
      state,
    });
    req.session.save(() => {
      res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
    });
  });

  app.post("/auth/apple/callback", limitAuth, async (req, res) => {
    try {
      if (!appleReady() || !req.body.code || !safeEqual(req.body.state, req.session.oauthState)) {
        res.redirect("/?auth=failed");
        return;
      }
      const redirectUri = `${publicBase(req)}/auth/apple/callback`;
      const clientSecret = await appleClientSecret();
      const tokenResponse = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.APPLE_CLIENT_ID,
          client_secret: clientSecret,
          code: String(req.body.code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      const token = await tokenResponse.json();
      if (!token.id_token) {
        res.redirect("/?auth=failed");
        return;
      }
      const verified = await jwtVerify(token.id_token, appleKeys, {
        issuer: "https://appleid.apple.com",
        audience: process.env.APPLE_CLIENT_ID,
      });
      let name = "";
      if (req.body.user) {
        try {
          const parsed = JSON.parse(req.body.user);
          name = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(" ");
        } catch {
          name = "";
        }
      }
      const email = verified.payload.email || "";
      login(req, res, {
        id: `apple:${verified.payload.sub}`,
        email,
        name: name || email || "Apple kullanıcısı",
        provider: "apple",
      });
    } catch (error) {
      console.error(error);
      res.redirect("/?auth=failed");
    }
  });

  app.get("/auth/dev", (req, res) => {
    if (!devReady()) {
      res.redirect("/?auth=missing");
      return;
    }
    login(req, res, {
      id: "dev:local",
      email: "deneme@yerel",
      name: "Deneme",
      provider: "dev",
    });
  });

  app.use(express.static(path.join(__dirname, "public")));
  app.use((_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });
  app.use((error, _req, res, _next) => {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "Sunucu hatası" });
  });

  app.listen(PORT, () => {
    console.log(`Gider Defteri ${PORT} portunda`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

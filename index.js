
const path = require("path");
const fs = require("fs");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cheerio = require("cheerio");
const { google } = require("googleapis");
require("dotenv").config();

/* ====================  CONFIG  ==================== */
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const MODEL_FALLBACK = process.env.GEMINI_MODEL_FALLBACK || "gemini-1.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CLINIC_SITE_URL = (process.env.CLINIC_SITE_URL || "").trim();
const SCRAPE_TTL_MS = 6 * 60 * 60 * 1000;
const INFO_TEXT_TTL_MS = 2 * 60 * 60 * 1000;

const CLINIC_NAME = process.env.CLINIC_NAME || "No disponible.";
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || "No disponible.";
const CLINIC_MAPS_URL = process.env.CLINIC_MAPS_URL || "No disponible.";
const CLINIC_HOURS = process.env.CLINIC_HOURS || "No disponible.";
const EMERGENCY_NOTE = process.env.EMERGENCY_NOTE || "No disponible.";

// Sanitiza ADMIN_NUMBER
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || "").replace(/\D/g, "");
// Calendar
const TIMEZONE = process.env.TIMEZONE || "America/Mexico_City";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

// Trigger para grupos (si en .env hay dos líneas, dotenv toma la última; aquí solo leemos una)
const GROUP_TRIGGER = (process.env.GROUP_TRIGGER || "!psico").toLowerCase();

// Terapias (costos/duración) — sobrescribibles con THERAPY_CONFIG en .env (JSON)
const DEFAULT_THERAPY_CONFIG = {
  individual: { price: 600, durationMin: 50, label: "Terapia individual" },
  pareja: { price: 850, durationMin: 70, label: "Terapia de pareja" },
  adolescentes: { price: 650, durationMin: 55, label: "Terapia para adolescentes (15+)" },
};
let THERAPY_CONFIG = DEFAULT_THERAPY_CONFIG;
try {
  if (process.env.THERAPY_CONFIG) {
    const parsed = JSON.parse(process.env.THERAPY_CONFIG);
    THERAPY_CONFIG = {
      individual: { ...DEFAULT_THERAPY_CONFIG.individual, ...(parsed.individual || {}) },
      pareja: { ...DEFAULT_THERAPY_CONFIG.pareja, ...(parsed.pareja || {}) },
      adolescentes: { ...DEFAULT_THERAPY_CONFIG.adolescentes, ...(parsed.adolescentes || {}) },
    };
  }
} catch (e) {
  console.warn("⚠️ THERAPY_CONFIG inválido, usando defaults. Error:", e.message);
}

// 🚫 Números a ignorar (si los necesitas)
const IGNORED_NUMBERS = [];

/*Depurar */
function dbg(...args) {
  const ts = new Date().toISOString();
  console.log(`[DBG ${ts}]`, ...args);
}

/* =======  LIMPIEZA DE DIRECTORIOS WWebJS AL INICIAR  ======= */
const AUTH_DIR = path.resolve(__dirname, ".wwebjs_auth");
const CACHE_DIR = path.resolve(__dirname, ".wwebjs_cache");
function cleanupWhatsAppDirs() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("🧹 Eliminado .wwebjs_auth");
    }
  } catch (e) { console.warn("No se pudo eliminar .wwebjs_auth:", e.message); }
  try {
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
      console.log("🧹 Eliminado .wwebjs_cache");
    }
  } catch (e) { console.warn("No se pudo eliminar .wwebjs_cache:", e.message); }
}
cleanupWhatsAppDirs();

/* ====================  GEMINI  ===================== */
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
function getModel(name) {
  if (!genAI) throw new Error("Falta GEMINI_API_KEY");
  return genAI.getGenerativeModel({ model: name });
}
async function generateWithGemini(content, { tries = 4 } = {}) {
  if (!genAI) return "";
  let lastErr;
  let modelName = MODEL_PRIMARY;
  for (let i = 0; i < tries; i++) {
    try {
      const model = getModel(modelName);
      const res = await model.generateContent(content);
      const text = await res?.response?.text();
      if (text && text.trim()) return text.trim();
      throw new Error("Respuesta vacía del modelo");
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retriable = /503|429|temporarily|unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (i === 1) modelName = MODEL_FALLBACK;
      if (retriable && i < tries - 1) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/* ==========  SCRAPER (opcional, si hay sitio)  ========== */
let siteCache = { text: "", at: 0 };
async function scrapeClinicText() {
  if (!CLINIC_SITE_URL) return "";
  const now = Date.now();
  if (siteCache.text && now - siteCache.at < SCRAPE_TTL_MS) return siteCache.text;

  const fetch = global.fetch || (await import("node-fetch")).then(m => m.default);
  const res = await fetch(CLINIC_SITE_URL, { redirect: "follow" });
  if (!res.ok) return "";

  const html = await res.text();
  const $ = cheerio.load(html);
  ["script", "style", "noscript", "svg"].forEach(sel => $(sel).remove());
  const mainText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  siteCache = { text: mainText, at: now };
  return mainText;
}

/* ==========  AVISOS AL ADMIN  ========== */
async function sendToAdmin(messageText) {
  try {
    if (!ADMIN_NUMBER || ADMIN_NUMBER.length < 9) {
      console.warn("⚠️ ADMIN_NUMBER no definido o inválido. No se puede notificar al admin.");
      return false;
    }
    const numberId = await client.getNumberId(ADMIN_NUMBER);
    if (!numberId) {
      console.error(`❌ getNumberId no resolvió ${ADMIN_NUMBER}. ¿Tiene WhatsApp y chat iniciado?`);
      return false;
    }
    await client.sendMessage(numberId._serialized, messageText);
    return true;
  } catch (e) {
    console.error("❌ Error enviando mensaje al admin:", e?.message || e);
    return false;
  }
}

/* ==========  WHATSAPP CLIENT  ========== */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bot-psicologia" }),
  puppeteer: {
    headless: false,
    executablePath: process.env.FILE_LOCATION || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,800"],
  },
  webVersionCache: { type: "local" },
});

/* ==========  SESIONES EN MEMORIA  ========== */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() });
  const s = sessions.get(chatId); s.last = Date.now(); return s;
}
// 🔧 CORRECCIÓN: cada vez que cambias de estado o agregas datos, imprime TODO lo guardado
function setState(chatId, state, patch = {}) {
  const s = getSession(chatId);
  s.state = state;
  s.data = { ...s.data, ...patch };
  dbg("📝 Estado actualizado:", state, "Datos:", JSON.stringify(s.data, null, 2));
}
function reset(chatId) { sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() }); }

/* ====== CONTROL: MUTEO DE BOT POR CHAT (HUMANO) ====== */
const botMute = new Map(); // chatId -> timestamp ms
function isBotMuted(chatId) {
  const until = botMute.get(chatId);
  if (!until) return false;
  if (Date.now() > until) { botMute.delete(chatId); return false; }
  return true;
}
function muteBot(chatId, ms) {
  const until = Date.now() + ms;
  botMute.set(chatId, until);
  setTimeout(() => { if (botMute.get(chatId) === until) botMute.delete(chatId); }, ms + 2_000);
}
function unmuteBot(chatId) { botMute.delete(chatId); }

/* ==========  UTILS TEXTO  ========== */
const isGreeting = (text) => !!text && /\b(hola|buenos dias|buenas|buenas tardes|buenas noches|lol)\b/i.test(text.trim());
const isCancel = (text) => !!text && ["menú", "menu", "salir", "inicio"].includes(text.toLowerCase().trim());
const onlyDigits = (s) => (s || "").replace(/\D/g, "");
const isYes = (t) => /\b(si|sí|correcto|confirmo|ok|de acuerdo|así es|vale)\b/i.test((t || "").trim());
const isNo = (t) => /\b(no|negativo|cambiar|no es|otra|equivocado)\b/i.test((t || "").trim());

/* ==========  COPYS Y MENÚ  ========== */
const WELCOME_MENU =
  `🤖 Gracias por contactar a *${CLINIC_NAME}*.\n` +
  "¿En qué puedo apoyarte hoy?\n\n" +
  "1. Agendar cita\n" +
  "2. Conocer la ubicación del consultorio\n" +
  "3. Horarios de servicio\n" +
  "4. Tengo una emergencia / hablar con la psicóloga\n" +
  "5. Olvidé mi cita / perdí el link de la reunión\n" +
  "6. Conocer la información y costo de las terapias\n" +
  "7. Atención a empresas\n\n" +
  "_Escribe el número de la opción, o `menú` para volver aquí._";

const EMERGENCY_COPY =
  `⚠️ *Importante*: ${EMERGENCY_NOTE}\n\n` +
  "Te atiende una psicóloga en breve por este medio. El asistente automático queda *en pausa*.";

const HOURS_COPY =
  `🕒 *Horarios de servicio*\n${CLINIC_HOURS}\n\n` +
  "¿Deseas *agendar una cita*? Responde *1*.\nEscribe *menú* para regresar.";

const LOCATION_COPY =
  `📍 *Ubicación del consultorio*\n${CLINIC_ADDRESS}\n\n` +
  `Mapa: ${CLINIC_MAPS_URL}\n\n` +
  "Si necesitas referencias adicionales, con gusto te apoyamos.";

/* ==========  INFO TERAPIAS (Gemini + cache general)  ========== */
let therapiesCache = { text: "", at: 0 };
const THERAPIES_STATIC =
  "Ofrecemos atención *presencial* y *en línea*.\n\n" +
  "🧠 *Terapias disponibles*\n" +
  "1) Terapia individual\n" +
  "2) Terapia de pareja\n" +
  "3) Terapia para adolescentes (15+)\n\n" +
  "Responde con el *número* para ver detalles, costo y duración.";
async function buildTherapiesInfoGeneral() {
  const now = Date.now();
  if (therapiesCache.text && now - therapiesCache.at < INFO_TEXT_TTL_MS) return therapiesCache.text;
  try {
    const siteText = await scrapeClinicText();
    if (!siteText || !genAI) {
      therapiesCache = { text: THERAPIES_STATIC, at: now };
      return THERAPIES_STATIC;
    }
    const prompt =
      `=== TEXTO DEL SITIO (recortado) ===\n${siteText}\n=== FIN ===\n\n` +
      `Eres recepcionista de ${CLINIC_NAME}. Redacta (3–6 líneas, español cálido y claro) un resumen de servicios de terapia. ` +
      `No inventes. Menciona que el cliente puede elegir: individual, pareja, adolescentes.`;
    const out = await generateWithGemini(prompt, { tries: 4 });
    const text = (out && out.trim()) ? out.trim() : THERAPIES_STATIC;
    therapiesCache = { text, at: now };
    return text + `\n\nResponde *1*, *2* o *3* para ver *detalles, costo y duración*.`;
  } catch {
    therapiesCache = { text: THERAPIES_STATIC, at: now };
    return THERAPIES_STATIC;
  }
}

// Detalle por tipo con Gemini (sin cache para personalizar por selección)
async function buildTherapyDetailByType(typeKey) {
  const cfg = THERAPY_CONFIG[typeKey];
  const label = cfg?.label || typeKey;
  let siteText = "";
  try { siteText = await scrapeClinicText(); } catch { }
  const baseDetail =
    `*${label}*\n` +
    `Costo: *$${cfg?.price ?? "—"} MXN*\n` +
    `Duración: *${cfg?.durationMin ?? "—"} minutos*\n`;
  if (!genAI || !siteText) return baseDetail + "\n¿Deseas *agendar*? Responde *1*.";
  const prompt =
    `=== TEXTO DEL SITIO (recortado) ===\n${siteText}\n=== FIN ===\n\n` +
    `Resume en 3–5 líneas (español, cálido, claro, sin inventar) los puntos clave de "${label}". ` +
    `NO menciones precios ni duración; yo los agregaré.`;
  try {
    const extra = await generateWithGemini(prompt, { tries: 3 });
    const safe = (extra || "").trim();
    return `${baseDetail}\n${safe}\n\n¿Deseas *agendar*? Responde *1*.`;
  } catch {
    return baseDetail + "\n¿Deseas *agendar*? Responde *1*.";
  }
}

/* ==========  MEDIA LOCAL  ========== */
// ✅ Solo Opción 2 enviará imagen. Horarios y Terapias serán SOLO TEXTO.
function mediaFrom(file) { return MessageMedia.fromFilePath(path.resolve(__dirname, "assets", file)); }
function getImgUbicacion() { return mediaFrom("Ubicacion.png"); } // ← Imagen fija para ubicación

/* ==========  AVISOS AL ADMIN (duplicado intencional según tu código original)  ========== */
async function sendToAdminDuplicate(messageText) {
  try {
    if (!ADMIN_NUMBER) {
      console.warn("⚠️ ADMIN_NUMBER no definido o inválido. No se puede notificar al admin.");
      return false;
    }
    const numberId = await client.getNumberId(ADMIN_NUMBER);
    if (!numberId) {
      console.error(`❌ getNumberId no resolvió ${ADMIN_NUMBER}. ¿Tiene WhatsApp y chat iniciado?`);
      return false;
    }
    const chatId = numberId._serialized;
    await client.sendMessage(chatId, messageText);
    console.log(`✅ Aviso enviado al admin (${chatId}).`);
    return true;
  } catch (e) {
    console.error("❌ Error enviando mensaje al admin:", e?.message || e);
    return false;
  }
}

/* ======== Utilidades de fecha con zona horaria ======== */
function todayInTZ(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = f.formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value || '1970';
  const m = parts.find(p => p.type === 'month')?.value || '01';
  const d = parts.find(p => p.type === 'day')?.value || '01';
  return new Date(`${y}-${m}-${d}T00:00:00`);
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function toISODateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
const WEEKDAYS = { 'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3, 'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6 };
const MONTHS = { 'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8, 'septiembre': 9, 'setiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12 };

/* ======== Parser de fecha ======== */
async function parseDateSmart(input) {
  const txt = (input || '').toLowerCase().trim();
  const base = todayInTZ(TIMEZONE);

  if (/\b(hoy)\b/.test(txt)) return { isoDate: toISODateLocal(base), readable: 'hoy' };
  if (/\b(pasado\s+mañana|pasado\s+manana)\b/.test(txt)) { const d = addDays(base, 2); return { isoDate: toISODateLocal(d), readable: 'pasado mañana' }; }
  if (/\b(mañana|manana)\b/.test(txt)) { const d = addDays(base, 1); return { isoDate: toISODateLocal(d), readable: 'mañana' }; }

  const mDia = txt.match(/\b(próximo|proximo|este|esta)\s+(domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/);
  if (mDia) {
    const wd = WEEKDAYS[mDia[2]]; const todayWD = base.getDay();
    let delta = (wd - todayWD + 7) % 7;
    if (delta === 0 || mDia[1].startsWith('próximo') || mDia[1].startsWith('proximo')) delta = (delta === 0 ? 7 : delta);
    const d = addDays(base, delta); return { isoDate: toISODateLocal(d), readable: `${mDia[1]} ${mDia[2]}` };
  }

  let m = txt.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?\b/);
  if (m) {
    let [_, dd, mm, yyyy] = m; dd = parseInt(dd, 10); mm = parseInt(mm, 10); yyyy = yyyy ? parseInt(yyyy, 10) : base.getFullYear();
    const candidate = new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T00:00:00`);
    const inPast = new Date(candidate) < new Date(`${toISODateLocal(base)}T00:00:00`);
    const finalDate = (!m[3] && inPast) ? new Date(`${yyyy + 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T00:00:00`) : candidate;
    return { isoDate: toISODateLocal(finalDate), readable: `${dd}/${mm}${m[3] ? `/${yyyy}` : ''}` };
  }

  m = txt.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/);
  if (m) {
    let dd = parseInt(m[1], 10); let mm = MONTHS[m[2]]; let yyyy = m[3] ? parseInt(m[3], 10) : base.getFullYear();
    let candidate = new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T00:00:00`);
    if (!m[3] && candidate < base) candidate = new Date(`${yyyy + 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T00:00:00`);
    return { isoDate: toISODateLocal(candidate), readable: `${dd} de ${m[2]}${m[3] ? ` de ${yyyy}` : ''}` };
  }

  // Sin LLM, devolvemos vacío
  return { isoDate: null, readable: null };
}

/* ======== Parser de hora ======== */
function toTwo(n) { return String(n).padStart(2, '0'); }
function parseTimeByRules(input) {
  if (!input) return { isoTime: null, readable: null };
  const t = input.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[\.]/g, '');
  if (/\b(medio ?d[ií]a|mediod[ií]a)\b/.test(t)) return { isoTime: "12:00", readable: "mediodía" };
  if (/\b(media ?noche|medianoche)\b/.test(t)) return { isoTime: "00:00", readable: "medianoche" };
  let m = t.match(/\b(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/);
  if (m) { let h = parseInt(m[1], 10); let mm = parseInt(m[2] ?? "0", 10); const suf = m[3]; if (h === 12 && suf === 'am') h = 0; else if (h !== 12 && suf === 'pm') h += 12; if (h > 23 || mm > 59) return { isoTime: null, readable: null }; return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` }; }
  m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) { let h = parseInt(m[1], 10); let mm = parseInt(m[2], 10); if (h > 23 || mm > 59) return { isoTime: null, readable: null }; return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` }; }
  m = t.match(/\b(\d{1,2})\b/);
  if (m) { let h = parseInt(m[1], 10); if (h >= 0 && h <= 23) { if (h >= 1 && h <= 11) h += 12; return { isoTime: `${toTwo(h)}:00`, readable: `${toTwo(h)}:00` }; } }
  return { isoTime: null, readable: null };
}
async function parseTimeSmart(input) {
  return parseTimeByRules(input);
}

/* ==========  GOOGLE CALENDAR  ========== */
function getCalendarClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltan GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN en .env");
  }
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: "v3", auth: oAuth2Client });
}

async function isSlotFree(startISO, endISO) {
  try {
    const calendar = getCalendarClient();
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: startISO,
        timeMax: endISO,
        timeZone: TIMEZONE,
        items: [{ id: GOOGLE_CALENDAR_ID }],
      },
    });
    const busy = res.data.calendars[GOOGLE_CALENDAR_ID]?.busy || [];
    return busy.length === 0;
  } catch (e) {
    console.error("❌ Error consultando disponibilidad:", e.message);
    throw e;
  }
}
async function createCalendarEvent({ summary, description, startISO, endISO }) {
  const calendar = getCalendarClient();
  try {
    const event = {
      summary,
      description,
      start: { dateTime: startISO, timeZone: TIMEZONE },
      end: { dateTime: endISO, timeZone: TIMEZONE },
    };

    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID, // normalmente "primary"
      requestBody: event,
    });

    dbg("✅ Evento creado en Google Calendar:", res.data.id, res.data.htmlLink);
    return res.data;

  } catch (err) {
    console.error("❌ Error creando evento en Calendar:", err.message);
    throw err;
  }
}

/* ==================  EVENTOS WPP  ==================== */
client.on("qr", (qr) => {
  require("qrcode-terminal").generate(qr, { small: true });
  console.log("📲 Escanea el QR (grupos requieren trigger:", GROUP_TRIGGER, ")");
});
client.on("authenticated", () => console.log("✅ Autenticado"));
client.on("ready", () => {
  console.log("Bot listo ✅");
  try {
    dbg("Mi WID:", client.info?.wid?._serialized || "N/D");
    dbg("Pushname:", client.info?.pushname || "N/D");
  } catch { }
});
client.on("auth_failure", (m) => console.error("❌ Fallo de auth:", m));
client.on("disconnected", (r) => console.error("🔌 Desconectado:", r));

/* ==================  HANDLER MSG  ==================== */
client.on("message", async (msg) => {
  try {
    // --- DEBUG ---
    dbg("Mensaje recibido:", {
      from: msg.from,
      author: msg.author || null,
      body_preview: (msg.body || "").slice(0, 120),
      fromMe: msg.fromMe,
      timestamp: msg.timestamp
    });

    const chatId = msg.from;
    const isGroup = chatId.endsWith("@g.us");
    const myWid = client.info?.wid?._serialized;
    const isSelfChat = chatId === myWid;

    // Ignorar ecos propios excepto self-chat
    if (msg.fromMe && !isSelfChat) {
      dbg("Ignorado: mensaje propio en chat que no es self-chat.");
      return;
    }

    let text = (msg.body || "").trim();
    const lower = text.toLowerCase();

    // Ignorados
    if (IGNORED_NUMBERS.includes(chatId)) {
      console.log(`⚠️ Mensaje ignorado de ${chatId}`);
      return;
    }

    // ====== COMANDOS DEL ADMIN PARA REACTIVAR BOT ======
    const adminChatIdSuffix = `${ADMIN_NUMBER}@c.us`;
    const isFromAdmin = ADMIN_NUMBER && chatId === adminChatIdSuffix;
    if (isFromAdmin) {
      const m = lower.match(/^activate\s+bot(?:\s+(\d{9,15}))?$/i);
      if (m) {
        const target = m[1];
        if (target) {
          const tId = `${target}@c.us`;
          unmuteBot(tId);
          reset(tId);
          await msg.reply(`✅ Bot reactivado para ${tId}`);
        } else {
          for (const k of Array.from(botMute.keys())) botMute.delete(k);
          await msg.reply("✅ Bot reactivado para *todos* los chats.");
        }
        return;
      }
      if (/^help$|^ayuda$/.test(lower)) {
        await msg.reply(
          "Comandos admin:\n" +
          "• activate bot → reactiva el bot en todos los chats\n" +
          "• activate bot 521XXXXXXXXXX → reactiva el bot para ese número"
        );
        return;
      }
    }

    // Si el chat está muteado (canal humano), no responder.
    if (isBotMuted(chatId) && !isFromAdmin) {
      dbg(`Chat ${chatId} está en modo HUMANO (muteado). No respondo.`);
      return;
    }

    // ======== DETECCIÓN DE COMANDOS ========
    const startsWithTrigger = lower.startsWith(GROUP_TRIGGER);
    const startsWithGemini = lower.startsWith("gemini");

    // En grupos además permitimos mención al bot o prefijos ! / como activadores
    const myId = client.info?.wid?._serialized;
    const byMention = Array.isArray(msg.mentionedIds) && myId
      ? msg.mentionedIds.includes(myId)
      : false;
    const byPrefix = isGroup ? /^([!\/])\S/.test(lower) : false;

    dbg("Triggers:", {
      isGroup, startsWithTrigger, startsWithGemini, byMention, byPrefix, GROUP_TRIGGER
    });

    // ======== RAMA COMANDOS GLOBALES (!trigger / gemini) ========
    if (startsWithTrigger) {
      const prompt = text.slice(GROUP_TRIGGER.length).trim();
      if (!prompt) {
        await msg.reply(`👋 Escribe tu consulta después de "${GROUP_TRIGGER}". Ej: *${GROUP_TRIGGER} hola*`);
        dbg("Comando sin prompt tras trigger.");
        return;
      }
      dbg("Ejecutando GEMINI por trigger con prompt:", prompt);
      try {
        const out = await generateWithGemini(prompt || "Hola, ¿en qué te ayudo?");
        const reply = out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂";
        await msg.reply(reply);
        dbg("Respuesta GEMINI enviada (trigger).");
      } catch (e) {
        console.error("Error GEMINI (trigger):", e?.message || e);
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    if (startsWithGemini) {
      const prompt = text.slice(6).trim();
      dbg("Ejecutando GEMINI por palabra clave con prompt:", prompt);
      try {
        const out = await generateWithGemini(prompt || "Hola, ¿en qué te ayudo?");
        const reply = out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂";
        await msg.reply(reply);
        dbg("Respuesta GEMINI enviada (keyword).");
      } catch (e) {
        console.error("Error GEMINI (keyword):", e?.message || e);
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    if (isGroup && (byMention || byPrefix)) {
      let prompt = text;
      if (byPrefix) prompt = prompt.replace(/^([!\/])\s*/, "");
      dbg("Ejecutando GEMINI por mención/prefijo en grupo. Prompt:", prompt);
      try {
        const out = await generateWithGemini(prompt || "Hola, ¿en qué te ayudo?");
        const reply = out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂";
        await msg.reply(reply);
        dbg("Respuesta GEMINI enviada (mention/prefix).");
      } catch (e) {
        console.error("Error GEMINI (mention/prefix):", e?.message || e);
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    // ======== FLUJO NORMAL (MENÚ) ========
    if (isCancel(text) || isGreeting(text)) {
      dbg("Entró a menú (greeting/cancel).");
      reset(chatId);
      await msg.reply(WELCOME_MENU);
      return;
    }

    const session = getSession(chatId);
    dbg("Estado actual:", session.state);

    switch (session.state) {
      case "IDLE": {
        if (/^[1-7]$/.test(text)) {
          const n = text;

          if (n === "1") {
            dbg("Rama: Agendar (1)");
            await msg.reply("📅 *Agendar cita*\nPaso 1/4: Indícame tu *nombre completo*.");
            setState(chatId, "CITA_NOMBRE");
            return;
          }

          if (n === "2") {
            dbg("Rama: Ubicación (2)");
            try { await client.sendMessage(chatId, getImgUbicacion(), { caption: LOCATION_COPY }); }
            catch {
              console.warn("Falla enviando imagen de ubicación; envío texto.");
              await msg.reply(LOCATION_COPY);
            }
            return;
          }

          if (n === "3") {
            dbg("Rama: Horarios (3)");
            await msg.reply(HOURS_COPY);
            return;
          }

          if (n === "4") {
            dbg("Rama: Emergencia (4) → pausa bot + avisa admin");
            await msg.reply(EMERGENCY_COPY);
            // Mutea el bot por 24 horas
            const H24 = 24 * 60 * 60 * 1000;
            muteBot(chatId, H24);
            setState(chatId, "HUMANO");
            const aviso =
              "🚨 *ALERTA EMERGENCIA / HUMANO*\n" +
              `• Cliente (chatId): ${chatId}\n` +
              `• Desde ahora el bot está *pausado 24h* para este chat.\n` +
              `• Para reactivar manualmente: *activate bot ${onlyDigits(chatId)}* (envíalo aquí).`;
            await sendToAdmin(aviso);
            return;
          }

          if (n === "5") {
            dbg("Rama: Recuperar cita/link (5)");
            await msg.reply("🔗 *Recuperar cita/link*\nPaso 1/2: Escríbeme tu *nombre completo* como aparece en tu cita.");
            setState(chatId, "FORGOT_NAME");
            return;
          }

          if (n === "6") {
            dbg("Rama: Info terapias (6) → pregunta tipo");
            const info = await buildTherapiesInfoGeneral();
            const options =
              "\n\nElige una opción:\n" +
              "1) Terapia individual\n" +
              "2) Terapia de pareja\n" +
              "3) Terapia para adolescentes (15+)";
            await msg.reply(info + options);
            setState(chatId, "THERAPY_TYPE");
            return;
          }

          if (n === "7") {
            dbg("Rama: Empresas (7)");
            const texto =
              "🏢 *Atención a empresas*\n" +
              "Ofrecemos charlas, talleres de bienestar emocional, intervención en crisis y evaluaciones. " +
              "Compártenos el tamaño de tu empresa y el servicio de interés para preparar una propuesta.\n\n" +
              "¿Deseas que te llame una asesora? *sí/no*";
            await msg.reply(texto);
            setState(chatId, "EMPRESAS_CONFIRM");
            return;
          }
        } else {
          dbg("IDLE sin opción válida → Mostrar menú");
          await msg.reply(WELCOME_MENU);
        }
        return;
      }

      /* ====== TERAPIAS ====== */
      case "THERAPY_TYPE": {
        const mapSel = { "1": "individual", "2": "pareja", "3": "adolescentes" };
        const key = mapSel[text.trim()];
        if (!key) {
          await msg.reply("Por favor elige *1*, *2* o *3*.");
          return;
        }
        setState(chatId, "THERAPY_DETAIL", { therapyKey: key });
        const detail = await buildTherapyDetailByType(key);
        await msg.reply(detail);
        // Después de mostrar detalle, invitamos a agendar con 1
        return;
      }

      case "THERAPY_DETAIL": {
        // Nudging: si dice "1" aquí, lo llevamos a agendar
        if (text.trim() === "1") {
          await msg.reply("Perfecto, vamos a *agendar tu cita*.\nPaso 1/4: Indícame tu *nombre completo*.");
          setState(chatId, "CITA_NOMBRE");
          return;
        }
        await msg.reply("¿Deseas *agendar*? Responde *1*, o escribe *menú* para regresar.");
        return;
      }

      case "INFO_TERAPIAS": {
        dbg("INFO_TERAPIAS → Nudging para agendar.");
        await msg.reply("¿Te gustaría *agendar* una consulta? Responde *1*, o escribe *menú* para regresar.");
        return;
      }

      /* ====== EMPRESAS ====== */
      case "EMPRESAS_CONFIRM": {
        if (isYes(text)) {
          dbg("EMPRESAS_CONFIRM: sí");
          await msg.reply("Perfecto, una asesora te contactará. ¿Podrías compartir *nombre de tu empresa* y un *teléfono* de contacto?");
          setState(chatId, "EMPRESAS_DATOS");
          return;
        }
        if (isNo(text)) {
          dbg("EMPRESAS_CONFIRM: no");
          await msg.reply("De acuerdo. Si cambias de opinión, escribe *7* o *menú*.");
          setState(chatId, "IDLE");
          return;
        }
        dbg("EMPRESAS_CONFIRM: respuesta inválida");
        await msg.reply("Responde *sí* o *no*.");
        return;
      }
      case "EMPRESAS_DATOS": {
        dbg("EMPRESAS_DATOS → notificar admin");
        const aviso =
          "🏢 *LEAD EMPRESAS*\n" +
          `• Cliente: ${chatId}\n` +
          `• Datos: ${text}`;
        await sendToAdminDuplicate(aviso);
        await msg.reply("¡Gracias! Compartimos tus datos con el equipo y te contactarán pronto. Escribe *menú* para volver.");
        setState(chatId, "IDLE");
        return;
      }

      /* ===== Recuperar cita / link ===== */
      case "FORGOT_NAME": {
        dbg("FORGOT_NAME → pedir fecha");
        setState(chatId, "FORGOT_DATE", { forgotName: text });
        await msg.reply("Paso 2/2: ¿Recuerdas *fecha aproximada* de tu cita? (ej.: *lunes*, *ayer*, *15/09*). Si no, escribe *no sé*.");
        return;
      }
      case "FORGOT_DATE": {
        dbg("FORGOT_DATE → notificar admin");
        const approx = text.toLowerCase();
        const data = getSession(chatId).data;
        const aviso =
          "🔗 *RECUPERAR CITA/LINK*\n" +
          `• Cliente: ${chatId}\n` +
          `• Nombre: ${data.forgotName}\n` +
          `• Fecha aprox: ${approx}`;
        await sendToAdminDuplicate(aviso);
        await msg.reply("Gracias. Revisaremos tu registro y te compartiremos el enlace o confirmación. Escribe *menú* para volver.");
        setState(chatId, "IDLE", {});
        return;
      }

      /* ===== Citas (Calendar) ===== */
      case "CITA_NOMBRE": {
        dbg("CITA_NOMBRE → pedir fecha");
        setState(chatId, "CITA_FECHA_FREEFORM", { nombre: text });
        await msg.reply("Paso 2/4: Escribe la *fecha* (ej.: *próximo jueves*, *17 de agosto*, *17/08/2025*).");
        return;
      }
      case "CITA_FECHA_FREEFORM": {
        dbg("CITA_FECHA_FREEFORM → parsear fecha");
        let parsed = { isoDate: null, readable: null };
        try { parsed = await parseDateSmart(text); } catch { }
        dbg("🗓️ Fecha parseada:", parsed);
        if (!parsed.isoDate) {
          dbg("Fecha inválida");
          await msg.reply("No pude interpretar la fecha. Intenta con *mañana*, *próximo jueves* o *17/08/2025*.");
          return;
        }
        setState(chatId, "CITA_FECHA_CONFIRM", {
          fechaTexto: text, fechaISO: parsed.isoDate, fechaReadable: parsed.readable || parsed.isoDate
        });
        await msg.reply(`Entendí la fecha como: *${parsed.readable || parsed.isoDate}* (${parsed.isoDate}). ¿Es correcto? *sí/no*`);
        return;
      }
      case "CITA_FECHA_CONFIRM": {
        if (isYes(text)) {
          dbg("CITA_FECHA_CONFIRM: sí → pedir hora");
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Paso 3/4: Ahora dime la *hora* (ej.: *3 pm*, *15:00*, *medio día*).");
          return;
        }
        if (isNo(text)) {
          dbg("CITA_FECHA_CONFIRM: no → reintentar fecha");
          setState(chatId, "CITA_FECHA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *fecha*.");
          return;
        }
        dbg("CITA_FECHA_CONFIRM: respuesta inválida");
        await msg.reply("Responde *sí* o *no*.");
        return;
      }
      case "CITA_HORA_FREEFORM": {
        dbg("CITA_HORA_FREEFORM → parsear hora");
        let parsed = { isoTime: null, readable: null };
        try { parsed = await parseTimeSmart(text); } catch { }
        dbg("⏰ Hora parseada:", parsed);
        if (!parsed.isoTime) {
          dbg("Hora inválida");
          await msg.reply("No pude interpretar la hora. Intenta con *3 pm* o *15:00*.");
          return;
        }
        setState(chatId, "CITA_HORA_CONFIRM", {
          horaTexto: text, horaISO: parsed.isoTime, horaReadable: parsed.readable || parsed.isoTime
        });
        await msg.reply(`Entendí la hora como: *${parsed.readable || parsed.isoTime}* (${parsed.isoTime}). ¿Es correcto? *sí/no*`);
        return;
      }
      case "CITA_HORA_CONFIRM": {
        if (isYes(text)) {
          dbg("CITA_HORA_CONFIRM: sí → verificar calendar y crear evento");
          const data = getSession(chatId).data;
          const { nombre, fechaISO, horaISO } = data;

          // ⚡ Usamos solo los ISO
          const startLocal = new Date(`${fechaISO}T${horaISO}:00`);
          const endLocal = new Date(startLocal.getTime() + 60 * 60 * 1000);
          const startISO = startLocal.toISOString();
          const endISO = endLocal.toISOString();

          dbg("📆 Intervalos calculados SOLO ISO:", { fechaISO, horaISO, startISO, endISO, tz: TIMEZONE });

          try {
            const free = await isSlotFree(startISO, endISO);
            dbg("¿Slot libre?:", free);
            if (!free) {
              dbg("Calendar ocupado en ese horario");
              await msg.reply("⛔ Ese horario ya está ocupado. ¿Propones otra *fecha* u *hora*?");
              setState(chatId, "CITA_FECHA_FREEFORM");
              return;
            }
            const event = await createCalendarEvent({
              summary: `Cita (psicología) con ${nombre}`,
              description: `Cita agendada vía WhatsApp (${chatId}).`,
              startISO, endISO,
            });
            dbg("Evento creado:", event?.id || "N/D");
            await msg.reply(`✅ *Cita creada* para *${fechaISO}* a las *${horaISO}*.\nSi necesitas reprogramar, responde *menú* y elige la opción 5.`);
            const aviso =
              "📅 *ALERTA CITA*\n" +
              `• Cliente: ${chatId}\n` +
              `• Nombre: ${nombre}\n` +
              `• Fecha: ${fechaISO}\n` +
              `• Hora: ${horaISO}\n` +
              `• Evento ID: ${event.id || "N/D"}`;
            await sendToAdmin(aviso);
            setState(chatId, "IDLE", {});
            return;
          } catch (e) {
            const msgErr = String(e?.message || e);
            console.error("Error Calendar:", msgErr);
            if (/invalid_grant/i.test(msgErr)) {
              await msg.reply(
                "⚠️ No pude verificar/crear la cita en Calendar por un problema de autorización.\n" +
                "Por favor intenta más tarde o escribe *4* para asistencia humana."
              );
            } else {
              await msg.reply(
                "⚠️ No pude verificar/crear la cita en Calendar por un error temporal.\n" +
                "Intenta más tarde o escribe *4* para asistencia."
              );
            }
            setState(chatId, "IDLE");
            return;
          }
        }
        if (isNo(text)) {
          dbg("CITA_HORA_CONFIRM: no → reintentar hora");
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *hora*.");
          return;
        }
        dbg("CITA_HORA_CONFIRM: respuesta inválida");
        await msg.reply("Responde *sí* o *no*.");
        return;
      }

      /* ===== Canal humano ===== */
      case "HUMANO": {
        dbg("Canal HUMANO: mantener silencio; pero confirmamos una vez.");
        await msg.reply("Gracias, una psicóloga dará seguimiento por este medio. 🙌");
        return;
      }
    }
  } catch (error) {
    console.error("Error en handler:", error);
    try { await msg.reply("⚠️ Ocurrió un error. Escribe *hola* para ver el menú."); } catch { }
  }
});

client.initialize();

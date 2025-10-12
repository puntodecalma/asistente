// index.js
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

// Trigger para grupos
const GROUP_TRIGGER = (process.env.GROUP_TRIGGER || "!psico").toLowerCase();

// Deshabilita respuestas LLM libres (mantenemos el código pero no se usa)
const ALLOW_FREEFORM_LLM = false;

/* ======== CONFIG TERAPIAS ======== */
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

// 🚫 Números a ignorar
const IGNORED_NUMBERS = [];

/*Depurar */
function dbg(...args) {
  const ts = new Date().toISOString();
  console.log(`[DBG ${ts}]`, ...args);
}

/* =======  LIMPIEZA DE DIRECTORIOS WWebJS ======= */
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

/* ==========  SCRAPER  ========== */
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

/* ==========  AVISOS ADMIN  ========== */
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
  headless: false, // en servidor ponlo true
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,800"
  ],
},
   webVersionCache: { type: "local" },
 });
 //PRODUCION
 /*
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bot-psicologia" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});*/
/* ==========  SESIONES EN MEMORIA  ========== */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() });
  const s = sessions.get(chatId); s.last = Date.now(); return s;
}
function setState(chatId, state, patch = {}) {
  const s = getSession(chatId);
  s.state = state;
  s.data = { ...s.data, ...patch };
  dbg("📝 Estado actualizado:", state, "Datos:", JSON.stringify(s.data, null, 2));
}
function reset(chatId) { sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() }); }

/* ====== CONTROL BOT MUTE ====== */
const botMute = new Map();
function isBotMuted(chatId) {
  const until = botMute.get(chatId);
  if (!until) return false;
  if (Date.now() > until) { botMute.delete(chatId); return false; }
  return true;
}
function muteBot(chatId, ms) {
  const until = Date.now() + ms;
  botMute.set(chatId, until);
  setTimeout(() => { if (botMute.get(chatId) === until) botMute.delete(chatId); }, ms + 2000);
}
function unmuteBot(chatId) { botMute.delete(chatId); }

/* ========== UTILS TEXTO ========== */
const isGreeting = (text) => !!text && ["hola"].includes(text.toLowerCase().trim());
// Solo permitir volver con 'menú/menu' para cumplir el requisito
const isCancel = (text) => !!text && ["menú", "menu"].includes(text.toLowerCase().trim());
const onlyDigits = (s) => (s || "").replace(/\D/g, "");
const isYes = (t) => /\b(si|sí|correcto|confirmo|ok|de acuerdo|así es|vale)\b/i.test((t || "").trim());
const isNo = (t) => /\b(no|negativo|cambiar|no es|otra|equivocado)\b/i.test((t || "").trim());

/* ========== COPYS Y MENÚ ========== */
const WELCOME_MENU =
  `🤖 Gracias por contactar a *${CLINIC_NAME}*.\n` +
  "¿En qué puedo asistirle hoy?\n\n" +
  "1. Agendar una cita\n" +
  "2. Consultar la ubicación del consultorio\n" +
  "3. Horarios de atención\n" +
  "4. Tengo una emergencia / contactar a la psicóloga\n" +
  "5. Olvidé mi cita o perdí el enlace de la reunión\n" +
  "6. Información y costo de las terapias\n" +
  "7. Atención a empresas\n\n" +
  "_Escriba el número de la opción, o `menú` para regresar a este menú._";

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

/* ==========  INFO TERAPIAS  ========== */
let therapiesCache = { text: "", at: 0 };
const THERAPIES_STATIC =
  "Ofrecemos atención *presencial* y *en línea*.\n\n" +
  "🧠 *Terapias disponibles*\n" +
  "1) Terapia individual\n" +
  "2) Terapia de pareja\n" +
  "3) Terapia para adolescentes (15+)\n\n" +
  "El enfoque de las sesiones es cognitivo conductual y humanista. Utilizando cada una según sean las necesidades de tus objetivos.\n\n" +
  "Responde con el *número* para ver detalles, costo y duración.";
// === Validación de horario permitido para agendar citas ===
function isAppointmentAllowed(fechaISO, horaISO) {
  // fechaISO: "YYYY-MM-DD", horaISO: "HH:MM"
  // Retorna {ok: boolean, reason: string|null}
  if (!fechaISO || !horaISO) return { ok: false, reason: "Fecha u hora no válida." };
  // Convertir a objeto Date en zona local
  // Creamos un Date con la hora local (sin Z)
  const [y, m, d] = fechaISO.split("-").map(Number);
  const [h, mi] = horaISO.split(":").map(Number);
  // JS Date interpreta YYYY-MM-DDTHH:MM como UTC, así que ajustamos con zona horaria
  // Usamos Intl.DateTimeFormat para obtener el día de la semana en la zona adecuada
  // Pero para la validación, basta con construir el Date y obtener el día
  const dt = new Date(`${fechaISO}T${horaISO}:00`);
  // Día de la semana: 0=domingo ... 6=sábado
  // Para la zona horaria, usamos Intl.DateTimeFormat
  let dayOfWeek;
  try {
    const fmt = new Intl.DateTimeFormat("es-MX", { timeZone: TIMEZONE, weekday: "long" });
    const parts = fmt.formatToParts(dt);
    const dayName = parts.find(p => p.type === "weekday")?.value?.toLowerCase();
    // Mapear a número
    // Domingo=0, Lunes=1, ..., Sábado=6
    dayOfWeek =
      dayName === "domingo" ? 0 :
      dayName === "lunes" ? 1 :
      dayName === "martes" ? 2 :
      (dayName === "miércoles" || dayName === "miercoles") ? 3 :
      dayName === "jueves" ? 4 :
      dayName === "viernes" ? 5 :
      (dayName === "sábado" || dayName === "sabado") ? 6 :
      dt.getDay();
  } catch {
    dayOfWeek = dt.getDay();
  }
  // Validar por día
  if (dayOfWeek === 0) {
    return { ok: false, reason: "Domingo no se permiten citas." };
  }
  // Hora permitida por día
  const hour = h;
  const minute = mi;
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    // Lunes a viernes: 10:00 a 18:00
    if (hour < 10 || (hour > 18) || (hour === 18 && minute > 0)) {
      return { ok: false, reason: "Lunes a viernes solo de 10:00 a 18:00 horas." };
    }
  } else if (dayOfWeek === 6) {
    // Sábado: 10:00 a 15:00
    if (hour < 10 || (hour > 15) || (hour === 15 && minute > 0)) {
      return { ok: false, reason: "Sábados solo de 10:00 a 15:00 horas." };
    }
  }
  // Si pasa todas las validaciones
  return { ok: true, reason: null };
}

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
      `=== TEXTO DEL SITIO ===\n${siteText}\n=== FIN ===\n\n` +
      `Eres recepcionista de ${CLINIC_NAME}. Resume en 3–6 líneas claras los servicios de terapia. ` +
      `Menciona que hay opciones: individual, pareja, adolescentes.`;
    const out = await generateWithGemini(prompt, { tries: 4 });
    const text = (out && out.trim()) ? out.trim() : THERAPIES_STATIC;
    therapiesCache = { text, at: now };
    return text + `\n\nResponde *1*, *2* o *3* para ver *detalles, costo y duración*.`;
  } catch {
    therapiesCache = { text: THERAPIES_STATIC, at: now };
    return THERAPIES_STATIC;
  }
}

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
    `=== TEXTO DEL SITIO ===\n${siteText}\n=== FIN ===\n\n` +
    `Resume en 3–5 líneas (sin inventar) los puntos clave de "${label}". No menciones precios ni duración.`;
  try {
    const extra = await generateWithGemini(prompt, { tries: 3 });
    const safe = (extra || "").trim();
    return `${baseDetail}\n${safe}\n\n¿Deseas *agendar*? Responde *1*.`;
  } catch {
    return baseDetail + "\n¿Deseas *agendar*? Responde *1*.";
  }
}

/* ==========  MEDIA LOCAL  ========== */
function mediaFrom(file) { return MessageMedia.fromFilePath(path.resolve(__dirname, "assets", file)); }
function getImgUbicacion() { return mediaFrom("Ubicacion.png"); }

/* ==========  FECHAS Y HORAS ========== */
function todayInTZ(tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = f.formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value || "1970";
  const m = parts.find(p => p.type === "month")?.value || "01";
  const d = parts.find(p => p.type === "day")?.value || "01";
  return new Date(`${y}-${m}-${d}T00:00:00`);
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function toISODateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const WEEKDAYS = { 'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3, 'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6 };
const MONTHS = { 'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8, 'septiembre': 9, 'setiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12 };

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
  return { isoDate: null, readable: null };
}

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
async function parseTimeSmart(input) { return parseTimeByRules(input); }

/* ========== GOOGLE CALENDAR ========== */
function buildEventRange(fechaISO, horaISO, durationMin) {
  // Crear fecha/hora en la zona configurada
  const [h, m] = horaISO.split(":").map(Number);
  const [y, mo, d] = fechaISO.split("-").map(Number);

  // Fecha local en la zona configurada
  const start = new Date(Date.UTC(y, mo - 1, d, h, m));
  const end = new Date(start.getTime() + durationMin * 60000);

  // Formato RFC3339 completo con offset Z (UTC)
  const startDT = start.toISOString();
  const endDT = end.toISOString();

  return { startDT, endDT };
}

// === NUEVO: sumar minutos y devolver sello “local” (sin Z) y UTC a la vez ===
function addMinutesLocalStamp(fechaISO, horaISO, minutes) {
  const [y, mo, d] = fechaISO.split("-").map(Number);
  const [h, mi] = horaISO.split(":").map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi) + minutes * 60000;
  const nd = new Date(ms);
  const newDate = `${nd.getUTCFullYear()}-${toTwo(nd.getUTCMonth() + 1)}-${toTwo(nd.getUTCDate())}`;
  const newTime = `${toTwo(nd.getUTCHours())}:${toTwo(nd.getUTCMinutes())}`;
  return { date: newDate, time: newTime };
}

function buildEventRangeDual(fechaISO, horaISO, durationMin) {
  // Local “flotante” (sin Z), para crear el evento con timeZone
  const startLocal = `${fechaISO}T${horaISO}:00`;
  const endLocalParts = addMinutesLocalStamp(fechaISO, horaISO, durationMin);
  const endLocal = `${endLocalParts.date}T${endLocalParts.time}:00`;

  // Ventana absoluta en UTC, para freebusy
  const [y, mo, d] = fechaISO.split("-").map(Number);
  const [h, m] = horaISO.split(":").map(Number);
  const msStartUTC = Date.UTC(y, mo - 1, d, h, m);
  const startUTC = new Date(msStartUTC).toISOString();
  const endUTC = new Date(msStartUTC + durationMin * 60000).toISOString();

  return { startLocal, endLocal, startUTC, endUTC };
}
function getOAuth2() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltan GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN en .env");
  }
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  oAuth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) dbg("🔐 Nuevo access_token obtenido automáticamente.");
    if (tokens.refresh_token) dbg("🔄 Google envió UN NUEVO refresh_token (guárdalo).");
  });

  return oAuth2Client;
}
async function getCalendarClient() {
  const auth = getOAuth2();
  await auth.getAccessToken(); // fuerza nuevo token fresco
  return google.calendar({ version: "v3", auth });
}

// === Helpers de zona horaria ===
function localDateTimeToUtcMs(fechaISO, horaISO, tz = TIMEZONE) {
  const [y, mo, d] = fechaISO.split("-").map(Number);
  const [h, mi] = horaISO.split(":").map(Number);

  let ms = Date.UTC(y, mo - 1, d, h, mi);

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const dispY = Number(parts.year);
  const dispM = Number(parts.month);
  const dispD = Number(parts.day);
  const dispH = Number(parts.hour);
  const dispMin = Number(parts.minute);

  const targetMinutes = (((y * 12 + (mo - 1)) * 31 + d) * 24 + h) * 60 + mi;
  const shownMinutes  = (((dispY * 12 + (dispM - 1)) * 31 + dispD) * 24 + dispH) * 60 + dispMin;
  const deltaMinutes = targetMinutes - shownMinutes;

  ms += deltaMinutes * 60_000;
  return ms;
}

function localRangeToUtcISO(fechaISO, horaISO, durationMin, tz = TIMEZONE) {
  const startMs = localDateTimeToUtcMs(fechaISO, horaISO, tz);
  const endMs = startMs + durationMin * 60_000;
  return { timeMinISO: new Date(startMs).toISOString(), timeMaxISO: new Date(endMs).toISOString() };
}

function localRangeToUtcISOExtended(fechaISO, horaISO, durationMin, paddingMin = 0, tz = TIMEZONE) {
  const startMs = localDateTimeToUtcMs(fechaISO, horaISO, tz) - paddingMin * 60_000;
  const endMs = startMs + (durationMin + paddingMin * 2) * 60_000;
  return { timeMinISO: new Date(startMs).toISOString(), timeMaxISO: new Date(endMs).toISOString() };
}

// === Función principal corregida ===
async function isSlotReallyFree(fechaISO, horaISO, durationMin, msg) {
  try {
    const calendar = await getCalendarClient();

    // Rango exacto de la cita (UTC correcto)
    const { timeMinISO, timeMaxISO } = localRangeToUtcISO(fechaISO, horaISO, durationMin, TIMEZONE);

    console.log("🔍 Verificando disponibilidad (events.list con conversión local→UTC)...");
    console.log("🕒 Local:", `${fechaISO} ${horaISO} (${durationMin}m)`, "TZ:", TIMEZONE);
    console.log("🕒 Ventana UTC:", timeMinISO, "→", timeMaxISO);

    const res = await calendar.events.list({
      calendarId: GOOGLE_CALENDAR_ID,
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      singleEvents: true,
      orderBy: "startTime"
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      console.log("✅ Horario libre (0 eventos en ventana exacta).");
      return true;
    }

    // Verificar solapamientos reales
    const reqStart = new Date(timeMinISO).getTime();
    const reqEnd = new Date(timeMaxISO).getTime();
    const conflicts = events.filter(ev => {
      const evStart = ev.start.dateTime ? new Date(ev.start.dateTime).getTime() : new Date(ev.start.date).getTime();
      const evEnd = ev.end.dateTime ? new Date(ev.end.dateTime).getTime() : new Date(ev.end.date).getTime();
      return evStart < reqEnd && evEnd > reqStart;
    });

    if (conflicts.length > 0) {
      console.log("⛔ Conflicto detectado con:", conflicts.map(e => e.summary).join(", "));
      if (msg) {
        await msg.reply(
          "⛔ Ese horario ya está *ocupado*.\nPor favor elige otra *hora* y escribe *reiniciar* para iniciar de nuevo."
        );
      }
      return false;
    }

    console.log("✅ Horario libre (sin solapamientos).");
    return true;
  } catch (error) {
    console.error("❌ Error verificando disponibilidad en Calendar:", error.message);
    if (msg) await msg.reply("⚠️ Ocurrió un problema al verificar el calendario. Intenta nuevamente.");
    return false;
  }
}
async function createCalendarEvent({ summary, description, startDT, endDT }) {
  const calendar = await getCalendarClient();
  try {
    const event = {
      summary,
      description,
      start: { dateTime: startDT, timeZone: TIMEZONE },
      end: { dateTime: endDT, timeZone: TIMEZONE },
    };
    const res = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: event,
    });
    dbg("✅ Evento creado:", res.data.id, res.data.htmlLink);
    return res.data;
  } catch (err) {
    console.error("❌ Error creando evento:", err?.message || err);
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

    if (msg.fromMe && !isSelfChat) return;

    let text = (msg.body || "").trim();
    let lower = text.toLowerCase();

    if (IGNORED_NUMBERS.includes(chatId)) return;

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

    if (isBotMuted(chatId) && !isFromAdmin) return;

    const startsWithTrigger = lower.startsWith(GROUP_TRIGGER);
    const startsWithGemini = lower.startsWith("gemini");
    const myId = client.info?.wid?._serialized;
    const byMention = Array.isArray(msg.mentionedIds) && myId
      ? msg.mentionedIds.includes(myId)
      : false;
    const byPrefix = isGroup ? /^([!\/])\S/.test(lower) : false;

    // En grupos: responder SOLO si empieza con el trigger (!psico)
    if (isGroup && !startsWithTrigger) return;

    // Si trae trigger, quitamos el prefijo y continuamos con el flujo normal
    if (startsWithTrigger) {
      text = text.slice(GROUP_TRIGGER.length).trim();
      lower = text.toLowerCase();
      // Si sólo envían el prefijo, mostramos el menú
      if (!text) {
        reset(chatId);
        await msg.reply(WELCOME_MENU);
        return;
      }
    }

    // Deshabilitar respuestas LLM libres (mantenemos el código, pero no se ejecuta)
    if (ALLOW_FREEFORM_LLM && startsWithGemini) {
      const prompt = text.slice(6).trim();
      try {
        const out = await generateWithGemini(prompt || "Hola, ¿en qué te ayudo?");
        const reply = out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂";
        await msg.reply(reply);
      } catch {
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }
    if (ALLOW_FREEFORM_LLM && isGroup && (byMention || byPrefix)) {
      let prompt = text;
      if (byPrefix) prompt = prompt.replace(/^([!\/])\s*/, "");
      try {
        const out = await generateWithGemini(prompt || "Hola, ¿en qué te ayudo?");
        const reply = out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂";
        await msg.reply(reply);
      } catch {
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    // Sesión y activación
    const session = getSession(chatId);
    const state = session?.state || "IDLE";
    const isHola = lower === "hola";
    const isMenuCmd = lower === "menú" || lower === "menu";
    const isMenuOption = /^[1-7]$/.test(lower);

    // Si la sesión está IDLE, responder sólo a "hola", "menú/menu", o una opción 1–7
    // (los grupos ya fueron filtrados por el prefijo más arriba)
    if (state === "IDLE" && !isHola && !isMenuCmd && !isMenuOption) return;

    // Permitir reiniciar la sesión con "reiniciar"
    if (lower === "reiniciar") {
      reset(chatId);
      await msg.reply("🔄 Registro reiniciado. Escribe *1* para comenzar a agendar una nueva cita.");
      return;
    }

    // Permitir volver al menú en cualquier momento
    if (isMenuCmd || isGreeting(text)) {
      reset(chatId);
      await msg.reply(WELCOME_MENU);
      return;
    }

    // Evita redeclarar 'session' (antes: const session = getSession(chatId);)
    const session2 = getSession(chatId);

    switch ((session2 || session).state) {
      case "IDLE": {
        if (/^[1-7]$/.test(text)) {
          const n = text;
          if (n === "1") {
            await msg.reply("📅 *Agendar cita*\nPaso 1/4: Indícame tu *nombre completo*.");
            setState(chatId, "CITA_NOMBRE");
            return;
          }
          if (n === "2") {
            try { await client.sendMessage(chatId, getImgUbicacion(), { caption: LOCATION_COPY }); }
            catch { await msg.reply(LOCATION_COPY); }
            return;
          }
          if (n === "3") {
            await msg.reply(HOURS_COPY);
            return;
          }
          if (n === "4") {
            await msg.reply(EMERGENCY_COPY);
            const H24 = 24 * 60 * 60 * 1000;
            muteBot(chatId, H24);
            setState(chatId, "HUMANO");
            const aviso =
              "🚨 *ALERTA EMERGENCIA / HUMANO*\n" +
              `• Cliente: ${chatId}\n` +
              `• Bot pausado 24h. Para reactivar: *activate bot ${onlyDigits(chatId)}*`;
            await sendToAdmin(aviso);
            return;
          }
          if (n === "5") {
            await msg.reply("🔗 *Recuperar cita/link*\nPaso 1/2: Escríbeme tu *nombre completo*.");
            setState(chatId, "FORGOT_NAME");
            return;
          }
          if (n === "6") {
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
            const texto =
              "🏢 *Atención a empresas*\n" +
              "Ofrecemos charlas, talleres y evaluaciones. " +
              "¿Deseas que te llame una asesora? *sí/no*";
            await msg.reply(texto);
            setState(chatId, "EMPRESAS_CONFIRM");
            return;
          }
        } else {
          await msg.reply(WELCOME_MENU);
        }
        return;
      }      /* ====== TERAPIAS ====== */
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
        return;
      }
      case "THERAPY_DETAIL": {
        if (text.trim() === "1") {
          await msg.reply("Perfecto, vamos a *agendar tu cita*.\nPaso 1/4: Indícame tu *nombre completo*.");
          setState(chatId, "CITA_NOMBRE");
          return;
        }
        await msg.reply("¿Deseas *agendar*? Responde *1*, o escribe *menú* para regresar.");
        return;
      }

      /* ====== EMPRESAS ====== */
      case "EMPRESAS_CONFIRM": {
        if (isYes(text)) {
          await msg.reply("Perfecto, una asesora te contactará. Compártenos *nombre de tu empresa* y un *teléfono* de contacto.");
          setState(chatId, "EMPRESAS_DATOS");
          return;
        }
        if (isNo(text)) {
          await msg.reply("De acuerdo. Si cambias de opinión, escribe *7* o *menú*.");
          setState(chatId, "IDLE");
          return;
        }
        await msg.reply("Responde *sí* o *no*.");
        return;
      }
      case "EMPRESAS_DATOS": {
        const aviso =
          "🏢 *LEAD EMPRESAS*\n" +
          `• Cliente: ${chatId}\n` +
          `• Datos: ${text}`;
        await sendToAdmin(aviso);
        await msg.reply("¡Gracias! Te contactaremos pronto. Escribe *menú* para volver.");
        setState(chatId, "IDLE");
        return;
      }

      /* ===== Recuperar cita / link ===== */
      case "FORGOT_NAME": {
        setState(chatId, "FORGOT_DATE", { nombre: text });
        await msg.reply("Paso 2/2: ¿Recuerdas *fecha aproximada* de tu cita? (ej.: *lunes*, *ayer*, *15/09*). Si no, escribe *no sé*.");
        return;
      }
      case "FORGOT_DATE": {
        const approx = text.toLowerCase();
        const data = getSession(chatId).data;
        const aviso =
          "🔗 *RECUPERAR CITA/LINK*\n" +
          `• Cliente: ${chatId}\n` +
          `• Nombre: ${data.nombre}\n` + // antes: data.forgotName
          `• Fecha aprox: ${approx}`;
        await sendToAdmin(aviso);
        await msg.reply("Gracias. Revisaremos tu registro y te compartiremos el enlace. Escribe *menú* para volver.");
        setState(chatId, "IDLE", {});
        return;
      }

      /* ===== Citas (Calendar) ===== */
      case "CITA_NOMBRE": {
        setState(chatId, "CITA_FECHA_FREEFORM", { nombre: text });
        await msg.reply("Paso 2/4: Escribe la *fecha* (ej.: *próximo jueves*, *17 de agosto*, *17/08/2025*).");
        return;
      }
      case "CITA_FECHA_FREEFORM": {
        let parsed = { isoDate: null, readable: null };
        try { parsed = await parseDateSmart(text); } catch { }
        if (!parsed.isoDate) {
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
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Paso 3/4: Ahora dime la *hora* (ej.: *3 pm*, *15:00*, *medio día*).");
          return;
        }
        if (isNo(text)) {
          setState(chatId, "CITA_FECHA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *fecha*.");
          return;
        }
        await msg.reply("Responde *sí* o *no*.");
        return;
      }
      case "CITA_HORA_FREEFORM": {
        let parsed = { isoTime: null, readable: null };
        try { parsed = await parseTimeSmart(text); } catch { }
        if (!parsed.isoTime) {
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
          const data = getSession(chatId).data;
          const { nombre, fechaISO, horaISO, therapyKey } = data;
          const durationMin = (therapyKey && THERAPY_CONFIG[therapyKey]?.durationMin) || 60;

          // Validar horario permitido antes de consultar disponibilidad
          const horarioVal = isAppointmentAllowed(fechaISO, horaISO);
          if (!horarioVal.ok) {
            await msg.reply(
              "⛔ Lo siento, las citas solo se pueden agendar de *lunes a viernes de 10:00 a 18:00* y los *sábados de 10:00 a 15:00*.\n\n" +
              "Por favor selecciona una *hora válida* o escribe *reiniciar* para comenzar nuevamente el registro de tu cita."
            );
            setState(chatId, "CITA_HORA_FREEFORM");
            return;
          }

          // Obtener rangos de evento
          const { startLocal, endLocal, startUTC, endUTC } =
            buildEventRangeDual(fechaISO, horaISO, durationMin);

          // Verificar disponibilidad usando isSlotReallyFree (nuevo nombre)
          const free = await isSlotReallyFree(fechaISO, horaISO, durationMin, msg);
          if (!free) {
            // Si hay conflicto, responder y reiniciar correctamente el proceso
            setState(chatId, "CITA_FECHA_FREEFORM");
            return;
          }

          try {
            const event = await createCalendarEvent({
              summary: `Cita (psicología) con ${nombre}`,
              description: `Cita agendada vía WhatsApp (${chatId}).`,
              startDT: startLocal,   // local “flotante”
              endDT: endLocal,       // local “flotante”
            });
            await msg.reply(
              `✅ Cita creada para ${fechaISO} a las ${horaISO} (${durationMin} min).\n` +
              `Si necesita reprogramar, escriba "menú" y elija la opción 5.`
            );
            const aviso =
              "📅 Nueva cita agendada\n" +
              `• Cliente: ${chatId}\n` +
              `• Nombre: ${nombre}\n` +
              `• Fecha: ${fechaISO}\n` +
              `• Hora: ${horaISO}\n` +
              `• Duración: ${durationMin} minutos\n` +
              "Le agradeceremos confirmar la recepción de esta cita.";
            await sendToAdmin(aviso);
            setState(chatId, "IDLE", {});
            return;
          } catch (e) {
            const msgErr = String(e?.message || e);
            if (/invalid_grant/i.test(msgErr)) {
              await msg.reply(
                "⚠️ No pude crear la cita en Calendar por un problema de autorización.\n" +
                "Por favor intenta más tarde o escribe *4* para asistencia humana."
              );
            } else {
              await msg.reply(
                "⚠️ No pude crear la cita en Calendar por un error temporal.\n" +
                "Intenta más tarde o escribe *4* para asistencia."
              );
            }
            setState(chatId, "IDLE");
            return;
          }
        }
        if (isNo(text)) {
          setState(chatId, "CITA_HORA_FREEFORM");
          await msg.reply("Ok, escribe nuevamente la *hora*.");
          return;
        }
        await msg.reply("Responde *sí* o *no*.");
        return;
      }

      /* ===== Canal humano ===== */
      case "HUMANO": {
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


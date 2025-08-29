// index.js
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cheerio = require("cheerio");
const { google } = require("googleapis");
require("dotenv").config();

/* ====================  CONFIG  ==================== */
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const MODEL_FALLBACK = process.env.GEMINI_MODEL_FALLBACK || "gemini-1.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CLINIC_SITE_URL = process.env.CLINIC_SITE_URL || "";
const SCRAPE_TTL_MS = 6 * 60 * 60 * 1000;       // 6h cache sitio
const INFO_TEXT_TTL_MS = 2 * 60 * 60 * 1000;    // 2h cache textos

const CLINIC_NAME = process.env.CLINIC_NAME || "No disponible.";
const CLINIC_ADDRESS = process.env.CLINIC_ADDRESS || "No disponible.";
const CLINIC_MAPS_URL = process.env.CLINIC_MAPS_URL || "No disponible.";
const CLINIC_HOURS = process.env.CLINIC_HOURS || "No disponible.";
const EMERGENCY_NOTE = process.env.EMERGENCY_NOTE || "No disponible.";

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "5217779313920"; // sin '+'

// Calendar
const TIMEZONE = process.env.TIMEZONE || "America/Mexico_City";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback";

// Trigger para grupos
const GROUP_TRIGGER = (process.env.GROUP_TRIGGER || "!psico").toLowerCase();

// 🚫 Números a ignorar (si los necesitas)
const IGNORED_NUMBERS = [];

/* ================  FETCH COMPAT  =================== */
async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch;
}

/* ====================  GEMINI  ===================== */
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
function getModel(name) { 
  if (!genAI) throw new Error("Falta GEMINI_API_KEY");
  return genAI.getGenerativeModel({ model: name }); 
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffMs(attempt) { const base = 500 * Math.pow(2, attempt); const jitter = base * (Math.random() * 0.5 - 0.25); return Math.max(250, Math.floor(base + jitter)); }
async function generateWithGemini(content, { tries = 4 } = {}) {
  if (!genAI) return ""; // si no hay clave, devolvemos vacío y usamos copys estáticos
  let lastErr; let modelName = MODEL_PRIMARY;
  for (let i = 0; i < tries; i++) {
    try {
      const model = getModel(modelName);
      const res = await model.generateContent(content);
      const text = res?.response?.text?.();
      if (text && text.trim()) return text.trim();
      throw new Error("Respuesta vacía del modelo");
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isOverloaded = /503|overloaded|temporarily|unavailable/i.test(msg);
      const isRate = /429|rate|quota/i.test(msg);
      const retriable = isOverloaded || isRate || /ECONNRESET|ETIMEDOUT|fetch/i.test(msg);
      if (i === 1) modelName = MODEL_FALLBACK;
      if (retriable && i < tries - 1) { await delay(backoffMs(i)); continue; }
      throw err;
    }
  }
  throw lastErr;
}

/* ==========  WHATSAPP CLIENT  ========== */
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bot-psicologia" }),
  puppeteer: {
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

/* ==========  SESIONES EN MEMORIA  ========== */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() });
  const s = sessions.get(chatId); s.last = Date.now(); return s;
}
function setState(chatId, state, patch = {}) {
  const s = getSession(chatId); s.state = state; s.data = { ...s.data, ...patch };
}
function reset(chatId) { sessions.set(chatId, { state: "IDLE", data: {}, last: Date.now() }); }

/* ==========  UTILS TEXTO  ========== */
const isGreeting = (text) => !!text && /\b(hola|buenos dias|buenas|buenas tardes|buenas noches)\b/i.test(text.trim());
const isCancel = (text) => !!text && ["menú", "menu", "salir", "inicio"].includes(text.toLowerCase().trim());
const onlyDigits = (s) => (s || "").replace(/\D/g, "");
const isYes = (t) => /\b(si|sí|correcto|confirmo|ok|de acuerdo|así es|vale)\b/i.test((t||"").trim());
const isNo  = (t) => /\b(no|negativo|cambiar|no es|otra|equivocado)\b/i.test((t||"").trim());

/* ==========  COPYS Y MENÚ  ========== */
const WELCOME_MENU =
  `🤖 Gracias por contactar a *${CLINIC_NAME}*.\n` +
  "¿En qué puedo apoyarte hoy?\n\n" +
  "1. Agendar cita\n" +
  "2. Conocer la ubicación del consultorio\n" +
  "3. Horarios de servicio\n" +
  "4. Tengo una emergencia / hablar con la psicóloga\n" +
  "5. Olvidé mi cita / perdí el link de la reunión\n" +
  "6. Conocer la información de las terapias\n" +
  "7. Atención a empresas\n\n" +
  "_Escribe el número de la opción, o `menú` para volver aquí._";

const EMERGENCY_COPY =
  `⚠️ *Importante*: ${EMERGENCY_NOTE}\n\n` +
  "Si deseas hablar con la psicóloga, en breve te atenderán por este medio.";

const HOURS_COPY =
  `🕒 *Horarios de servicio*\n${CLINIC_HOURS}\n\n` +
  "¿Deseas *agendar una cita*? Responde *1*.\nEscribe *menú* para regresar.";

const LOCATION_COPY =
  `📍 *Ubicación del consultorio*\n${CLINIC_ADDRESS}\n\n` +
  `Mapa: ${CLINIC_MAPS_URL}\n\n` +
  "Si necesitas referencias adicionales, con gusto te apoyamos.";

const THERAPIES_STATIC =
"Presencial o remota\n\n" +
  "🧠 *Terapias e intervención*\n" +
  "• Terapia individual (ansiedad, depresión, autoestima)\n" +
  "• Terapia de pareja\n" +
  "• Terapia adolescentes mayores de 15 años\n" +
 
  "¿Te gustaría *agendar*? Responde *1* o escribe *menú*.";

/* ==========  SCRAPER (opcional, si hay sitio)  ========== */
let siteCache = { text: "", at: 0 };
async function scrapeClinicText() {
  if (!CLINIC_SITE_URL) return "";
  const now = Date.now();
  if (siteCache.text && now - siteCache.at < SCRAPE_TTL_MS) return siteCache.text;
  const _fetch = await getFetch();
  const res = await _fetch(CLINIC_SITE_URL, { redirect: "follow" });
  if (!res.ok) return "";
  const html = await res.text();
  const $ = cheerio.load(html);
  ["script", "style", "noscript", "svg"].forEach((sel) => $(sel).remove());
  const mainText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  siteCache = { text: mainText, at: now };
  return mainText;
}

/* ==========  INFO TERAPIAS (Gemini + cache)  ========== */
let therapiesCache = { text: "", at: 0 };
async function buildTherapiesInfo() {
  const now = Date.now();
  if (therapiesCache.text && now - therapiesCache.at < INFO_TEXT_TTL_MS) return therapiesCache.text;

  try {
    const siteText = await scrapeClinicText();
    if (!siteText || !genAI) { // sin sitio o sin gemini -> estático
      therapiesCache = { text: THERAPIES_STATIC, at: now };
      return THERAPIES_STATIC;
    }
    const prompt =
      `=== TEXTO DEL SITIO (recortado) ===\n${siteText}\n=== FIN ===\n\n` +
      `Eres recepcionista de ${CLINIC_NAME}. Usa SOLO lo anterior para redactar (3–6 líneas) ` +
      "un resumen de *terapias/servicios* (en español, cálido y claro). Evita inventar.";
    const out = await generateWithGemini(prompt, { tries: 4 });
    const text = (out && out.trim()) ? out.trim() : THERAPIES_STATIC;
    therapiesCache = { text, at: now };
    return text;
  } catch {
    therapiesCache = { text: THERAPIES_STATIC, at: now };
    return THERAPIES_STATIC;
  }
}

/* ==========  MEDIA LOCAL  ========== */
// ✅ Solo Opción 2 enviará imagen. Horarios y Terapias serán SOLO TEXTO.
function mediaFrom(file) { 
  return MessageMedia.fromFilePath(path.resolve(__dirname, "assets", file)); 
}
function getImgUbicacion() { return mediaFrom("Ubicacion.png"); } // ← Imagen fija para ubicación

/* ==========  AVISOS AL ADMIN  ========== */
async function sendToAdmin(messageText) {
  try {
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
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = f.formatToParts(new Date());
  const y = parts.find(p => p.type==='year')?.value || '1970';
  const m = parts.find(p => p.type==='month')?.value || '01';
  const d = parts.find(p => p.type==='day')?.value || '01';
  return new Date(`${y}-${m}-${d}T00:00:00`);
}
function addDays(date, days){ const d=new Date(date); d.setDate(d.getDate()+days); return d; }
function toISODateLocal(date){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
const WEEKDAYS = { 'domingo':0,'lunes':1,'martes':2,'miércoles':3,'miercoles':3,'jueves':4,'viernes':5,'sábado':6,'sabado':6 };
const MONTHS = { 'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,'julio':7,'agosto':8,'septiembre':9,'setiembre':9,'octubre':10,'noviembre':11,'diciembre':12 };

/* ======== Parser de fecha ======== */
async function parseDateSmart(input) {
  const txt = (input||'').toLowerCase().trim();
  const base = todayInTZ(TIMEZONE);

  if (/\b(hoy)\b/.test(txt)) return { isoDate: toISODateLocal(base), readable: 'hoy' };
  if (/\b(pasado\s+mañana|pasado\s+manana)\b/.test(txt)) { const d = addDays(base, 2); return { isoDate: toISODateLocal(d), readable: 'pasado mañana' }; }
  if (/\b(mañana|manana)\b/.test(txt)) { const d = addDays(base, 1); return { isoDate: toISODateLocal(d), readable: 'mañana' }; }

  const mDia = txt.match(/\b(próximo|proximo|este|esta)\s+(domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/);
  if (mDia) {
    const wd = WEEKDAYS[mDia[2]]; const todayWD = base.getDay();
    let delta = (wd - todayWD + 7) % 7;
    if (delta === 0 || mDia[1].startsWith('próximo') || mDia[1].startsWith('proximo')) delta = (delta===0?7:delta);
    const d = addDays(base, delta); return { isoDate: toISODateLocal(d), readable: `${mDia[1]} ${mDia[2]}` };
  }

  let m = txt.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?\b/);
  if (m) {
    let [_, dd, mm, yyyy] = m; dd = parseInt(dd,10); mm = parseInt(mm,10); yyyy = yyyy?parseInt(yyyy,10):base.getFullYear();
    const candidate = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    const inPast = new Date(candidate) < new Date(`${toISODateLocal(base)}T00:00:00`);
    const finalDate = (!m[3] && inPast) ? new Date(`${yyyy+1}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`) : candidate;
    return { isoDate: toISODateLocal(finalDate), readable: `${dd}/${mm}${m[3]?`/${yyyy}`:''}` };
  }

  m = txt.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/);
  if (m) {
    let dd = parseInt(m[1],10); let mm = MONTHS[m[2]]; let yyyy = m[3] ? parseInt(m[3],10) : base.getFullYear();
    let candidate = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    if (!m[3] && candidate < base) candidate = new Date(`${yyyy+1}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T00:00:00`);
    return { isoDate: toISODateLocal(candidate), readable: `${dd} de ${m[2]}${m[3]?` de ${yyyy}`:''}` };
  }

  // Sin LLM, devolvemos vacío
  return { isoDate: null, readable: null };
}

/* ======== Parser de hora ======== */
function toTwo(n){ return String(n).padStart(2,'0'); }
function parseTimeByRules(input) {
  if (!input) return { isoTime: null, readable: null };
  const t = input.toLowerCase().trim().replace(/\s+/g,' ').replace(/[\.]/g,'');
  if (/\b(medio ?d[ií]a|mediod[ií]a)\b/.test(t)) return { isoTime: "12:00", readable: "mediodía" };
  if (/\b(media ?noche|medianoche)\b/.test(t))   return { isoTime: "00:00", readable: "medianoche" };
  let m = t.match(/\b(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/);
  if (m) { let h = parseInt(m[1],10); let mm = parseInt(m[2] ?? "0",10); const suf = m[3]; if (h === 12 && suf === 'am') h = 0; else if (h !== 12 && suf === 'pm') h += 12; if (h>23 || mm>59) return { isoTime:null, readable:null }; return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` }; }
  m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) { let h = parseInt(m[1],10); let mm = parseInt(m[2],10); if (h>23 || mm>59) return { isoTime:null, readable:null }; return { isoTime: `${toTwo(h)}:${toTwo(mm)}`, readable: `${toTwo(h)}:${toTwo(mm)}` }; }
  m = t.match(/\b(\d{1,2})\b/);
  if (m) { let h = parseInt(m[1],10); if (h>=0 && h<=23) { if (h>=1 && h<=11) h += 12; return { isoTime: `${toTwo(h)}:00`, readable: `${toTwo(h)}:00` }; } }
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
  const calendar = getCalendarClient();
  const res = await calendar.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, timeZone: TIMEZONE, items: [{ id: GOOGLE_CALENDAR_ID }] },
  });
  const busy = res.data.calendars[GOOGLE_CALENDAR_ID]?.busy || [];
  return busy.length === 0;
}
async function createCalendarEvent({ summary, description, startISO, endISO }) {
  const calendar = getCalendarClient();
  const event = {
    summary, description,
    start: { dateTime: startISO, timeZone: TIMEZONE },
    end:   { dateTime: endISO,   timeZone: TIMEZONE },
  };
  const res = await calendar.events.insert({ calendarId: GOOGLE_CALENDAR_ID, requestBody: event });
  return res.data;
}

/* ==================  EVENTOS WPP  ==================== */
client.on("qr", (qr) => { require("qrcode-terminal").generate(qr, { small: true }); console.log("📲 Escanea el QR (grupos requieren trigger:", GROUP_TRIGGER, ")"); });
client.on("ready", () => console.log("Bot listo ✅"));
client.on("authenticated", () => console.log("✅ Autenticado"));
client.on("auth_failure", (m) => console.error("❌ Fallo de auth:", m));
client.on("disconnected", (r) => console.error("🔌 Desconectado:", r));

/* ==================  HANDLER MSG  ==================== */
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;

    const chatId = msg.from;

    // Ignorados
    if (IGNORED_NUMBERS.includes(chatId)) {
      console.log(`⚠️ Mensaje ignorado de ${chatId}`);
      return;
    }

    const isGroup = chatId.endsWith("@g.us");
    let text = (msg.body || "").trim();
    const lower = text.toLowerCase();

    // --- Reglas para grupos: solo con trigger o "gemini"
    if (isGroup) {
      const triggered = lower.startsWith(GROUP_TRIGGER) || lower.startsWith("gemini");
      if (!triggered) {
        console.log(`🤫 Ignorado grupo ${chatId} (sin trigger): ${text}`);
        return;
      }
      if (lower.startsWith(GROUP_TRIGGER)) {
        text = text.slice(GROUP_TRIGGER.length).trim();
        if (!text) {
          await msg.reply(`👋 Escribe tu consulta después de "${GROUP_TRIGGER}". Ej: *${GROUP_TRIGGER} hola*`);
          return;
        }
      }
    }

    // Comando libre: gemini ...
    if (text.toLowerCase().startsWith("gemini")) {
      try {
        const out = await generateWithGemini(text.slice(6).trim() || "Hola, ¿en qué te ayudo?");
        await msg.reply(out && out.length > 0 ? (out.length > 4000 ? out.slice(0, 4000) + "…" : out) : "🙂");
      } catch {
        await msg.reply("⚠️ El modelo está ocupado. Intentémoslo más tarde.");
      }
      return;
    }

    // Globales
    if (isCancel(text) || isGreeting(text)) {
      reset(chatId);
      await msg.reply(WELCOME_MENU);
      return;
    }

    // Flujo por estado
    const session = getSession(chatId);

    switch (session.state) {
      case "IDLE": {
        if (/^[1-7]$/.test(text)) {
          const n = text;

          if (n === "1") {
            await msg.reply("📅 *Agendar cita*\nPaso 1/4: Indícame tu *nombre completo*.");
            setState(chatId, "CITA_NOMBRE");
            return;
          }

          if (n === "2") {
            // ✅ SOLO opción 2 envía imagen
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
            const aviso =
              "🚨 *ALERTA EMERGENCIA / HUMANO*\n" +
              `• Cliente (chatId): ${chatId}`;
            await sendToAdmin(aviso);
            setState(chatId, "HUMANO");
            return;
          }

          if (n === "5") {
            await msg.reply("🔗 *Recuperar cita/link*\nPaso 1/2: Escríbeme tu *nombre completo* como aparece en tu cita.");
            setState(chatId, "FORGOT_NAME");
            return;
          }

          if (n === "6") {
            // 📝 SOLO TEXTO (sin imagen)
            const info = await buildTherapiesInfo();
            await msg.reply(info);
            setState(chatId, "INFO_TERAPIAS");
            return;
          }

          if (n === "7") {
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
          // Si escriben otra cosa en IDLE, mostramos menú
          await msg.reply(WELCOME_MENU);
        }
        return;
      }

      /* ====== TERAPIAS ====== */
      case "INFO_TERAPIAS": {
        await msg.reply("¿Te gustaría *agendar* una consulta? Responde *1*, o escribe *menú* para regresar.");
        return;
      }

      /* ====== EMPRESAS ====== */
      case "EMPRESAS_CONFIRM": {
        if (isYes(text)) {
          await msg.reply("Perfecto, una asesora te contactará. ¿Podrías compartir *nombre de tu empresa* y un *teléfono* de contacto?");
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
        await msg.reply("¡Gracias! Compartimos tus datos con el equipo y te contactarán pronto. Escribe *menú* para volver.");
        setState(chatId, "IDLE");
        return;
      }

      /* ===== Recuperar cita / link ===== */
      case "FORGOT_NAME": {
        setState(chatId, "FORGOT_DATE", { forgotName: text });
        await msg.reply("Paso 2/2: ¿Recuerdas *fecha aproximada* de tu cita? (ej.: *lunes*, *ayer*, *15/09*). Si no, escribe *no sé*.");
        return;
      }
      case "FORGOT_DATE": {
        const approx = text.toLowerCase();
        const data = getSession(chatId).data;
        const aviso =
          "🔗 *RECUPERAR CITA/LINK*\n" +
          `• Cliente: ${chatId}\n` +
          `• Nombre: ${data.forgotName}\n` +
          `• Fecha aprox: ${approx}`;
        await sendToAdmin(aviso);
        await msg.reply("Gracias. Revisaremos tu registro y te compartiremos el enlace o confirmación. Escribe *menú* para volver.");
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
        try { parsed = await parseDateSmart(text); } catch {}
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
        try { parsed = await parseTimeSmart(text); } catch {}
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
          const { nombre, fechaISO, horaISO } = data;
          const startLocal = new Date(`${fechaISO}T${horaISO}:00`);
          const endLocal   = new Date(startLocal.getTime() + 60 * 60 * 1000);
          const startISO   = startLocal.toISOString();
          const endISO     = endLocal.toISOString();
          try {
            const free = await isSlotFree(startISO, endISO);
            if (!free) {
              await msg.reply("⛔ Ese horario ya está ocupado. ¿Propones otra *fecha* u *hora*?");
              setState(chatId, "CITA_FECHA_FREEFORM");
              return;
            }
            const event = await createCalendarEvent({
              summary: `Cita (psicología) con ${nombre}`,
              description: `Cita agendada vía WhatsApp (${chatId}).`,
              startISO, endISO,
            });
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
            console.error("Error Calendar:", e?.message || e);
            await msg.reply("⚠️ No pude verificar/crear la cita en Calendar. Intenta más tarde o escribe *4* para asistencia.");
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
        await msg.reply("En breve te atenderá una psicóloga. 🙌");
        return;
      }
    }
  } catch (error) {
    console.error("Error en handler:", error);
    try { await msg.reply("⚠️ Ocurrió un error. Escribe *hola* para ver el menú."); } catch {}
  }
});

client.initialize();
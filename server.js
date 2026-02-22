// ═══════════════════════════════════════════════════════════
// My Dish Recipes – Chatbot Backend v2
// Smart, günstig, live Rezepte, WhatsApp-Benachrichtigungen
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
const SITE_URL = process.env.SITE_URL || 'https://mydishrecipes.com';
const WP_API = process.env.WP_API_URL || `${SITE_URL}/wp-json/wp/v2`;

const twilioClient = TWILIO_SID ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

// ═══════════════════════════════════════════════════════════
// LIVE REZEPT-CACHE (spart API-Kosten + hält alles aktuell)
// ═══════════════════════════════════════════════════════════
let recipesCache = [];
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten – fängt neue Rezepte schnell

async function getRecipes() {
  const now = Date.now();
  if (recipesCache.length > 0 && (now - cacheTimestamp) < CACHE_TTL) {
    return recipesCache;
  }

  try {
    // WordPress REST API – Rezepte laden
    // Passe die URL an dein Setup an (Custom Post Type, Kategorien, etc.)
    const res = await fetch(
      `${WP_API}/posts?per_page=100&orderby=date&order=desc&_fields=id,title,slug,excerpt,date,categories,tags,featured_media`,
      { timeout: 5000 }
    );

    if (!res.ok) throw new Error(`WP API ${res.status}`);
    const posts = await res.json();

    recipesCache = posts.map(p => ({
      id: p.id,
      title: p.title?.rendered || '',
      slug: p.slug,
      url: `/${p.slug}`,
      excerpt: (p.excerpt?.rendered || '').replace(/<[^>]*>/g, '').trim().slice(0, 120),
      date: p.date,
      categories: p.categories || [],
      tags: p.tags || [],
    }));

    cacheTimestamp = now;
    console.log(`[Cache] ${recipesCache.length} Rezepte geladen`);

  } catch (err) {
    console.error('[Cache] WP-Fehler:', err.message);
    // Bei Fehler: alten Cache behalten, kein Crash
  }

  return recipesCache;
}

// Beim Start einmal laden
getRecipes();

// ─── SYSTEM PROMPT BUILDER (dynamisch mit aktuellen Rezepten) ──
async function buildSystemPrompt(lang) {
  const recipes = await getRecipes();
  const recipeList = recipes.slice(0, 50).map(r =>
    `- "${r.title}" → ${r.url} (${r.excerpt})`
  ).join('\n');

  const langInstructions = {
    de: 'Antworte auf Deutsch.',
    en: 'Reply in English.',
    tr: 'Türkçe cevap ver.',
    ar: 'أجب بالعربية.',
    fr: 'Réponds en français.',
    es: 'Responde en español.',
  };

  return `Du bist der Rezept-Assistent von "My Dish Recipes" (${SITE_URL}).
${langInstructions[lang] || langInstructions.en}

PERSÖNLICHKEIT:
- Freundlich, warmherzig, food-begeistert
- Frag zuerst: "Worauf hast du Appetit?" oder "Welche Zutaten hast du?"
- Halte Antworten kurz (2-3 Sätze + Rezeptkarten)

FÄHIGKEITEN:
1. REZEPTE EMPFEHLEN basierend auf: Zutaten, Wünschen (leicht/deftig/schnell), Anlass, Ernährung
2. EINKAUFSLISTE erstellen für jedes Rezept
3. KOCHTIPPS geben
4. ZUTATEN-BASIERTE SUCHE: User nennt was er hat → du findest passende Rezepte

FORMAT für Rezeptempfehlungen (IMMER nutzen):
[RECIPE]{"title":"Name","emoji":"🍝","desc":"Kurze Beschreibung","time":"30 Min","difficulty":"Einfach","url":"/slug"}[/RECIPE]

FORMAT für Einkaufslisten:
[SHOPLIST]{"title":"Einkaufsliste für X","items":["200g Spaghetti","4 Eier","150g Speck"]}[/SHOPLIST]

AKTUELLE REZEPTE (Empfehle NUR aus dieser Liste):
${recipeList}

REGELN:
- Empfehle NUR Rezepte die in der Liste oben stehen
- Die URL muss exakt stimmen
- Maximal 3 Rezepte pro Antwort
- Bei "Einkaufsliste" → erstelle sie mit [SHOPLIST]
- Bleib beim Thema Kochen/Rezepte
- Wenn jemand Zutaten nennt, finde das beste passende Rezept`;
}

// ─── DEEPSEEK API CALL ───────────────────────────────────
async function callAI(messages, lang) {
  const systemPrompt = await buildSystemPrompt(lang || 'de');

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-10), // Nur letzte 10 Nachrichten → spart Tokens
      ],
      max_tokens: 600,   // Kurze Antworten = günstig
      temperature: 0.6,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ═══════════════════════════════════════════════════════════
// ROUTE: Web Chat
// ═══════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, lang } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages[] required' });
    }
    const reply = await callAI(messages, lang);
    res.json({ reply });
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ reply: 'Entschuldigung, bitte versuche es nochmal!' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE: WhatsApp Webhook (Twilio)
// ═══════════════════════════════════════════════════════════
const waSessions = new Map();
const WA_MAX_HISTORY = 16;

app.post('/api/whatsapp', async (req, res) => {
  try {
    const msg = req.body.Body;
    const from = req.body.From;
    if (!msg || !from) return res.status(400).end();

    console.log(`[WA] ${from}: ${msg}`);

    // Session
    if (!waSessions.has(from)) waSessions.set(from, []);
    const hist = waSessions.get(from);
    hist.push({ role: 'user', content: msg });
    if (hist.length > WA_MAX_HISTORY) hist.splice(0, hist.length - WA_MAX_HISTORY);

    // Sprache aus Nachricht erraten (einfach)
    const lang = detectMsgLang(msg);

    const reply = await callAI(hist, lang);
    hist.push({ role: 'assistant', content: reply });

    // Format für WhatsApp
    const waReply = formatWA(reply);

    if (twilioClient) {
      await twilioClient.messages.create({
        from: TWILIO_WA,
        to: from,
        body: waReply,
      });
    }

    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

  } catch (err) {
    console.error('[WA]', err.message);
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  }
});

// ═══════════════════════════════════════════════════════════
// WhatsApp: Neue Rezepte benachrichtigen
// ═══════════════════════════════════════════════════════════

// Subscriber-Liste (in Produktion: Datenbank nutzen!)
const waSubscribers = new Set();
let lastKnownRecipeId = null;

// User kann sich anmelden mit "SUBSCRIBE" / abmelden mit "STOP"
app.post('/api/whatsapp', (req, res, next) => {
  const msg = (req.body.Body || '').trim().toUpperCase();
  const from = req.body.From;

  if (msg === 'SUBSCRIBE' || msg === 'START') {
    waSubscribers.add(from);
    if (twilioClient) {
      twilioClient.messages.create({
        from: TWILIO_WA, to: from,
        body: '✅ Du bekommst jetzt Benachrichtigungen über neue Rezepte! Sende STOP zum Abmelden.',
      });
    }
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  if (msg === 'STOP' || msg === 'UNSUBSCRIBE') {
    waSubscribers.delete(from);
    if (twilioClient) {
      twilioClient.messages.create({
        from: TWILIO_WA, to: from,
        body: '👋 Benachrichtigungen deaktiviert. Sende START um sie wieder zu aktivieren.',
      });
    }
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  next(); // Weiter zum normalen Chat-Handler
});

// Periodisch prüfen ob neue Rezepte da sind (alle 15 Minuten)
setInterval(async () => {
  if (!twilioClient || waSubscribers.size === 0) return;

  try {
    const recipes = await getRecipes();
    if (recipes.length === 0) return;

    const newest = recipes[0]; // Sortiert nach Datum DESC
    if (lastKnownRecipeId === null) {
      lastKnownRecipeId = newest.id;
      return;
    }

    if (newest.id !== lastKnownRecipeId) {
      // Neues Rezept gefunden!
      lastKnownRecipeId = newest.id;
      const msg = `🍽️ *Neues Rezept!*\n\n` +
        `*${newest.title}*\n` +
        `${newest.excerpt}\n\n` +
        `👉 ${SITE_URL}${newest.url}\n\n` +
        `_Sende STOP um Benachrichtigungen zu deaktivieren._`;

      for (const sub of waSubscribers) {
        try {
          await twilioClient.messages.create({
            from: TWILIO_WA, to: sub, body: msg,
          });
          console.log(`[WA-Notify] Sent to ${sub}`);
        } catch (e) {
          console.error(`[WA-Notify] Failed for ${sub}:`, e.message);
          // Bei Fehler ggf. Subscriber entfernen
        }
      }
    }
  } catch (err) {
    console.error('[WA-Notify]', err.message);
  }
}, 15 * 60 * 1000); // alle 15 Min

// ═══════════════════════════════════════════════════════════
// ROUTE: Widget Ein/Aus (Admin-Toggle)
// ═══════════════════════════════════════════════════════════
let widgetEnabled = true;

app.get('/api/widget/status', (req, res) => {
  res.json({ enabled: widgetEnabled });
});

// Einfacher Admin-Toggle (in Produktion: Auth hinzufügen!)
app.post('/api/widget/toggle', (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  widgetEnabled = !widgetEnabled;
  console.log(`[Widget] ${widgetEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: widgetEnabled });
});

// ═══════════════════════════════════════════════════════════
// ROUTE: Health
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const recipes = await getRecipes();
  res.json({
    status: 'ok',
    widget: widgetEnabled,
    recipes: recipes.length,
    waSubscribers: waSubscribers.size,
    cacheAge: Math.round((Date.now() - cacheTimestamp) / 1000) + 's',
  });
});

// ─── HELPERS ─────────────────────────────────────────────

function formatWA(reply) {
  const rr = /\[RECIPE\](.*?)\[\/RECIPE\]/gs;
  const sr = /\[SHOPLIST\](.*?)\[\/SHOPLIST\]/gs;
  const recipes = [], shops = [];
  let m;
  while ((m = rr.exec(reply)) !== null) try { recipes.push(JSON.parse(m[1])); } catch(e) {}
  while ((m = sr.exec(reply)) !== null) try { shops.push(JSON.parse(m[1])); } catch(e) {}

  let text = reply.replace(rr, '').replace(sr, '').trim();

  if (recipes.length > 0) {
    text += '\n';
    recipes.forEach(r => {
      text += `\n${r.emoji || '🍽️'} *${r.title}*\n`;
      if (r.desc) text += `${r.desc}\n`;
      text += `⏱ ${r.time || ''} · 📊 ${r.difficulty || ''}\n`;
      text += `👉 ${SITE_URL}${r.url}\n`;
    });
  }

  if (shops.length > 0) {
    shops.forEach(s => {
      text += `\n🛒 *${s.title || 'Einkaufsliste'}*\n`;
      (s.items || []).forEach(i => { text += `☐ ${i}\n`; });
    });
  }

  return text;
}

// Einfache Spracherkennung anhand häufiger Wörter
function detectMsgLang(msg) {
  const m = msg.toLowerCase();
  if (/\b(ich|und|oder|das|mit|ein|was|hast|habe|kochen|rezept|zutaten)\b/.test(m)) return 'de';
  if (/[\u0600-\u06FF]/.test(m)) return 'ar';
  if (/\b(ben|bir|ve|ne|var|yemek|tarif)\b/.test(m)) return 'tr';
  if (/\b(je|les|des|une|avec|recette)\b/.test(m)) return 'fr';
  if (/\b(yo|los|las|una|con|receta|quiero)\b/.test(m)) return 'es';
  return 'en';
}

// ─── STATIC + START ──────────────────────────────────────
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────┐
  │  🍽️  My Dish Recipes Chatbot v2      │
  │  Port: ${PORT}                             │
  │  Widget: ${widgetEnabled ? 'ON' : 'OFF'}                          │
  │  WP API: ${WP_API}  │
  └──────────────────────────────────────┘`);
});

// ═══════════════════════════════════════════════════════════
// My Dish Recipes – Chatbot Backend v4.3
// Autor: Younes Biane | mydishrecipes.com
// ═══════════════════════════════════════════════════════════
//
// ╔═════════════════════════════════════════════════════════╗
// ║  FÜR CLAUDE-CHATS:                                    ║
// ║                                                       ║
// ║  Diese Datei läuft auf Railway (Node.js), NICHT auf   ║
// ║  dem WordPress-Server! Änderungen hier müssen per     ║
// ║  Git-Push auf Railway deployed werden.                ║
// ║                                                       ║
// ║  SPRACHEN v4.3.0: de, en, fr, es, pt                 ║
// ║  ENTFERNT: tr, ar                                     ║
// ║                                                       ║
// ║  Sprache hinzufügen? Stellen in DIESER Datei:         ║
// ║  1. langMap{} (~Z.287): Sprach-Anweisung hinzufügen  ║
// ║  2. buildSystemPrompt() (~Z.340): Grammatik-Hinweis  ║
// ║  3. WhatsApp langMap (~Z.1005): Vorwahl→Sprache      ║
// ║                                                       ║
// ║  ENV-VARIABLEN (Railway):                             ║
// ║  DEEPSEEK_KEY, ELEVENLABS_KEY, WA_TOKEN, WA_PHONE_ID ║
// ║  WP_API_URL, SITE_URL, BOT_NAME, BOT_EMOJI           ║
// ╚═════════════════════════════════════════════════════════╝
//
// ARCHITEKTUR:
// ─────────────────────────────────────────────────────────
// 1. WEB-CHAT    POST /api/chat       → DeepSeek AI → JSON
// 2. WHATSAPP    POST /api/whatsapp   → Meta Cloud API
// 3. VOICE TTS   POST /api/voice      → ElevenLabs → MP3
// 4. STATS       GET  /api/stats      → Admin-Dashboard
// 5. HEALTH      GET  /api/health     → Server-Status
// 6. BROADCAST   POST /api/wa/broadcast → Wöchentl. WhatsApp
//
// VOICE-FLOW (ElevenLabs):
//   Userin spricht/tippt → /api/chat (voiceMode:true) → AI-Text
//   → /api/voice → ElevenLabs Multilingual v2 → MP3 Audio → Browser
//   → Fallback: Browser SpeechSynthesis (weibliche Stimme)
//
// REZEPT-LOGIK (3 Stufen):
//   Stufe 1: Rezept auf unserer Seite → Link + [RECIPE] Card
//   Stufe 2: Userin will Details → Zutaten + Schritte + Link
//   Stufe 3: Rezept NICHT bei uns → Allgemeines Rezept, KEINE fremden Links
//
// WHATSAPP-BROADCAST:
//   - Timezone-aware: Sendet nur 8:00-21:00 Ortszeit
//   - Duplicate-Lock: 30 Min globaler Lock pro Broadcast-Typ
//   - Personalisiert: Subscriber-Name + Sprache nach Vorwahl
//
// ENV-VARIABLEN (Railway Settings > Variables):
//   ┌─────────────────────────┬──────────────────────────────────────────┐
//   │ DEEPSEEK_API_KEY        │ DeepSeek Chat API Key                    │
//   │ DEEPSEEK_MODEL          │ Modell (default: deepseek-chat)          │
//   │ SITE_URL                │ WordPress Domain                         │
//   │ WP_API_URL              │ Rezepte REST-Endpoint                    │
//   │ ELEVENLABS_API_KEY      │ ElevenLabs TTS API Key                   │
//   │ ELEVENLABS_VOICE_ID     │ ElevenLabs Stimme (z.B. Sarah)           │
//   │ FISH_AUDIO_API_KEY      │ Fish Audio TTS API Key (Alternative)     │
//   │ FISH_AUDIO_VOICE_ID     │ Fish Audio Voice ID (Alternative)        │
//   │ META_WA_TOKEN           │ Meta WhatsApp Business Token              │
//   │ META_WA_PHONE_ID        │ WhatsApp Phone Number ID                  │
//   │ META_WA_VERIFY          │ Webhook Verify Token                      │
//   │ AMAZON_PRODUCTS_URL     │ Produkte-API (optional)                   │
//   └─────────────────────────┴──────────────────────────────────────────┘
//
// SICHERHEIT:
//   - Rate Limit: 20 req/min pro IP (Web-Chat + Voice)
//   - Body Limit: 50kb max
//   - Input: Max 2000 Zeichen/Nachricht, max 30 Messages/Session
//   - Sessions: Validierung von sessionId (Länge < 100)
//   - WhatsApp: 50 Nachrichten/Tag pro Nummer
//
// DEPLOYMENT:
//   GitHub → Railway (Auto-Deploy bei git push)
//   Plugin → WordPress Admin > Plugins > ZIP hochladen
// ═══════════════════════════════════════════════════════════

// ─── ABHÄNGIGKEITEN ──────────────────────────────────────
require('dotenv').config();           // .env Datei laden (Railway setzt ENV direkt)
const express = require('express');   // HTTP Server Framework
const cors = require('cors');         // Cross-Origin für WordPress→Railway Requests
const fetch = require('node-fetch');  // HTTP Client für DeepSeek, Meta, WordPress API

// ─── EXPRESS APP SETUP ───────────────────────────────────
const app = express();
app.use(cors());                                          // Erlaubt Requests von jeder Domain
app.use(express.json({ limit: '50kb' }));                 // JSON Body Parser mit Größenlimit
app.use(express.urlencoded({ extended: true, limit: '50kb' })); // URL-encoded Body Parser

// ─── RATE LIMITER (Schutz vor Missbrauch) ────────────────
// Einfaches In-Memory Rate Limit: max 20 Requests pro Minute pro IP.
// Gilt für /api/chat und /api/voice (die teuren AI-Endpoints).
// WhatsApp hat eigenes Limit über Meta API.
const rateLimits = new Map();         // IP → { count, ts }
const RATE_WINDOW = 60 * 1000;       // Zeitfenster: 1 Minute
const RATE_MAX = 20;                  // Max Requests in diesem Fenster

/**
 * Rate Limit Middleware
 * Prüft IP des Requests, zählt Requests pro Minute.
 * Bei Überschreitung: HTTP 429 Too Many Requests.
 */
function rateLimit(req, res, next) {
  // Railway/Cloudflare: Echte IP aus X-Forwarded-For Header
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, { count: 0, ts: now });
  const rl = rateLimits.get(ip);
  if (now - rl.ts > RATE_WINDOW) { rl.count = 0; rl.ts = now; } // Fenster zurücksetzen
  rl.count++;
  if (rl.count > RATE_MAX) return res.status(429).json({ error: 'Too many requests' });
  next();
}
// Rate Limit NUR auf teure Endpoints (AI + Voice)
app.use('/api/chat', rateLimit);
app.use('/api/voice', rateLimit);

// Alte Rate-Limit-Einträge aufräumen (alle 5 Min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, rl] of rateLimits) {
    if (now - rl.ts > RATE_WINDOW * 5) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── KONFIGURATION (alle aus ENV-Variablen) ──────────────
const PORT = process.env.PORT || 3000;                        // Railway setzt PORT automatisch
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;            // DeepSeek AI API Key
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'; // DeepSeek Chat Endpoint
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'; // Modell (default: deepseek-chat)
const SITE_URL = process.env.SITE_URL || 'https://mydishrecipes.com'; // WordPress-Domain
const WP_API = process.env.WP_API_URL || `${SITE_URL}/wp-json/mdr-chatbot/v1/recipes`; // Rezepte REST-API
const PRODUCTS_API = process.env.AMAZON_PRODUCTS_URL || '';    // Produkte-API (optional, für Affiliate)
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';    // ElevenLabs TTS API Key
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || ''; // ElevenLabs Voice ID
const FISH_AUDIO_KEY = process.env.FISH_AUDIO_API_KEY || '';    // Fish Audio TTS API Key
const FISH_AUDIO_VOICE = process.env.FISH_AUDIO_VOICE_ID || ''; // Fish Audio Voice ID

// WhatsApp Meta Cloud API Credentials
const META_WA_TOKEN = process.env.META_WA_TOKEN || '';         // Permanenter System User Token
const META_WA_PHONE_ID = process.env.META_WA_PHONE_ID || '';   // WhatsApp Business Phone Number ID
const META_WA_VERIFY = process.env.META_WA_VERIFY || 'mdr_verify_token'; // Webhook Verify Token

// ─── WHATSAPP CONVERSATION MEMORY ────────────────────────
// In-Memory Map: Telefonnummer → { msgs[], ts, userName, userLang, dailyCount, ... }
// Speichert die letzten 20 Nachrichten pro User für 24 Stunden.
// ACHTUNG: Daten gehen bei Railway Deploy/Restart verloren!
// Für persistente Daten → Redis oder Datenbank nötig (zukünftig).
const waConversations = new Map(); // phone → {msgs, ts, name, lang, ...}
const WA_HISTORY_MAX = 20;                    // Max Nachrichten pro Conversation
const WA_HISTORY_TTL = 24 * 60 * 60 * 1000;  // 24 Stunden Time-to-Live

// Abgelaufene Conversations automatisch entfernen (alle 30 Min)
setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of waConversations) {
    if (now - conv.ts > WA_HISTORY_TTL) waConversations.delete(phone);
  }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// LIVE REZEPT-CACHE
// ═══════════════════════════════════════════════════════════
let recipesCache = [];
let productsCache = [];
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten

async function getRecipes() {
  const now = Date.now();
  if (recipesCache.length > 0 && (now - cacheTimestamp) < CACHE_TTL) {
    return recipesCache;
  }

  try {
    // Custom REST Route – gibt bereits saubere Daten zurück
    const res = await fetch(WP_API, { timeout: 8000 });
    if (!res.ok) throw new Error(`WP API ${res.status}`);
    const data = await res.json();

    recipesCache = (data.recipes || []).map(r => ({
      id: r.id,
      title: r.title || '',
      url: r.url || '',
      excerpt: (r.excerpt || '').slice(0, 150),
      date: r.date,
    }));

    cacheTimestamp = now;
    console.log(`[Cache] ${recipesCache.length} Rezepte geladen`);

  } catch (err) {
    console.error('[Cache] WP-Fehler:', err.message);
  }

  // Auch Produkte laden wenn konfiguriert
  if (PRODUCTS_API) {
    try {
      const pres = await fetch(PRODUCTS_API, { timeout: 5000 });
      if (pres.ok) {
        const pdata = await pres.json();
        productsCache = pdata.products || [];
      }
    } catch (e) {
      console.error('[Cache] Produkte-Fehler:', e.message);
    }
  }

  return recipesCache;
}

// Beim Start einmal laden
getRecipes();

// ─── BRANDING CACHE (Bot-Name, Emoji, Blog-Name) ────────
let brandingCache = { bot_name: 'Lily', bot_emoji: '👩‍🍳', blog_name: 'My Dish Recipes' };
const BRANDING_API = process.env.BRANDING_API_URL || `${SITE_URL}/wp-json/mdr-chatbot/v1/branding`;

async function getBranding() {
  try {
    const res = await fetch(BRANDING_API, { timeout: 5000 });
    if (res.ok) {
      const data = await res.json();
      brandingCache = { ...brandingCache, ...data };
      console.log(`[Branding] ${brandingCache.bot_name} ${brandingCache.bot_emoji} @ ${brandingCache.blog_name}`);
    }
  } catch (e) {
    console.error('[Branding] Fehler:', e.message);
  }
}
getBranding();
// Branding alle 30 Min refreshen
setInterval(getBranding, 30 * 60 * 1000);

// ─── SYSTEM PROMPT (KERN des AI-Verhaltens) ─────────────
// Diese Funktion baut den gesamten System-Prompt für DeepSeek AI.
// Hier wird definiert WER Lily ist, WIE sie spricht, und WELCHE Rezepte sie kennt.
// 
// Prompt-Struktur:
//   1. Identität (persönliche Assistentin, nicht Mensch, nicht AI)
//   2. Geschlecht & Grammatik (weiblich, 6 Sprachen)
//   3. Sprache (auto-detect, GTranslate)
//   4. Persönlichkeit (warm, freundlich, ermutigend)
//   5. Rezept-Logik (3 Stufen: Link → Details → Allgemein)
//   6. Rezeptliste (aus WordPress REST API, cached)
//   7. Produkt-Integration (Amazon Affiliate, optional)
//
// ÄNDERN: Wenn Lily anders sprechen soll → hier anpassen.
async function buildSystemPrompt(lang, pageTitle, isRecipe) {
  const recipes = await getRecipes();
  const { bot_name: botName, bot_emoji: botEmoji, blog_name: blogName } = brandingCache;

  // ── Rezeptliste für den Prompt zusammenstellen ──
  // Wenn Admin Rezepte fixiert hat → nur diese zeigen
  // Sonst: Mix aus neuesten + zufälligen Rezepten (damit Bot variiert)
  const pinnedRecipeIds = (brandingCache.pinned_recipe_ids || '').split(',').map(s=>s.trim()).filter(Boolean);
  let promptRecipes = recipes;

  if (pinnedRecipeIds.length > 0) {
    // Admin hat bestimmte Rezepte vorgegeben → die zuerst, Rest dahinter
    const pinned = recipes.filter(r => pinnedRecipeIds.includes(String(r.id)));
    const rest = recipes.filter(r => !pinnedRecipeIds.includes(String(r.id)));
    promptRecipes = [...pinned, ...rest];
  } else {
    // Keine Vorgabe → Mix: 30 neueste + 30 zufällige (verhindert "immer das Gleiche")
    const newest = recipes.slice(0, 30);
    const older = recipes.slice(30);
    // Fisher-Yates Shuffle auf ältere Rezepte
    for (let i = older.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [older[i], older[j]] = [older[j], older[i]];
    }
    promptRecipes = [...newest, ...older.slice(0, 30)];
  }

  const recipeList = promptRecipes.slice(0, 60).map(r =>
    `• "${r.title}" | URL: ${r.url} | ${r.excerpt}`
  ).join('\n');

  // ── Produktliste separat (unabhängig vom Affiliate-Modul) ──
  // Stufe 1: Fixierte Produkte aus Admin-Panel (Blog-Review-URLs)
  // Stufe 2: Produkte aus PRODUCTS_API (Affiliate)
  // Stufe 3: Keine Produkte → kein PRODUKT-Block im Prompt
  const pinnedProducts = (brandingCache.pinned_products || '').trim();
  let productList = '';

  if (pinnedProducts) {
    // Admin hat Produkte fixiert → diese nutzen
    const items = pinnedProducts.split('\n').filter(Boolean).map(line => {
      const [name, url] = line.split('|').map(s => s.trim());
      return `• ${name}${url ? ` → ${SITE_URL}${url.startsWith('/') ? url : '/' + url}` : ''}`;
    });
    productList = '\n\nFIXIERTE PRODUKT-EMPFEHLUNGEN (Blog-Reviews):\n' + items.join('\n');
  } else if (productsCache.length > 0) {
    // Keine fixierten → Produkte aus API (wenn konfiguriert)
    productList = '\n\nVERFÜGBARE PRODUKTE (für Empfehlungen):\n' + productsCache.map(p =>
        `• ${p.name} (Kategorie: ${p.category || 'Allgemein'}, Kontext: ${p.context || ''})`
      ).join('\n');
  }

  const langMap = {
    de: 'Antworte immer auf Deutsch.',
    en: 'Always reply in English.',
    fr: 'Réponds toujours en français.',
    es: 'Responde siempre en español.',
    pt: 'Responde sempre em português.',
  };

  // Kontext: User ist auf einer bestimmten Rezeptseite
  let pageContext = '';
  if (isRecipe && pageTitle) {
    // Finde das Rezept in unserer Liste
    const currentRecipe = recipes.find(r => r.title.toLowerCase() === pageTitle.toLowerCase());
    pageContext = `
AKTUELLER KONTEXT:
Die Userin befindet sich gerade auf der Rezeptseite: "${pageTitle}"
${currentRecipe ? `URL: ${currentRecipe.url}\nBeschreibung: ${currentRecipe.excerpt}` : ''}

VERHALTEN AUF REZEPTSEITEN:
- Du weißt welches Rezept sie sich gerade anschaut
- Beantworte Fragen zu DIESEM Rezept direkt und spezifisch
- Bei "Einkaufsliste" → erstelle sie für DIESES Rezept
- Bei "Alternativen" → schlage Ersatzzutaten für DIESES Rezept vor
- Bei "ähnliche Rezepte" → empfehle verwandte Rezepte aus der Liste
- Du musst nicht fragen "welches Rezept?" – du weißt es bereits
`;
  }

  // ── Rezept-Verhalten klar definieren ──
  // Stufe 1: Rezept auf unserer Seite → Link + Details
  // Stufe 2: User will Details im Chat → Zutaten & Schritte aus unserem Rezept liefern
  // Stufe 3: Rezept NICHT bei uns → allgemeines Rezept-Wissen, KEINE fremden Links

  return `Du bist "${botName}" ${botEmoji}, die persönliche Kochassistentin von "${blogName}" (${SITE_URL}).

WICHTIG – DEINE IDENTITÄT:
- Du bist eine persönliche Kochassistentin. Punkt. Sage WEDER "ich bin eine KI" NOCH "ich bin ein Mensch".
- Wenn jemand fragt "Bist du echt/ein Mensch/eine KI?" → "Ich bin ${botName}, deine persönliche Kochassistentin! Wie kann ich dir helfen?" (KEINE weitere Erklärung!)
- ERFINDE NIEMALS persönliche Geschichten! VERBOTEN:
  ❌ "Das Rezept meiner Mutter...", "Gestern habe ich gekocht...", "Ich liebe dieses Gericht..."
  ❌ "Als Kind habe ich...", "Meine Familie kocht das immer...", "Mein persönliches Rezept..."
  ❌ "Mir schmeckt das...", "Ich esse am liebsten...", "Mein Geheimtipp von zu Hause..."
- Sage STATTDESSEN:
  ✅ "Ein beliebtes Rezept dafür ist...", "Hier ist ein tolles Rezept:", "Das wird super!"
  ✅ "Viele lieben dieses Gericht!", "Ein Klassiker der marokkanischen Küche:"
  ✅ "Probier mal diese Variante:", "Tipp: Wenn du ... hinzufügst, wird es noch besser!"
  ✅ "Ich empfehle dir...", "Ich schlage vor...", "Ein bewährtes Rezept:"
- Du DARFST warm, freundlich und persönlich sein – aber OHNE erfundene Lebensgeschichten.

GESCHLECHT & GRAMMATIK (SEHR WICHTIG für alle Sprachen!):
- Du (${botName}) bist WEIBLICH. Sprich IMMER in weiblicher Form über dich selbst.
- Deine Userinnen sind hauptsächlich FRAUEN. Sprich sie in weiblicher Form an.
- Das gilt für JEDE Sprache – besonders wichtig für:
  • Deutsch: Weibliche Anrede (Liebe, Süße) – du bist eine Köchin, Freundin, Assistentin
  • Englisch: Geschlechtsneutral ist OK, aber nutze weibliche Wärme (sweetie, lovely)
  • Französisch: Weibliche Formen (tu es prête?, ma chère, ta recette préférée)
  • Spanisch: Weibliche Formen (¿estás lista?, querida, tu receta favorita)
  • Portugiesisch: Formas femininas (estás pronta?, querida, a tua receita favorita)
- Über dich selbst: "Ich bin begeistert!" (du bist eine Frau)
- Beispiele: "Hast du Lust auf...?" / "¿Te gustaría...?" / "Tu veux...?"

SPRACHE:
- Die Startsprache ist: ${langMap[lang] || langMap.en}
- WICHTIG: Wenn in einer ANDEREN Sprache geschrieben wird, antworte SOFORT in dieser Sprache!
- Passe dich immer der letzten Nachricht an.
- Achte in JEDER Sprache auf die korrekte weibliche Grammatik!

DEINE PERSÖNLICHKEIT:
- Du bist ${botName}, eine leidenschaftliche Köchin und beste Freundin in der Küche
- Warmherzig, verständnisvoll, motivierend – wie eine Freundin die sagt "Das kriegst du locker hin!"
- Du verstehst den Alltag: wenig Zeit, Kinder, Meal Prep, gesund essen, Gäste beeindrucken
- Sprich persönlich und empathisch: "Ich weiß genau was du meinst!", "Oh das wird SO gut!"
- Nutze gelegentlich Emojis (nicht übertreiben): 😊🍳💕✨
- Halte Antworten KURZ (2-3 Sätze + Rezeptkarten) – niemand will einen Roman lesen
- Frag nach: Was hast du Lust drauf? Welche Zutaten hast du da?
- Wenn dir jemand etwas erzählt (Vegetarierin, Allergien, Kinder) → merke es dir!
- Sei ermutigend: "Das schaffst du!", nicht belehrend
- Gib praktische Tipps die im Alltag helfen

════════════════════════════════════════
REZEPT-LOGIK (WICHTIGSTE REGELN!)
════════════════════════════════════════

STUFE 1 – REZEPT AUF UNSERER SEITE VORHANDEN:
→ Zeige die Rezeptkarte mit Link zu unserer Seite.
→ Verwende das [RECIPE]-Format (Web) oder den vollständigen Link (WhatsApp).
→ Empfehle ihr, das volle Rezept auf unserer Seite anzuschauen.

STUFE 2 – USER WILL DETAILS IM CHAT (Zutaten, Schritte, Tipps):
→ Wenn das Rezept auf unserer Seite existiert: Gib die Zutaten und Zubereitungsschritte
  im Chat, basierend auf dem was du über das Rezept weißt. Sage dazu:
  "Das vollständige Rezept mit Bildern findest du hier: [Link]"
→ Erfinde KEINE Zutaten oder Schritte, die nicht zum Rezept gehören!

STUFE 3 – REZEPT NICHT AUF UNSERER SEITE:
→ Du darfst trotzdem helfen! Gib ein allgemeines Rezept mit:
  - Zutatenliste
  - Schritt-für-Schritt Anleitung
  - Tipps und Variationen
→ WICHTIG: ERFINDE KEINE URLs! Gib KEINEN Link zu fremden Websites!
→ NIEMALS externe Domains zitieren oder verlinken (kein chefkoch.de, kein allrecipes.com, etc.)
→ Sage: "Dieses Rezept haben wir noch nicht auf unserer Seite – aber hier ist mein Vorschlag:"
→ Gib dann ein sauberes, vollständiges Rezept im Chat.
→ Wenn möglich, empfehle ein ähnliches Rezept von unserer Seite dazu.

ABSOLUT VERBOTEN:
❌ Fremde Website-URLs oder Domains nennen (kein chefkoch, allrecipes, etc.)
❌ URLs erfinden die nicht in der Rezeptliste stehen
❌ Sagen "das kann ich nicht" wenn sie ein Rezept will das wir nicht haben
✅ Stattdessen: Allgemeines Koch-Wissen nutzen und Rezept im Chat liefern

REZEPT-FORMAT (NUR für Rezepte aus UNSERER Liste):
[RECIPE]{"title":"EXAKTER Titel aus Liste","emoji":"🍝","desc":"Kurzbeschreibung","time":"30 Min","difficulty":"Einfach","url":"EXAKTE URL aus Liste"}[/RECIPE]

EINKAUFSLISTEN-FORMAT:
[SHOPLIST]{"title":"Einkaufsliste für X","items":["200g Spaghetti","4 Eier","150g Speck"]}[/SHOPLIST]

${productList ? `PRODUKT-FORMAT (nur wenn es zum Rezept passt, NICHT bei jeder Antwort):
[PRODUCT]{"name":"Produktname","emoji":"🍳","reason":"Warum es passt","url":"BLOG_REVIEW_URL"}[/PRODUCT]
WICHTIG: Die URL muss auf unsere Blog-Review-Seite zeigen (${SITE_URL}/...), NICHT direkt auf Amazon!
Sie soll zuerst unseren Review lesen und kann dann von dort zu Amazon gehen.` : ''}

UNSERE REZEPTE (Links nur aus dieser Liste, URLs EXAKT übernehmen):
${recipeList || 'Keine Rezepte verfügbar.'}

VERHALTEN:
- Maximal 3 Rezepte pro Antwort
- URLs MÜSSEN exakt aus der Liste übernommen werden – NIEMALS erfinden!
- Bei "Einkaufsliste" → erstelle mit [SHOPLIST]
- Bleib beim Thema Kochen & Rezepte
- Sei freundlich, nicht roboterhaft
- Wenn User Zutaten nennt → finde das beste passende Rezept aus der Liste
- Wenn kein Rezept passt → liefere ein allgemeines Rezept (ohne fremde Links!)
${pageContext}`;
}

// ─── DEEPSEEK API CALL ───────────────────────────────────
async function callAI(messages, lang, pageTitle, isRecipe) {
  const systemPrompt = await buildSystemPrompt(lang || 'de', pageTitle, isRecipe);

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
        ...messages.slice(-10),
      ],
      max_tokens: 800,
      temperature: 0.5,  // Etwas weniger kreativ = genauer
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
// ROUTE: POST /api/chat – Web-Chat + Voice-Chat
// ═══════════════════════════════════════════════════════════
// Empfängt: { messages[], lang, pageTitle, isRecipe, sessionId, voiceMode }
// Gibt zurück: { reply: "AI Antwort" }
//
// Session-Tracking: Speichert Konversation per sessionId (1h TTL).
// Jede neue Nachricht wird an die Session angehängt → AI hat Kontext.
// voiceMode: true → Stats werden als Voice gezählt statt Web.
//
// Flow: Nachricht → Session laden → AI Prompt bauen → DeepSeek → Antwort
const webSessions = new Map(); // sessionId → { msgs, ts }
const WEB_SESSION_TTL = 60 * 60 * 1000; // 1 Stunde

// Web sessions aufräumen (alle 15 Min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of webSessions) {
    if (now - s.ts > WEB_SESSION_TTL) webSessions.delete(id);
  }
}, 15 * 60 * 1000);

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, lang, pageTitle, isRecipe, sessionId, voiceMode } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length > 30) {
      return res.status(400).json({ error: 'messages[] required (max 30)' });
    }
    // Sanitize: limit message content length
    const cleanMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '',
    })).filter(m => m.content.length > 0);

    // Session-Tracking: merge mit vorherigen Nachrichten
    let fullMessages = cleanMessages;
    if (sessionId && typeof sessionId === 'string' && sessionId.length < 100) {
      if (!webSessions.has(sessionId)) {
        webSessions.set(sessionId, { msgs: [], ts: Date.now() });
      }
      const session = webSessions.get(sessionId);
      session.ts = Date.now();

      // Neue Nachrichten hinzufügen
      const lastStored = session.msgs.length;
      if (cleanMessages.length > lastStored) {
        session.msgs = cleanMessages.slice();
      }
      if (session.msgs.length > 20) session.msgs = session.msgs.slice(-20);
      fullMessages = session.msgs;
    }

    const reply = await callAI(fullMessages, lang, pageTitle, isRecipe);

    // Antwort in Session speichern
    if (sessionId && webSessions.has(sessionId)) {
      webSessions.get(sessionId).msgs.push({ role: 'assistant', content: reply });
    }

    // Tracking: Voice oder Web-Chat Nutzung zählen
    if (voiceMode) {
      trackUsage(voiceChatStats);
    } else {
      trackUsage(webChatStats);
    }

    res.json({ reply });
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ reply: 'Entschuldigung, bitte versuche es nochmal!' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE: POST /api/voice – ElevenLabs Text-to-Speech
// ═══════════════════════════════════════════════════════════
// Empfängt: { text, lang }
// Gibt zurück: audio/mpeg (MP3 Buffer)
//
// Modell: eleven_multilingual_v2 → erkennt Sprache automatisch aus Text
// Voice: Aus ENV ELEVENLABS_VOICE_ID (Default: Sarah = EXAVITQu4vr4xnSDxMaL)
// Max 500 Zeichen pro Request (Kostenkontrolle)
// Bei Fehler: Client fällt auf Browser SpeechSynthesis zurück
app.post('/api/voice', async (req, res) => {
  try {
    const { text, lang, provider } = req.body;
    const useFish = provider === 'fishaudio';

    // Prüfe ob der gewählte Provider konfiguriert ist
    if (!text) return res.status(400).json({ error: 'No text' });
    if (useFish && !FISH_AUDIO_KEY) return res.status(400).json({ error: 'Fish Audio not configured' });
    if (!useFish && !ELEVENLABS_KEY) return res.status(400).json({ error: 'ElevenLabs not configured' });

    // Kürze Text auf max 500 Zeichen (Kostenkontrolle)
    const shortText = text.slice(0, 500);
    let ttsRes;

    if (useFish) {
      // ── Fish Audio TTS ──
      const voiceId = FISH_AUDIO_VOICE;
      console.log('[Voice] Fish Audio...', { textLen: shortText.length, voice: voiceId || 'default' });

      const ttsBody = { text: shortText, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'balanced' };
      if (voiceId) ttsBody.reference_id = voiceId;

      ttsRes = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FISH_AUDIO_KEY}` },
        body: JSON.stringify(ttsBody),
      });
    } else {
      // ── ElevenLabs Multilingual v2 (Default) ──
      const voiceId = ELEVENLABS_VOICE || 'EXAVITQu4vr4xnSDxMaL'; // Default: Sarah
      console.log('[Voice] ElevenLabs...', { textLen: shortText.length, voice: voiceId, lang });

      ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_KEY },
        body: JSON.stringify({
          text: shortText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
        }),
      });
    }

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error(`[Voice] ${useFish ? 'Fish Audio' : 'ElevenLabs'} error:`, ttsRes.status, err);
      return res.status(500).json({ error: 'TTS failed', detail: err });
    }

    // Audio zurück an Client
    res.set('Content-Type', 'audio/mpeg');
    const buffer = await ttsRes.buffer();
    console.log('[Voice] Success, audio size:', buffer.length, 'bytes');
    trackUsage(voiceChatStats);
    res.send(buffer);

  } catch (err) {
    console.error('[Voice] Exception:', err.message);
    res.status(500).json({ error: 'Voice error' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE: WhatsApp (Meta Cloud API)
// ═══════════════════════════════════════════════════════════
// GET  /api/whatsapp → Webhook Verification (Meta prüft einmalig)
// POST /api/whatsapp → Eingehende Nachrichten von Userinnen
// POST /api/wa/broadcast → Broadcasts (Rezepte/Affiliate, von WP-Cron)
//
// Konversation: In-Memory Map (Telefon → {msgs[], userName, userLang})
// Limit: 50 Nachrichten/Tag pro Nummer, 20 History Messages
// Sprache: Auto-detect aus Text, Fallback aus Vorwahl
// Broadcasts: Timezone-aware (8:00-21:00 Ortszeit), Duplicate-Lock 30 Min

// Webhook Verification (GET)
app.get('/api/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_WA_VERIFY) {
    console.log('[WA] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// Webhook Handler (POST) – empfängt Nachrichten
app.post('/api/whatsapp', async (req, res) => {
  // Sofort 200 an Meta zurück (sonst Retry-Schleife)
  res.status(200).send('OK');

  try {
    // Kann direkt von Meta kommen ODER von WordPress weitergeleitet
    let entry, value, msg, from, name;
    const raw = req.body?.raw_webhook || req.body;
    const settings = {
      chatLimit: req.body?.chat_limit || 0,
    };

    entry = raw?.entry?.[0];
    const changes = entry?.changes?.[0];
    value = changes?.value;
    if (!value?.messages?.[0]) return;

    msg = value.messages[0];
    from = msg.from;
    name = value.contacts?.[0]?.profile?.name || '';
    const type = msg.type;

    let userText = '';
    if (type === 'text') {
      userText = (msg.text?.body || '').slice(0, 2000); // Limit input
    } else if (type === 'audio') {
      userText = '[Der User hat eine Sprachnachricht gesendet. Antworte freundlich, frage was du helfen kannst. Erwähne dass du leider noch keine Sprachnachrichten verstehen kannst, aber gerne Textfragen beantwortest.]';
    } else if (type === 'interactive') {
      userText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    } else {
      userText = '[Nachricht vom Typ: ' + type + ']';
    }
    if (!userText) return;

    // Abo-Check
    const lower = userText.toLowerCase().trim();
    if (['stop','quit','abmelden','unsubscribe','abbestellen','arrêter','parar','durdur'].includes(lower)) {
      await sendWhatsApp(from, '✅ Du wurdest abgemeldet. Schreibe jederzeit "Hallo" um wieder dabei zu sein! 👋');
      try {
        await fetch(`${SITE_URL}/wp-json/mdr-chatbot/v1/wa/unsubscribe`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({phone:from}), timeout:5000,
        });
      } catch(e) {}
      return;
    }

    // Chat-Limit prüfen
    if (settings.chatLimit > 0) {
      const conv = waConversations.get(from);
      if (conv) {
        const today = new Date().toDateString();
        if (!conv.dailyCount || conv.dailyDate !== today) {
          conv.dailyCount = 0;
          conv.dailyDate = today;
        }
        conv.dailyCount++;
        if (conv.dailyCount > settings.chatLimit) {
          const lang = detectLangFromPhone(from);
          const limitMsgs = {
            de: `⏳ Du hast dein Tageslimit von ${settings.chatLimit} Nachrichten erreicht. Morgen geht es weiter!`,
            en: `⏳ You've reached your daily limit of ${settings.chatLimit} messages. Try again tomorrow!`,
            fr: `⏳ Vous avez atteint votre limite de ${settings.chatLimit} messages. Réessayez demain !`,
            es: `⏳ Has alcanzado tu límite de ${settings.chatLimit} mensajes. ¡Inténtalo mañana!`,
          };
          await sendWhatsApp(from, limitMsgs[lang] || limitMsgs.en);
          return;
        }
      }
    }

    // FIX v4.3.3: Auto-Subscribe entfernt!
    // WordPress handle_webhook() ruft auto_subscribe() + track() bereits auf.
    // Der zusätzliche Railway → WordPress /wa/subscribe Callback war redundant
    // und verursachte 3x update_option pro Nachricht (statt 2x).
    // Bei vielen gleichzeitigen Nachrichten: PHP-Worker-Exhaustion.

    // Conversation History – Name und Sprache merken
    if (!waConversations.has(from)) {
      waConversations.set(from, { msgs:[], ts:Date.now(), dailyCount:1, dailyDate:new Date().toDateString(), userName:name||'', userLang:'' });
    }
    const conv = waConversations.get(from);
    conv.ts = Date.now();
    if (name && !conv.userName) conv.userName = name; // Name merken
    conv.msgs.push({ role:'user', content:userText });
    if (conv.msgs.length > WA_HISTORY_MAX) conv.msgs = conv.msgs.slice(-WA_HISTORY_MAX);
    const isFirstContact = conv.msgs.filter(m => m.role === 'user').length === 1;

    // Sprache: erst aus Text erkennen, Fallback gespeichert, dann Vorwahl
    const textLang = detectLang(userText);
    const lang = textLang || conv.userLang || phoneLang;
    if (textLang) conv.userLang = textLang; // Sprache merken

    // AI Antwort
    const systemPrompt = await buildSystemPrompt(lang, '', false);
    const userName = conv.userName || name || '';
    const msgCount = conv.msgs.filter(m => m.role === 'user').length;
    const waSystemPrompt = systemPrompt + `

WHATSAPP-MODUS:
- Du antwortest via WhatsApp, NICHT im Web-Chat
- WICHTIG: Antworte IMMER in der Sprache der letzten Nachricht!
- Wenn User Deutsch schreibt → Deutsch. Englisch → Englisch. Französisch → Französisch. Etc.
- Halte Antworten KURZ (max 3-4 Sätze)
- KEINE [RECIPE], [SHOPLIST], [PRODUCT] Tags – nur einfacher Text
- Rezept-Links IMMER als vollständige URL mit Domain: ${SITE_URL}/rezept-slug/
- WICHTIG: Jeder Rezept-Link MUSS auf unsere Website zeigen (${SITE_URL}), damit Userinnen auf unsere Seite kommen!
- Einkaufslisten als • Aufzählung
- Wenn du Produkte empfiehlst, verlinke auf unsere BLOG-REVIEW-SEITE (${SITE_URL}/produkt-review/), NICHT direkt auf Amazon!

REZEPT-VERHALTEN IM WHATSAPP:
- Stufe 1: Wenn Rezept auf unserer Seite → Link geben: ${SITE_URL}/rezept-name/
- Stufe 2: Wenn User "zeig mir das Rezept" oder Details will → Zutaten + Schritte im Chat, PLUS Link
- Stufe 3: Wenn Rezept NICHT auf unserer Seite → Zutaten + Schritte im Chat, OHNE fremde Links
  Sage: "Das haben wir noch nicht auf unserer Seite, aber hier ist mein Rezept für dich:"
  Dann Zutaten + Schritte liefern. NIEMALS fremde Websites verlinken!

PERSÖNLICHKEIT & KONTEXT:
- Die Userin heißt: ${userName || 'unbekannt'}${userName ? ` – nutze den Namen gelegentlich persönlich (z.B. "Hey ${userName}!", "Gute Wahl, ${userName}!")` : ''}
- Das ist Nachricht Nr. ${msgCount} von ihr
${isFirstContact ? '- ERSTER KONTAKT: Begrüße sie herzlich, stelle dich als ihre Koch-Freundin vor, frage was sie kochen möchte.' : '- WIEDERKEHRENDE USERIN: Ihr kennt euch schon. Sei freundlich aber überspringe die Vorstellung. Beziehe dich auf den bisherigen Gesprächsverlauf.'}
- WICHTIG: Lies den bisherigen Chat-Verlauf genau! Wenn sie vorher etwas erwähnt hat (Zutaten, Vorlieben, Allergien, Geräte), erinnere dich daran und nutze es.
- Wenn sie z.B. gesagt hat "ich habe Hähnchen" und jetzt fragt "was noch?" → beziehe dich auf das Hähnchen!
- Merke dir Vorlieben: Wenn jemand sagt "ich bin Vegetarierin" oder "kein Schwein" → respektiere das in ALLEN folgenden Antworten
- GESCHLECHT: Du (${botName}) bist weiblich. Sprich die Userin in weiblicher Form an. Französisch/Spanisch/Portugiesisch: weibliche Formen.
- Sei warm, persönlich und wie eine beste Freundin die gerne kocht`;

    const aiRes = await fetch(DEEPSEEK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${DEEPSEEK_KEY}`},
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {role:'system', content:waSystemPrompt},
          ...conv.msgs.slice(-12),
        ],
        max_tokens: 600, temperature: 0.6,
      }),
    });

    if (!aiRes.ok) throw new Error(`DeepSeek ${aiRes.status}`);
    const aiData = await aiRes.json();
    let reply = aiData.choices[0].message.content;

    // Tags entfernen
    reply = reply.replace(/\[RECIPE\].*?\[\/RECIPE\]/gs,'')
                 .replace(/\[SHOPLIST\].*?\[\/SHOPLIST\]/gs,'')
                 .replace(/\[PRODUCT\].*?\[\/PRODUCT\]/gs,'')
                 .trim();

    conv.msgs.push({role:'assistant',content:reply});
    await sendWhatsApp(from, reply);
    trackUsage(waChatStats);

  } catch (err) {
    console.error('[WA] Error:', err.message);
  }
});

// WhatsApp Broadcast Endpoint (von WordPress Cron aufgerufen)
app.post('/api/wa/broadcast', async (req, res) => {
  try {
    const { type, recipes, subscribers, pinned_product, botName } = req.body;
    if (!subscribers || !Array.isArray(subscribers)) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }

    // ── Schutz gegen doppelte Broadcasts (30 Min Lock) ──
    const lockKey = `_broadcast_lock_${type}`;
    if (global[lockKey] && Date.now() - global[lockKey] < 30 * 60 * 1000) {
      console.log(`[WA Broadcast] ${type} BLOCKED – duplicate lock active`);
      return res.json({ sent: 0, total: subscribers.length, blocked: 'duplicate' });
    }
    global[lockKey] = Date.now();

    let sent = 0;

    if (type === 'weekly_recipes' && recipes) {
      for (const sub of subscribers) {
        const phone = sub.phone || sub;
        const lang = sub.lang || 'en';
        const name = sub.name || '';
        try {
          // Timezone-Check: nicht vor 8:00 oder nach 21:00 Ortszeit senden
          const tz = getTimezoneFromPhone(phone);
          const localHour = getLocalHour(tz);
          if (localHour < 8 || localHour > 21) {
            console.log(`[WA Broadcast] Skip ${phone} – ${localHour}h in ${tz}`);
            continue;
          }
          // EINE Nachricht: Begrüßung + Rezepte mit Links + Footer
          const msg = buildRecipeBroadcast(recipes, lang, botName || 'Lily', name);
          await sendWhatsApp(phone, msg);
          sent++;
          await new Promise(r => setTimeout(r, 200));
        } catch(e) {
          console.error(`[WA Broadcast] Failed ${phone}:`, e.message);
        }
      }
    }
    else if (type === 'weekly_affiliate') {
      // FIX v4.3.3: DeepSeek nur 1x PRO SPRACHE aufrufen, nicht pro Subscriber!
      // Vorher: 100 Subscriber = 100 API-Calls = 500s Blockade
      // Nachher: Max 5 API-Calls (5 Sprachen) = 25s
      const aiMsgCache = {}; // lang → message

      // Schritt 1: Für jede vorkommende Sprache EINE Nachricht generieren
      const langs = [...new Set(subscribers.map(s => s.lang || 'en'))];
      for (const lang of langs) {
        try {
          if (pinned_product && pinned_product.trim()) {
            aiMsgCache[lang] = buildPinnedProductMsg(pinned_product, lang);
          } else {
            const allRecipes = await getRecipes();
            const latest = allRecipes.slice(0,3).map(r=>r.title).join(', ');
            const langInstructions = {
              de:'auf Deutsch',en:'in English',
              fr:'en français',es:'en español',pt:'em português',
            };
            const aiRes = await fetch(DEEPSEEK_URL, {
              method:'POST',
              headers:{'Content-Type':'application/json','Authorization':`Bearer ${DEEPSEEK_KEY}`},
              body:JSON.stringify({
                model:DEEPSEEK_MODEL,
                messages:[{
                  role:'user',
                  content:`Erstelle eine kurze WhatsApp-Nachricht (max 3 Sätze) ${langInstructions[lang]||langInstructions.en} die EIN nützliches Küchenprodukt empfiehlt das zu diesen Rezepten passt: ${latest}. Natürlich, nicht werblich. 1-2 Emojis. Keine Links.`
                }],
                max_tokens:200, temperature:0.7,
              }),
            });
            const aiData = await aiRes.json();
            aiMsgCache[lang] = aiData.choices?.[0]?.message?.content || '';
          }
        } catch(e) {
          console.error(`[WA Affiliate] AI failed for ${lang}:`, e.message);
          aiMsgCache[lang] = '';
        }
      }

      // Schritt 2: Generierte Nachrichten an alle Subscriber senden
      for (const sub of subscribers) {
        const phone = sub.phone || sub;
        const lang = sub.lang || 'en';
        try {
          let msg = aiMsgCache[lang] || aiMsgCache['en'] || '';
          if (msg) {
            const stopMsg = {de:'"stop" zum Abmelden',en:'"stop" to unsubscribe',fr:'"stop" pour se désabonner',es:'"stop" para cancelar',pt:'"stop" para cancelar'};
            msg += `\n\n_${stopMsg[lang]||stopMsg.en}_`;
            await sendWhatsApp(phone, msg);
            sent++;
          }
          await new Promise(r => setTimeout(r, 200));
        } catch(e) {
          console.error(`[WA Affiliate] Failed ${phone}:`, e.message);
        }
      }
    }

    console.log(`[WA Broadcast] ${type}: ${sent}/${subscribers.length}`);
    res.json({ sent, total: subscribers.length });

  } catch (err) {
    console.error('[WA Broadcast]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Timezone aus Telefon-Vorwahl → sendet Broadcasts zur Ortszeit
 */
function getTimezoneFromPhone(phone) {
  const clean = phone.replace(/[^0-9]/g, '');
  const map = {
    '1':'America/New_York','44':'Europe/London','49':'Europe/Berlin',
    '43':'Europe/Vienna','41':'Europe/Zurich','90':'Europe/Istanbul',
    '33':'Europe/Paris','34':'Europe/Madrid','39':'Europe/Rome',
    '31':'Europe/Amsterdam','966':'Asia/Riyadh','971':'Asia/Dubai',
    '20':'Africa/Cairo','212':'Africa/Casablanca','55':'America/Sao_Paulo',
    '52':'America/Mexico_City','91':'Asia/Kolkata','86':'Asia/Shanghai','81':'Asia/Tokyo',
  };
  for (const len of [3, 2, 1]) {
    const pre = clean.substring(0, len);
    if (map[pre]) return map[pre];
  }
  return 'Europe/Berlin';
}

function getLocalHour(tz) {
  try {
    const str = new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
    return parseInt(str, 10);
  } catch(e) { return 12; }
}

/**
 * Rezept-Broadcast: EINE Nachricht mit persönlicher Begrüßung + Rezepte mit Links + Footer
 * Sprache basiert auf Telefon-Vorwahl des Subscribers
 */
function buildRecipeBroadcast(recipes, lang, botName, subscriberName) {
  const bot = botName || 'Lily';
  const firstName = subscriberName ? subscriberName.split(' ')[0] : '';

  // Persönliche Begrüßung mit Subscriber-Name wenn vorhanden
  const intros = {
    de: `Hey${firstName ? ' ' + firstName : ' Liebes'}! 💕 Hier ist ${bot} mit frischen Rezept-Ideen für dich:`,
    en: `Hey${firstName ? ' ' + firstName : ' lovely'}! 💕 It's ${bot} with fresh recipe ideas for you:`,
    fr: `Coucou${firstName ? ' ' + firstName : ' ma belle'} ! 💕 C'est ${bot} avec de nouvelles idées :`,
    es: `¡Hola${firstName ? ' ' + firstName : ' guapa'}! 💕 Soy ${bot} con ideas frescas de recetas:`,
  };

  const footers = {
    de: `\n💬 _Antworte einfach mit einer Nummer für Details!_\n\n_"stop" zum Abmelden_`,
    en: `\n💬 _Reply with a number for details!_\n\n_"stop" to unsubscribe_`,
    fr: `\n💬 _Répondez avec un numéro pour les détails !_\n\n_"stop" pour se désabonner_`,
    es: `\n💬 _Responde con un número para detalles!_\n\n_"stop" para cancelar_`,
  };

  let msg = (intros[lang] || intros.en) + '\n\n';

  recipes.forEach((r, i) => {
    msg += `*${i + 1}. ${r.title}*\n`;
    if (r.excerpt) msg += `${r.excerpt}\n`;
    if (r.url) msg += `👉 ${r.url}\n`;
    msg += '\n';
  });

  msg += (footers[lang] || footers.en);
  return msg;
}

/**
 * Fixiertes Produkt als Message formatieren
 */
function buildPinnedProductMsg(pinned, lang) {
  const lines = pinned.trim().split('\n').filter(Boolean);
  const first = lines[0];
  const parts = first.split('|').map(s=>s.trim());
  const name = parts[0] || '';
  const link = parts[1] || '';
  const intros = {
    de:`💡 *Küchentipp der Woche:* ${name}`,
    en:`💡 *Kitchen tip of the week:* ${name}`,
    fr:`💡 *Astuce cuisine de la semaine :* ${name}`,
    es:`💡 *Consejo de cocina de la semana:* ${name}`,
  };
  let msg = intros[lang]||intros.en;
  if (link) msg += `\n👉 ${link}`;
  return msg;
}

/**
 * Meta Cloud API: Nachricht senden
 */
async function sendWhatsApp(to, text) {
  if (!META_WA_TOKEN || !META_WA_PHONE_ID) {
    console.error('[WA] Not configured: missing TOKEN or PHONE_ID');
    return;
  }

  // WhatsApp max 4096 Zeichen
  const msg = text.slice(0, 4000);

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${META_WA_PHONE_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${META_WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: msg },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta WA API ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Sprache aus Telefon-Vorwahl erkennen
 */
function detectLangFromPhone(phone) {
  const clean = (phone||'').replace(/\D/g,'');
  const map = {
    '49':'de','43':'de','41':'de',
    '1':'en','44':'en','61':'en',
    '90':'en', // Türkei → Englisch als Fallback
    '966':'en','971':'en','20':'en','212':'en','213':'en','216':'en', // Arab. Länder → Englisch
    '33':'fr','32':'fr',
    '34':'es','52':'es','54':'es',
    '55':'pt','351':'pt', // Portugiesisch → Portugiesisch
    '39':'en','31':'en',
    '81':'en','82':'en','86':'en',
    '91':'en','62':'en','66':'en',
  };
  for (const len of [3,2,1]) {
    const pre = clean.substring(0, len);
    if (map[pre]) return map[pre];
  }
  return 'en';
}

/**
 * Einfache Spracherkennung aus Text
 */
function detectLang(text) {
  const t = (text || '').toLowerCase();
  if (/[äöüß]|hallo|bitte|danke|rezept/i.test(t)) return 'de';
  if (/bonjour|recette|merci|[éèêàâùûçœ]/i.test(t)) return 'fr';
  if (/hola|receta|gracias|[ñ¿¡]/i.test(t)) return 'es';
  return 'en';
}


// ═══════════════════════════════════════════════════════════
// TRACKING STATS – Web, WhatsApp, Voice
// ═══════════════════════════════════════════════════════════
const webChatStats = { today: 0, daily: {}, lastActive: 0 };
const waChatStats = { today: 0, daily: {}, lastActive: 0 };
const voiceChatStats = { today: 0, daily: {}, lastActive: 0 };

function trackUsage(statsObj) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (!statsObj.daily[today]) statsObj.daily[today] = 0;
  statsObj.daily[today]++;
  statsObj.today = statsObj.daily[today];
  statsObj.lastActive = Date.now();
  // Nur letzte 60 Tage behalten
  const keys = Object.keys(statsObj.daily).sort();
  if (keys.length > 60) {
    keys.slice(0, keys.length - 60).forEach(k => delete statsObj.daily[k]);
  }
}

function getStatsRange(statsObj, days) {
  const now = new Date();
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    total += statsObj.daily[key] || 0;
  }
  return total;
}

// Stats API für Admin-Dashboard
app.get('/api/stats', (req, res) => {
  res.json({
    web: {
      today: getStatsRange(webChatStats, 1),
      week: getStatsRange(webChatStats, 7),
      month: getStatsRange(webChatStats, 30),
    },
    whatsapp: {
      today: getStatsRange(waChatStats, 1),
      week: getStatsRange(waChatStats, 7),
      month: getStatsRange(waChatStats, 30),
      subscribers: waConversations.size,
    },
    voice: {
      today: getStatsRange(voiceChatStats, 1),
      week: getStatsRange(voiceChatStats, 7),
      month: getStatsRange(voiceChatStats, 30),
    },
  });
});

// ═══════════════════════════════════════════════════════════
// ROUTE: Health
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const recipes = await getRecipes();
  res.json({
    status: 'ok',
    recipes: recipes.length,
    products: productsCache.length,
    cacheAge: Math.round((Date.now() - cacheTimestamp) / 1000) + 's',
    version: '4.0.0',
    whatsapp: META_WA_TOKEN ? 'configured' : 'not configured',
    wa_conversations: waConversations.size,
  });
});

// ═══════════════════════════════════════════════════════════
// ROUTE: Rezepte-Liste (Debug)
// ═══════════════════════════════════════════════════════════
app.get('/api/recipes', async (req, res) => {
  const recipes = await getRecipes();
  res.json({ count: recipes.length, recipes: recipes.slice(0, 10) });
});

// ─── START ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────┐
  │  🍽️  My Dish Recipes Chatbot v4.2    │
  │  Port: ${PORT}                             │
  │  API:  ${WP_API.slice(0, 32)}...  │
  │  WA:   ${META_WA_TOKEN ? '✅ Connected' : '❌ Not configured'}              │
  └──────────────────────────────────────┘`);
});

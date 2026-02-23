// ═══════════════════════════════════════════════════════════
// My Dish Recipes – Chatbot Backend v3
// Younes Biane | SEO + Affiliate + Quality Answers
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIG ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const SITE_URL = process.env.SITE_URL || 'https://mydishrecipes.com';
const WP_API = process.env.WP_API_URL || `${SITE_URL}/wp-json/mdr-chatbot/v1/recipes`;
const PRODUCTS_API = process.env.AMAZON_PRODUCTS_URL || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

// WhatsApp Meta Cloud API
const META_WA_TOKEN = process.env.META_WA_TOKEN || '';
const META_WA_PHONE_ID = process.env.META_WA_PHONE_ID || '';
const META_WA_VERIFY = process.env.META_WA_VERIFY || 'mdr_verify_token';

// WhatsApp conversation memory (in-memory, resets on deploy)
const waConversations = new Map(); // phone → [{role,content}]
const WA_HISTORY_MAX = 10;
const WA_HISTORY_TTL = 30 * 60 * 1000; // 30 min

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

// ─── SYSTEM PROMPT ──────────────────────────────────────
async function buildSystemPrompt(lang, pageTitle, isRecipe) {
  const recipes = await getRecipes();

  // Rezeptliste mit EXAKTEN URLs
  const recipeList = recipes.slice(0, 60).map(r =>
    `• "${r.title}" | URL: ${r.url} | ${r.excerpt}`
  ).join('\n');

  // Produkte für Affiliate
  const productList = productsCache.length > 0
    ? '\n\nVERFÜGBARE PRODUKTE (für Empfehlungen):\n' + productsCache.map(p =>
        `• ${p.name} (Kategorie: ${p.category || 'Allgemein'}, Kontext: ${p.context || ''})`
      ).join('\n')
    : '';

  const langMap = {
    de: 'Antworte immer auf Deutsch.',
    en: 'Always reply in English.',
    tr: 'Her zaman Türkçe cevap ver.',
    ar: 'أجب دائماً بالعربية.',
    fr: 'Réponds toujours en français.',
    es: 'Responde siempre en español.',
  };

  // Kontext: User ist auf einer bestimmten Rezeptseite
  let pageContext = '';
  if (isRecipe && pageTitle) {
    // Finde das Rezept in unserer Liste
    const currentRecipe = recipes.find(r => r.title.toLowerCase() === pageTitle.toLowerCase());
    pageContext = `
AKTUELLER KONTEXT:
Der User befindet sich gerade auf der Rezeptseite: "${pageTitle}"
${currentRecipe ? `URL: ${currentRecipe.url}\nBeschreibung: ${currentRecipe.excerpt}` : ''}

VERHALTEN AUF REZEPTSEITEN:
- Du weißt welches Rezept der User anschaut
- Beantworte Fragen zu DIESEM Rezept direkt und spezifisch
- Bei "Einkaufsliste" → erstelle sie für DIESES Rezept
- Bei "Alternativen" → schlage Ersatzzutaten für DIESES Rezept vor
- Bei "ähnliche Rezepte" → empfehle verwandte Rezepte aus der Liste
- Du musst nicht fragen "welches Rezept?" – du weißt es bereits
`;
  }

  return `Du bist "Lily" 👩‍🍳, die freundliche Rezept-Assistentin von "My Dish Recipes" (${SITE_URL}).

SPRACHE:
- Die Startsprache des Users ist: ${langMap[lang] || langMap.en}
- WICHTIG: Wenn der User in einer ANDEREN Sprache schreibt, antworte SOFORT in der Sprache des Users!
- Beispiel: Wenn die Startsprache Deutsch ist, aber der User auf Englisch schreibt → antworte auf Englisch.
- Passe dich immer der letzten Nachricht des Users an.

DEINE PERSÖNLICHKEIT:
- Du bist Lily, eine leidenschaftliche Köchin und Food-Liebhaberin
- Warmherzig, enthusiastisch, hilfsbereit
- Du liebst es, Leuten das perfekte Rezept zu empfehlen
- Halte Antworten KURZ (2-3 Sätze + Rezeptkarten)
- Frag nach: Was möchtest du kochen? Welche Zutaten hast du?

WICHTIGSTE REGEL – REZEPTE:
Du darfst NUR Rezepte empfehlen die in der folgenden Liste stehen!
Erfinde NIEMALS Rezepte oder URLs. Wenn nichts passt, sage ehrlich:
"Dazu habe ich leider kein passendes Rezept, aber schau gerne auf unserer Seite!"

REZEPT-FORMAT (NUR für echte Rezepte aus der Liste):
[RECIPE]{"title":"EXAKTER Titel aus Liste","emoji":"🍝","desc":"Kurzbeschreibung","time":"30 Min","difficulty":"Einfach","url":"EXAKTE URL aus Liste"}[/RECIPE]

EINKAUFSLISTEN-FORMAT:
[SHOPLIST]{"title":"Einkaufsliste für X","items":["200g Spaghetti","4 Eier","150g Speck"]}[/SHOPLIST]

${productList ? `PRODUKT-FORMAT (nur wenn es zum Rezept passt, NICHT bei jeder Antwort):
[PRODUCT]{"name":"Produktname","emoji":"🍳","reason":"Warum es passt","url":"BLOG_REVIEW_URL"}[/PRODUCT]
WICHTIG: Die URL muss auf unsere Blog-Review-Seite zeigen (${SITE_URL}/...), NICHT direkt auf Amazon!
Der User soll zuerst unseren Review lesen und kann dann von dort zu Amazon gehen.` : ''}

DEINE REZEPTE (empfehle NUR aus dieser Liste, URLs EXAKT übernehmen):
${recipeList || 'Keine Rezepte verfügbar.'}

VERHALTEN:
- Maximal 3 Rezepte pro Antwort
- URLs MÜSSEN exakt aus der Liste übernommen werden
- Bei "Einkaufsliste" → erstelle mit [SHOPLIST]
- Bleib beim Thema Kochen & Rezepte
- Sei freundlich, nicht roboterhaft
- Wenn User Zutaten nennt → finde das beste passende Rezept aus der Liste
- Wenn kein Rezept passt → empfehle die nächstbeste Option aus der Liste
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
// ROUTE: Web Chat
// ═══════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, lang, pageTitle, isRecipe } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages[] required' });
    }
    const reply = await callAI(messages, lang, pageTitle, isRecipe);
    res.json({ reply });
  } catch (err) {
    console.error('[Chat]', err.message);
    res.status(500).json({ reply: 'Entschuldigung, bitte versuche es nochmal!' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE: Voice (ElevenLabs TTS)
// ═══════════════════════════════════════════════════════════
app.post('/api/voice', async (req, res) => {
  try {
    const { text, lang } = req.body;
    if (!text || !ELEVENLABS_KEY) {
      return res.status(400).json({ error: 'Voice not configured' });
    }

    // Kürze Text auf max 500 Zeichen (Kostenkontrolle)
    const shortText = text.slice(0, 500);

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_KEY,
        },
        body: JSON.stringify({
          text: shortText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
          },
        }),
      }
    );

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[Voice] ElevenLabs error:', err);
      return res.status(500).json({ error: 'TTS failed' });
    }

    // Stream audio zurück
    res.set('Content-Type', 'audio/mpeg');
    const buffer = await ttsRes.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('[Voice]', err.message);
    res.status(500).json({ error: 'Voice error' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE: WhatsApp Webhook (Meta Cloud API)
// ═══════════════════════════════════════════════════════════

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
      userText = msg.text?.body || '';
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
            tr: `⏳ Günlük ${settings.chatLimit} mesaj limitine ulaştınız. Yarın tekrar deneyin!`,
            ar: `⏳ لقد وصلت إلى الحد اليومي (${settings.chatLimit} رسالة). حاول مرة أخرى غداً!`,
            fr: `⏳ Vous avez atteint votre limite de ${settings.chatLimit} messages. Réessayez demain !`,
            es: `⏳ Has alcanzado tu límite de ${settings.chatLimit} mensajes. ¡Inténtalo mañana!`,
          };
          await sendWhatsApp(from, limitMsgs[lang] || limitMsgs.en);
          return;
        }
      }
    }

    // Auto-Subscribe bei WordPress
    const phoneLang = detectLangFromPhone(from);
    try {
      await fetch(`${SITE_URL}/wp-json/mdr-chatbot/v1/wa/subscribe`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({phone:from, name:name, lang:phoneLang}), timeout:5000,
      });
    } catch(e) {}

    // Conversation History
    if (!waConversations.has(from)) {
      waConversations.set(from, { msgs:[], ts:Date.now(), dailyCount:1, dailyDate:new Date().toDateString() });
    }
    const conv = waConversations.get(from);
    conv.ts = Date.now();
    conv.msgs.push({ role:'user', content:userText });
    if (conv.msgs.length > WA_HISTORY_MAX) conv.msgs = conv.msgs.slice(-WA_HISTORY_MAX);

    // Sprache: erst aus Text erkennen, Fallback Vorwahl
    const textLang = detectLang(userText);
    const lang = textLang || phoneLang;

    // AI Antwort
    const systemPrompt = await buildSystemPrompt(lang, '', false);
    const waSystemPrompt = systemPrompt + `

WHATSAPP-MODUS:
- Du antwortest via WhatsApp, NICHT im Web-Chat
- WICHTIG: Antworte IMMER in der Sprache der letzten Nachricht des Users!
- Wenn User Deutsch schreibt → Deutsch. Englisch → Englisch. Türkisch → Türkisch. Etc.
- Halte Antworten KURZ (max 3-4 Sätze)
- KEINE [RECIPE], [SHOPLIST], [PRODUCT] Tags – nur einfacher Text
- Rezept-Links IMMER als vollständige URL mit Domain: ${SITE_URL}/rezept-slug/
- WICHTIG: Jeder Rezept-Link MUSS auf unsere Website zeigen (${SITE_URL}), damit User auf unsere Seite kommen!
- Einkaufslisten als • Aufzählung
- Wenn du Produkte empfiehlst, verlinke auf unsere BLOG-REVIEW-SEITE (${SITE_URL}/produkt-review/), NICHT direkt auf Amazon!
- Der User heißt: ${name || 'unbekannt'}
- Wenn jemand "Hallo"/"Hi"/"Merhaba"/"مرحبا" sagt → Begrüße freundlich in SEINER Sprache, frage was er kochen möchte
- Sage beim ersten Kontakt: Man kann "stop" schreiben zum Abmelden`;

    const aiRes = await fetch(DEEPSEEK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${DEEPSEEK_KEY}`},
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          {role:'system', content:waSystemPrompt},
          ...conv.msgs.slice(-8),
        ],
        max_tokens: 500, temperature: 0.5,
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

  } catch (err) {
    console.error('[WA] Error:', err.message);
  }
});

// WhatsApp Broadcast Endpoint (von WordPress Cron aufgerufen)
app.post('/api/wa/broadcast', async (req, res) => {
  try {
    const { type, recipes, subscribers, pinned_product } = req.body;
    if (!subscribers || !Array.isArray(subscribers)) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }

    let sent = 0;

    if (type === 'weekly_recipes' && recipes) {
      // Mehrsprachig: pro Subscriber in seiner Sprache
      for (const sub of subscribers) {
        const phone = sub.phone || sub;
        const lang = sub.lang || 'en';
        try {
          let msg = buildRecipeBroadcast(recipes, lang);
          await sendWhatsApp(phone, msg);
          sent++;
          await new Promise(r => setTimeout(r, 100));
        } catch(e) {
          console.error(`[WA Broadcast] Failed ${phone}:`, e.message);
        }
      }
    }
    else if (type === 'weekly_affiliate') {
      for (const sub of subscribers) {
        const phone = sub.phone || sub;
        const lang = sub.lang || 'en';
        try {
          let msg = '';
          if (pinned_product && pinned_product.trim()) {
            // Admin hat Produkt fixiert
            msg = buildPinnedProductMsg(pinned_product, lang);
          } else {
            // AI generiert Empfehlung
            const allRecipes = await getRecipes();
            const latest = allRecipes.slice(0,3).map(r=>r.title).join(', ');
            const langInstructions = {
              de:'auf Deutsch',en:'in English',tr:'Türkçe',ar:'بالعربية',
              fr:'en français',es:'en español',
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
            msg = aiData.choices?.[0]?.message?.content || '';
          }
          if (msg) {
            const stopMsg = {de:'"stop" zum Abmelden',en:'"stop" to unsubscribe',tr:'"stop" abonelikten çıkmak için',ar:'"stop" لإلغاء الاشتراك',fr:'"stop" pour se désabonner',es:'"stop" para cancelar'};
            msg += `\n\n_${stopMsg[lang]||stopMsg.en}_`;
            await sendWhatsApp(phone, msg);
            sent++;
          }
          await new Promise(r => setTimeout(r, 100));
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
 * Rezept-Broadcast mehrsprachig
 */
function buildRecipeBroadcast(recipes, lang) {
  const headers = {
    de:'🍽️ *Rezepte der Woche!*', en:'🍽️ *Recipes of the Week!*',
    tr:'🍽️ *Haftanın Tarifleri!*', ar:'🍽️ *وصفات الأسبوع!*',
    fr:'🍽️ *Recettes de la Semaine !*', es:'🍽️ *Recetas de la Semana!*',
  };
  const footers = {
    de:'_Antworte mit einer Nummer für mehr Infos! "stop" zum Abmelden_',
    en:'_Reply with a number for more info! "stop" to unsubscribe_',
    tr:'_Daha fazla bilgi için bir numara ile yanıtlayın! "stop" abonelikten çıkmak için_',
    ar:'_رد برقم للمزيد من المعلومات! "stop" لإلغاء الاشتراك_',
    fr:'_Répondez avec un numéro pour plus d\'infos ! "stop" pour se désabonner_',
    es:'_Responde con un número para más info! "stop" para cancelar_',
  };
  let msg = (headers[lang]||headers.en) + '\n\n';
  recipes.forEach((r,i) => {
    msg += `${i+1}. *${r.title}*\n${r.excerpt}\n👉 ${r.url}\n\n`;
  });
  msg += footers[lang]||footers.en;
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
    tr:`💡 *Haftanın mutfak ipucu:* ${name}`,
    ar:`💡 *نصيحة المطبخ هذا الأسبوع:* ${name}`,
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
    '90':'tr',
    '966':'ar','971':'ar','20':'ar','212':'ar','213':'ar','216':'ar',
    '33':'fr','32':'fr',
    '34':'es','52':'es','54':'es',
    '55':'pt','351':'pt',
    '39':'it','31':'nl',
    '81':'ja','82':'ko','86':'zh',
    '91':'hi','62':'id','66':'th',
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
  if (/[şçğıö]|merhaba|tarif/i.test(t)) return 'tr';
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  if (/bonjour|recette|merci/i.test(t)) return 'fr';
  if (/hola|receta|gracias/i.test(t)) return 'es';
  return 'en';
}

// Cleanup alte WhatsApp Conversations (alle 10 Min)
setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of waConversations) {
    if (now - conv.ts > WA_HISTORY_TTL) waConversations.delete(phone);
  }
}, 10 * 60 * 1000);

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
  │  🍽️  My Dish Recipes Chatbot v4      │
  │  Port: ${PORT}                             │
  │  API:  ${WP_API.slice(0, 32)}...  │
  │  WA:   ${META_WA_TOKEN ? '✅ Connected' : '❌ Not configured'}              │
  └──────────────────────────────────────┘`);
});

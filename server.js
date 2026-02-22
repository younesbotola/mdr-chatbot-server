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
[PRODUCT]{"name":"Produktname","emoji":"🍳","reason":"Warum es passt","url":"AFFILIATE_URL"}[/PRODUCT]` : ''}

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
// ROUTE: Health
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const recipes = await getRecipes();
  res.json({
    status: 'ok',
    recipes: recipes.length,
    products: productsCache.length,
    cacheAge: Math.round((Date.now() - cacheTimestamp) / 1000) + 's',
    version: '3.0.0',
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
  │  🍽️  My Dish Recipes Chatbot v3      │
  │  Port: ${PORT}                             │
  │  API:  ${WP_API.slice(0, 32)}...  │
  └──────────────────────────────────────┘`);
});

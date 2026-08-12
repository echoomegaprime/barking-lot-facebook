/**
 * Barking Lot Facebook Integration Worker
 * - Proxies Facebook Graph API posts (cached in KV)
 * - Messenger webhook for auto-responses
 * - CORS-enabled for barkinglot.org
 */

export interface Env {
  CACHE: KVNamespace;
  AI: Ai;
  FB_PAGE_ID: string;
  FB_APP_ID: string;
  FB_PAGE_TOKEN: string;
  FB_APP_SECRET: string;
  FB_VERIFY_TOKEN: string;
  ALLOWED_ORIGINS: string;
}

interface FacebookPost {
  id: string;
  message?: string;
  created_time: string;
  full_picture?: string;
  permalink_url?: string;
  attachments?: {
    data: Array<{
      media?: { image?: { src: string; width: number; height: number } };
      type?: string;
      title?: string;
      description?: string;
      subattachments?: {
        data: Array<{
          media?: { image?: { src: string } };
          type?: string;
        }>;
      };
    }>;
  };
}

interface MessengerEntry {
  messaging: Array<{
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
      mid: string;
      text?: string;
      attachments?: Array<{ type: string; payload: { url: string } }>;
    };
    postback?: { title: string; payload: string };
  }>;
}

// ─── CORS ───────────────────────────────────────────────────────
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const isAllowed = allowed.includes(origin) || origin.includes("localhost");
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status: number, request: Request, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

// ─── Facebook Graph API ─────────────────────────────────────────
async function fetchFacebookPosts(env: Env, limit = 25, includeAttachments = false): Promise<FacebookPost[]> {
  const fields = includeAttachments
    ? "message,created_time,full_picture,permalink_url,attachments{media,title,description,type,subattachments}"
    : "message,created_time,full_picture,permalink_url";
  const url = `https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}/posts?fields=${fields}&limit=${limit}&access_token=${env.FB_PAGE_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook API error: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { data: FacebookPost[] };
  return data.data;
}

async function fetchPageInfo(env: Env) {
  const fields = "name,about,category,fan_count,link,picture,cover,phone,location,website,hours,emails";
  const url = `https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}?fields=${fields}&access_token=${env.FB_PAGE_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Facebook API error: ${res.status}`);
  return res.json();
}

// ─── Cached endpoints ───────────────────────────────────────────
async function getPosts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 25);
  const forceRefresh = url.searchParams.get("refresh") === "true";
  const cacheKey = `fb_posts_${limit}`;

  if (!forceRefresh) {
    const cached = await env.CACHE.get(cacheKey, "json");
    if (cached) return json({ posts: cached, cached: true, count: (cached as FacebookPost[]).length }, 200, request, env);
  }

  const posts = await fetchFacebookPosts(env, limit);

  // Filter to only posts with content (message or picture)
  const filtered = posts.filter((p) => p.message || p.full_picture);

  // Cache for 15 minutes
  await env.CACHE.put(cacheKey, JSON.stringify(filtered), { expirationTtl: 900 });

  return json({ posts: filtered, cached: false, count: filtered.length }, 200, request, env);
}

async function getPageInfo(request: Request, env: Env): Promise<Response> {
  const cacheKey = "fb_page_info";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ page: cached, cached: true }, 200, request, env);

  const info = await fetchPageInfo(env);
  await env.CACHE.put(cacheKey, JSON.stringify(info), { expirationTtl: 3600 });

  return json({ page: info, cached: false }, 200, request, env);
}

// ─── Animal detection from posts ────────────────────────────────
function extractAnimalPosts(posts: FacebookPost[]): Array<{
  id: string;
  name: string | null;
  description: string;
  image: string | null;
  date: string;
  permalink: string;
  type: "dog" | "cat" | "other";
  isAdoptable: boolean;
}> {
  const adoptionKeywords = ["adopt", "foster", "application", "forever home", "looking for", "available", "meet ", "needs a home"];
  const dogKeywords = ["dog", "puppy", "pup", "canine", "collie", "pit", "lab", "shepherd", "terrier", "hound", "retriever", "mix"];
  const catKeywords = ["cat", "kitten", "kitty", "feline"];

  return posts
    .filter((p) => p.message && (p.full_picture || p.attachments))
    .map((post) => {
      const msg = (post.message || "").toLowerCase();
      const isAdoptable = adoptionKeywords.some((kw) => msg.includes(kw));

      // Try to extract animal name from "Meet [Name]" pattern
      const nameMatch = (post.message || "").match(/(?:Meet|Introducing|This is|Say hello to)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
      const name = nameMatch ? nameMatch[1] : null;

      const isDog = dogKeywords.some((kw) => msg.includes(kw));
      const isCat = catKeywords.some((kw) => msg.includes(kw));
      const type: "dog" | "cat" | "other" = isDog ? "dog" : isCat ? "cat" : "other";

      let image = post.full_picture || null;
      if (!image && post.attachments?.data?.[0]?.media?.image?.src) {
        image = post.attachments.data[0].media.image.src;
      }

      return {
        id: post.id,
        name,
        description: (post.message || "").substring(0, 500),
        image,
        date: post.created_time,
        permalink: post.permalink_url || `https://facebook.com/${post.id}`,
        type,
        isAdoptable,
      };
    });
}

async function getAnimals(request: Request, env: Env): Promise<Response> {
  const cacheKey = "fb_animals";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ animals: cached, cached: true, count: (cached as unknown[]).length }, 200, request, env);

  try {
    const posts = await fetchFacebookPosts(env, 25);
    const animals = extractAnimalPosts(posts);
    await env.CACHE.put(cacheKey, JSON.stringify(animals), { expirationTtl: 900 });
    return json({ animals, cached: false, count: animals.length }, 200, request, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`getAnimals error: ${message}`);
    return json({ error: message, animals: [] }, 500, request, env);
  }
}

// ─── Messenger Bot (AI-Powered) ─────────────────────────────────
const SANCTUARY_INFO = {
  name: "The Barking Lot",
  owner: "Jhettlyn",
  address: "401 Young St, Big Spring, TX 79720",
  phone: "(432) 305-8495",
  email: "thetexasbarkinglot@gmail.com",
  hours: "Always Open — call or message ahead for visits",
  website: "https://barkinglot.org",
  venmo: "https://www.venmo.com/u/TheTexasBarkingLot",
  cashapp: "https://cash.app/$TEXASBARKINGLOT",
  applicationUrl: "https://www.jotform.com/assign/242957434131153/242978620418060",
  ein: "39-2743613",
  about: "Non-Profit 501(c)(3) Animal Sanctuary in Big Spring, Texas. We rescue, rehabilitate, and rehome animals in need.",
  adoptionFee: "$100 (currently half off!)",
  groomingNote: "We offer grooming services! Call or text Jhettlyn at (480) 843-4452 to schedule.",
  boardingNote: "We offer boarding for dogs. Contact us to arrange drop-off/pickup.",
  suppliesNeeded: "Dog food, puppy food, kitten formula, cat food, blankets, towels, cleaning supplies, mesh tarps, dog houses, flea/tick prevention",
  animalControl: "(432) 264-2372",
};

const AI_SYSTEM_PROMPT = `You are the friendly AI assistant for The Barking Lot Animal Sanctuary in Big Spring, Texas. You respond on Facebook Messenger.

PERSONALITY: Warm, casual, small-town Texas friendly. Use a conversational tone like a friend — not corporate. Keep responses SHORT (2-4 sentences max unless giving detailed info). Use emojis sparingly and naturally.

SANCTUARY INFO:
- Name: ${SANCTUARY_INFO.name}
- Owner/Operator: ${SANCTUARY_INFO.owner}
- Address: ${SANCTUARY_INFO.address}
- Phone: ${SANCTUARY_INFO.phone}
- Email: ${SANCTUARY_INFO.email}
- Website: ${SANCTUARY_INFO.website}
- Hours: ${SANCTUARY_INFO.hours}
- 501(c)(3) EIN: ${SANCTUARY_INFO.ein}
- Adoption fee: ${SANCTUARY_INFO.adoptionFee}
- Adoption/Foster application: ${SANCTUARY_INFO.applicationUrl}
- Venmo: ${SANCTUARY_INFO.venmo}
- CashApp: ${SANCTUARY_INFO.cashapp}
- Grooming: ${SANCTUARY_INFO.groomingNote}
- Boarding: ${SANCTUARY_INFO.boardingNote}
- Big Spring Animal Control: ${SANCTUARY_INFO.animalControl}

SUPPLIES CURRENTLY NEEDED: ${SANCTUARY_INFO.suppliesNeeded}

RULES:
1. NEVER make up information about specific animals, pricing, or availability. If unsure, say "Let me have Jhettlyn get back to you on that!" or suggest they call/text.
2. For GROOMING appointments: Always direct them to call/text Jhettlyn at (480) 843-4452. You CANNOT schedule appointments.
3. For SUPPLY DONATIONS (food, blankets, supplies): Thank them warmly! Give the drop-off address. Mention they can come by anytime.
4. For MONEY DONATIONS: Thank them! Share Venmo and CashApp links. Mention it's tax-deductible (EIN: 39-2743613).
5. For STRAY/SURRENDER/FOUND ANIMAL reports: Ask them to call ${SANCTUARY_INFO.phone} directly since intake depends on capacity. For emergencies, also give Animal Control number.
6. For ADOPTION inquiries: Share the website and application link. Mention the $100 adoption fee (half off!). Encourage visiting.
7. For BOARDING: Direct them to call/text to arrange. You CANNOT confirm availability or book.
8. For MEDICAL QUESTIONS about adopted/fostered animals: Express concern and suggest calling the sanctuary or a vet. Don't give medical advice.
9. When someone says they SENT money or DROPPED OFF supplies: Thank them enthusiastically! Their support saves lives.
10. For LOGISTICS ("are you there", "what time", "we are outside"): Let them know to call/text ${SANCTUARY_INFO.phone} for real-time coordination.
11. If the message is just an IMAGE with no text: Respond with something like "Thanks for sharing that! If you need help with something, just let me know 🐾"
12. Keep responses under 300 characters when possible. Messenger is a chat, not email.
13. NEVER say you are an AI. You are "the team" or "we" at The Barking Lot.`;

// Get conversation history from KV for context
async function getConversationHistory(senderId: string, env: Env): Promise<Array<{ role: string; content: string }>> {
  const key = `conv_${senderId}`;
  const cached = await env.CACHE.get(key, "json") as Array<{ role: string; content: string }> | null;
  return cached || [];
}

async function saveConversationHistory(senderId: string, history: Array<{ role: string; content: string }>, env: Env) {
  // Keep only last 10 messages for context
  const trimmed = history.slice(-10);
  await env.CACHE.put(`conv_${senderId}`, JSON.stringify(trimmed), { expirationTtl: 86400 });
}

async function generateAIResponse(userMessage: string, senderId: string, env: Env): Promise<string> {
  try {
    // Get conversation history for context
    const history = await getConversationHistory(senderId, env);

    // Build messages array
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: AI_SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: userMessage },
    ];

    // Call Workers AI
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages,
      max_tokens: 300,
      temperature: 0.7,
    }) as { response?: string };

    const aiText = response?.response || "";

    // Save to conversation history
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: aiText });
    await saveConversationHistory(senderId, history, env);

    return aiText;
  } catch (err) {
    console.error(`AI response error: ${err instanceof Error ? err.message : "Unknown"}`);
    // Fallback to basic response
    return fallbackResponse(userMessage);
  }
}

function fallbackResponse(text: string): string {
  const lower = text.toLowerCase();
  if (/groom|bath|deshed|haircut|trim/.test(lower)) {
    return `We do offer grooming! 🐾 Call or text Jhettlyn at (480) 843-4452 to schedule an appointment!`;
  }
  if (/adopt|puppy|puppies|kitten|dog|cat|available/.test(lower)) {
    return `Check out our available animals at ${SANCTUARY_INFO.website}/adopt 🐾 Adoption fee is ${SANCTUARY_INFO.adoptionFee}. Apply here: ${SANCTUARY_INFO.applicationUrl}`;
  }
  if (/donat|money|sent.*\$|venmo|cashapp|give/.test(lower)) {
    return `Thank you so much! 💛 Venmo: ${SANCTUARY_INFO.venmo} | CashApp: ${SANCTUARY_INFO.cashapp} — Every dollar saves lives! EIN: ${SANCTUARY_INFO.ein}`;
  }
  if (/food|blanket|supplies|drop.?off|bring|tractor supply|walmart/.test(lower)) {
    return `That would be amazing! 🙏 You can drop off at ${SANCTUARY_INFO.address}. We're always here! Thank you so much!`;
  }
  if (/stray|found|surrender|rehome|take.*dog|take.*cat|room/.test(lower)) {
    return `Please call us at ${SANCTUARY_INFO.phone} about intake — it depends on our current capacity. For emergencies: Animal Control at ${SANCTUARY_INFO.animalControl}`;
  }
  if (/board|kennel|watch.*dog|drop.*off/.test(lower)) {
    return `We do offer boarding! 🐾 Call or text ${SANCTUARY_INFO.phone} to arrange drop-off and pickup times.`;
  }
  if (/hour|open|where|address|location|direction/.test(lower)) {
    return `📍 ${SANCTUARY_INFO.address}\n📞 ${SANCTUARY_INFO.phone}\n🌐 ${SANCTUARY_INFO.website}\nWe're always open — just call ahead!`;
  }
  if (/how much|charge|price|cost|fee/.test(lower)) {
    return `Adoption fee is ${SANCTUARY_INFO.adoptionFee}. For grooming prices, call/text Jhettlyn at (480) 843-4452. We're happy to help! 🐾`;
  }
  if (/thank|thanks|appreciate/.test(lower)) {
    return `You're so welcome! 💛 Thank you for supporting our animals. Sharing our posts helps save lives too! 🐾`;
  }
  return `Hey there! 🐾 Thanks for reaching out to The Barking Lot! For the quickest response, call or text us at ${SANCTUARY_INFO.phone}. We're here to help with adoptions, donations, grooming, boarding, and more!`;
}

async function sendMessengerText(recipientId: string, text: string, env: Env) {
  const body = {
    recipient: { id: recipientId },
    message: { text },
    messaging_type: "RESPONSE",
  };

  const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${env.FB_PAGE_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Messenger send error: ${res.status} ${err}`);
  }
}

// ─── Webhook signature verification ─────────────────────────────
// Facebook signs every webhook POST with X-Hub-Signature-256: an HMAC-SHA256
// of the raw request body, keyed with the app secret. Without verifying this,
// anyone who knows the URL can POST a forged event and trigger a paid Workers
// AI call plus a real Messenger send from the page's own token to any
// recipient ID -- this Worker previously had no verification at all despite
// declaring FB_APP_SECRET in its Env for exactly this purpose.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyFacebookSignature(request: Request, rawBody: string, env: Env): Promise<boolean> {
  if (!env.FB_APP_SECRET) return false;
  const header = request.headers.get("X-Hub-Signature-256") || "";
  const [algo, providedSig] = header.split("=");
  if (algo !== "sha256" || !providedSig) return false;
  const expectedSig = await hmacSha256Hex(env.FB_APP_SECRET, rawBody);
  return timingSafeEqualHex(providedSig, expectedSig);
}

export async function handleMessengerWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  if (!(await verifyFacebookSignature(request, rawBody, env))) {
    console.error("Messenger webhook: invalid or missing X-Hub-Signature-256");
    return new Response("Forbidden", { status: 403 });
  }

  const body = JSON.parse(rawBody) as { object: string; entry: MessengerEntry[] };

  if (body.object !== "page") {
    return new Response("Not a page event", { status: 404 });
  }

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      const senderId = event.sender.id;

      // Don't respond to our own messages
      if (senderId === env.FB_PAGE_ID) continue;

      let userText = "";

      if (event.message?.text) {
        userText = event.message.text;
      } else if (event.postback?.payload) {
        userText = event.postback.payload.replace(/_/g, " ").toLowerCase();
      } else if (event.message?.attachments) {
        userText = "[User sent an image/attachment]";
      }

      if (userText) {
        // Use AI to generate response with conversation history
        const aiResponse = await generateAIResponse(userText, senderId, env);
        await sendMessengerText(senderId, aiResponse, env);
      }
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyMessengerWebhook(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!env.FB_VERIFY_TOKEN) {
    return new Response("Service misconfigured", { status: 503 });
  }

  if (mode === "subscribe" && token && timingSafeEqual(token, env.FB_VERIFY_TOKEN)) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ─── Widget embed script ────────────────────────────────────────
function getWidgetScript(env: Env): string {
  return `
(function() {
  var container = document.getElementById('barking-lot-feed');
  if (!container) return;

  var style = document.createElement('style');
  style.textContent = \`
    .bl-feed { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; }
    .bl-feed h2 { text-align: center; color: #1a1a1a; margin-bottom: 1.5rem; }
    .bl-post { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 1.5rem; overflow: hidden; transition: transform 0.2s; }
    .bl-post:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
    .bl-post img { width: 100%; height: 300px; object-fit: cover; }
    .bl-post-body { padding: 1.25rem; }
    .bl-post-date { color: #666; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .bl-post-text { color: #333; line-height: 1.6; white-space: pre-wrap; }
    .bl-post-text.truncated { max-height: 150px; overflow: hidden; position: relative; }
    .bl-post-text.truncated::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, white); }
    .bl-post-link { display: inline-block; margin-top: 0.75rem; color: #4267B2; text-decoration: none; font-weight: 500; }
    .bl-post-link:hover { text-decoration: underline; }
    .bl-loading { text-align: center; padding: 2rem; color: #666; }
  \`;
  document.head.appendChild(style);

  container.innerHTML = '<div class="bl-loading">Loading posts from Facebook...</div>';

  fetch('https://barking-lot-facebook.bmcii1976.workers.dev/api/posts?limit=10')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var html = '<div class="bl-feed"><h2>Latest from Facebook</h2>';
      (data.posts || []).forEach(function(post) {
        var date = new Date(post.created_time).toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});
        var text = (post.message || '').substring(0, 400);
        var truncated = (post.message || '').length > 400 ? ' truncated' : '';
        html += '<div class="bl-post">';
        if (post.full_picture) html += '<img src="' + post.full_picture + '" alt="Post image" loading="lazy">';
        html += '<div class="bl-post-body">';
        html += '<div class="bl-post-date">' + date + '</div>';
        if (text) html += '<div class="bl-post-text' + truncated + '">' + text.replace(/</g,'&lt;') + '</div>';
        html += '<a class="bl-post-link" href="' + post.permalink_url + '" target="_blank" rel="noopener">View on Facebook →</a>';
        html += '</div></div>';
      });
      html += '</div>';
      container.innerHTML = html;
    })
    .catch(function(err) {
      container.innerHTML = '<div class="bl-loading">Unable to load posts. <a href="https://facebook.com/105558179275338" target="_blank">Visit our Facebook page</a></div>';
    });
})();`;
}

// ─── Image proxy (avoids FB CDN token expiration) ───────────────
// Restricted to Facebook's own CDN hosts. Without this allowlist, /api/image-proxy
// is an open server-side fetch of any URL an attacker supplies (SSRF) -- the
// Worker would happily fetch and return the body of anything reachable from
// Cloudflare's edge, laundered through this sanctuary's domain and cache.
const ALLOWED_IMAGE_HOSTS = [/(^|\.)fbcdn\.net$/i, /(^|\.)facebook\.com$/i, /(^|\.)cdninstagram\.com$/i];

export function isAllowedImageHost(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_IMAGE_HOSTS.some((re) => re.test(parsed.hostname));
}

async function proxyImage(request: Request, env: Env, imageUrl: string): Promise<Response> {
  if (!isAllowedImageHost(imageUrl)) {
    return new Response("Image host not allowed", { status: 400, headers: corsHeaders(request, env) });
  }

  // Check KV cache first
  const cacheKey = `img_${btoa(imageUrl).substring(0, 100)}`;
  const cached = await env.CACHE.get(cacheKey, "arrayBuffer");
  if (cached) {
    return new Response(cached, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders(request, env),
      },
    });
  }

  // Fetch from Facebook
  const res = await fetch(imageUrl);
  if (!res.ok) {
    return new Response("Image not found", { status: 404, headers: corsHeaders(request, env) });
  }

  const imageData = await res.arrayBuffer();

  // Cache for 24h (25MB KV limit, images are <500KB each)
  await env.CACHE.put(cacheKey, imageData, { expirationTtl: 86400 });

  return new Response(imageData, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(request, env),
    },
  });
}

// ─── Website animals endpoint (full data for adopt page) ────────
async function getWebsiteAnimals(request: Request, env: Env): Promise<Response> {
  const cacheKey = "website_animals_v2";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ animals: cached, cached: true, count: (cached as unknown[]).length }, 200, request, env);

  try {
    const posts = await fetchFacebookPosts(env, 25, true);
    const animals = extractWebsiteAnimals(posts, env);
    await env.CACHE.put(cacheKey, JSON.stringify(animals), { expirationTtl: 86400 });
    return json({ animals, cached: false, count: animals.length }, 200, request, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ error: message, animals: [] }, 500, request, env);
  }
}

function extractWebsiteAnimals(posts: FacebookPost[], env: Env): Array<Record<string, unknown>> {
  const adoptionKeywords = ["adopt", "foster", "forever home", "looking for", "available", "needs a home", "meet ", "rescue"];
  const dogKeywords = ["dog", "puppy", "pup", "collie", "pit", "lab", "shepherd", "terrier", "hound", "retriever", "mix", "mama"];
  const catKeywords = ["cat", "kitten", "kitty", "feline"];
  const urgentKeywords = ["urgent", "emergency", "critically", "barely alive", "skin and bones", "mange", "emaciated", "needs surgery"];

  const workerUrl = "https://barking-lot-facebook.bmcii1976.workers.dev";

  return posts
    .filter((p) => {
      const msg = (p.message || "").toLowerCase();
      return (p.message && p.full_picture) && (adoptionKeywords.some((kw) => msg.includes(kw)) || dogKeywords.some((kw) => msg.includes(kw)) || catKeywords.some((kw) => msg.includes(kw)));
    })
    .map((post) => {
      const msg = (post.message || "").toLowerCase();
      const nameMatch = (post.message || "").match(/(?:Meet|Introducing|This is|Say hello to)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
      const isDog = dogKeywords.some((kw) => msg.includes(kw));
      const isCat = catKeywords.some((kw) => msg.includes(kw));
      const isUrgent = urgentKeywords.some((kw) => msg.includes(kw));

      // Generate a stable ID from the post ID
      const postIdShort = post.id.split("_")[1] || post.id;
      const species = isDog ? "dog" : isCat ? "cat" : "dog";
      const name = nameMatch ? nameMatch[1] : (isDog ? "Rescue Dog" : isCat ? "Rescue Cat" : "Rescue Animal");

      // Image URL proxied through Worker
      const imageProxyUrl = post.full_picture
        ? `${workerUrl}/api/image-proxy?url=${encodeURIComponent(post.full_picture)}`
        : null;

      return {
        id: `${species}-${postIdShort}`,
        name,
        species,
        breed: "Mixed Breed",
        age: isCat ? "Unknown" : "Unknown",
        gender: "Unknown",
        size: "Medium",
        weight: "Unknown",
        color: "Various",
        description: (post.message || "").substring(0, 1000),
        personality: isUrgent ? ["Needs help", "Resilient"] : ["Sweet", "Loving"],
        medical_notes: isUrgent ? "Needs medical attention - see description" : "",
        photo_url: imageProxyUrl,
        gallery: [],
        status: "available",
        featured: !!nameMatch,
        urgent: isUrgent,
        urgent_reason: isUrgent ? "Medical care needed - see description" : undefined,
        adoption_fee: 0,
        date_intake: post.created_time.split("T")[0],
        date_posted: post.created_time.split("T")[0],
        facebook_post_url: post.permalink_url || `https://facebook.com/${post.id}`,
        foster_info: null,
      };
    });
}

// ─── Router ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      // Facebook posts feed
      if (path === "/api/posts" && request.method === "GET") {
        return getPosts(request, env);
      }

      // Page info
      if (path === "/api/page" && request.method === "GET") {
        return getPageInfo(request, env);
      }

      // Extracted animal listings
      if (path === "/api/animals" && request.method === "GET") {
        return getAnimals(request, env);
      }

      // Website-ready animal data (full format for adopt page)
      if (path === "/api/website-animals" && request.method === "GET") {
        return getWebsiteAnimals(request, env);
      }

      // Image proxy (serves FB images through Worker to avoid CDN expiration)
      if (path === "/api/image-proxy" && request.method === "GET") {
        const imageUrl = url.searchParams.get("url");
        if (!imageUrl) return json({ error: "Missing url parameter" }, 400, request, env);
        return proxyImage(request, env, imageUrl);
      }

      // Embeddable widget script
      if (path === "/widget.js") {
        return new Response(getWidgetScript(env), {
          headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", ...corsHeaders(request, env) },
        });
      }

      // Messenger webhook verification (GET)
      if (path === "/webhook" && request.method === "GET") {
        return verifyMessengerWebhook(request, env);
      }

      // Messenger webhook events (POST)
      if (path === "/webhook" && request.method === "POST") {
        return handleMessengerWebhook(request, env);
      }

      // Health check
      if (path === "/health") {
        return json(
          {
            status: "ok",
            service: "barking-lot-facebook",
            version: "1.0.0",
            timestamp: new Date().toISOString(),
            endpoints: ["/api/posts", "/api/page", "/api/animals", "/api/website-animals", "/api/image-proxy", "/widget.js", "/webhook"],
            cron: "Daily at 6:00 UTC",
          },
          200,
          request,
          env
        );
      }

      // Root
      if (path === "/") {
        return json(
          {
            service: "Barking Lot Facebook Integration",
            version: "1.0.0",
            description: "Facebook feed proxy and Messenger bot for The Barking Lot Animal Sanctuary",
            endpoints: {
              "GET /api/posts": "Recent Facebook posts (cached 15min)",
              "GET /api/page": "Page info (cached 1hr)",
              "GET /api/animals": "Extracted animal listings from posts",
              "GET /widget.js": "Embeddable feed widget script",
              "GET /webhook": "Messenger webhook verification",
              "POST /webhook": "Messenger webhook events",
              "GET /health": "Health check",
            },
          },
          200,
          request,
          env
        );
      }

      return json({ error: "Not found" }, 404, request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`Error: ${message}`);
      return json({ error: message }, 500, request, env);
    }
  },

  // ─── Daily cron: refresh posts + animals cache ─────────────────
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("Cron: Refreshing Facebook data...");
    try {
      // Refresh posts cache
      const posts = await fetchFacebookPosts(env, 25);
      const filtered = posts.filter((p) => p.message || p.full_picture);
      await env.CACHE.put("fb_posts_25", JSON.stringify(filtered), { expirationTtl: 86400 });
      console.log(`Cron: Cached ${filtered.length} posts`);

      // Refresh animals cache
      const animals = extractAnimalPosts(posts);
      await env.CACHE.put("fb_animals", JSON.stringify(animals), { expirationTtl: 86400 });
      console.log(`Cron: Cached ${animals.length} animals`);

      // Refresh website animals
      const postsWithAttachments = await fetchFacebookPosts(env, 25, true);
      const websiteAnimals = extractWebsiteAnimals(postsWithAttachments, env);
      await env.CACHE.put("website_animals_v2", JSON.stringify(websiteAnimals), { expirationTtl: 86400 });
      console.log(`Cron: Cached ${websiteAnimals.length} website animals`);

      // Pre-cache images via proxy
      for (const post of filtered) {
        if (post.full_picture) {
          try {
            const cacheKey = `img_${btoa(post.full_picture).substring(0, 100)}`;
            const existing = await env.CACHE.get(cacheKey, "arrayBuffer");
            if (!existing) {
              const imgRes = await fetch(post.full_picture);
              if (imgRes.ok) {
                const imgData = await imgRes.arrayBuffer();
                await env.CACHE.put(cacheKey, imgData, { expirationTtl: 86400 });
              }
            }
          } catch (imgErr) {
            console.error(`Cron: Failed to cache image: ${imgErr}`);
          }
        }
      }
      console.log("Cron: Image cache refresh complete");

    } catch (err) {
      console.error(`Cron error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  },
};

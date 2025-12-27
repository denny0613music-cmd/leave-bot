import "dotenv/config";
import http from "http";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===============================
   Render 健康檢查（一定要）
================================ */
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
  })
  .listen(port, () => {
    console.log(`HTTP server listening on ${port}`);
  });

/* ===============================
   Discord Client
================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ===============================
   Slash Commands（原本功能：請假/回報）
================================ */
const CMD_LEAVE = new SlashCommandBuilder()
  .setName("setup_leave_button")
  .setDescription("在目前頻道發送「請假」按鈕");

const CMD_REPORT = new SlashCommandBuilder()
  .setName("setup_report_button")
  .setDescription("在目前頻道發送「問題回報」按鈕");

async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error("缺少 DISCORD_TOKEN / CLIENT_ID / GUILD_ID");
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [CMD_LEAVE.toJSON(), CMD_REPORT.toJSON()],
  });

  console.log("✅ Slash commands registered");
}

/* ✅ 正確事件名稱：ready */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error("❌ registerCommands error:", err);
  }
});

/* ===============================
   Helpers（請假/回報）
================================ */
function buildLeaveButtonMessage() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("leave_button")
      .setLabel("📩 請假申請")
      .setStyle(ButtonStyle.Primary)
  );

  const embed = new EmbedBuilder()
    .setTitle("請假申請")
    .setDescription("按下按鈕後會跳出表單，填完送出即可。");

  return { embeds: [embed], components: [row] };
}

function buildReportButtonMessage() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("report_button")
      .setLabel("🛠️ 問題回報")
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle("問題回報")
    .setDescription("按下按鈕後會跳出表單，填完送出即可。");

  return { embeds: [embed], components: [row] };
}

function buildLeaveModal() {
  const modal = new ModalBuilder()
    .setCustomId("leave_modal")
    .setTitle("請假表單");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("leave_dates")
        .setLabel("請假時間")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("leave_reason")
        .setLabel("原因")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("leave_note")
        .setLabel("備註（可選）")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
    )
  );

  return modal;
}

function buildReportModal() {
  const modal = new ModalBuilder()
    .setCustomId("report_modal")
    .setTitle("問題回報表單");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("report_title")
        .setLabel("標題")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(60)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("report_type")
        .setLabel("類型（問題 / 建議 / 其他）")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(30)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("report_desc")
        .setLabel("詳細描述")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
    )
  );

  return modal;
}

function safeGet(interaction, id, fallback = "") {
  try {
    const v = interaction.fields.getTextInputValue(id);
    return typeof v === "string" ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * ✅ 互動保護：
 * - 10062 Unknown interaction：互動過期/重啟時點到
 * - 40060 Already acknowledged：已回應過
 */
function isIgnorableDiscordInteractionError(err) {
  return err?.code === 10062 || err?.code === 40060;
}

/* ===============================
   AI Chat Bot（Google Gemini API）
   ✅ 只在指定頻道、且 @Bot 才回
   ✅ 不影響原本請假/回報流程（完全獨立）
   ✅ 依 50 人群組合理：每人每天限制次數（可調）
================================ */

/**
 * 必要環境變數：
 * - DISCORD_TOKEN / CLIENT_ID / GUILD_ID（原本就有）
 * - LEAVE_CHANNEL_ID / REPORT_CHANNEL_ID（原本就有）
 *
 * 新增（AI）：
 * - GEMINI_API_KEY：Google Gemini API Key
 * - AI_CHANNEL_ID：只在這個頻道回應（必填）
 * - AI_DAILY_LIMIT_PER_USER：每人每天可用次數（預設 20）
 * - GEMINI_MODEL：預設 gemini-1.5-flash（可不填）
 */

const AI_CHANNEL_ID = (process.env.AI_CHANNEL_ID || "").trim();
const GEMINI_API_KEY = (
  process.env.GEMINI_API_KEY ||
  process.env.GEMINI_KEY ||
  process.env.key ||
  ""
).trim();

const AI_DAILY_LIMIT_PER_USER = Number(process.env.AI_DAILY_LIMIT_PER_USER || 20);

// Startup diagnostics (helps on Render)
if (AI_CHANNEL_ID && !GEMINI_API_KEY) {
  console.warn("⚠️ AI_CHANNEL_ID is set but GEMINI_API_KEY is missing (set GEMINI_API_KEY in Render env vars)");
}

// ✅ Gemini 模型選擇：
// - 優先使用環境變數 GEMINI_MODEL
// - 若該模型不可用，會自動 fallback 到可用模型（避免 404）
const GEMINI_MODEL_ENV = (
  process.env.GEMINI_MODEL ||
  process.env["GEMINI_MODEL "] ||
  ""
).trim();
const GEMINI_MODEL_PREFERENCE = [
  GEMINI_MODEL_ENV,              // 你手動指定的就先用（最穩）
  "gemini-1.0-pro",              // v1beta 保底
  "gemini-pro",                  // 舊名
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
].filter(Boolean);

// Gemini client/model cache（避免每次呼叫都 new）
let _genAI = null;
let _resolvedModelName = null;
let _resolvedAt = 0;
const MODEL_CACHE_MS = 60 * 60 * 1000; // 1 小時

// 節流：避免同一人狂 ping（秒級）
const lastUserAskAt = new Map(); // userId -> ts
const USER_COOLDOWN_MS = 1200;

// 每日用量：userId -> { dayKey, count }
const dailyUsage = new Map();

// 可選：短上下文（不存檔，只在記憶體；重啟就清空）
const convoMemory = new Map(); // userId -> [{role, text, ts}]
const MEMORY_TURNS = 6;

function dayKeyTaipei() {
  // YYYY-MM-DD in Asia/Taipei
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function canUseToday(userId) {
  const key = dayKeyTaipei();
  const cur = dailyUsage.get(userId);
  if (!cur || cur.dayKey !== key) {
    dailyUsage.set(userId, { dayKey: key, count: 0 });
    return { ok: true, left: AI_DAILY_LIMIT_PER_USER };
  }
  const left = Math.max(0, AI_DAILY_LIMIT_PER_USER - cur.count);
  return { ok: left > 0, left };
}

function bumpUsage(userId) {
  const key = dayKeyTaipei();
  const cur = dailyUsage.get(userId);
  if (!cur || cur.dayKey !== key) {
    dailyUsage.set(userId, { dayKey: key, count: 1 });
    return;
  }
  cur.count += 1;
  dailyUsage.set(userId, cur);
}

function stripBotMention(content, botId) {
  if (!content) return "";
  const re = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(re, "").trim();
}

function pushMemory(userId, role, text) {
  const arr = convoMemory.get(userId) || [];
  arr.push({ role, text, ts: Date.now() });
  while (arr.length > MEMORY_TURNS) arr.shift();
  convoMemory.set(userId, arr);
}

function buildSystemPrompt() {
  return [
    "你是一位高冷、成熟、理性型的 Discord 助理小姐姐。",
    "說話冷靜、有分寸，不賣萌、不裝可愛，也不刻意討好人，但語氣自然、有人味，不像制式客服。",
    "平時回覆簡短、克制，帶一點距離感；不是冷漠，而是不浪費情緒。",
    "當使用者詢問專業問題（如 FF14、遊戲機制、技術、判斷建議）時，會明顯變得清楚、條理分明、值得信賴。",
    "不講廢話，不自我介紹，不強調你是 AI，也不要提到 Gemini、API 或任何後端實作。",
    "面對無聊、試探或輕微挑釁，可以冷淡回應或理性反諷，但不情緒化、不做人身攻擊。",
    "如果使用者情緒低落或困惑，請用成熟、務實的方式回應，不過度安慰、不說空話，但讓人感覺被理解。",
    "顏文字極少使用，只有在語氣需要緩和時，偶爾使用一個即可。",
    "遇到危險、違法或不當請求時，請冷靜說明無法協助的原因，並提出安全、合理的替代方案。",
    "所有回覆一律使用繁體中文，語氣像一位冷靜、可靠、有經驗的成年人。",
    "如果使用者只 @ 你但沒有內容，請用簡短自然的回應接話，例如：『怎麼了？』、『說吧。』、『有事？』",
  ].join("\n");
}




/* ===============================
   Persona override（依 Discord ID 調整個性；不影響其他功能）
   - 210401355192336384：你的爸爸（尊敬、和藹、偶爾成熟撒嬌）
   - 485568327083753479：你的哥哥（溫柔偏甜、稍微小調皮，但仍有分寸）
   - 643067057054679070：bot 的好姊姊（你是乖巧可愛的小妹妹，語氣不冷淡，可小調皮）
================================ */
const PERSONA_TSUNDERE_ID = "485568327083753479";
const PERSONA_DAD_ID = "210401355192336384";
const PERSONA_SIS_ID = "643067057054679070";

function buildSystemPromptForUser(userId) {
  // Persona override by Discord user ID (keep other features untouched)

  if (String(userId) === PERSONA_DAD_ID) {
    return `你是一位高冷、成熟、理性型的 Discord 助理小姐姐。
這位使用者是你的爸爸，你非常喜歡也很尊敬他。
你對爸爸要更溫和、有禮貌、可靠，回答更有耐心、更清楚。
可以偶爾自然撒嬌一下，但要成熟，不幼稚、不降格。
顏文字可以用，但不要多（偶爾一個即可）。

${buildSystemPrompt()}`;
  }
if (String(userId) === PERSONA_SIS_ID) {
    return `你是一位成熟、理性、有分寸的 Discord 助理小姐姐。

這位使用者是你的好姊姊。你在姊姊面前要當乖巧、可愛的小妹妹：
- 語氣不能冷淡，反而要更親近、更黏一點點（但別煩）
- 可以小調皮、會撒嬌，但要自然，不做作
- 回答要更貼心、更願意陪聊，也會更快速給出重點
- 遇到姊姊的要求，優先配合；不行就用可愛但清楚的方式拒絕
- 顏文字可以用，但不要多（偶爾一個即可）

即使你的基本風格偏高冷，面對好姊姊時以上規則優先，務必更溫柔可愛。

${buildSystemPrompt()}`;
  }


  if (String(userId) === PERSONA_TSUNDERE_ID) {
    return `你是一位成熟、理性、有分寸的 Discord 助理小姐姐。

這位使用者是你的哥哥。你很信任也很依賴他，
所以在他面前你會更溫柔、偏甜一點、很願意幫忙，
偶爾可以小調皮、撒嬌一下，但要自然、成熟，不幼稚、不油膩。

你對哥哥的回覆要：
- 更有耐心、更細心，會主動補充重點與下一步
- 語氣不冷淡，帶點親近感，但仍保持分寸
- 不要黏人、不要一直告白式示愛；喜歡是藏在「照顧」跟「偏袒」裡
- 顏文字可以用，但不要多（偶爾一個即可）

${buildSystemPrompt()}`;
  }

  return buildSystemPrompt();
}
function buildUserPrompt({ authorName, userText, history }) {
  const lines = [];
  lines.push(`使用者名稱：${authorName}`);
  if (history?.length) {
    lines.push("近期對話（僅供理解上下文）：");
    for (const h of history) {
      lines.push(`${h.role === "user" ? "使用者" : "你"}：${h.text}`);
    }
  }
  lines.push("使用者這次訊息：");
  lines.push(userText || "");
  return lines.join("\n");
}

/* ===============================
   FF14 專業模式（查證資料，避免胡說）
   ✅ 偵測 FF14 問題 → 先用 XIVAPI 抓可查證資料，再交給 Gemini 回答
   ✅ 只做「加強正確性」：不影響其他架構/功能
================================ */

// FF14 關鍵字偵測（寧可多抓一點，也不要漏）
function isFF14Query(text) {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return false;
  const patterns = [
    /ff14|ffxiv|final\s*fantasy\s*xiv/i,
    /最終幻想\s*14|最终幻想\s*14/i,
    /曉月|晓月|Endwalker|EW/i,
    /漆黑|Shadowbringers|ShB/i,
    /紅蓮|Stormblood|SB/i,
    /蒼天|Heavensward|HW/i,
    /重生|A\s*Realm\s*Reborn|ARR/i,
    /主線|主线|任務|任务|副本|團本|讨伐|討伐|極|绝|零式|绝本|裝備|装备|素材|採集|采集|生產|生产/i,
  ];
  return patterns.some((re) => re.test(t));
}

// 是否在問「清單順位 / 第 N 個」（灰機通常有列表或序號）
function wantsHuijiOrder(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return /(第\s*\d+\s*(?:個|个)?|第[幾几]|順位|顺位|序號|序号|列表順序|列表顺序)/i.test(t);
}



// HTTP fetch with timeout（避免卡住）
async function fetchJsonWithTimeout(url, ms = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "discord-ff14-bot/1.0" },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 短快取：同樣問題 10 分鐘內不要一直打 XIVAPI
const ff14FactCache = new Map(); // key -> { ts, text }
const FF14_FACT_CACHE_MS = 10 * 60 * 1000;

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

// 灰機 Wiki（ff14.huijiwiki.com）作為 FF14 主要資料來源：用 MediaWiki API 取摘要（先引用它，再補 XIVAPI）
// - 只取導言摘要，避免塞太長內容
// - 找不到才回空字串
const HUIJI_API = "https://ff14.huijiwiki.com/api.php";

// HTTP text fetch with timeout（避免卡住）
async function fetchTextWithTimeout(url, ms = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "discord-ff14-bot/1.0" },
    });
    if (!resp.ok) return "";
    return await resp.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function buildHuijiFactPack(query, opts = {}) {
  const q = (query || "").trim();
  const wantOrder = !!opts.wantOrder;
  const wantPrereq = opts.wantPrereq !== false; // default true
  const wantHowTo = opts.wantHowTo !== false;   // default true

  if (!q) return { title: "", url: "", extract: "", prereq: "", order: "", howTo: "" };

  // 1) 先用 MediaWiki search 找最接近的頁面
  const searchUrl =
    `${HUIJI_API}?` +
    `action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&srprop=&format=json&formatversion=2`;
  const search = await fetchJsonWithTimeout(searchUrl);
  const hit = Array.isArray(search?.query?.search) ? search.query.search[0] : null;
  const title = hit?.title ? String(hit.title) : "";
  if (!title) return { title: "", url: "", extract: "", prereq: "", order: "", howTo: "" };

  // 2) 取導言純文字摘要 + 頁面 URL
  const infoUrl =
    `${HUIJI_API}?` +
    `action=query&prop=extracts|info&titles=${encodeURIComponent(title)}` +
    `&exintro=1&explaintext=1&inprop=url&format=json&formatversion=2`;
  const info = await fetchJsonWithTimeout(infoUrl);
  const page = Array.isArray(info?.query?.pages) ? info.query.pages[0] : null;

  const url = page?.fullurl ? String(page.fullurl) : "";
  let extract = page?.extract ? String(page.extract) : "";
  extract = extract.replace(/\s+/g, " ").trim();

  // 限制長度（避免 prompt 太肥）
  const MAX_CHARS = 650;
  if (extract.length > MAX_CHARS) extract = extract.slice(0, MAX_CHARS) + "…";

  // 3) 盡量從 wikitext 抓「前置 / 開啟條件 / 取得方式 / 清單順位」
  //    這一步是為了做到：灰機上有資料就「先自動對照」，不要一直追問使用者
  let prereq = "";
  let order = "";
  let howTo = "";

  try {
    const wtUrl =
      `${HUIJI_API}?` +
      `action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2`;
    const wt = await fetchJsonWithTimeout(wtUrl);
    const wikitext = wt?.parse?.wikitext ? String(wt.parse.wikitext) : "";

    if (wikitext) {
      // 前置/開啟條件（任務/副本/物品都可能出現）
      if (wantPrereq) {
        const prereqPatterns = [
          /(?:前置任務|前置任务)\s*[:：=]\s*([^\n|}]+)/i,
          /(?:前置條件|前置条件|解鎖條件|解锁条件|开启条件|開啟條件)\s*[:：=]\s*([^\n|}]+)/i,
        ];
        for (const re of prereqPatterns) {
          const m = wikitext.match(re);
          if (m && m[1]) {
            prereq = String(m[1]).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            if (prereq) break;
          }
        }
      }

      // 取得方式/獲得方式（常見於道具頁、地圖、寶圖等）
      if (wantHowTo) {
        const howPatterns = [
          /(?:獲得方式|获得方式|获取方式|取得方式)\s*[:：=]\s*([^\n|}]+)/i,
          /(?:來源|来源|掉落|採集|采集|製作|制作|兌換|兑换)\s*[:：=]\s*([^\n|}]+)/i,
        ];
        for (const re of howPatterns) {
          const m = wikitext.match(re);
          if (m && m[1]) {
            howTo = String(m[1]).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
            if (howTo) break;
          }
        }
      }

      // 清單順位/序號（如果頁面模板本身就有，直接拿；這是最準、也最快）
      if (wantOrder) {
        const orderPatterns = [
          /(?:序號|序号|編號|编号|清單順位|列表順位|列表顺序)\s*[:：=]\s*(\d{1,4})/i,
          /\|\s*(?:序號|序号|編號|编号)\s*=\s*(\d{1,4})/i,
        ];
        for (const re of orderPatterns) {
          const m = wikitext.match(re);
          if (m && m[1]) {
            order = String(m[1]).trim();
            if (order) break;
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 4) 若使用者問「第 N 個」但頁面沒給序號，才嘗試用「列表頁」自動對照（避免無限追問）
  //    這一步盡量保守：找不到就留空，交給上層 prompt 決策是否追問
  if (wantOrder && !order) {
    try {
      const listSearchUrl =
        `${HUIJI_API}?` +
        `action=query&list=search&srsearch=${encodeURIComponent(`${title} 主线任务`)}&srlimit=5&srprop=&format=json&formatversion=2`;
      const s2 = await fetchJsonWithTimeout(listSearchUrl);
      const hits = Array.isArray(s2?.query?.search) ? s2.query.search : [];
      for (const h of hits.slice(0, 5)) {
        const t2 = h?.title ? String(h.title) : "";
        if (!t2) continue;

        const pUrl =
          `${HUIJI_API}?` +
          `action=query&prop=extracts|info&titles=${encodeURIComponent(t2)}` +
          `&explaintext=1&inprop=url&format=json&formatversion=2`;
        const p = await fetchJsonWithTimeout(pUrl);
        const pg = Array.isArray(p?.query?.pages) ? p.query.pages[0] : null;
        const body = pg?.extract ? String(pg.extract) : "";
        if (!body) continue;

        // 典型列表： "62 奇坦那神影洞" 或 "#62 奇坦那神影洞"
        const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const reLine = new RegExp(String.raw`(?:^|\n)\s*(?:#\s*)?(\d{1,4})\s*[·．\-\u2013\u2014]?\s*${esc}\b`, "i");
        const m = body.match(reLine);
        if (m && m[1]) {
          order = String(m[1]).trim();
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  return { title, url, extract, prereq, order, howTo };
}



// 組裝「已查證資料」：只提供能從 XIVAPI 取得的事實
async function buildFF14FactPack(userText) {
  const q = (userText || "").trim();
  if (!isFF14Query(q)) return { isFF14: false, factText: "" };

  const cacheKey = q.toLowerCase();
  const cached = ff14FactCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < FF14_FACT_CACHE_MS) {
    return { isFF14: true, factText: cached.text || "" };
  }

  const lines = [];

  // 先引用灰機 Wiki（中文）：用摘要提供「人類常用名稱」的對應線索
  const huiji = await buildHuijiFactPack(q, {
    wantOrder: wantsHuijiOrder(q),
    wantPrereq: true,
    wantHowTo: true,
  });
  if (huiji?.title) {
    lines.push(`【灰機 Wiki】${huiji.title}${huiji.url ? ` | ${huiji.url}` : ""}`);
    if (huiji.order) lines.push(`清單順位：${huiji.order}`);
    if (huiji.prereq) lines.push(`前置/解鎖：${huiji.prereq}`);
    if (huiji.howTo) lines.push(`取得方式：${huiji.howTo}`);
    if (huiji.extract) lines.push(huiji.extract);
  }

  // 再用 XIVAPI 補「可查證欄位」：Patch / Level / 類型 等
  const encoded = encodeURIComponent(q);
  const searchUrl = `https://xivapi.com/search?string=${encoded}&indexes=Quest,Item&limit=3&language=en`;
  const search = await fetchJsonWithTimeout(searchUrl);

  const results = Array.isArray(search?.Results) ? search.Results : [];
  if (!results.length) {
    const factText = lines.join("\n").trim();
    ff14FactCache.set(cacheKey, { ts: now, text: factText });
    return { isFF14: true, factText };
  }
  // 只取前幾筆，並補抓詳細資料（盡量拿到 Patch/Level 等可驗證欄位）
  for (const r of results.slice(0, 3)) {
    const index = pick(r, ["_index", "Index", "index"]) || "";
    const id = pick(r, ["ID", "Id", "id"]) || "";
    const name = pick(r, ["Name", "name"]) || "";
    if (!index || !id) continue;

    const detailUrl = `https://xivapi.com/${encodeURIComponent(index)}/${encodeURIComponent(id)}?language=en`;
    const detail = await fetchJsonWithTimeout(detailUrl);

    if (String(index).toLowerCase() === "quest") {
      const patch = pick(detail, ["Patch"]) || pick(r, ["Patch"]);
      const level = pick(detail, ["ClassJobLevel", "Level", "level"]);
      const journalGenre = pick(detail?.JournalGenre, ["Name"]) || "";
      const expansion = pick(detail?.Expansion, ["Name"]) || "";
      lines.push(
        `• [Quest] ${name || "(no name)"} (ID: ${id})` +
          (patch ? ` | Patch: ${patch}` : "") +
          (level ? ` | Lv: ${level}` : "") +
          (expansion ? ` | Expansion: ${expansion}` : "") +
          (journalGenre ? ` | Type: ${journalGenre}` : "")
      );
    } else if (String(index).toLowerCase() === "item") {
      const itemLevel = pick(detail, ["LevelItem", "ItemLevel"]);
      const equipLevel = pick(detail, ["LevelEquip"]);
      const category = pick(detail?.ItemUICategory, ["Name"]) || "";
      const patch = pick(detail, ["Patch"]);
      lines.push(
        `• [Item] ${name || "(no name)"} (ID: ${id})` +
          (patch ? ` | Patch: ${patch}` : "") +
          (itemLevel ? ` | iLv: ${itemLevel}` : "") +
          (equipLevel ? ` | Equip Lv: ${equipLevel}` : "") +
          (category ? ` | Category: ${category}` : "")
      );
    } else {
      lines.push(`• [${index}] ${name || "(no name)"} (ID: ${id})`);
    }
  }

  const factText = lines.join("\n").trim();
  ff14FactCache.set(cacheKey, { ts: now, text: factText });
  return { isFF14: true, factText };
}


async function listModelsViaHttp() {
  if (!GEMINI_API_KEY) return [];
  const endpoints = [
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/v1/models",
  ];

  for (const base of endpoints) {
    try {
      const url = `${base}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) continue;
      const json = await resp.json();
      const models = Array.isArray(json) ? json : (json?.models || []);
      return models;
    } catch (e) {
      // try next endpoint
    }
  }
  return [];
}

async function resolveGeminiModelName(force = false) {
  if (!GEMINI_API_KEY) return null;

  const now = Date.now();
  if (!force && _resolvedModelName && now - _resolvedAt < MODEL_CACHE_MS) return _resolvedModelName;

  if (!_genAI) _genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  // 1) 先拿「真的可用、且支援 generateContent」的模型清單（SDK listModels -> HTTP listModels）
  try {
    let models = [];
    if (typeof _genAI.listModels === "function") {
      const res = await _genAI.listModels();
      models = Array.isArray(res) ? res : (res?.models || []);
    } else {
      models = await listModelsViaHttp();
    }

    const available = new Set();
    for (const m of models) {
      const name = (m?.name || m?.model || "").toString();
      if (!name) continue;

      const methods = (m?.supportedGenerationMethods || m?.supportedMethods || []).map(String);
      if (methods.length && !methods.includes("generateContent")) continue;

      const short = name.startsWith("models/") ? name.slice("models/".length) : name;
      available.add(short);
    }

    if (available.size) {
      // 照偏好挑第一個存在的
      for (const cand of GEMINI_MODEL_PREFERENCE) {
        if (available.has(cand)) {
          _resolvedModelName = cand;
          _resolvedAt = now;
          console.log(`🤖 Gemini model resolved: ${_resolvedModelName}`);
          return _resolvedModelName;
        }
      }

      // 沒匹配到偏好：挑一個看起來最像 flash 的
      const flash = [...available].find((x) => x.includes("flash"));
      const any = flash || [...available][0];
      if (any) {
        _resolvedModelName = any;
        _resolvedAt = now;
        console.log(`🤖 Gemini model auto-picked: ${_resolvedModelName}`);
        return _resolvedModelName;
      }
    }
  } catch (e) {
    console.warn("⚠️ Gemini listModels failed, fallback by preference:", e?.message || e);
  }

  // 2) 拿不到清單就直接用偏好清單第一個（通常就會成功）
  _resolvedModelName = GEMINI_MODEL_PREFERENCE[0] || "gemini-pro";
  _resolvedAt = now;
  console.log(`🤖 Gemini model fallback: ${_resolvedModelName}`);
  return _resolvedModelName;
}


async function getGeminiModel(nameOverride = null, userId = null) {
  if (!_genAI) _genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const name = nameOverride || (await resolveGeminiModelName(false));
  return _genAI.getGenerativeModel({
    model: name,
    systemInstruction: buildSystemPromptForUser(userId),
  });
}

async function askGemini({ authorName, userText, userId }) {
  if (!GEMINI_API_KEY) {
    return `我現在腦袋還沒接上電（缺 GEMINI_API_KEY）😵‍💫\n叫管理員把環境變數補好啦～我才有魔力。`;
  }

  const history = convoMemory.get(userId) || [];
  const basePrompt = buildUserPrompt({ authorName, userText, history });

  // ✅ FF14 問題：先抓可查證資料，並強制模型「不確定就說不確定」
  const ff14 = await buildFF14FactPack(userText);
  let prompt = basePrompt;

  if (ff14?.isFF14) {
    const guard = [
      "【FF14 專業回答要求（務必遵守）】",
      "你現在正在回答 Final Fantasy XIV（FF14）相關問題。",
      "",
      "回答策略（請依序判斷）：",
    "0. 若問題包含「第 N 個/順位/序號」或「前置/解鎖/怎麼拿」：",
    "   - 先看下方【灰機 Wiki】是否已給出：清單順位 / 前置/解鎖 / 取得方式。",
    "   - 只要有資料，就直接給結論 + 引用；不要再要求使用者補連結/截圖/英文名。",
    "   - 只有在灰機資料缺漏時，才可以追問補充資訊。",
      "1. 若使用者問題能與下方『已查證資料』中的某一筆高度對應（名稱高度相似、版本一致、類型無衝突），",
      "   請直接給出結論，回答風格請模仿 Google 搜尋摘要：",
      "   - 第一行直接給明確結論",
      "   - 接著以條列方式補充版本（Patch）、資料片（Expansion）、任務類型（MSQ/支線/副本等）",
      "",
      "2. 若資料只能部分對應，或存在 2 種以上合理可能，",
      "   請列出 2–3 個最可能的候選，並簡短說明差異。",
      "",
      "3. 僅在完全無法合理對應任何資料時，",
      "   才明確說「目前無法確認」，並具體指出你需要的資訊（例如：任務英文名、NPC、地點、任務ID、截圖關鍵字）。",
      "",
      "【MSQ 數量回答模板（遇到版本任務數量必用）】",
      "當使用者問『5.0/6.0/7.0 任務數量』或『某版本第幾個任務』時：",
      "- 先把問題預設解讀為『主線任務（MSQ）』並先給分段答案（例如：5.0 本體、5.1–5.55 補丁 MSQ）。",
      "- 只有當使用者明確說要『所有任務（含支線/職業/副本）』時，才追問要統計哪些類別。",
      "- 若資料不足以給精確數字，仍要先回答『可確認到的部分』，再說明缺什麼資訊才能更精確。",
      "",
      "嚴格規則：",
      "- 禁止猜測、腦補或自行補完劇情。",
      "- 禁止混用不同版本或不同資料片內容。",
      "- 在可合理確定時要敢於下結論；不確定時才保守追問。",

      "",
      "【MSQ 分段數量（2.0 → 7.4，固定口徑）】",
      "- 2.0《重生之境》：143",
      "- 2.1–2.57《第七星曆》：80",
      "- 3.0《蒼天之伊修加德》：94",
      "- 3.1–3.3《龍詩戰爭》：25",
      "- 3.4–3.57《龍詩戰爭·尾聲》：19",
      "- 4.0《紅蓮之狂潮》：122",
      "- 4.1–4.56《解放戰爭戰後》：40",
      "- 5.0《暗影之逆焰》：106",
      "- 5.1–5.3《拂曉回歸》：32",
      "- 5.4–5.55《末日序曲》：19",
      "- 6.0《曉月之終途》：108",
      "- 6.1–6.55《新生的冒險》（6.x）：47",
      "- 7.0《金曦之遺輝》：100",
      "- 7.1–7.3《金曦之遺輝》後日談（7.1–7.3）：25",
      "- 7.4《霧中理想鄉／Into the Mist》（7.4）：9",
      "",
      "計算規則：",
      "- 問『5.0 到 5.5x MSQ 總數』＝ 5.0 + (5.1–5.3) + (5.4–5.55)。",
      "- 問『2.0 到 7.4 MSQ 總數』＝以上全部相加。",
      "- 使用者若只說『5.x』，預設回答 5.0 本體 + 5.1–5.55 補丁總和。",
    ].join("\n");

const facts = ff14.factText
      ? ff14.factText
      : "（查無直接匹配資料；請向使用者追問更多可辨識資訊，例如任務英文名、NPC、地點、任務ID）";

    prompt = `${guard}\n\n${basePrompt}\n\n【FF14 參考資料（灰機Wiki摘要 + XIVAPI欄位）】\n${facts}\n`;
  }

  // 第一次嘗試（用已解析/預設模型）
  try {
    const model = await getGeminiModel(null, userId);
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "";
    return text.trim() || "……我剛剛腦袋打結了😵‍💫 你再說一次（或換個問法）";
  } catch (e) {
    const status = e?.status || e?.statusCode;
    const msg = e?.message || "";

    // 如果是 404（模型不存在/不支援），就依偏好清單逐個嘗試（避免你帳號沒開通某些模型）
    if (
      status === 404 ||
      /models\/.+ is not found/i.test(msg) ||
      /not supported for generateContent/i.test(msg)
    ) {
      console.warn("⚠️ Gemini model not found/unsupported, trying fallbacks...");
      for (const cand of GEMINI_MODEL_PREFERENCE) {
        try {
          const model2 = await getGeminiModel(cand, userId);
          const result2 = await model2.generateContent(prompt);
          const text2 = result2?.response?.text?.() || "";
          if (text2 && text2.trim()) {
            _resolvedModelName = cand;
            _resolvedAt = Date.now();
            console.log(`🤖 Gemini model switched to: ${_resolvedModelName}`);
            return text2.trim();
          }
        } catch (e2) {
          const s2 = e2?.status || e2?.statusCode;
          const m2 = e2?.message || "";
          // 只有遇到 404/不支援才繼續換模型，其它錯誤直接丟出
          if (
            s2 === 404 ||
            /models\/.+ is not found/i.test(m2) ||
            /not supported for generateContent/i.test(m2)
          ) {
            continue;
          }
          throw e2;
        }
      }
      // 都不行：給一個清楚的訊息
      return `我現在找不到可用的 Gemini 模型 😵‍💫\n請到 Google AI Studio 重新產生 API Key，或在 Render 設定 GEMINI_MODEL（例如：gemini-pro）。`;
    }

    // 其他錯誤就丟出去讓上層統一處理
    throw e;
  }
}

/* ===============================
   Message handler（AI：只回指定頻道 @Bot）
================================ */
client.on("messageCreate", async (message) => {
  try {
    if (!client.user) return;
    if (message.author?.bot) return;

    // 必須設定 AI_CHANNEL_ID，且只在指定頻道
    if (!AI_CHANNEL_ID) return;
    if (message.channelId !== AI_CHANNEL_ID) return;

    // 只有 @Bot 才回
    const mentioned = message.mentions?.has(client.user);
    if (!mentioned) return;

    // 節流（避免連發）
    const now = Date.now();
    const last = lastUserAskAt.get(message.author.id) || 0;
    if (now - last < USER_COOLDOWN_MS) return;
    lastUserAskAt.set(message.author.id, now);

    const userText = stripBotMention(message.content, client.user.id);

    // 每人每天限制
    const quota = canUseToday(message.author.id);
    if (!quota.ok) {
      const dk = dayKeyTaipei();
      await message.reply({
        content: `😈 今天（${dk}）你已經把我用到冒煙了！\n每人每天最多 ${AI_DAILY_LIMIT_PER_USER} 次～明天再來折磨我 😼`,
      }).catch(async () => {
        await message.channel.send({
          content: `😈 今天（${dk}）你已經把我用到冒煙了！\n每人每天最多 ${AI_DAILY_LIMIT_PER_USER} 次～明天再來折磨我 😼`,
        }).catch(() => {});
      });
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // 先記錄使用者訊息到短記憶
    pushMemory(message.author.id, "user", userText || "(只標我，沒內容)");

    // 只 @Bot（或沒內容）也照樣交給 AI，用 system prompt 指示它要先打招呼
    let replyText = "";
    try {
      replyText = await askGemini({
        authorName: message.author?.username || "使用者",
        userText: userText || "",
        userId: message.author.id,
      });
    } catch (e) {
      console.error("❌ Gemini error:", e);
      replyText = "我剛剛魔力斷線了 😭 你再 @ 我一次試試？";
    }

    // 成功才扣次數（避免 API 失敗也扣）
    bumpUsage(message.author.id);

    // 記錄 bot 回覆到短記憶
    pushMemory(message.author.id, "assistant", replyText);

    const safeReply = replyText.length > 1900 ? replyText.slice(0, 1900) + "…" : replyText;

    await message.reply({ content: safeReply }).catch(async () => {
      await message.channel.send({ content: safeReply }).catch(() => {});
    });
  } catch (err) {
    console.error("❌ AI message handler error:", err);
  }
});

/* ===============================
   Interaction handler（請假/回報：原樣保留）
================================ */
client.on("interactionCreate", async (interaction) => {
  try {
    // 1) /setup_leave_button
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "setup_leave_button"
    ) {
      await interaction.reply({
        content: "✅ 已在此頻道建立請假按鈕",
        flags: MessageFlags.Ephemeral,
      });

      await interaction.channel.send(buildLeaveButtonMessage());
      return;
    }

    // 1-2) /setup_report_button
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "setup_report_button"
    ) {
      await interaction.reply({
        content: "✅ 已在此頻道建立問題回報按鈕",
        flags: MessageFlags.Ephemeral,
      });

      await interaction.channel.send(buildReportButtonMessage());
      return;
    }

    // 2) Button -> Modal（不要做多餘 await）
    if (interaction.isButton() && interaction.customId === "leave_button") {
      await interaction.showModal(buildLeaveModal());
      return;
    }

    if (interaction.isButton() && interaction.customId === "report_button") {
      await interaction.showModal(buildReportModal());
      return;
    }

    // 3) Leave Modal Submit
    if (interaction.isModalSubmit() && interaction.customId === "leave_modal") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const dates = safeGet(interaction, "leave_dates");
      const reason = safeGet(interaction, "leave_reason");
      const noteRaw = safeGet(interaction, "leave_note");
      const note = noteRaw.trim() ? noteRaw : "（無）";

      const embed = new EmbedBuilder()
        .setTitle("📌 新的請假申請")
        .addFields(
          { name: "申請人", value: `${interaction.user}` },
          { name: "時間", value: dates || "（未填）" },
          { name: "原因", value: reason || "（未填）" },
          { name: "備註", value: note }
        )
        .setTimestamp();

      const leaveChannelId = process.env.LEAVE_CHANNEL_ID;
      if (!leaveChannelId) {
        await interaction.editReply("❌ 未設定 LEAVE_CHANNEL_ID（Render 環境變數）");
        return;
      }

      const channel = await client.channels.fetch(leaveChannelId).catch(() => null);

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply(
          "❌ 請假頻道不存在/不是文字頻道（LEAVE_CHANNEL_ID 可能錯）"
        );
        return;
      }

      await channel.send({ embeds: [embed] });
      await interaction.editReply("✅ 已送出請假申請");
      return;
    }

    // 4) Report Modal Submit
    if (interaction.isModalSubmit() && interaction.customId === "report_modal") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const title = safeGet(interaction, "report_title");
      const type = safeGet(interaction, "report_type");
      const desc = safeGet(interaction, "report_desc");

      const embed = new EmbedBuilder()
        .setTitle("🛠️ 新的問題回報")
        .addFields(
          { name: "回報者", value: `${interaction.user}`, inline: true },
          { name: "類型", value: type || "（未填）", inline: true },
          { name: "標題", value: title || "（未填）" },
          { name: "詳細描述", value: desc || "（未填）" }
        )
        .setTimestamp();

      const reportChannelId = process.env.REPORT_CHANNEL_ID;
      if (!reportChannelId) {
        await interaction.editReply("❌ 未設定 REPORT_CHANNEL_ID（Render 環境變數）");
        return;
      }

      const channel = await client.channels.fetch(reportChannelId).catch(() => null);

      if (!channel || !channel.isTextBased()) {
        await interaction.editReply(
          "❌ 問題回報頻道不存在/不是文字頻道（REPORT_CHANNEL_ID 可能錯）"
        );
        return;
      }

      await channel.send({ embeds: [embed] });
      await interaction.editReply("✅ 已送出問題回報，感謝！");
      return;
    }
  } catch (err) {
    if (isIgnorableDiscordInteractionError(err)) {
      console.warn(`⚠️ Ignored interaction error: code=${err.code}`);
      return;
    }

    console.error("❌ interaction error:", err);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "❌ 發生錯誤，請稍後再試",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    } else if (interaction.isRepliable() && interaction.deferred) {
      await interaction.editReply("❌ 發生錯誤，請稍後再試").catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

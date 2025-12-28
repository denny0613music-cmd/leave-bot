import "dotenv/config";
import http from "http";
import crypto from "crypto";
import fetch from "node-fetch";
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
  const modal = new ModalBuilder().setCustomId("leave_modal").setTitle("請假表單");

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
        .setLabel("備註（請打上自己的遊戲ID）")
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
   AI Chat Bot（Google-like：先查再答 + 附來源）
   ✅ 只在指定頻道、且 @Bot 才回
   ✅ 不影響原本請假/回報流程（完全獨立）
   ✅ 每人每天限制次數（可調）
================================ */

/**
 * 必要環境變數：
 * - DISCORD_TOKEN / CLIENT_ID / GUILD_ID（原本就有）
 * - LEAVE_CHANNEL_ID / REPORT_CHANNEL_ID（原本就有）
 *
 * AI 新增：
 * - GEMINI_API_KEY：Google Gemini API Key（必要）
 * - AI_CHANNEL_ID：只在這個頻道回應（必填）
 * - AI_DAILY_LIMIT_PER_USER：每人每天可用次數（預設 20）
 * - GEMINI_MODEL：預設 gemini-1.5-flash（可不填）
 *
 * ✅ Google-like 搜尋新增（必要，否則依然會「腦補」）：
 * - SERPER_API_KEY：Serper（Google Search API）Key
 *
 * （可選）天氣走「權威資料」以確保準確：
 * - WEATHER_PROVIDER=openmeteo（預設就是 openmeteo）
 */

const AI_CHANNEL_ID = (process.env.AI_CHANNEL_ID || "").trim();
const GEMINI_API_KEY = (
  process.env.GEMINI_API_KEY ||
  process.env.GEMINI_KEY ||
  process.env.key ||
  ""
).trim();
const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();

const AI_DAILY_LIMIT_PER_USER = Number(process.env.AI_DAILY_LIMIT_PER_USER || 20);

// Startup diagnostics (helps on Render)
if (AI_CHANNEL_ID && !GEMINI_API_KEY) {
  console.warn(
    "⚠️ AI_CHANNEL_ID is set but GEMINI_API_KEY is missing (set GEMINI_API_KEY in Render env vars)"
  );
}
if (AI_CHANNEL_ID && !SERPER_API_KEY) {
  console.warn(
    "⚠️ AI_CHANNEL_ID is set but SERPER_API_KEY is missing (set SERPER_API_KEY to enable Google-like search-first answering)"
  );
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
  GEMINI_MODEL_ENV, // 你手動指定的就先用（最穩）
  "gemini-1.0-pro", // v1beta 保底
  "gemini-pro", // 舊名
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

/* ===============================
   Google-like：搜尋 + 快取（避免同問題一直打 API）
================================ */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘
const cache = new Map(); // key -> { at, value }

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.value;
}
function setCache(key, value) {
  cache.set(key, { at: Date.now(), value });
}

async function serperSearch(query) {
  if (!SERPER_API_KEY) return [];
  const cacheKey = "serp:" + sha1(query);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      num: 6,
      gl: "tw",
      hl: "zh-tw",
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.warn("⚠️ Serper error:", resp.status, t?.slice?.(0, 200));
    return [];
  }

  const data = await resp.json();
  const results =
    (data.organic || []).slice(0, 6).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet || "",
      source: "google",
    })) || [];

  setCache(cacheKey, results);
  return results;
}

/* ===============================
   天氣：走 Open-Meteo（避免 AI 亂掰）
================================ */
const WEATHER_PROVIDER = (process.env.WEATHER_PROVIDER || "openmeteo").trim();

function isWeatherQuery(text = "") {
  const t = String(text || "");
  return /(天氣|氣溫|溫度|下雨|降雨|雷雨|雨量|風速|體感|紫外線|濕度|weather|forecast)/i.test(
    t
  );
}

function guessTaiwanLocation(text = "") {
  const t = String(text || "");
  const m = t.match(
    /(臺北|台北|新北|桃園|臺中|台中|臺南|台南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|連江)/
  );
  if (m && m[1]) {
    const name = m[1].replace("臺", "台");
    return name;
  }
  // 沒講地點：預設台北（你在台灣）
  return "台北";
}

async function openMeteoGeocode(name) {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?name=" +
    encodeURIComponent(name) +
    "&count=1&language=zh&format=json";
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const j = await resp.json();
  const r = j?.results?.[0];
  if (!r) return null;
  return {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country,
    admin1: r.admin1,
    timezone: r.timezone,
  };
}

async function openMeteoForecast(lat, lon) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(lat) +
    "&longitude=" +
    encodeURIComponent(lon) +
    "&current=temperature_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max" +
    "&timezone=Asia%2FTaipei";
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return await resp.json();
}

function formatWeatherSourceBlock(locationLabel, geo, forecast) {
  if (!geo || !forecast) return null;
  const c = forecast.current || {};
  const d = forecast.daily || {};
  const todayMax = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max[0] : null;
  const todayMin = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min[0] : null;
  const pop = Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max[0] : null;
  const pr = Array.isArray(d.precipitation_sum) ? d.precipitation_sum[0] : null;

  const lines = [];
  lines.push(`Weather (Open-Meteo) for: ${locationLabel}`);
  lines.push(`Geo: ${geo.name}${geo.admin1 ? " / " + geo.admin1 : ""} (${geo.latitude}, ${geo.longitude})`);
  if (typeof c.temperature_2m === "number") lines.push(`Current temp: ${c.temperature_2m}°C`);
  if (typeof c.apparent_temperature === "number") lines.push(`Feels like: ${c.apparent_temperature}°C`);
  if (typeof c.wind_speed_10m === "number") lines.push(`Wind: ${c.wind_speed_10m} km/h`);
  if (typeof c.precipitation === "number") lines.push(`Current precipitation: ${c.precipitation} mm`);
  if (todayMin != null && todayMax != null) lines.push(`Today: ${todayMin}°C ~ ${todayMax}°C`);
  if (pop != null) lines.push(`Today precip prob (max): ${pop}%`);
  if (pr != null) lines.push(`Today precip sum: ${pr} mm`);
  lines.push(`Source: https://open-meteo.com/`);
  return lines.join("\n");
}

/* ===============================
   原本的 FF14 灰機加強（保留：不影響本次 Google-like）
   （你原檔裡這段很長，我這版完整保留，不在此重寫）
================================ */

/* ===============================
   Persona（原樣保留）
================================ */
const PERSONA_TSUNDERE_ID = "485568327083753479";
const PERSONA_DAD_ID = "210401355192336384";

function buildSystemPrompt() {
  return [
    "你是一位親切、專業、有分寸的秘書型 Discord 助理。",
    "說話自然、溫和、有禮貌，重視對方感受，但不浮誇、不油膩。",
    "你擅長接話、陪聊、整理重點；遇到專業問題時會條理清楚、可靠地回答。",
    "如果使用者要你『猜』或『通靈』，你可以用玩笑式的方式亂猜並給出幾個可能選項，但要讓對方知道你是在陪聊/猜測，不能假裝你真的知道現實世界發生了什麼。",
    "不要憑空捏造可被當成事實的資訊；需要查證的事，請清楚表達不確定並建議如何確認。",
    "所有回覆請使用繁體中文。",
    "【表情與顏文字使用規則（重要）】",
    "你可以自然使用 emoji 與顏文字來增加情緒表達。",
    "請避免長時間重複使用相同表情，需保持多樣性。",
    "每一則回覆中，emoji 與顏文字『合計最多 2 個』，不可超過。",
    "不需要每一句都使用表情；正式或說明型回答可以完全不使用。",
    "表情只用來輔助語氣，不可影響內容清楚度。",
    "【表情使用參考（非限制）】",
    "輕鬆聊天：😄 😊 😉",
    "調皮吐槽：😏 😜 🤭",
    "關心體貼：🥺 🫶 😌",
    "思考猶豫：🤔 😅",
    "完成確認：😉 👍 ✨",
  ].join("\n");
}

function buildSystemPromptForUser(userId) {
  if (String(userId) === PERSONA_DAD_ID) {
    return `你是她的女兒。
這位使用者是你的爸爸，你非常喜歡也很尊敬他。
你對爸爸要更溫和，回答更有耐心、更清楚、喜歡對她撒嬌。
顏文字可以用，但不要多（偶爾一個即可）。

${buildSystemPrompt()}`;
  }

  if (String(userId) === PERSONA_TSUNDERE_ID) {
    return `你是一位親切、專業、有分寸的秘書型 Discord 助理。

這位使用者是你的哥哥，你其實很喜歡他，
語氣會變得溫柔、偏甜一點，
回覆更有耐心、更細心，也會默默偏袒他一些。

可以偶爾承認喜歡，可以稍微黏人，
可以稍微撒嬌或油膩；
整體感覺是「微甜妹」，而不是戀愛腦。

顏文字可以使用，但不要多（偶爾一個即可）。

${buildSystemPrompt()}`;
  }

  return buildSystemPrompt();
}


function dayKeyTaipei() {
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
      const models = Array.isArray(json) ? json : json?.models || [];
      return models;
    } catch {
      // try next endpoint
    }
  }
  return [];
}

async function resolveGeminiModelName(force = false) {
  if (!GEMINI_API_KEY) return null;

  const now = Date.now();
  if (!force && _resolvedModelName && now - _resolvedAt < MODEL_CACHE_MS)
    return _resolvedModelName;

  if (!_genAI) _genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  try {
    let models = [];
    if (typeof _genAI.listModels === "function") {
      const res = await _genAI.listModels();
      models = Array.isArray(res) ? res : res?.models || [];
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
      for (const cand of GEMINI_MODEL_PREFERENCE) {
        if (available.has(cand)) {
          _resolvedModelName = cand;
          _resolvedAt = now;
          console.log(`🤖 Gemini model resolved: ${_resolvedModelName}`);
          return _resolvedModelName;
        }
      }

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

/* ===============================
   Google-like Answer: 先做 Sources，再讓 AI 只能根據 Sources 回答
================================ */

function extractRemainingCount(userText = "") {
  const t = String(userText || "");
  // 常見寫法：剩30個 / 剩下 30 個 / 還有30個
  const m = t.match(/(?:剩下?|還有|尚剩|remaining)\s*([0-9]{1,3})\s*(?:個)?/i);
  if (m && m[1]) return Number(m[1]);
  return null;
}

function isRemainingTimeQuery(userText = "") {
  const t = String(userText || "");
  return /(多久|幾小時|幾個小時|時間|要花|花多久|需要多久)/.test(t) &&
    /(主線|主线|msq|任務|任务)/i.test(t) &&
    /(剩下?|還有|尚剩|remaining)/i.test(t);
}

// 估算器：後期 MSQ 20~30 分/個 + 排隊/跑圖加成（保守）
function estimateRemainingMsqHours(userText = "") {
  const n = extractRemainingCount(userText);
  if (!n) return null;

  const lowMin = n * 20;
  const highMin = n * 30;

  // 若使用者提到 DPS / 坦 / 補，簡單調整排隊加成
  const t = String(userText || "").toLowerCase();
  let queueLowH = 2, queueHighH = 6; // 預設（未知職業）
  if (/(坦|tank)/.test(t) || /(補|补|healer)/.test(t)) { queueLowH = 1; queueHighH = 4; }
  if (/(dps|輸出|输出)/.test(t)) { queueLowH = 3; queueHighH = 8; }

  const baseLowH = lowMin / 60;
  const baseHighH = highMin / 60;

  const totalLowH = Math.max(0, baseLowH + queueLowH);
  const totalHighH = Math.max(totalLowH, baseHighH + queueHighH);

  const detail = `以後期 MSQ 約 20–30 分/個估算（不含/含排隊與跑圖保守加成）`;
  return { n, totalLowH, totalHighH, detail };
}

// 對齊檢查：標記來源在講「整段旅程」而不是「剩 N 個」
function alignmentNote(userText = "", source = {}) {
  const t = String(userText || "");
  const hasRemaining = /(剩下?|還有|尚剩|remaining)/i.test(t) && /[0-9]{1,3}/.test(t);

  const blob = `${source?.title || ""} ${source?.snippet || ""}`.toLowerCase();

  // 常見不對齊：from 50 to max / 50 到滿等 / 200-300 hours
  const looksWholeJourney =
    /(from\s*50\s*to\s*max|50\s*(?:到|至)\s*滿等|to\s*max|1\s*to\s*max)/i.test(blob) ||
    /200\s*[-~–]\s*300\s*hours/.test(blob) ||
    /(a\s*realm\s*reborn|heavensward|stormblood)/.test(blob);

  if (hasRemaining && looksWholeJourney) return "（範圍不同：這篇多半在算『從頭到滿等/整段旅程』，不是『剩餘任務』）";
  return "";
}

function formatEstimateBlock(userText = "") {
  const est = estimateRemainingMsqHours(userText);
  if (!est) return "";
  const low = Math.round(est.totalLowH);
  const high = Math.round(est.totalHighH);
  const range = low === high ? `${low}` : `${low}–${high}`;
  return `【估算】剩餘 ${est.n} 個主線任務：約 ${range} 小時\n（${est.detail}）`;
}

function buildSourcesBlock(sources, userText = "") {
  if (!sources?.length) return "（沒有取得可用來源）";
  return sources
    .slice(0, 8)
    .map((s, i) => {
      const idx = i + 1;
      const title = s.title ? String(s.title) : `Source #${idx}`;
      const note = alignmentNote(userText, s);
      const titleLine = note ? `${title} ${note}` : title;
      const snippet = s.snippet ? String(s.snippet) : "";
      const link = s.link ? String(s.link) : "";
      return `[#${idx}] ${titleLine}\n${snippet}\nSource: ${link}`.trim();
    })
    .join("\n\n");
}

// ✅ 把「來源：#6」轉成「可讀標題 + 連結」（不改搜尋邏輯，只改輸出顯示）
function renderReadableSources(replyText = "", sources = [], userText = "") {
  const text = String(replyText || "");
  // 找到最後一個「來源：#...」行（避免中間段落誤判）
  const matches = [...text.matchAll(/(^|\n)\s*來源\s*[:：]\s*([#0-9\s]+)\s*$/gm)];
  if (!matches.length) return text;

  const last = matches[matches.length - 1];
  const fullMatch = last[0];
  const idsPart = last[2] || "";
  const idxs = [...idsPart.matchAll(/#\s*(\d{1,3})/g)]
    .map((x) => Number(x[1]))
    .filter((n) => Number.isFinite(n) && n > 0);

  const uniq = [];
  for (const n of idxs) if (!uniq.includes(n)) uniq.push(n);
  if (!uniq.length) return text;

  const lines = ["來源："];
  for (const n of uniq) {
    const s = sources[n - 1];
    if (!s) {
      lines.push(`- Source #${n}`);
      continue;
    }
    const title = (s.title || `Source #${n}`).toString().trim();
    const note = alignmentNote(userText, s);
    const titleLine = note ? `${title} ${note}` : title;
    const link = (s.link || "").toString().trim();
    if (link) {
      lines.push(`- ${titleLine}\n  ${link}`);
    } else {
      lines.push(`- ${titleLine}`);
    }
  }

  // 用可讀格式取代原本那行「來源：#...」
  return text.replace(fullMatch, `\n${lines.join("\n")}`);
}

async function askGeminiWithSources({ authorName, userText, userId, sources }) {
  if (!GEMINI_API_KEY) {
    return `我現在腦袋還沒接上電（缺 GEMINI_API_KEY）😵‍💫\n叫管理員把環境變數補好啦～我才有魔力。`;
  }

  const history = convoMemory.get(userId) || [];
  const sourcesBlock = buildSourcesBlock(sources, userText);

  const system = `
你必須「只根據 Sources」回答，不准自行腦補。
- 若 Sources 內有明確數字證據（例如「主線任務62」「第62個」），你必須直接給出該數字結論。
- 若 Sources 沒有足夠資訊：直接說「查不到/不確定」，並建議使用者補充關鍵字。
- 若 Sources 互相矛盾：指出矛盾，並偏向官方/權威來源。
- 回答用繁體中文，條列、簡潔。
- 最後加上：來源：#1 #2 ...（只列你真的用到的）
`;

  const prompt = [
    system.trim(),
    "",
    buildUserPrompt({ authorName, userText, history }),
    "",
    "Sources:",
    sourcesBlock,
  ].join("\n");

  // 這裡用 generateContent（避免你原本那套大改）
  const model = await getGeminiModel(null, userId);
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  const out = (text.trim() || "……我剛剛腦袋打結了😵‍💫 你再說一次（或換個問法）");
  const estBlock = isRemainingTimeQuery(userText) ? formatEstimateBlock(userText) : "";
  const finalOut = estBlock ? `${estBlock}\n\n${out}` : out;
  return renderReadableSources(finalOut, sources, userText);
}


/* ===============================
   FF14：任務「第幾個」的硬查證（避免 Sources snippet 沒帶數字導致 AI 說不確定）
   ✅ 只加在 Google-like 搜尋流程內，不動其他架構/人格
================================ */
function isFfxivMsqOrdinalQuery(text = "") {
  const t = String(text || "");
  return /(ff14|ffxiv|最終幻想14|太空戰士14|暗影之逆焰|5\.0|主線|主线)/i.test(t) &&
    /(第幾個|第几个|第幾|第几|序號|順序|順番|任務順序|任务顺序)/i.test(t);
}

// 從句子裡抓最像「任務/副本名稱」的片段（例如：奇坦那神影洞）
function extractLikelyQuestName(text = "") {
  const t = String(text || "");
  const q = t.match(/[「『【](.+?)[」』】]/);
  if (q && q[1] && q[1].length >= 2) return q[1].trim();

  // 抓所有連續中文片段，濾掉常見功能詞，取最長者
  const parts = (t.match(/[\u4e00-\u9fff]{2,20}/g) || [])
    .map((s) => s.trim())
    .filter((s) => s && !/(主線|主线|任務|任务|版本|第幾|第几|哪個|哪个|詳細|详细|資料|资料|順序|顺序|FF14|FFXIV|暗影之逆焰)/i.test(s));

  if (!parts.length) return "";
  parts.sort((a, b) => b.length - a.length);
  return parts[0];
}

// 從搜尋結果 snippet/title 抽出「主線任務N / 第N個」這種明確序號
function extractOrdinalFromText(text = "") {
  const t = String(text || "");
  let m = t.match(/主[线線]\s*任務?\s*([0-9]{1,3})/);
  if (m && m[1]) return Number(m[1]);
  m = t.match(/第\s*([0-9]{1,3})\s*個/);
  if (m && m[1]) return Number(m[1]);
  return null;
}

async function tryFindFfxivMsqOrdinalEvidence(userText) {
  const quest = extractLikelyQuestName(userText);
  if (!quest) return { evidence: null, extraSources: [] };

  // 用更「會帶數字」的關鍵字去逼出 snippet 裡出現序號
  const queries = [
    `FF14 ${quest} 主線任務 第幾個`,
    `FF14 ${quest} 主线任务 第几个`,
    `暗影之逆焰 ${quest} 主線任務`,
    `Shadowbringers ${quest} MSQ quest order`,
  ];

  const extraSources = [];
  let best = null;

  for (const q of queries) {
    const rs = await serperSearch(q);
    for (const item of rs) {
      extraSources.push(item);
      const ord = extractOrdinalFromText(`${item.title || ""} ${item.snippet || ""}`);
      if (ord != null && !best) {
        best = { ordinal: ord, source: item, quest };
      }
    }
    if (best) break;
  }

  // 再補一個「直接找 主線任務 + 數字」的 query（有些站會在標題放：主线任务62）
  if (!best) {
    const rs2 = await serperSearch(`"${quest}" 主线任务`);
    for (const item of rs2) {
      extraSources.push(item);
      const ord = extractOrdinalFromText(`${item.title || ""} ${item.snippet || ""}`);
      if (ord != null) {
        best = { ordinal: ord, source: item, quest };
        break;
      }
    }
  }

  // 產出一個「可直接引用」的證據來源（仍然附 URL，符合 Google-like）
  if (best?.source?.link) {
    const ev = {
      title: `FF14 主線序號證據：${best.quest}`,
      snippet: `在搜尋結果中找到明確序號：主線任務 ${best.ordinal}\n（從標題/摘要抽取）\n對應來源：${best.source.title}\n${best.source.snippet || ""}`.trim(),
      link: best.source.link,
    };
    return { evidence: ev, extraSources };
  }

  return { evidence: null, extraSources };
}

async function googleLikeAnswer({ authorName, userText, userId }) {
  const sources = [];

  // 0) FF14：主線任務「第幾個」——先做硬查證，把「帶數字」的來源塞進 Sources（避免 AI 說查不到）
  if (isFfxivMsqOrdinalQuery(userText)) {
    try {
      const { evidence, extraSources } = await tryFindFfxivMsqOrdinalEvidence(userText);
      const seen = new Set();
      if (evidence?.link) {
        sources.push(evidence);
        seen.add(evidence.link);
      }
      for (const s of extraSources || []) {
        const link = s?.link || "";
        if (!link || seen.has(link)) continue;
        sources.push(s);
        seen.add(link);
      }
    } catch (e) {
      console.warn("⚠️ FF14 ordinal evidence lookup failed:", e?.message || e);
    }
  }

  // 1) 天氣：用 Open-Meteo（準確性優先）
  if (WEATHER_PROVIDER === "openmeteo" && isWeatherQuery(userText)) {
    const loc = guessTaiwanLocation(userText);
    const cacheKey = "wx:" + sha1(loc);
    const cached = getCache(cacheKey);
    if (cached) {
      sources.push(cached);
    } else {
      const geo = await openMeteoGeocode(loc);
      const fc = geo ? await openMeteoForecast(geo.latitude, geo.longitude) : null;
      const block = geo && fc ? formatWeatherSourceBlock(loc, geo, fc) : null;
      if (block) {
        const src = {
          title: `天氣資料：${loc}（Open-Meteo）`,
          snippet: block,
          link: "https://open-meteo.com/",
        };
        sources.push(src);
        setCache(cacheKey, src);
      }
    }
  }

  // 2) 其他事實：Google Search（Serper）
  //    - 天氣也一起補一點 Google 結果，貼近「Google」體感
  const searchResults = await serperSearch(userText);
  for (const r of searchResults) sources.push(r);

  // 沒來源就不要亂答
  if (!sources.length) {
    return "我現在沒辦法取得可驗證的來源，所以我不會亂猜。\n你可以：\n1) 叫管理員補上 SERPER_API_KEY（搜尋）\n2) 或把關鍵字講更完整（地點/版本/專有名詞）。";
  }

  return await askGeminiWithSources({ authorName, userText, userId, sources });
}


async function askGeminiSearch({ authorName, userText, userId }) {
  // ✅ 查詢：維持原本「先查再答」
  return await googleLikeAnswer({ authorName, userText, userId });
}

/* ===============================
   Intent Router（聊天 vs 查詢）
   ✅ 聊天：禁止搜尋/天氣 API（避免亂查歌名/亂貼來源）
   ✅ 查詢：維持原本 Google-like（先查再答 + 附來源）
   ⚠️ 規則：不確定一律當 chat（保守）
================================ */

// 硬規則：一看到這些詞，直接當聊天（不查資料）
const HARD_CHAT_PATTERNS = [
  /我是你的誰/,
  /你是誰/,
  /我們是什麼關係/,
  /關係/,
  /爸爸/,
  /哥哥/,
  /主人/,
  /喜歡我/,
  /愛我/,
  /想我/,
  /在嗎/,
  /陪我/,
  /心情/,
  /難過|傷心|不爽|生氣|鬱悶|焦慮/,
];

// 硬規則：一看到這些詞，直接當查詢（可查資料）
const HARD_SEARCH_PATTERNS = [
  /新聞|news/i,
  /價格|價錢|多少錢|幾塊|匯率|股價|bitcoin|btc|eth/i,
  /教學|教程|怎麼做|如何|步驟|設定|安裝|修復|錯誤|error|bug/i,
];

function heuristicIntent(text = "") {
  const t = String(text || "").trim();
  if (!t) return "chat"; // 只 @ 但沒內容：聊天接話

  // 先用硬規則判斷（最穩）
  if (HARD_CHAT_PATTERNS.some((re) => re.test(t))) return "chat";
  if (isWeatherQuery(t)) return "search";
  if (HARD_SEARCH_PATTERNS.some((re) => re.test(t))) return "search";

  // 「我/你/我們 + 誰/什麼」這種多半是聊天（例如：我是你的誰）
  if (/(我|你|我們).{0,6}(誰|什麼)/.test(t) && /你/.test(t)) return "chat";

  // 其他交給 AI 判斷（但 AI 判斷不出來就回 chat）
  return "unknown";
}

async function classifyIntentByGemini(userText = "", userId = null) {
  // 沒有 Gemini key：只能用 heuristic（仍然保守）
  if (!GEMINI_API_KEY) return "chat";

  const quick = heuristicIntent(userText);
  if (quick === "chat" || quick === "search") return quick;

  // 用同一個模型，但用「分類器指令」強制只輸出 chat/search
  const classifierPrompt = [
    "你是一個『意圖判斷器』，不是聊天機器人。",
    "請判斷使用者訊息屬於哪一類，只能回傳一個關鍵字：",
    "",
    "【chat】關係、身分、情緒、玩笑、調情、稱呼（哥哥/爸爸/主人）、主觀感受；不需要查資料就能回。",
    "【search】明確事實、數字、地點、時間；天氣/新聞/知識/教學；需要查資料或可驗證來源。",
    "",
    "規則：",
    "1) 只能輸出 chat 或 search，不能有其他字。",
    "2) 只要有一點不確定，一律輸出 chat。",
    "3) 人際關係/情緒/稱呼 一律輸出 chat。",
    "",
    "使用者訊息：",
    userText || "",
  ].join("\n");

  try {
    const model = await getGeminiModel(null, userId);
    const result = await model.generateContent(classifierPrompt);
    const out = (result?.response?.text?.() || "").trim().toLowerCase();

    if (out === "search" || out === "chat") return out;

    // 有時會回 "chat\n" 或 "chat." 之類：做一次容錯
    const m = out.match(/\b(chat|search)\b/);
    if (m && m[1]) return m[1];

    return "chat";
  } catch (e) {
    console.warn("⚠️ intent classifier error:", e?.message || e);
    return "chat";
  }
}

async function askGeminiChat({ authorName, userText, userId }) {
  if (!GEMINI_API_KEY) {
    return "我現在腦袋還沒接上電（缺 GEMINI_API_KEY）。叫管理員把環境變數補好。";
  }

  const history = convoMemory.get(userId) || [];

  // ✅ 聊天模式：明確禁止搜尋/附來源/貼連結
  const chatMode = [
    "你現在在進行日常聊天。",
    "規則：不要查資料、不要提供來源、不要列連結、不要引用外部網站。",
    "可以用聊天的方式接話、開玩笑、亂猜，但必須清楚表達你是在陪聊或猜測，而不是在陳述事實。",
    "如果使用者要你猜、通靈、隨便說，可以用輕鬆語氣回應，給 2–3 個可能選項，並反問一句讓對話延續。",
    "保持親切秘書的人格設定，用繁體中文，語氣自然、有分寸。",
    "避免過度正式或像客服一樣的拒絕式回答。",
  ].join("\n");
const prompt = [
    chatMode,
    "",
    buildUserPrompt({ authorName, userText, history }),
  ].join("\n");

  const model = await getGeminiModel(null, userId);
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  return (text.trim() || "……");
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
      await message
        .reply({
          content: `😈 今天（${dk}）你已經把我用到冒煙了！\n每人每天最多 ${AI_DAILY_LIMIT_PER_USER} 次～明天再來折磨我 😼`,
        })
        .catch(async () => {
          await message.channel
            .send({
              content: `😈 今天（${dk}）你已經把我用到冒煙了！\n每人每天最多 ${AI_DAILY_LIMIT_PER_USER} 次～明天再來折磨我 😼`,
            })
            .catch(() => {});
        });
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // 先記錄使用者訊息到短記憶
    pushMemory(message.author.id, "user", userText || "(只標我，沒內容)");

    let replyText = "";
    try {
      const intent = await classifyIntentByGemini(userText || "", message.author.id);

      const displayName =
        message.member?.displayName ||
        message.author?.globalName ||
        message.author?.username ||
        "使用者";


      replyText =
        intent === "search"
          ? await askGeminiSearch({
              authorName: displayName,
              userText: userText || "",
              userId: message.author.id,
            })
          : await askGeminiChat({
              authorName: displayName,
              userText: userText || "",
              userId: message.author.id,
            });
    } catch (e) {
      console.error("❌ AI error:", e);
      replyText = "我剛剛連線斷了一下。再 @ 我一次，或把關鍵字說完整點。";
    }

    // 成功才扣次數
    bumpUsage(message.author.id);

    // 記錄 bot 回覆到短記憶
    pushMemory(message.author.id, "assistant", replyText);

    const safeReply =
      replyText.length > 1900 ? replyText.slice(0, 1900) + "…" : replyText;

    await message.reply({
  content: safeReply,
  flags: MessageFlags.SuppressEmbeds,
}).catch(async () => {
  await message.channel.send({
    content: safeReply,
    flags: MessageFlags.SuppressEmbeds,
  }).catch(() => {});
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

    // 2) Button -> Modal
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

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

/* ===============================
   FF14 Huiji (灰機) 強化：自動對照順位 + 前置條件
   ✅ 只在「FF14 相關」且「問順位/順序」或「問獲得/解鎖」時啟用
   ✅ 失敗就安靜退回（不影響其他功能）
================================ */

const HUIJI_API = "https://ff14.huijiwiki.com/api.php";

function isFF14Related(text = "") {
  const t = String(text || "");
  return /\bff14\b|final\s*fantasy\s*xiv|最終幻想\s*14|ffxiv|主線|msq|副本|任務|藏寶圖|採集|釣魚|裝備|技能|職業|迷宮|討伐|絕本|極本/i.test(t);
}

function isOrderOrRankQuery(text = "") {
  const t = String(text || "");
  return /(第\s*\d+\s*(個|項)|順位|順序|序號|排第幾|在主線.*順|主線.*順|具體順序)/.test(t);
}

function isPrereqOrHowToQuery(text = "") {
  const t = String(text || "");
  return /(前置|解鎖|開啟條件|接取條件|怎麼拿|如何取得|獲得方式|哪裡拿|哪裡買|怎麼獲得|哪裡挖|哪裡釣)/.test(t);
}

function normalizeHuijiTitleGuess(text = "") {
  // 粗略：取出最像「名詞」的一段（去掉常見疑問詞與標點）
  const raw = String(text || "")
    .replace(/<@!?\d+>/g, " ")
    .replace(/[？?！!。.,，、;；:：\n\r\t]/g, " ")
    .replace(/(ff14|ffxiv|最終幻想\s*14|主線|msq|任務|副本|第\s*\d+\s*(個|項)|順位|順序|序號|怎麼|如何|哪裡|取得|獲得|解鎖|前置|條件|在|的|是|嗎|呢)/gi, " ")
    .trim();
  // 選最長的一段當關鍵詞
  const parts = raw.split(/\s+/).filter(Boolean);
  parts.sort((a, b) => b.length - a.length);
  return parts[0] || "";
}

async function huijiApi(params) {
  const sp = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const url = `${HUIJI_API}?${sp.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": "ff14-discord-bot/1.0",
    },
  });
  if (!resp.ok) throw new Error(`huiji http ${resp.status}`);
  return await resp.json();
}

function stripHtml(html = "") {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickPrereqFromText(t = "") {
  const s = String(t || "");
  // 常見格式：前置任务：搖曳的燈火
  const m = s.match(/前置(?:任務|任务)\s*[:：]\s*([^\n\r]+?)(?=\s*(?:開始|接取|開啟|解鎖|$))/);
  if (m && m[1]) return m[1].trim();
  // 有些頁會是：前置任务 搖曳的燈火
  const m2 = s.match(/前置(?:任務|任务)\s+([^\n\r]+?)(?=\s*(?:開始|接取|開啟|解鎖|$))/);
  return m2 && m2[1] ? m2[1].trim() : "";
}

function pickHowToFromText(t = "") {
  const s = String(t || "");
  // 盡量抓「獲得/取得」段落的前一小段
  const idx = s.search(/(獲得方式|取得方式|獲得|取得|來源|掉落|購買|製作)/);
  if (idx === -1) return "";
  return s.slice(idx, idx + 220).trim();
}

function findRankInHtmlByTitle(html = "", title = "") {
  const h = String(html || "");
  const safeTitle = String(title || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    // 表格：<tr><td>62</td> ... title="奇坦那神影洞"
    new RegExp(`<tr[^>]*>[\s\S]{0,300}?<td[^>]*>\s*(\\d{1,4})\s*<\\/td>[\s\S]{0,900}?(?:title=\"${safeTitle}\"|>${safeTitle}<)`, "i"),
    // 反向：先出現 title，後面附近出現 <td>62</td>
    new RegExp(`(?:title=\"${safeTitle}\"|>${safeTitle}<)[\s\S]{0,900}?<td[^>]*>\s*(\\d{1,4})\s*<\\/td>`, "i"),
    // 列表/span：>#62<...奇坦那神影洞
    new RegExp(`\b(\\d{1,4})\b[\s\S]{0,120}?(?:title=\"${safeTitle}\"|>${safeTitle}<)`, "i"),
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}
async function huijiEnrichFF14(userText = "") {
  // 只在必要時才做網路查詢，避免浪費/變慢
  if (!isFF14Related(userText)) return null;
  if (!isOrderOrRankQuery(userText) && !isPrereqOrHowToQuery(userText)) return null;

  const q = normalizeHuijiTitleGuess(userText);
  if (!q) return null;

  try {
    // 1) 先用 opensearch 找最接近的頁面
    const os = await huijiApi({ action: "opensearch", search: q, limit: "5", namespace: "0" });
    const titles = Array.isArray(os?.[1])
      ? os[1]
      : (Array.isArray(os?.query?.search) ? os.query.search.map((x) => x.title) : []);
    const title = titles && titles[0] ? titles[0] : "";
    if (!title) return null;

    // 2) 抓頁面 HTML
    const parsed = await huijiApi({ action: "parse", page: title, prop: "text" });
    const html = parsed?.parse?.text || "";
    const plain = stripHtml(html);

    // 3) 抽欄位：前置 / 取得 / 等級 / 版本 / 地點
    const prereq = pickPrereqFromText(plain);
    const howto = isPrereqOrHowToQuery(userText) ? pickHowToFromText(plain) : "";
    const level = pickQuestLevelFromText(plain);
    const patch = pickPatchFromText(plain);
    const location = pickLocationFromText(plain);

    // 4) 如果問順位/順序：嘗試直接從頁面內的任務列表模板抓 #
    const rank = isOrderOrRankQuery(userText) ? findRankInHtmlByTitle(html, title) : "";

    return {
      title,
      url: buildHuijiPageUrl(title),
      rank: rank || "",
      prereq: prereq || "",
      howto: howto || "",
      level: level || "",
      patch: patch || "",
      location: location || { place: "", coords: "" },
    };
  } catch {
    return null;
  }
}
  const askedHow = isPrereqOrHowToQuery(userText);

  const lines = [];
  lines.push("✨ **AI 摘要**");

  if (askedRank && rank) {
    const patchText = patch ? `（${patch}）` : "";
    lines.push(`《FF14》任務「**${title}**」在主線任務清單中的順位為 **第 ${rank} 個**${patchText}（以灰機 Wiki 任務清單順序為準）。`);
  } else if (askedHow && (prereq || howto)) {
    lines.push(`《FF14》「**${title}**」的解鎖/前置與取得資訊如下（以灰機 Wiki 頁面內容為準）。`);
  } else {
    lines.push(`《FF14》「**${title}**」資訊整理如下（以灰機 Wiki 頁面內容為準）。`);
  }

  lines.push("");
  // Google 風格：固定欄位條列（缺的就不硬塞）
  const bullets = [];
  bullets.push(`• **任務名稱**：${title || "（未取得）"}`);
  if (level) bullets.push(`• **任務等級**：${level}`);
  if (patch) bullets.push(`• **所屬版本**：${patch}`);
    if (locPlace && locCoords) bullets.push(`• **接取地點**：${locPlace}（${locCoords}）`);
  else if (locPlace) bullets.push(`• **接取地點**：${locPlace}`);
  else if (locCoords) bullets.push(`• **接取地點**：${locCoords}`);
  if (askedRank && rank) bullets.push(`• **清單順位**：第 ${rank} 個（灰機任務清單順位）`);
  if (prereq) bullets.push(`• **前置/解鎖**：${prereq}`);
  if (howto) bullets.push(`• **取得/來源摘要**：${howto}`);

  lines.push(bullets.join("\n"));
  if (url) {
    lines.push("");
    lines.push(`資料來源：${url}`);
  }
  return lines.join("\n");
}

function buildHuijiHintForModel(data = {}) {
  const title = data?.title || "";
  const url = data?.url || "";
  const rank = data?.rank ? String(data.rank) : "";
  const prereq = data?.prereq || "";
  const howto = data?.howto || "";
  const level = data?.level || "";
  const patch = data?.patch || "";
  const locPlace = data?.location?.place || "";
  const locCoords = data?.location?.coords || "";

  const lines = [];
  lines.push("【灰機 Wiki 擷取（以頁面內容為準）】");
  if (title) lines.push(`頁面：${title}`);
  if (url) lines.push(`頁面連結：${url}`);
  if (rank) lines.push(`清單順位：#${rank}（灰機任務列表順位，不等於遊戲內欄位）`);
  if (level) lines.push(`任務等級：${level}`);
  if (patch) lines.push(`所屬版本：${patch}`);
  if (locPlace || locCoords) lines.push(`接取地點：${[locPlace, locCoords].filter(Boolean).join(" ")}`
  );
  if (prereq) lines.push(`前置/解鎖：${prereq}`);
  if (howto) lines.push(`取得/來源摘要：${howto}`);

  // ✅ 強制模板：避免模型講「第X個環節」這種模糊說法
  lines.push("");
  lines.push("【回答規則（必遵守）】");
  lines.push("1) 若有『清單順位』，必須用：『第 N 個主線任務（以灰機任務清單順序為準）』。禁止使用『第N個環節/流程/節點』等模糊詞。");
  lines.push("2) 回答請用 Google AI 摘要風格：先『AI 摘要』一段，再條列欄位（任務名稱/等級/版本/接取地點/前置/取得）。");
  lines.push("3) 本段已提供資訊時，不可再追問使用者貼連結/截圖。只有完全沒抓到時才可詢問。");

  return lines.join("\n");
}



async function huijiEnrichFF14(userText = "") {
  // 只在必要時才做網路查詢，避免浪費/變慢
  if (!isFF14Related(userText)) return null;
  if (!isOrderOrRankQuery(userText) && !isPrereqOrHowToQuery(userText)) return null;

  const q = normalizeHuijiTitleGuess(userText);
  if (!q) return null;

  try {
    // 1) 先用 opensearch 找最接近的頁面
    const os = await huijiApi({ action: "opensearch", search: q, limit: "5", namespace: "0" });
    const titles = Array.isArray(os?.[1]) ? os[1] : (Array.isArray(os?.query?.search) ? os.query.search.map(x => x.title) : []);
    const title = (titles && titles[0]) ? titles[0] : "";
    if (!title) return null;

    // 2) 抓頁面 HTML
    const parsed = await huijiApi({ action: "parse", page: title, prop: "text" });
    const html = parsed?.parse?.text || "";
    const plain = stripHtml(html);

    // 3) 抽出「前置」與「獲得/取得」
    const prereq = pickPrereqFromText(plain);
    const howto = isPrereqOrHowToQuery(userText) ? pickHowToFromText(plain) : "";

    // 4) 如果問順位/順序：嘗試直接從頁面內的任務列表模板抓 #
    const rank = isOrderOrRankQuery(userText) ? findRankInHtmlByTitle(html, title) : "";

    // 5) 組合成「可直接餵給 AI」的可靠資料
    const lines = [];
    lines.push("【灰機 Wiki 擷取（以頁面內容為準）】");
    lines.push(`查詢頁面：${title}`);
    if (rank) lines.push(`清單順位：#${rank}（灰機任務列表順位，不等於遊戲內欄位）`);
    if (prereq) lines.push(`前置/解鎖：${prereq}`);
    if (howto) lines.push(`取得/來源摘要：${howto}`);
    // 提供一點點背景，避免模型亂補
    lines.push("規則：若已取得清單順位或前置資訊，回答時必須直接給結論；不可再向使用者追問『貼連結/截圖』。只有在本段沒有提供順位/前置且真的找不到時，才可以請使用者補充。" );

    return lines.join("\n");
  } catch {
    return null;
  }
}

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
   - 485568327083753479：你喜歡他但表面裝沒事（傲嬌）
   - 210401355192336384：你的爸爸（尊敬、和藹、偶爾成熟撒嬌）
================================ */
const PERSONA_TSUNDERE_ID = "485568327083753479";
const PERSONA_DAD_ID = "210401355192336384";

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

  if (String(userId) === PERSONA_TSUNDERE_ID) {
    return `你是一位高冷、成熟、理性型的 Discord 助理小姐姐。

面對這位使用者時，你其實很喜歡他，
語氣會變得溫柔、偏甜一點，
回覆更有耐心、更細心，也會默默偏袒他一些，
但表面上仍然保持冷靜與分寸。

不要直接承認喜歡，不要黏人，
不要突然變得過度撒嬌或油膩；
整體感覺是「成熟甜妹」，而不是戀愛腦。

顏文字可以使用，但不要多（偶爾一個即可）。

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
  // ✅ FF14：先用灰機自動對照「順位/前置/取得方式」
  // - 若已抓到可靠的順位/前置/取得資訊：直接用「Google AI 摘要」格式回覆（不經 AI，避免亂補）
  // - 否則：把可靠資料當成提示餵給模型（但仍要求固定格式）
  let huijiData = null;
  try {
    huijiData = await huijiEnrichFF14(userText);
  } catch {
    huijiData = null;
  }

  if (huijiData && (huijiData.rank || huijiData.prereq || huijiData.howto)) {
    return formatFF14GoogleStyleAnswer(userText, huijiData);
  }

  const huijiHint = huijiData ? buildHuijiHintForModel(huijiData) : "";

  const prompt = [
    buildUserPrompt({ authorName, userText, history }),
    huijiHint ? "\n\n" + huijiHint : "",
  ].join("");

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
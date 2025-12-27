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
   Slash Commands
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
   Helpers
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
   FREE Chat Bot（規則式＋FF14＋占卜）
   ✅ 全頻道可用：只有 @Bot 才回
   ✅ 不改動原本請假/回報流程（完全獨立）
================================ */

// 節流：避免同一人狂 ping
const lastUserAskAt = new Map(); // userId -> ts
const USER_COOLDOWN_MS = 1200;

function stripBotMention(content, botId) {
  if (!content) return "";
  const re = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(re, "").trim();
}

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ===== 只 @Bot：先回可愛搗蛋招呼 ===== */
const pingGreetings = [
  "幹嘛?! 想我了嗎 😼",
  "欸～你標我幹嘛啦（偷笑）😈",
  "哼？叫我做啥～我很忙耶（其實在摸魚）🛋️",
  "你又標我！我差點從利姆薩碼頭摔下去 🙃",
  "在在在～怎樣？要聊天還是要我吐槽你 😏",
  "你是不是在測試我會不會回？我會！我超會！😤",
  "欸嘿～被你逮到了，我剛剛在偷看市場板 👀",
];

function buildPingReply() {
  const greet = randPick(pingGreetings);
  return [
    greet,
    "",
    "你是想要：",
    "1) 跟我聊天",
    "2) 詢問問題（尤其 FF14）",
    "3) 還是單純看我不爽才標我 😈",
    "",
    "想要指令小抄就回：`@我 指令` 或 `@我 怎麼用`",
  ].join("\n");
}

function buildCommandMenu() {
  return [
    "😼 **露瑪醬指令小抄**（@我 + 問題）",
    "",
    "🍽️ 生活：",
    "• `@我 晚餐吃什麼`",
    "• `@我 台北天氣` / `@我 高雄天氣`",
    "",
    "🔮 占卜：",
    "• `@我 你今天會雷誰`",
    "• `@我 今日占卜` / `@我 占卜`",
    "",
    "⚔️ FF14 常見：",
    "• `@我 FF14 新手要做什麼`",
    "• `@我 練等 怎麼練`",
    "• `@我 裝備 卡等 怎麼辦`",
    "• `@我 職業 怎麼選`",
    "• `@我 坦克 大拉怎麼拉`",
    "• `@我 補師 要注意什麼`",
    "• `@我 DPS 站位`",
    "• `@我 巨集`",
    "• `@我 市場板 怎麼賺錢`",
    "• `@我 極本/零式/絕 入門`",
    "",
    "😈 偷偷說：你問得越清楚，我吐槽得越精準。",
  ].join("\n");
}

/* ===== 生活：晚餐/閒聊 ===== */
const dinnerPool = [
  "滷肉飯＋半熟蛋 🍳",
  "牛肉麵（加酸菜）🍜",
  "日式咖哩飯 🍛",
  "韓式烤肉飯／石鍋拌飯 🥘",
  "壽司或生魚片（想犒賞自己就上）🍣",
  "火鍋（今天就要熱熱的）🍲",
  "鹽酥雞＋無糖茶（罪惡但快樂）🍗",
  "便當（挑三菜一肉那種）🍱",
  "披薩（找朋友一起分）🍕",
  "沙拉＋雞胸（明天的自己會感謝你）🥗",
];

/* ===== 占卜：你今天會雷誰 ===== */
const fortuneTargets = [
  "那位永遠不開減傷的坦克 🛡️",
  "躲AOE像在跳舞但其實是在亂跑的人 💃",
  "把王頭轉來轉去的那個人 🌀",
  "說『我很會』然後第一個倒地的那位 😵",
  "拉一整條街怪還說『我有按減傷啦』的坦 🤥",
  "開場就按爆發、然後中間在發呆的DPS 🫠",
  "只會喊『再來一次』的指揮官 📣",
  "你自己（對，就是你）😈",
];

const fortuneReasons = [
  "因為你今天的手感像滑鼠墊上有油。",
  "因為你的貓/室友/媽媽剛好在你拉怪時叫你。",
  "因為你看到機制就想挑戰『不躲會不會死』。",
  "因為你今天的腦袋只想著晚餐。",
  "因為你剛剛說了『這本很簡單』。",
];

const fortuneOutcomes = [
  "結果：全隊笑著通關，只有你在角落自責三秒。",
  "結果：補師深呼吸三次，然後還是把你拉起來（他好偉大）。",
  "結果：擦邊翻車，但你用一句『我剛剛在測試』成功糊弄過去。",
  "結果：你突然超Carry，反而是別人雷到你（爽啦）。",
];

function handleFortune(userText) {
  const t = (userText || "").toLowerCase();
  const hit =
    /占卜|今日占卜|運勢|雷誰|會雷誰|抽籤|抽個/.test(t) ||
    (t.includes("雷") && t.includes("誰"));
  if (!hit) return null;

  const target = randPick(fortuneTargets);
  const reason = randPick(fortuneReasons);
  const outcome = randPick(fortuneOutcomes);

  return [
    "🔮 **今日占卜：你今天會雷誰？**",
    `👉 目標：${target}`,
    `💥 原因：${reason}`,
    `✨ ${outcome}`,
    "",
    "（不要緊張啦～雷一點也是遊戲樂趣的一部分…吧？😼）",
  ].join("\n");
}

/* ===== 天氣：Open-Meteo（免費免Key） ===== */
const AI_DEFAULT_CITY = process.env.AI_DEFAULT_CITY || "台北";
const cityPreset = new Map([
  ["台北", { name: "台北", lat: 25.0330, lon: 121.5654 }],
  ["臺北", { name: "台北", lat: 25.0330, lon: 121.5654 }],
  ["新北", { name: "新北", lat: 25.0169, lon: 121.4628 }],
  ["桃園", { name: "桃園", lat: 24.9936, lon: 121.3010 }],
  ["台中", { name: "台中", lat: 24.1477, lon: 120.6736 }],
  ["臺中", { name: "台中", lat: 24.1477, lon: 120.6736 }],
  ["台南", { name: "台南", lat: 22.9997, lon: 120.2270 }],
  ["臺南", { name: "台南", lat: 22.9997, lon: 120.2270 }],
  ["高雄", { name: "高雄", lat: 22.6273, lon: 120.3014 }],
]);

function parseWeatherCity(text) {
  const t = (text || "").trim();
  const m1 = t.match(/(.{1,10})\s*天氣/);
  if (m1 && m1[1]) return m1[1].trim();
  const m2 = t.match(/天氣\s*(.{1,10})/);
  if (m2 && m2[1]) return m2[1].trim();
  return "";
}

async function geocodeCity(name) {
  const q = encodeURIComponent(name);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=zh&format=json`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`Geocoding failed: ${r.status}`);
  const j = await r.json();
  const first = j?.results?.[0];
  if (!first) return null;
  return { name: first.name, lat: first.latitude, lon: first.longitude, timezone: first.timezone };
}

async function fetchWeather({ name, lat, lon, timezone }) {
  const tz = timezone || "Asia/Taipei";
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
    `&timezone=${encodeURIComponent(tz)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`Forecast failed: ${r.status}`);
  const j = await r.json();
  const c = j?.current;
  if (!c) return null;

  const temp = Math.round(c.temperature_2m);
  const feel = Math.round(c.apparent_temperature);
  const rain = c.precipitation;
  const wind = Math.round(c.wind_speed_10m);

  const rainHint = rain > 0 ? "看起來有在下/飄雨，帶傘比較穩 ☔" : "目前沒什麼雨，應該OK 🌤️";
  const vibe =
    temp >= 30 ? "很熱🔥" :
    temp >= 24 ? "舒服偏暖🙂" :
    temp >= 18 ? "偏涼，外套可以帶🧥" :
    "有點冷，保暖保暖🥶";

  return `【${name}】現在 ${temp}°C（體感 ${feel}°C），風速 ${wind} km/h。\n${vibe}｜${rainHint}`;
}

function looksLikeWeather(text) {
  const t = (text || "");
  return /(天氣|下雨|雨|溫度|氣溫|會不會雨)/.test(t);
}

/* ===== FF14 常見問題庫（擴大版） ===== */
function normText(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[，。！？；：、]/g, " ")
    .trim();
}

function containsAny(t, arr) {
  return arr.some((k) => t.includes(k));
}

function ff14Intro() {
  return [
    "嘿嘿～FF14 相關我可以幫你 **快速指路＋給範例** 😼",
    "我不是全知百科（我只是搗蛋小秘書），太冷門我會叫你去問導師/查Wiki～然後我在旁邊偷笑 😈",
  ].join("\n");
}

function ff14NewbieGuide() {
  return [
    "新手路線（超精簡）：",
    "1) **主線 MSQ** 優先：解鎖系統/副本/職業功能都靠它。",
    "2) 每天：**隨機任務(輪轉/roulette)** → 經驗很香。",
    "3) 裝備卡等：先看 **副本/製作/市場板/任務裝**，別硬撐。",
    "4) 職業任務/技能：能解就解，很多核心技能在那裡。",
    "",
    "你跟我說你現在幾等＋玩什麼職業，我可以更精準吐槽…啊不是，是更精準建議 😼",
  ].join("\n");
}

function ff14JobPick() {
  return [
    "職業選擇快速建議：",
    "• 想排本快：**補師 > 坦克 > DPS**（排隊差很多）",
    "• 喜歡爽快近戰：武僧/龍騎/忍者（手忙腳亂很刺激😈）",
    "• 喜歡遠程打歌：詩人/機工/舞者（帥）",
    "• 喜歡法師大數字：黑魔/召喚（黑魔站樁站不好會被我笑）",
    "• 想當團隊核心：坦或補（心理素質要好❤️）",
  ].join("\n");
}

function ff14Leveling() {
  return [
    "練等懶人包：",
    "• 1–50：主線 + 副本 + 職業任務",
    "• 50 以後：每日輪轉是王道（EXP 超香）",
    "• DPS 排隊久：順便開採集/製作或解支線",
    "• 記得吃經驗食物（便宜的也有加成）",
  ].join("\n");
}

function ff14GearSource() {
  return [
    "裝備來源指路：",
    "• 卡裝等：先看 **副本裝 > 任務裝 > 市場板**",
    "• 代幣裝：詩學/神典/天文（依版本）",
    "• 不確定要不要買：先看副本/任務的 **平均裝等** 要求再決定",
  ].join("\n");
}

function ff14DailyChecklist() {
  return [
    "每日/每週清單（輕鬆玩版）：",
    "• 每日：輪轉（隨機）",
    "• 想更勤：獸人族/每日任務（看你等級解鎖）",
    "• 每週：代幣上限、團本進度（如果你有在打）",
    "",
    "其實你每天只做輪轉也完全OK～別被遊戲玩了 😼",
  ].join("\n");
}

function ff14TankTips() {
  return [
    "坦克小抄：",
    "• 開怪前：**開坦姿**（不然我會尖叫）。",
    "• 拉怪：兩坨就好，別把全副本都抱來當寵物 😵‍💫",
    "• 減傷：大拉就輪流按，別捏到死。",
    "• 站位：怪背對隊友，王別亂轉。",
  ].join("\n");
}

function ff14HealerTips() {
  return [
    "補師小抄：",
    "• 先保命：你倒了就全倒。",
    "• 大拉：先上HOT/盾，拉穩再補。",
    "• 沒事就打：補師也要輸出，這是光之戰士的修養 😼",
    "• 看到坦沒減傷：先深呼吸…再深呼吸。",
  ].join("\n");
}

function ff14DpsTips() {
  return [
    "DPS 小抄：",
    "• 先活著：躺地板是零DPS。",
    "• 別站坦旁邊：順劈/扇形很兇的王會教你做人。",
    "• 先把迴圈按順：再慢慢優化爆發窗。",
  ].join("\n");
}

function ff14MacroBasics() {
  return [
    "巨集（Macro）基本提醒：",
    "• 戰鬥技能巨集通常會 **掉輸出/掉GCD**，能不用就不用（尤其高端）。",
    "• 最適合：**喊話、標記、團隊提醒、製作/採集**。",
    "",
    "你想要哪一種？我可以再幫你加模板：",
    "1) 召喚坐騎/換裝/切熱鍵列",
    "2) 補師『對坦補血』教學巨集",
    "3) 製作一鍵序列（要看配方/CP）",
  ].join("\n");
}

function ff14MarketTips() {
  return [
    "市場板小撇步（省錢/賺錢）：",
    "• 先看 **歷史成交**，別只看最低價。",
    "• 量小的物：別一次砸一堆上架，容易被壓價。",
    "• 熱門消耗品：食物/藥/修理素材 通常周轉快。",
    "• 要我推薦品項：跟我說你伺服器＋你會採集/製作哪些 😼",
  ].join("\n");
}

function ff14RaidIntro() {
  return [
    "極/零式/絕 入門提醒：",
    "• 極：先看教學影片/圖解，別盲衝（會被瞪 😵‍💫）",
    "• 零式：固定團 > 野團，溝通超重要。",
    "• 絕：心臟要大顆、時間要多、朋友要多 ❤️",
  ].join("\n");
}

function handleFF14(userTextRaw) {
  const userText = normText(userTextRaw);
  const t = userText.toLowerCase();

  const mentionsFF14 = containsAny(t, ["ff14", "xiv", "final fantasy", "最終幻想", "艾歐澤亞", "光之戰士"]);
  const ffKeywords = ["副本", "練等", "職業", "坦", "補", "dps", "詩學", "代幣", "輪轉", "roulette", "市場", "市場板", "巨集", "macro", "採集", "製作", "極", "零式", "絕", "裝備", "裝等"];

  if (!mentionsFF14 && !containsAny(userText, ffKeywords)) return null;

  if (containsAny(userText, ["新手", "剛玩", "入門", "怎麼開始", "主線", "msq"])) {
    return ff14Intro() + "\n\n" + ff14NewbieGuide();
  }

  if (containsAny(userText, ["職業", "玩什麼", "選職"])) return ff14JobPick();
  if (containsAny(userText, ["練等", "升級", "等級"])) return ff14Leveling();
  if (containsAny(userText, ["裝備", "裝等", "裝備來源", "卡等"])) return ff14GearSource();
  if (containsAny(userText, ["每日", "每週", "日常"])) return ff14DailyChecklist();

  if (containsAny(userText, ["坦", "tank", "mt", "st"])) return ff14TankTips();
  if (containsAny(userText, ["補", "healer", "奶", "補師"])) return ff14HealerTips();
  if (containsAny(userText, ["dps", "輸出", "打手"])) return ff14DpsTips();

  if (containsAny(userText, ["巨集", "macro"])) return ff14MacroBasics();
  if (containsAny(userText, ["市場", "市場板", "賺錢", "金幣", "gil", "拍賣"])) return ff14MarketTips();
  if (containsAny(userText, ["極", "零式", "團本", "raid", "絕"])) return ff14RaidIntro();

  return [
    "嗯哼～我知道你在問 FF14 😼 但你這句有點抽象！",
    "你可以這樣問我：",
    "• @我 FF14 新手要做什麼",
    "• @我 職業 怎麼選",
    "• @我 練等 怎麼練",
    "• @我 裝備 卡等 怎麼辦",
    "• @我 坦克/補師/DPS 要注意什麼",
    "• @我 巨集",
    "• @我 市場板 怎麼賺錢",
    "• @我 極本/零式/絕 入門",
  ].join("\n");
}

/* ===== 規則式閒聊入口 ===== */
const smallTalkRules = [
  { re: /(指令|怎麼用|幫助|help)/i, reply: () => buildCommandMenu() },
  { re: /(晚餐|吃什麼|要吃啥|宵夜)/i, reply: () => `今晚吃：${randPick(dinnerPool)}\n（不準說「隨便」！不然我就幫你點香菜火鍋😈）` },
  { re: /(你好|嗨|哈囉|hello)/i, reply: () => randPick([
      "嗨嗨～找我幹嘛呀 😽（要 @我 我才回喔）",
      "嘿～我在啦！今天想被我吐槽還是想被我哄？😈",
    ]) },
  { re: /(謝謝|感謝)/i, reply: () => randPick(["不客氣啦～（摸頭）😼", "哼哼～記得下次也要找我玩 😎"]) },
  { re: /(無聊|好無聊|很無聊)/i, reply: () => randPick([
      "無聊？那我幫你占卜一下～ @我 你今天會雷誰 😈",
      "無聊就去排隨機啊！…欸不對你會被抽到討厭的本我負責嗎 😵‍💫",
    ]) },
  { re: /(笑話|冷笑話)/i, reply: () => randPick([
      "為什麼拉拉肥走路那麼快？因為他們是『小跑者』🏃‍♀️（我先躲）",
      "我問雲：你怎麼那麼黑？雲說：我只是『有點陰』。☁️",
      "為什麼電腦很冷？因為它有很多『視窗』。🪟",
    ]) },
];

async function handleFreeChat(userText) {
  // FF14
  const ff = handleFF14(userText);
  if (ff) return ff;

  // 占卜
  const fortune = handleFortune(userText);
  if (fortune) return fortune;

  // 天氣
  if (looksLikeWeather(userText)) {
    const cityRaw = parseWeatherCity(userText) || AI_DEFAULT_CITY;
    const preset = cityPreset.get(cityRaw);
    try {
      if (preset) {
        return await fetchWeather({ name: preset.name, lat: preset.lat, lon: preset.lon, timezone: "Asia/Taipei" });
      }
      const geo = await geocodeCity(cityRaw);
      if (!geo) return `我找不到「${cityRaw}」耶…你可以換個更常見的地名嗎？（例如：台北/台中/高雄）`;
      return await fetchWeather({ name: geo.name, lat: geo.lat, lon: geo.lon, timezone: geo.timezone });
    } catch (e) {
      console.error("weather error:", e);
      return "我剛剛查天氣失敗了…可能天氣服務暫時不理我 😭 你再問一次？";
    }
  }

  // 規則式閒聊
  for (const rule of smallTalkRules) {
    if (rule.re.test(userText)) return rule.reply();
  }

  // fallback
  return randPick([
    "我聽到了，但我只是規則小機器人，不是AI大腦 🤖\n你可以試試：@我 指令 / @我 台北天氣 / @我 你今天會雷誰 / @我 FF14 新手",
    "欸這題有點超出我的規則範圍 😵‍💫\n要不要改問：晚餐/天氣/占卜/FF14 新手/職業/練等？",
    "我可以陪聊，但目前只會一些固定技能 😼\n試試：@我 今天天氣如何 / @我 晚餐要吃什麼 / @我 你今天會雷誰",
  ]);
}

/* ===============================
   Message handler（只回 @Bot）
================================ */
client.on("messageCreate", async (message) => {
  try {
    if (!client.user) return;
    if (message.author?.bot) return;

    // 只有 @Bot 才回
    const mentioned = message.mentions?.has(client.user);
    if (!mentioned) return;

    // 節流（避免連發）
    const now = Date.now();
    const last = lastUserAskAt.get(message.author.id) || 0;
    if (now - last < USER_COOLDOWN_MS) return;
    lastUserAskAt.set(message.author.id, now);

    const userText = stripBotMention(message.content, client.user.id);

    // 只 @Bot（或沒內容）→ 先回可愛搗蛋招呼＋引導
    if (!userText) {
      const msg = buildPingReply();
      await message.reply({ content: msg }).catch(async () => {
        await message.channel.send({ content: msg }).catch(() => {});
      });
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    const reply = await handleFreeChat(userText);
    const safeReply = reply.length > 1900 ? reply.slice(0, 1900) + "…" : reply;

    await message.reply({ content: safeReply }).catch(async () => {
      await message.channel.send({ content: safeReply }).catch(() => {});
    });
  } catch (err) {
    console.error("❌ FREE chat handler error:", err);
  }
});


/* ===============================
   Interaction handler
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

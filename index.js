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
} from "discord.js";

/**
 * ✅ Render Web Service 需要有開 Port，不然會被判定失敗停掉
 * 這段不影響 Discord Bot，只是回傳 ok 讓 Render 健康檢查通過
 */
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
  })
  .listen(port, () => {
    console.log(`HTTP server listening on ${port}`);
  });

/** ====== Discord Client ====== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/** ====== Slash Command ====== */
const CMD = new SlashCommandBuilder()
  .setName("setup_leave_button")
  .setDescription("在目前頻道發送「請假」按鈕");

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId || !guildId) {
    console.error("❌ 缺少環境變數：DISCORD_TOKEN / CLIENT_ID / GUILD_ID");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [CMD.toJSON()],
  });

  console.log("✅ Slash command registered");
}

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("❌ registerCommands failed:", e);
  }
});

/** ====== Helpers ====== */
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
        .setLabel("備註（可選）")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
    )
  );

  return modal;
}

function safeGet(interaction, customId, fallback = "") {
  // 避免可選欄位 getTextInputValue 丟錯造成整個互動失敗
  try {
    const v = interaction.fields.getTextInputValue(customId);
    return typeof v === "string" ? v : fallback;
  } catch {
    return fallback;
  }
}

/** ====== Interaction Handler ====== */
client.on("interactionCreate", async (interaction) => {
  try {
    /** 1) /setup_leave_button */
    if (interaction.isChatInputCommand() && interaction.commandName === "setup_leave_button") {
      const payload = buildLeaveButtonMessage();

      // ✅ 先用 ephemeral 回覆操作者：避免頻道洗版、也避免交互失敗
      await interaction.reply({ content: "✅ 已在此頻道建立請假按鈕", ephemeral: true });

      // ✅ 再把按鈕訊息送到當前頻道
      await interaction.channel.send(payload);
      return;
    }

    /** 2) Button -> 立刻 showModal（3 秒規則） */
    if (interaction.isButton() && interaction.customId === "leave_button") {
      const modal = buildLeaveModal();
      await interaction.showModal(modal); // ✅ 這裡不要做任何其他 await
      return;
    }

    /** 3) Modal Submit -> 先 deferReply 搶 3 秒，再慢慢做 */
    if (interaction.isModalSubmit() && interaction.customId === "leave_modal") {
      await interaction.deferReply({ ephemeral: true });

      const leaveDates = safeGet(interaction, "leave_dates");
      const leaveReason = safeGet(interaction, "leave_reason");
      const leaveNoteRaw = safeGet(interaction, "leave_note", "");
      const leaveNote = leaveNoteRaw.trim() ? leaveNoteRaw : "（無）";

      const embed = new EmbedBuilder()
        .setTitle("📌 新的請假申請")
        .addFields(
          { name: "申請人", value: `${interaction.user}` },
          { name: "時間", value: leaveDates || "（未填）" },
          { name: "原因", value: leaveReason || "（未填）" },
          { name: "備註", value: leaveNote }
        )
        .setTimestamp();

      const leaveChannelId = process.env.LEAVE_CHANNEL_ID;
      if (!leaveChannelId) {
        await interaction.editReply("❌ 送出失敗：未設定 LEAVE_CHANNEL_ID（Render 環境變數）");
        return;
      }

      const channel = await client.channels.fetch(leaveChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.editReply("❌ 送出失敗：請假頻道不存在/不是文字頻道（LEAVE_CHANNEL_ID 可能錯）");
        return;
      }

      // ✅ 送到請假專用頻道
      await channel.send({ embeds: [embed] });

      // ✅ 回覆申請人
      await interaction.editReply("✅ 已送出請假申請");
      return;
    }
  } catch (err) {
    console.error("❌ interactionCreate error:", err);

    // ✅ 保底回覆：避免 Discord 顯示「此交互失敗」
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ 發生錯誤，請稍後再試。", ephemeral: true }).catch(() => {});
    } else if (interaction.isRepliable() && interaction.deferred) {
      await interaction.editReply("❌ 發生錯誤，請稍後再試。").catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

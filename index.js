import "dotenv/config";
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CMD = new SlashCommandBuilder()
  .setName("setup_leave_button")
  .setDescription("在目前頻道發送「請假」按鈕");

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: [CMD.toJSON()] }
  );

  console.log("✅ Slash command registered");
}

client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 啟動時註冊指令（只要你 CLIENT_ID / GUILD_ID 正確就會成功）
  try {
    await registerCommands();
  } catch (err) {
    console.error("❌ registerCommands failed:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    // /setup_leave_button
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "setup_leave_button"
    ) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("leave_button")
          .setLabel("📩 請假申請")
          .setStyle(ButtonStyle.Primary)
      );

      const embed = new EmbedBuilder()
        .setTitle("請假申請")
        .setDescription("按下按鈕後會跳出表單，填完送出即可。");

      await interaction.reply({ embeds: [embed], components: [row] });
      return;
    }

    // 按鈕：leave_button
    if (interaction.isButton() && interaction.customId === "leave_button") {
      const modal = new ModalBuilder()
        .setCustomId("leave_modal")
        .setTitle("請假表單");

      const typeInput = new TextInputBuilder()
        .setCustomId("leave_type")
        .setLabel("假別（年假 / 病假 / 事假）")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const dateInput = new TextInputBuilder()
        .setCustomId("leave_dates")
        .setLabel("請假時間（例：2025-01-01 09:00 ~ 18:00）")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const reasonInput = new TextInputBuilder()
        .setCustomId("leave_reason")
        .setLabel("原因")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const noteInput = new TextInputBuilder()
        .setCustomId("leave_note")
        .setLabel("備註（可選）")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(typeInput),
        new ActionRowBuilder().addComponents(dateInput),
        new ActionRowBuilder().addComponents(reasonInput),
        new ActionRowBuilder().addComponents(noteInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // 表單送出：leave_modal
    if (interaction.isModalSubmit() && interaction.customId === "leave_modal") {
      const leaveType = interaction.fields.getTextInputValue("leave_type");
      const leaveDates = interaction.fields.getTextInputValue("leave_dates");
      const leaveReason = interaction.fields.getTextInputValue("leave_reason");
      const leaveNote =
        interaction.fields.getTextInputValue("leave_note") || "（無）";

      const embed = new EmbedBuilder()
        .setTitle("📌 新的請假申請")
        .addFields(
          { name: "申請人", value: `${interaction.user}` },
          { name: "假別", value: leaveType, inline: true },
          { name: "時間", value: leaveDates, inline: true },
          { name: "原因", value: leaveReason },
          { name: "備註", value: leaveNote }
        )
        .setTimestamp();

      const channel = await client.channels.fetch(process.env.LEAVE_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({
          content: "❌ 找不到請假通知頻道，請檢查 LEAVE_CHANNEL_ID。",
          ephemeral: true,
        });
        return;
      }

      await channel.send({ embeds: [embed] });

      await interaction.reply({
        content: "✅ 已送出請假申請！",
        ephemeral: true,
      });
      return;
    }
  } catch (err) {
    console.error("❌ interactionCreate error:", err);

    // 避免互動沒回覆造成 Discord 顯示失敗
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "❌ 發生錯誤，請稍後再試。",
          ephemeral: true,
        });
      } catch {}
    }
  }
});

client.login(process.env.DIS

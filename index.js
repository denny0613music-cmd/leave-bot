import 'dotenv/config';
import {
  Client, GatewayIntentBits,
  SlashCommandBuilder, REST, Routes,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder
} from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CMD = new SlashCommandBuilder()
  .setName('setup_leave_button')
  .setDescription('在目前頻道發送「請假」按鈕');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: [CMD.toJSON()] }
  );
  console.log('✅ Slash command registered');
}

client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup_leave_button') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('leave_button')
        .setLabel('📩 請假申請')
        .setStyle(ButtonStyle.Primary)
    );

    const embed = new EmbedBuilder()
      .setTitle('請假申請')
      .setDescription('按下按鈕後會跳出表單，填完送出即可。');

    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'leave_button') {
    const modal = new ModalBuilder()
      .setCustomId('leave_modal')
      .setTitle('請假表單');

    const typeInput = new TextInputBuilder()
      .setCustomId('leave_type')
      .setLabel('假別（年假 / 病假 / 事假）')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const dateInput = new TextInputBuilder()
      .setCustomId('leave_dates')
      .setLabel('請假時間（例：2025-01-01 09:00 ~ 18:00）')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('leave_reason')
      .setLabel('原因')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const noteInput = new TextInputBuilder()
      .setCustomId('leave_note')
      .setLabel('備註（可選）')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(typeInput),
      new ActionRowBuilder().addComponents(dateInput),
      new ActionRowBuilder().addComponents(reasonInput),
      new ActionRowBuilder().addComponents(noteInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'leave_modal') {
    const embed = new EmbedBuilder()
      .setTitle('📌 新的請假申請')
      .addFields(
        { name: '申請人', value: `${interaction.user}` },
        { name: '假別', value: interaction.fields.getTextInputValue('leave_type'), inline: true },
        { name: '時間', value: interaction.fields.getTextInputValue('leave_dates'), inline: true },
        { name: '原因', value: interaction.fields.getTextInputValue('leave_reason') },
        { name: '備註', value: interaction.fields.getTextInputValue('leave_note') || '（無）' }
      )
      .setTimestamp();

    const channel = await client.channels.fetch(process.env.LEAVE_CHANNEL_ID);
    a

'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const reports = require('../lib/reports');
const embeds = require('../lib/embeds');

/*
  A scheduled summary posted into a channel.

  The daily and weekly rhythm is what turns the bot from something you check
  into something that tells you. It is also the feature a community manager
  quotes in a staff channel, which is why the report leads with the change
  against the previous window rather than a bare average: "peak 41, up 12% on
  last week" is worth reading and "peak 41" is not.
*/

const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Scheduled player and uptime summaries (Pro)')
  .addSubcommand((sub) => sub
    .setName('add')
    .setDescription('Post a recurring summary in a channel')
    .addStringOption((option) => option
      .setName('cadence')
      .setDescription('How often to post it')
      .setRequired(true)
      .addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly (Mondays)', value: 'weekly' }
      ))
    .addIntegerOption((option) => option
      .setName('hour')
      .setDescription('Hour of day to post it, UTC (default 9)')
      .setMinValue(0)
      .setMaxValue(23))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post it (defaults to here)'))
    .addRoleOption((option) => option
      .setName('mention')
      .setDescription('Role to ping with it')))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Stop a scheduled summary')
    .addIntegerOption((option) => option
      .setName('id')
      .setDescription('Report id from /report list')
      .setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('Show the scheduled summaries in this Discord'))
  .addSubcommand((sub) => sub
    .setName('preview')
    .setDescription('Show what the summary looks like right now')
    .addStringOption((option) => option
      .setName('cadence')
      .setDescription('Which window to preview')
      .addChoices(
        { name: 'Daily', value: 'daily' },
        { name: 'Weekly', value: 'weekly' }
      )));

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    await handleList(interaction);
    return;
  }

  if (sub === 'preview') {
    await handlePreview(interaction);
    return;
  }

  if (!(await shared.requireManager(interaction))) {
    return;
  }

  if (sub === 'add') {
    await handleAdd(interaction);
  } else if (sub === 'remove') {
    await handleRemove(interaction);
  }
}

async function handleAdd(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!plan.isPro) {
    await shared.denyWithUpsell(
      interaction,
      'Scheduled summaries are a Pro feature. Pro posts a daily or weekly digest of players, peaks and uptime '
      + 'into a channel, with the change against the previous window.',
      plan
    );
    return;
  }

  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const me = interaction.guild.members.me;
  const permissions = channel && typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(me)
    : null;

  if (!permissions || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    await interaction.editReply(`I need Send Messages and Embed Links in ${channel}.`);
    return;
  }

  const cadence = interaction.options.getString('cadence', true);
  const hour = interaction.options.getInteger('hour');
  const role = interaction.options.getRole('mention');

  const report = await store.addReport({
    guildId: interaction.guildId,
    channelId: channel.id,
    cadence,
    hourUtc: hour === null || hour === undefined ? 9 : hour,
    mentionRoleId: role ? role.id : null,
  });

  await interaction.editReply(
    `Report **#${report.id}** added: a **${cadence}** summary in ${channel} at **${String(report.hour_utc).padStart(2, '0')}:00 UTC**`
    + `${role ? `, pinging ${role}` : ''}. Preview it now with \`/report preview\`.`
  );
}

async function handleRemove(interaction) {
  const id = interaction.options.getInteger('id', true);
  const removed = await store.removeReport(interaction.guildId, id);

  await interaction.reply({
    content: removed ? `Report #${id} removed.` : `No report #${id} in this Discord.`,
    flags: shared.EPHEMERAL,
  });
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);
  const rows = await store.listReports(interaction.guildId);

  if (rows.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(embeds.COLORS.flat)
      .setTitle('No scheduled reports')
      .setDescription(plan.isPro
        ? 'Add one with `/report add`.'
        : 'Scheduled summaries are a Pro feature. Try `/report preview` to see what one looks like.')
      .setFooter({ text: shared.planFooter(plan) });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const lines = rows.map((row) => {
    const last = row.last_sent_at ? embeds.relativeTime(new Date(row.last_sent_at)) : 'not yet';
    const mention = row.mention_role_id ? ` · pings <@&${row.mention_role_id}>` : '';
    return `**#${row.id}** ${row.cadence} at ${String(row.hour_utc).padStart(2, '0')}:00 UTC\n`
      + ` <#${row.channel_id}>${mention} · last sent ${last}`;
  });

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(embeds.COLORS.neutral)
      .setTitle('Scheduled reports')
      .setDescription(lines.join('\n\n').slice(0, 4000))
      .setFooter({ text: shared.planFooter(plan) })],
  });
}

async function handlePreview(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const cadence = interaction.options.getString('cadence') || 'daily';
  const built = await reports.build(interaction.guild, cadence);

  if (!built) {
    await interaction.editReply('Track a server first with `/track add`, then there is something to summarise.');
    return;
  }

  await interaction.editReply({ embeds: [built.embed], files: built.files });
}

module.exports = { data, execute };

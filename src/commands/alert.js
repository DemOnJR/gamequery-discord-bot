'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const embeds = require('../lib/embeds');

const TYPE_CHOICES = [
  { name: 'Server went offline', value: 'offline' },
  { name: 'Server came back online', value: 'online' },
  { name: 'Players rose above a number', value: 'players_above' },
  { name: 'Players fell below a number', value: 'players_below' },
  { name: 'Server filled up', value: 'full' },
  { name: 'Map changed', value: 'map_change' },
];

const NEEDS_THRESHOLD = new Set(['players_above', 'players_below']);

const data = new SlashCommandBuilder()
  .setName('alert')
  .setDescription('Get pinged when a server changes state (Pro)')
  .addSubcommand((sub) => sub
    .setName('add')
    .setDescription('Add an alert')
    .addStringOption((option) => option
      .setName('server')
      .setDescription('Tracked server')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((option) => option
      .setName('type')
      .setDescription('What to watch for')
      .setRequired(true)
      .addChoices(...TYPE_CHOICES))
    .addIntegerOption((option) => option
      .setName('players')
      .setDescription('Player count for the above/below alerts')
      .setMinValue(0)
      .setMaxValue(10000))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post it (defaults to here)'))
    .addRoleOption((option) => option
      .setName('mention')
      .setDescription('Role to ping'))
    .addIntegerOption((option) => option
      .setName('cooldown')
      .setDescription('Minutes to wait before the same alert can fire again (default 15)')
      .setMinValue(0)
      .setMaxValue(1440)))
  .addSubcommand((sub) => sub
    .setName('remove')
    .setDescription('Remove an alert')
    .addIntegerOption((option) => option
      .setName('id')
      .setDescription('Alert id from /alert list')
      .setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('Show the alerts in this Discord'));

async function autocomplete(interaction) {
  await shared.trackedAutocomplete(interaction);
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    await handleList(interaction);
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

function describe(row) {
  switch (row.alert_type) {
    case 'offline':
      return 'goes offline';
    case 'online':
      return 'comes back online';
    case 'players_above':
      return `rises above ${row.threshold} players`;
    case 'players_below':
      return `falls below ${row.threshold} players`;
    case 'full':
      return 'fills up';
    case 'map_change':
      return 'changes map';
    default:
      return row.alert_type;
  }
}

async function handleAdd(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (plan.limits.alerts <= 0) {
    await shared.denyWithUpsell(
      interaction,
      'Alerts are a Pro feature. Pro pings your staff the moment a server drops, comes back, fills up or crosses a player count you choose.',
      plan
    );
    return;
  }

  const current = await store.countAlerts(interaction.guildId);

  if (current >= plan.limits.alerts) {
    await interaction.editReply(`This Discord already has the maximum of ${plan.limits.alerts} alerts.`);
    return;
  }

  const tracked = await shared.resolveTracked(interaction, interaction.options.getString('server', true));

  if (!tracked) {
    await interaction.editReply('No tracked server matched that.');
    return;
  }

  const alertType = interaction.options.getString('type', true);
  const threshold = interaction.options.getInteger('players');

  if (NEEDS_THRESHOLD.has(alertType) && (threshold === null || threshold === undefined)) {
    await interaction.editReply('That alert needs a `players` number to compare against.');
    return;
  }

  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const me = interaction.guild.members.me;
  const permissions = channel && typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(me)
    : null;

  if (!permissions || !permissions.has(PermissionFlagsBits.SendMessages)) {
    await interaction.editReply(`I cannot post in ${channel}. Give me Send Messages there first.`);
    return;
  }

  const role = interaction.options.getRole('mention');
  const cooldown = interaction.options.getInteger('cooldown');

  const alert = await store.addAlert({
    guildId: interaction.guildId,
    trackedServerId: tracked.id,
    channelId: channel.id,
    alertType,
    threshold: NEEDS_THRESHOLD.has(alertType) ? threshold : null,
    mentionRoleId: role ? role.id : null,
    cooldownMinutes: cooldown === null || cooldown === undefined ? 15 : cooldown,
  });

  if (!alert) {
    // The INSERT only matches tracked servers owned by this guild, so no row
    // means the server is not one of ours.
    await interaction.editReply('That server is not tracked in this Discord.');
    return;
  }

  await interaction.editReply(
    `Alert **#${alert.id}** added: ping ${role ? `${role}` : 'the channel'} in ${channel} when `
    + `**${tracked.label || tracked.address}** ${describe(alert)}. `
    + `It will not repeat within ${alert.cooldown_minutes} minutes.`
  );
}

async function handleRemove(interaction) {
  const id = interaction.options.getInteger('id', true);
  const removed = await store.removeAlert(interaction.guildId, id);

  await interaction.reply({
    content: removed ? `Alert #${id} removed.` : `No alert #${id} in this Discord.`,
    flags: shared.EPHEMERAL,
  });
}

async function handleList(interaction) {
  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);
  const alerts = await store.listAlerts(interaction.guildId);

  if (alerts.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(embeds.COLORS.flat)
      .setTitle('No alerts')
      .setDescription(plan.isPro
        ? 'Add one with `/alert add`.'
        : 'Alerts are a Pro feature. Pro pings your staff when a server drops, returns, fills up or crosses a player count.')
      .setFooter({ text: shared.planFooter(plan) });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const lines = alerts.map((row) => {
    const last = row.last_fired_at ? embeds.relativeTime(new Date(row.last_fired_at)) : 'never';
    const mention = row.mention_role_id ? ` · pings <@&${row.mention_role_id}>` : '';
    return `**#${row.id}** ${row.label || row.address} ${describe(row)}\n`
      + ` <#${row.channel_id}>${mention} · cooldown ${row.cooldown_minutes}m · last fired ${last}`;
  });

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('Alerts')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setFooter({ text: `${alerts.length}/${plan.limits.alerts} used - ${plan.limits.name}` });

  await interaction.editReply({ embeds: [embed] });
}

module.exports = { data, execute, autocomplete, describe };

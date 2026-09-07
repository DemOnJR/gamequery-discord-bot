'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const shared = require('./shared');
const store = require('../lib/store');
const servers = require('../lib/servers');
const history = require('../lib/history');
const embeds = require('../lib/embeds');
const games = require('../lib/games');
const config = require('../config');

/*
  One panel that manages everything, so nobody has to memorise twelve commands.

  Slash commands are excellent when you already know what you want and terrible
  for discovering what exists. A guild admin setting this up for the first time
  should be able to press buttons: see what is tracked, add a server, open one,
  chart it, remove it. Every button here maps onto a command that also exists on
  its own, so power users lose nothing.

  Custom ids are namespaced `gqd:` and carry their arguments, because Discord
  gives no other way to pass state between a click and its handler. Every
  handler re-checks permissions: a button posted by an admin sits in the channel
  afterwards and anyone can press it.
*/

const ID = {
  refresh: 'gqd:refresh',
  add: 'gqd:add',
  addModal: 'gqd:addmodal',
  pick: 'gqd:pick',
  back: 'gqd:back',
  graph: 'gqd:graph',
  uptime: 'gqd:uptime',
  remove: 'gqd:remove',
  confirmRemove: 'gqd:rmyes',
};

const data = new SlashCommandBuilder()
  .setName('dashboard')
  .setDescription('Open the control panel for this Discord');

function planLine(plan, counts) {
  const limits = plan.limits;
  return [
    `**${limits.name}** plan`,
    `${counts.tracked}/${limits.trackedServers} servers`,
    `${counts.counters}/${limits.counterChannels} counters`,
    `${counts.messages}/${limits.statusMessages} live messages`,
    limits.alerts > 0 ? `${counts.alerts}/${limits.alerts} alerts` : 'alerts on Pro',
    `refresh every ${limits.refreshMinutes} min`,
  ].join(' · ');
}

async function buildOverview(guild, plan) {
  const tracked = await store.listTracked(guild.id);
  const [snapshots, counters, messages, alerts] = await Promise.all([
    servers.getSnapshots(tracked.map((row) => ({ game: row.game, address: row.address }))),
    store.countCounters(guild.id),
    store.countStatusMessages(guild.id),
    store.countAlerts(guild.id),
  ]);

  const stats = await history.getBatchStats(
    tracked.map((row) => row.server_id).filter(Boolean),
    24
  );

  let online = 0;
  let players = 0;

  const lines = tracked.map((row) => {
    const snapshot = snapshots.get(row.address);
    const stat = row.server_id ? stats.get(Number(row.server_id)) : null;

    if (snapshot && snapshot.online) {
      online += 1;
      players += snapshot.players || 0;
    }

    const label = embeds.safeValue(row.label || (snapshot && snapshot.name) || row.address, 44);
    const uptime = stat && stat.uptimePercent !== null ? `${stat.uptimePercent.toFixed(1)}%` : '--';
    const peak = stat ? stat.peakPlayers : '--';

    return `${embeds.statusDot(snapshot)} **${label}**\n`
      + `\`${embeds.safeCode(row.address, 32)}\` · now ${embeds.playersText(snapshot)}`
      + ` · 24h peak ${peak} · up ${uptime}`;
  });

  const embed = new EmbedBuilder()
    .setColor(online > 0 ? embeds.COLORS.online : embeds.COLORS.flat)
    .setTitle(`${guild.name} · control panel`.slice(0, 250))
    .setDescription(
      lines.length > 0
        ? lines.join('\n\n').slice(0, 3600)
        : 'No servers tracked yet. Press **Add server** to start, or run `/track add`.'
    )
    .addFields(
      { name: 'Right now', value: `**${players}** players across **${online}/${tracked.length}** servers`, inline: false },
      { name: 'Plan', value: planLine(plan, { tracked: tracked.length, counters, messages, alerts }), inline: false }
    )
    .setFooter({ text: `${games.count()} games supported · gamequery.dev` })
    .setTimestamp(new Date());

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID.refresh).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
      new ButtonBuilder().setCustomId(ID.add).setLabel('Add server').setStyle(ButtonStyle.Primary).setEmoji('➕'),
      new ButtonBuilder()
        .setLabel(plan.isPro ? 'Manage plan' : 'Get Pro')
        .setStyle(ButtonStyle.Link)
        .setURL(config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`)
    ),
  ];

  if (tracked.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ID.pick)
        .setPlaceholder('Open a server')
        .addOptions(tracked.slice(0, 25).map((row) => {
          const snapshot = snapshots.get(row.address);
          return {
            label: String(row.label || (snapshot && snapshot.name) || row.address).slice(0, 100),
            description: `${row.address} · ${games.gameName(row.game)}`.slice(0, 100),
            value: String(row.id),
            emoji: embeds.statusDot(snapshot),
          };
        }))
    ));
  }

  return { embeds: [embed], components: rows };
}

async function buildServerView(guild, plan, tracked) {
  const snapshot = await servers.getSnapshot(tracked.address, tracked.game);
  const stats = tracked.server_id ? await history.getStats(tracked.server_id, '24h') : null;

  const embed = embeds.serverEmbed(snapshot, { game: tracked.game });

  if (stats) {
    embed.addFields(
      { name: '24h average', value: stats.avgPlayers.toFixed(1), inline: true },
      { name: '24h peak', value: String(stats.peakPlayers), inline: true },
      { name: '24h uptime', value: `${stats.uptimePercent.toFixed(1)}%`, inline: true }
    );
  }

  embed.setFooter({ text: `id ${tracked.id} · ${plan.limits.name} plan` });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${ID.back}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀'),
      new ButtonBuilder().setCustomId(`${ID.graph}:${tracked.id}`).setLabel('Players graph').setStyle(ButtonStyle.Primary).setEmoji('📈'),
      new ButtonBuilder().setCustomId(`${ID.uptime}:${tracked.id}`).setLabel('Uptime').setStyle(ButtonStyle.Primary).setEmoji('🟢'),
      new ButtonBuilder().setCustomId(`${ID.remove}:${tracked.id}`).setLabel('Untrack').setStyle(ButtonStyle.Danger).setEmoji('🗑')
    ),
  ];

  return { embeds: [embed], components: rows };
}

async function execute(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);
  const view = await buildOverview(interaction.guild, plan);

  await interaction.editReply(view);
}

/*
  Component handling.

  Returns true when the interaction was ours, so index.js can ignore anything
  else without needing to know the id scheme.
*/
async function handleComponent(interaction) {
  const id = interaction.customId || '';

  if (!id.startsWith('gqd:')) {
    return false;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'That panel only works inside a server.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const [prefix, action, argument] = id.split(':');
  const key = `${prefix}:${action}`;

  // The message stays in the channel after an admin posts it, so every action
  // is re-authorised on click rather than trusting whoever ran /dashboard.
  const mutating = [ID.add, ID.remove, ID.confirmRemove].includes(key);

  if (mutating && !shared.isManager(interaction)) {
    await interaction.reply({
      content: 'That needs the **Manage Server** permission.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const plan = await shared.getPlan(interaction);

  if (key === ID.add) {
    await interaction.showModal(buildAddModal());
    return true;
  }

  if (key === ID.refresh || key === ID.back) {
    await interaction.deferUpdate();
    await interaction.editReply(await buildOverview(interaction.guild, plan));
    return true;
  }

  if (key === ID.pick) {
    await interaction.deferUpdate();
    const tracked = await store.getTracked(interaction.guildId, interaction.values[0]);

    if (!tracked) {
      await interaction.editReply(await buildOverview(interaction.guild, plan));
      return true;
    }

    await interaction.editReply(await buildServerView(interaction.guild, plan, tracked));
    return true;
  }

  if (key === ID.graph || key === ID.uptime) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tracked = await store.getTracked(interaction.guildId, argument);

    if (!tracked || !tracked.server_id) {
      await interaction.editReply('That server is no longer tracked.');
      return true;
    }

    const chart = require('../lib/chart');
    const range = '24h';

    if (key === ID.graph) {
      const [series, stats, snapshot] = await Promise.all([
        history.getSeries(tracked.server_id, range),
        history.getStats(tracked.server_id, range),
        servers.getSnapshot(tracked.address, tracked.game),
      ]);

      const png = chart.renderPlayerChart([{ label: tracked.label || tracked.address, points: series.points }], {
        title: tracked.label || (snapshot && snapshot.name) || tracked.address,
        subtitle: `${games.gameName(tracked.game)} · ${tracked.address}`,
        rangeKey: range,
        rangeLabel: 'Last 24 hours',
        capacity: snapshot ? snapshot.maxPlayers : null,
        footer: stats ? `Average ${stats.avgPlayers.toFixed(1)} · peak ${stats.peakPlayers}` : 'History is still building.',
      });

      const { AttachmentBuilder } = require('discord.js');
      await interaction.editReply({
        files: [new AttachmentBuilder(png, { name: 'players.png' })],
        content: `Use \`/graph players\` for 7d, 30d and 90d ranges.`,
      });
      return true;
    }

    const series = await history.getUptimeSeries(tracked.server_id, range);
    const png = chart.renderUptimeChart(series.points, {
      title: tracked.label || tracked.address,
      subtitle: `${games.gameName(tracked.game)} · ${tracked.address}`,
      rangeKey: range,
      rangeLabel: 'Last 24 hours',
    });

    const { AttachmentBuilder } = require('discord.js');
    await interaction.editReply({
      files: [new AttachmentBuilder(png, { name: 'uptime.png' })],
      content: 'Use `/uptime` for longer ranges and the incident list.',
    });
    return true;
  }

  if (key === ID.remove) {
    const tracked = await store.getTracked(interaction.guildId, argument);

    if (!tracked) {
      await interaction.reply({ content: 'That server is no longer tracked.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({
      content: `Stop tracking **${embeds.safeValue(tracked.label || tracked.address, 80)}**? `
        + 'Its counters, live messages and alerts go too. History is kept.',
      flags: MessageFlags.Ephemeral,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ID.confirmRemove}:${tracked.id}`)
          .setLabel('Yes, untrack it')
          .setStyle(ButtonStyle.Danger)
      )],
    });
    return true;
  }

  if (key === ID.confirmRemove) {
    await interaction.deferUpdate();
    const removed = await store.removeTracked(interaction.guildId, argument);
    await interaction.editReply({
      content: removed ? 'Untracked.' : 'It was already gone.',
      components: [],
    });
    return true;
  }

  return false;
}

function buildAddModal() {
  return new ModalBuilder()
    .setCustomId(ID.addModal)
    .setTitle('Track a game server')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('game')
          .setLabel('Game id (run /games to search)')
          .setPlaceholder('counterstrike16')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('address')
          .setLabel('Address as ip:port (query port)')
          .setPlaceholder('203.0.113.10:27015')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Short name (optional)')
          .setPlaceholder('Main public')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(60)
      )
    );
}

async function handleModal(interaction) {
  if (interaction.customId !== ID.addModal) {
    return false;
  }

  if (!shared.isManager(interaction)) {
    await interaction.reply({ content: 'That needs the **Manage Server** permission.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gameId = String(interaction.fields.getTextInputValue('game') || '').trim().toLowerCase();
  const rawAddress = interaction.fields.getTextInputValue('address');
  const label = String(interaction.fields.getTextInputValue('label') || '').trim() || null;

  if (!games.isValidGame(gameId)) {
    await interaction.editReply(
      `\`${embeds.safeCode(gameId, 40)}\` is not a supported game id. Run \`/games\` to search the ${games.count()} supported games.`
    );
    return true;
  }

  const validation = servers.validateAddress(rawAddress);

  if (!validation.ok) {
    await interaction.editReply(validation.reason);
    return true;
  }

  const plan = await shared.getPlan(interaction);
  const existing = await store.getTracked(interaction.guildId, validation.address);
  const current = await store.countTracked(interaction.guildId);

  if (!existing && current >= plan.limits.trackedServers) {
    await shared.denyWithUpsell(
      interaction,
      `This Discord tracks ${current} of the ${plan.limits.trackedServers} servers allowed on the ${plan.limits.name} plan.`,
      plan
    );
    return true;
  }

  const serverId = await servers.ensureTracked(gameId, validation.address);

  await store.addTracked({
    guildId: interaction.guildId,
    serverId,
    game: gameId,
    address: validation.address,
    label,
    addedBy: interaction.user.id,
  });

  if (serverId) {
    await history.backfillFromProbeAttempts(serverId, validation.address).catch(() => 0);
  }

  await interaction.editReply(
    `Now tracking **${embeds.safeValue(label || validation.address, 80)}**. `
    + 'Press Refresh on the panel to see it.'
  );
  return true;
}

module.exports = { data, execute, handleComponent, handleModal, buildOverview, ID };

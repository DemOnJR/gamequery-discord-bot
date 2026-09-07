'use strict';

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const shared = require('./shared');
const servers = require('../lib/servers');
const history = require('../lib/history');
const games = require('../lib/games');
const embeds = require('../lib/embeds');
const config = require('../config');

// /players -------------------------------------------------------------------

const playersData = new SlashCommandBuilder()
  .setName('players')
  .setDescription('Who is on the server right now (Pro)')
  .addStringOption((option) => option
    .setName('server')
    .setDescription('Tracked server')
    .setRequired(true)
    .setAutocomplete(true));

async function executePlayers(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  await interaction.deferReply();

  const plan = await shared.getPlan(interaction);

  if (!plan.limits.playerList) {
    await shared.denyWithUpsell(
      interaction,
      'The live player list is a Pro feature. Pro shows names and scores straight from the server.',
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, interaction.options.getString('server', true));

  if (!tracked) {
    await interaction.editReply('No tracked server matched that.');
    return;
  }

  const snapshot = await servers.getSnapshot(tracked.address, tracked.game);

  if (!snapshot || !snapshot.online) {
    await interaction.editReply(`**${tracked.label || tracked.address}** is not reachable right now.`);
    return;
  }

  const list = snapshot.playerNames || [];

  if (list.length === 0) {
    /*
      Plenty of games answer the player-count query but refuse the player-list
      query, or return only bots. Saying so is more useful than an empty box
      that reads like a bug.
    */
    await interaction.editReply(
      `**${tracked.label || tracked.address}** reports ${embeds.playersText(snapshot)} players `
      + 'but did not return a player list. Not every game exposes one, and some servers disable it.'
    );
    return;
  }

  const sorted = list.slice().sort((a, b) => b.score - a.score);
  const lines = sorted.slice(0, 40).map((player, index) => {
    const name = embeds.escapeMarkdown(player.name).slice(0, 40);
    return `\`${String(index + 1).padStart(2, ' ')}\` ${name} — ${player.score}`;
  });

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.online)
    .setTitle(`${snapshot.name || tracked.address}`.slice(0, 250))
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(
      { name: 'Players', value: embeds.playersText(snapshot), inline: true },
      { name: 'Map', value: snapshot.map || 'unknown', inline: true }
    )
    .setFooter({ text: sorted.length > 40 ? `Showing 40 of ${sorted.length} - Pro` : 'Pro · gamequery.dev' })
    .setTimestamp(snapshot.updatedAt || new Date());

  await interaction.editReply({ embeds: [embed] });
}

// /export --------------------------------------------------------------------

const exportData = new SlashCommandBuilder()
  .setName('export')
  .setDescription('Download the player history as CSV (Pro)')
  .addStringOption((option) => option
    .setName('server')
    .setDescription('Tracked server')
    .setRequired(true)
    .setAutocomplete(true))
  .addStringOption((option) => option
    .setName('range')
    .setDescription('How far back to export')
    .addChoices(
      { name: 'Last 24 hours', value: '24h' },
      { name: 'Last 7 days', value: '7d' },
      { name: 'Last 30 days', value: '30d' },
      { name: 'Last 90 days', value: '90d' }
    ));

async function executeExport(interaction) {
  if (!(await shared.requireGuild(interaction))) {
    return;
  }

  await interaction.deferReply({ flags: shared.EPHEMERAL });

  const plan = await shared.getPlan(interaction);

  if (!plan.limits.exports) {
    await shared.denyWithUpsell(
      interaction,
      'CSV export is a Pro feature. Pro hands you the raw history so you can chart it wherever you like.',
      plan
    );
    return;
  }

  const tracked = await shared.resolveTracked(interaction, interaction.options.getString('server', true));

  if (!tracked || !tracked.server_id) {
    await interaction.editReply('No tracked server matched that.');
    return;
  }

  const range = interaction.options.getString('range') || '7d';
  const csv = await history.exportCsv(tracked.server_id, range);

  if (!csv) {
    await interaction.editReply('That range is not available.');
    return;
  }

  const lineCount = csv.split('\n').length - 1;

  if (lineCount === 0) {
    await interaction.editReply('No history recorded for that range yet.');
    return;
  }

  const fileName = `${(tracked.label || tracked.address).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${range}.csv`;
  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: fileName });

  await interaction.editReply({
    content: `${lineCount} rows for **${tracked.label || tracked.address}**, ${range}. Times are UTC.`,
    files: [attachment],
  });
}

// /games ---------------------------------------------------------------------

const gamesData = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Search the games this bot can query')
  .addStringOption((option) => option
    .setName('search')
    .setDescription('Part of a game name'));

async function executeGames(interaction) {
  const term = interaction.options.getString('search') || '';
  const matches = games.search(term, 30);

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle(term ? `Games matching "${term}"` : 'Supported games')
    .setDescription(
      matches.length > 0
        ? matches.map((game) => `\`${game.id}\` ${game.name}`).join('\n').slice(0, 4000)
        : 'Nothing matched. Try a shorter search.'
    )
    .setFooter({
      text: term
        ? `${matches.length} shown of ${games.count()} supported games`
        : `${games.count()} games supported - showing the most used`,
    });

  await interaction.reply({ embeds: [embed], flags: shared.EPHEMERAL });
}

// /help ----------------------------------------------------------------------

const helpData = new SlashCommandBuilder()
  .setName('help')
  .setDescription('What this bot does, and how to set it up in two minutes');

async function executeHelp(interaction) {
  const free = config.plans.FREE;
  const pro = config.plans.PRO;
  const plan = interaction.inGuild() ? await shared.getPlan(interaction) : null;

  const embed = new EmbedBuilder()
    .setColor(embeds.COLORS.neutral)
    .setTitle('GameQuery')
    .setDescription(
      'Live game server status in Discord: player graphs, channels that show the player count in their name, '
      + `and alerts. ${games.count()} games supported.`
    )
    .addFields(
      {
        name: 'Set it up',
        value: [
          '`/track add` pick the server this Discord follows',
          '`/counter create` a channel whose name is the live player count',
          '`/live status` a message that rewrites itself with the current state',
          '`/graph players` player count over time',
        ].join('\n'),
      },
      {
        name: 'Everything else',
        value: [
          '`/server` query any server, tracked or not',
          '`/players` who is on right now (Pro)',
          '`/alert add` get pinged on offline, online, full or a player threshold (Pro)',
          '`/graph compare` several servers on one chart (Pro)',
          '`/graph peak` the busiest hour of your day (Pro)',
          '`/export` the raw history as CSV (Pro)',
          '`/games` search supported games',
        ].join('\n'),
      },
      {
        name: 'Free',
        value: `${free.trackedServers} servers · ${free.counterChannels} counter · ${free.statusMessages} live message · 24h graphs · ${free.refreshMinutes} min refresh`,
        inline: false,
      },
      {
        name: 'Pro',
        value: `${pro.trackedServers} servers · ${pro.counterChannels} counters · ${pro.statusMessages} live messages · 24h to 90d graphs · comparison and peak-hour charts · ${pro.alerts} alerts · player lists · CSV export · ${pro.refreshMinutes} min refresh`,
        inline: false,
      },
      {
        name: 'Get Pro',
        value: `7-day free trial at ${config.proUpgradeUrl || `${config.siteUrl}/dashboard/billing`}, then \`/link\` and \`/pro claim\`. One subscription covers ${config.proGuildLimit} Discord servers.`,
      }
    );

  if (config.inviteUrl) {
    embed.addFields({ name: 'Add it to another Discord', value: config.inviteUrl });
  }

  if (plan) {
    embed.setFooter({ text: `This Discord is on ${plan.limits.name}.` });
  }

  await interaction.reply({ embeds: [embed], flags: shared.EPHEMERAL });
}

module.exports = {
  players: { data: playersData, execute: executePlayers, autocomplete: shared.trackedAutocomplete },
  export: { data: exportData, execute: executeExport, autocomplete: shared.trackedAutocomplete },
  games: { data: gamesData, execute: executeGames },
  help: { data: helpData, execute: executeHelp },
};

'use strict';

const http = require('http');
const { Client, GatewayIntentBits, Events, ActivityType, MessageFlags } = require('discord.js');

const config = require('./config');
const db = require('./lib/db');
const redisClient = require('./lib/redisClient');
const games = require('./lib/games');
const chart = require('./lib/chart');
const entitlement = require('./lib/entitlement');
const commands = require('./commands');

const sampler = require('./workers/sampler');
const refresher = require('./workers/refresher');
const alerts = require('./workers/alerts');
const entitlementSync = require('./workers/entitlementSync');
const reportWorker = require('./workers/reports');
const history = require('./lib/history');
const migrate = require('./lib/migrate');
const source = require('./lib/source');

/*
  Guilds is the only intent needed. The bot never reads message content, never
  needs the member list, and asking for either would put the application in
  Discord's privileged-intent review for features it does not have.
*/
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const timers = [];
let shuttingDown = false;

function every(ms, name, fn) {
  const run = async () => {
    if (shuttingDown) {
      return;
    }

    try {
      await fn();
    } catch (error) {
      console.error(`[${name}] tick failed:`, error.message);
    }
  };

  const timer = setInterval(run, ms);
  timer.unref();
  timers.push(timer);

  // Stagger the first run so a restart does not fire every worker at once.
  const kickoff = setTimeout(run, Math.min(ms, 5000 + timers.length * 3000));
  kickoff.unref();
  timers.push(kickoff);
}

async function registerCommands() {
  const payload = commands.toJSON();

  try {
    await client.application.commands.set(payload);
    console.log(`[bot] registered ${payload.length} global slash commands`);
  } catch (error) {
    console.error('[bot] slash command registration failed:', error.message);
  }
}

async function handleAutocomplete(interaction) {
  const command = commands.get(interaction.commandName);

  if (!command || typeof command.autocomplete !== 'function') {
    await interaction.respond([]).catch(() => {});
    return;
  }

  try {
    await command.autocomplete(interaction);
  } catch (error) {
    console.error(`[bot] autocomplete for /${interaction.commandName} failed:`, error.message);
    await interaction.respond([]).catch(() => {});
  }
}

async function handleCommand(interaction) {
  const command = commands.get(interaction.commandName);

  if (!command) {
    await interaction.reply({
      content: 'That command is no longer available. Try `/help`.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[bot] /${interaction.commandName} failed:`, error);

    /*
      A failed command must still answer the interaction: an unanswered one
      shows the user "the application did not respond", which reads as the bot
      being broken even when only one command path failed.
    */
    const message = 'Something went wrong running that. It has been logged; try again in a moment.';

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message, embeds: [], files: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} guilds`);

  // The invite link must advertise the application this token belongs to, not
  // whatever DISCORD_CLIENT_ID happens to be set to.
  config.setClientId(readyClient.application ? readyClient.application.id : '');
  console.log(`[bot] application ${config.clientId}, invite ${config.inviteUrl}`);

  readyClient.user.setActivity({ name: '/help · gamequery.dev', type: ActivityType.Watching });

  if (config.registerCommandsOnBoot) {
    await registerCommands();
  }

  // Reconcile the guild table with reality on boot: guilds joined or left
  // while the bot was down are otherwise never noticed.
  for (const guild of readyClient.guilds.cache.values()) {
    await entitlement.ensureGuild(guild).catch((error) => {
      console.error(`[bot] ensureGuild failed for ${guild.id}: ${error.message}`);
    });
  }

  every(config.intervals.samplerMinutes * 60 * 1000, 'sampler', () => sampler.tick());
  every(config.intervals.counterSeconds * 1000, 'refresher', () => refresher.tick(client));
  every(config.intervals.alertSeconds * 1000, 'alerts', () => alerts.tick(client));
  every(config.intervals.entitlementMinutes * 60 * 1000, 'entitlement', () => entitlementSync.tick());
  // Checked every few minutes; whether a report is actually due is decided in
  // SQL against last_sent_at, so a frequent tick cannot double-send.
  every(config.intervals.reportSeconds * 1000, 'reports', () => reportWorker.tick(client));
  every(config.intervals.pruneHours * 3600 * 1000, 'prune', async () => {
    const result = await history.prune();
    console.log(`[prune] removed ${result.samples} samples, ${result.hourly} hourly rows, ${result.linkCodes} link codes`);
  });
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[bot] joined guild ${guild.id} (${guild.name})`);
  await entitlement.ensureGuild(guild).catch(() => {});
});

client.on(Events.GuildDelete, async (guild) => {
  console.log(`[bot] left guild ${guild.id}`);
  await entitlement.markGuildLeft(guild.id).catch(() => {});
});

/*
  Buttons and modals fail the same way commands do: an unanswered interaction
  shows "this interaction failed", which reads as the bot being broken. Every
  path here either answers or logs why it could not.
*/
async function handleComponent(interaction) {
  try {
    const handled = await commands.handleComponent(interaction);

    if (!handled && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'That control belongs to an older version of this panel. Run `/dashboard` for a fresh one.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  } catch (error) {
    console.error(`[bot] component ${interaction.customId} failed:`, error);

    const message = 'Something went wrong handling that. It has been logged.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

async function handleModal(interaction) {
  try {
    await commands.handleModal(interaction);
  } catch (error) {
    console.error(`[bot] modal ${interaction.customId} failed:`, error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Something went wrong saving that. It has been logged.').catch(() => {});
    } else {
      await interaction.reply({
        content: 'Something went wrong saving that. It has been logged.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
    return;
  }

  if (interaction.isModalSubmit()) {
    await handleModal(interaction);
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await handleComponent(interaction);
  }
});

client.on(Events.Error, (error) => {
  console.error('[bot] client error:', error.message);
});

/*
  A tiny health endpoint so Kubernetes can tell "the process is up" from "the
  gateway is connected". A bot that has lost its websocket still has a live
  process, and without this the pod would look healthy while doing nothing.
*/
function startHealthServer() {
  const port = parseInt(process.env.HEALTH_PORT || '8081', 10);

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      const ready = client.isReady();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ready,
        guilds: ready ? client.guilds.cache.size : 0,
        redis: redisClient.isReady(),
        games: games.count(),
      }));
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(port, () => console.log(`[bot] health endpoint on :${port}/healthz`));
  return server;
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[bot] ${signal} received, shutting down`);

  timers.forEach((timer) => clearInterval(timer));

  await client.destroy().catch(() => {});
  await redisClient.client.quit().catch(() => {});
  await db.pool.end().catch(() => {});

  process.exit(0);
}

async function main() {
  if (!config.token) {
    console.error('[bot] DISCORD_BOT_TOKEN is not set. Refusing to start.');
    process.exit(1);
  }

  /*
    The bundled catalogue is a starting point, not a requirement: the API is
    refreshed from below and is the authority. Failing here would make a clone
    without data/games.json unable to start even though the API could supply
    the whole list a second later.
  */
  games.load();

  chart.registerFonts();

  await db.pool.query('SELECT 1');
  console.log('[bot] postgres reachable');

  // The bot owns its schema and applies it itself, so a self-hoster sets
  // DATABASE_URL and starts the process; there is no separate migrate step.
  await migrate.run();

  // Only the direct source needs the platform's Redis; in api mode connecting
  // to a Redis that is not there must not hold up boot.
  if (config.source === 'direct') {
    await redisClient.connect().catch((error) => {
      console.error('[bot] redis unavailable at boot:', error.message);
    });
  }

  /*
    The gamequery.dev API key is a hard requirement, not a nicety.

    Every piece of server data the bot shows comes from gamequery.dev; it never
    speaks a game protocol itself. Starting without working credentials would
    produce a bot that connects to Discord, answers every command, and reports
    every server as unknown forever, which reads as the bot being broken rather
    than as unconfigured. Failing loudly at boot is the honest behaviour.
  */
  const check = await source.verify();

  if (!check.ok) {
    console.error('[bot] gamequery.dev credentials are not usable, refusing to start.');
    console.error(`[bot] ${check.reason}`);
    console.error('[bot] Create a key at https://gamequery.dev/dashboard/keys and set');
    console.error('[bot]   GAMEQUERY_API_TOKEN, GAMEQUERY_API_EMAIL, GAMEQUERY_API_TYPE');
    process.exit(1);
  }

  console.log(`[bot] gamequery.dev source "${source.name()}" ready (${check.detail})`);

  /*
    Refresh the catalogue from the API. The bundled games.json is a snapshot
    taken when the image was built, so a long-running self-hosted copy would
    otherwise keep rejecting a game the API had since added.
  */
  try {
    const live = await source.listGames();
    console.log(`[bot] games catalogue: ${games.replace(live)} entries`);
  } catch (error) {
    console.warn(`[bot] could not refresh the games catalogue, using the bundled copy: ${error.message}`);
  }

  // Only now is an empty catalogue fatal: both the bundled copy and the API
  // failed, so /server and /track would reject every input.
  if (games.count() === 0) {
    console.error('[bot] no games catalogue from the bundled copy or the API. Refusing to start.');
    process.exit(1);
  }

  startHealthServer();

  await client.login(config.token);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[bot] unhandled rejection:', error instanceof Error ? error.message : error);
});

main().catch((error) => {
  console.error('[bot] failed to start:', error);
  process.exit(1);
});

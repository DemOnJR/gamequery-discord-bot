'use strict';

/*
  Everything that can be verified without a Discord token or a database:
  the command payloads Discord will accept, the name-template renderer, the
  alert transition rules, and that the chart renderer produces a real PNG with
  text in it. Run with `npm run check`.

  This is the test that would have caught the two mistakes most likely to ship
  unnoticed: a slash command that Discord rejects at registration (which only
  shows up at boot), and a chart rendered without a font, which silently
  produces a graph with no labels rather than an error.
*/

const assert = require('assert');
const path = require('path');

process.env.GAMES_JSON_PATH = process.env.GAMES_JSON_PATH
  || path.join(__dirname, '..', 'data', 'games.json');
process.env.FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/dejavu';

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

// --- Slash command payloads -------------------------------------------------

const commands = require('../src/commands');

check('every command produces a payload Discord accepts', () => {
  const payload = commands.toJSON();
  assert.ok(payload.length >= 10, `expected at least 10 commands, got ${payload.length}`);

  const names = new Set();

  payload.forEach((command) => {
    assert.ok(/^[-_\p{L}\p{N}]{1,32}$/u.test(command.name), `bad command name: ${command.name}`);
    assert.ok(command.description && command.description.length <= 100, `bad description on /${command.name}`);
    assert.ok(!names.has(command.name), `duplicate command name ${command.name}`);
    names.add(command.name);

    (command.options || []).forEach((option) => {
      assert.ok(option.description.length <= 100, `option description too long on /${command.name}`);

      (option.options || []).forEach((subOption) => {
        assert.ok(
          subOption.description.length <= 100,
          `sub-option description too long on /${command.name} ${option.name} ${subOption.name}`
        );
      });
    });
  });
});

check('every command exposes an execute function', () => {
  commands.names().forEach((name) => {
    const command = commands.get(name);
    assert.strictEqual(typeof command.execute, 'function', `/${name} has no execute`);
  });
});

check('every autocomplete option has an autocomplete handler', () => {
  commands.toJSON().forEach((command) => {
    const handler = commands.get(command.name);

    const usesAutocomplete = (command.options || []).some((option) => option.autocomplete
      || (option.options || []).some((subOption) => subOption.autocomplete));

    if (usesAutocomplete) {
      assert.strictEqual(
        typeof handler.autocomplete,
        'function',
        `/${command.name} declares autocomplete but has no handler`
      );
    }
  });
});

// --- Name templates ---------------------------------------------------------

const templates = require('../src/lib/templates');

check('a reachable server renders its live count', () => {
  const snapshot = { online: true, players: 24, maxPlayers: 32, map: 'de_dust2', name: 'Test', known: true };
  const rendered = templates.renderServerTemplate('{dot} {players}/{maxplayers} online', snapshot, { address: '1.2.3.4:27015' });
  assert.strictEqual(rendered, '🟢 24/32 online');
});

check('an unreachable server never renders as zero players', () => {
  const snapshot = { online: false, stale: false, players: 0, maxPlayers: 32, known: true };
  const rendered = templates.renderServerTemplate('{players}/{maxplayers}', snapshot, { address: '1.2.3.4:27015' });
  assert.ok(rendered.startsWith('--'), `expected "--", got "${rendered}"`);
});

check('a total counter ignores offline servers', () => {
  const tracked = [{ address: 'a', game: 'x' }, { address: 'b', game: 'x' }];
  const snapshots = new Map([
    ['a', { online: true, players: 10, maxPlayers: 32 }],
    ['b', { online: false, players: 99, maxPlayers: 32 }],
  ]);

  const rendered = templates.renderTotalTemplate('{players} on {servers_online}/{servers_total}', snapshots, tracked);
  assert.strictEqual(rendered, '10 on 1/2');
});

check('a template is capped at the Discord channel name limit', () => {
  const snapshot = { online: true, players: 1, maxPlayers: 2, name: 'x'.repeat(200), known: true };
  const rendered = templates.renderServerTemplate('{name} {players}', snapshot, { address: 'a' });
  assert.ok(rendered.length <= 100, `rendered ${rendered.length} characters`);
});

check('template validation rejects unknown placeholders', () => {
  assert.strictEqual(templates.validateTemplate('{playerz}').ok, false);
  assert.strictEqual(templates.validateTemplate('no placeholders').ok, false);
  assert.strictEqual(templates.validateTemplate('{players} online').ok, true);
});

// --- Alert transitions ------------------------------------------------------

const alerts = require('../src/workers/alerts');

check('an offline alert fires on the transition, not on every pass', () => {
  const alert = { alert_type: 'offline' };
  assert.strictEqual(alerts.shouldFire(alert, 'up', 'down'), true, 'should fire when it drops');
  assert.strictEqual(alerts.shouldFire(alert, 'down', 'down'), false, 'should not repeat while down');
  assert.strictEqual(alerts.shouldFire(alert, null, 'down'), false, 'should not fire on first sight');
  assert.strictEqual(alerts.shouldFire(alert, 'unknown', 'down'), false, 'should not fire out of unknown');
});

check('an online alert fires only on recovery', () => {
  const alert = { alert_type: 'online' };
  assert.strictEqual(alerts.shouldFire(alert, 'down', 'up'), true);
  assert.strictEqual(alerts.shouldFire(alert, 'up', 'down'), false);
});

check('a threshold alert reads the player count', () => {
  const alert = { alert_type: 'players_above', threshold: 20 };
  assert.strictEqual(alerts.currentState(alert, { online: true, players: 25 }), 'above');
  assert.strictEqual(alerts.currentState(alert, { online: true, players: 5 }), 'below');
  assert.strictEqual(alerts.currentState(alert, { online: false, players: 25 }), 'unknown');
  assert.strictEqual(alerts.shouldFire(alert, 'below', 'above'), true);
  assert.strictEqual(alerts.shouldFire(alert, 'above', 'above'), false);
});

check('a full alert needs a slot count to mean anything', () => {
  const alert = { alert_type: 'full' };
  assert.strictEqual(alerts.currentState(alert, { online: true, players: 32, maxPlayers: 32 }), 'full');
  assert.strictEqual(alerts.currentState(alert, { online: true, players: 32, maxPlayers: null }), 'unknown');
});

// --- Address validation -----------------------------------------------------

const servers = require('../src/lib/servers');

check('address validation accepts ip:port and rejects the rest', () => {
  assert.strictEqual(servers.validateAddress('203.0.113.10:27015').ok, true);
  assert.strictEqual(servers.validateAddress('play.example.com:27015').ok, false, 'hostnames must be rejected');
  assert.strictEqual(servers.validateAddress('203.0.113.10').ok, false, 'a missing port must be rejected');
  assert.strictEqual(servers.validateAddress('203.0.113.999:27015').ok, false, 'a bad octet must be rejected');
  assert.strictEqual(servers.validateAddress('203.0.113.10:99999').ok, false, 'a bad port must be rejected');
});

// --- Chart rendering --------------------------------------------------------

const chart = require('../src/lib/chart');

check('the player chart renders a real PNG', () => {
  const now = Date.now();
  const points = Array.from({ length: 96 }, (_, index) => ({
    at: new Date(now - (96 - index) * 15 * 60 * 1000),
    players: index % 17 === 0 ? null : Math.round(12 + 10 * Math.sin(index / 6)),
  }));

  const png = chart.renderPlayerChart(
    [{ label: 'Test server', points }],
    {
      title: 'Test server',
      subtitle: 'Counter-Strike 1.6 · 203.0.113.10:27015',
      rangeKey: '24h',
      rangeLabel: 'Last 24 hours',
      capacity: 32,
      footer: 'Average 12.0 · peak 22',
    }
  );

  assert.ok(Buffer.isBuffer(png), 'not a buffer');
  assert.strictEqual(png.slice(1, 4).toString('ascii'), 'PNG', 'not a PNG');

  /*
    A chart rendered without a registered font still produces a valid PNG,
    just with no labels on it. Size is the cheap proxy that catches it: the
    blank version comes out around 3 KB, a labelled one is far larger.
  */
  assert.ok(png.length > 8000, `PNG is only ${png.length} bytes, which means the fonts did not load`);
});

check('an empty series renders the explanatory chart rather than throwing', () => {
  const png = chart.renderPlayerChart([{ label: 'Nothing', points: [] }], { rangeKey: '24h' });
  assert.ok(Buffer.isBuffer(png) && png.length > 0);
});

check('a comparison chart renders every series', () => {
  const now = Date.now();
  const series = ['A', 'B', 'C'].map((label, seriesIndex) => ({
    label,
    points: Array.from({ length: 40 }, (_, index) => ({
      at: new Date(now - (40 - index) * 30 * 60 * 1000),
      players: 5 + seriesIndex * 7 + (index % 5),
    })),
  }));

  const png = chart.renderPlayerChart(series, { rangeKey: '7d', title: '3 servers compared' });
  assert.ok(png.length > 8000, `comparison PNG is only ${png.length} bytes`);
});

check('the peak-hour chart renders', () => {
  const profile = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    avgPlayers: Math.round(5 + 15 * Math.sin((hour / 24) * Math.PI)),
    peakPlayers: 30,
  }));

  const png = chart.renderHourProfile(profile, { title: 'Peak hours', rangeLabel: '14 days' });
  assert.ok(png.length > 8000, `peak PNG is only ${png.length} bytes`);
});

// --- Hostile server data ----------------------------------------------------

/*
  Everything a game server reports is attacker-controlled: anyone can point
  /server at a box they run. Discord rejects the WHOLE message if one embed
  field exceeds 1024 characters, so an uncapped field is a denial of service on
  the command, not a cosmetic issue.
*/

const embedsLib = require('../src/lib/embeds');

check('a hostile hostname cannot break out of an embed field', () => {
  const nasty = '`'.repeat(50) + '@everyone **' + 'A'.repeat(5000);
  const value = embedsLib.safeValue(nasty, 200);
  assert.ok(value.length <= 1024, `safeValue returned ${value.length} characters`);
  assert.ok(!value.includes('**'), 'markdown was not escaped');
});

check('a hostile connect string stays inside its code span', () => {
  const value = embedsLib.safeCode('1.2.3.4:27015` @everyone `' + 'B'.repeat(5000), 100);
  assert.ok(value.length <= 100, `safeCode returned ${value.length} characters`);
  assert.ok(!value.includes('`'), 'a backtick survived, which would close the code span');
});

check('every embed field stays inside the Discord limits for a hostile server', () => {
  const hostile = {
    address: '203.0.113.10:27015',
    game: 'counterstrike16',
    name: 'X'.repeat(4000),
    map: 'm'.repeat(4000),
    connect: 'c'.repeat(4000),
    errorName: 'e'.repeat(4000),
    players: 5,
    maxPlayers: 32,
    ping: 20,
    bots: 0,
    online: false,
    stale: true,
    known: true,
    status: 'offline',
    playerNames: [],
    updatedAt: new Date(),
    lastProbeAt: new Date(),
    lastOnlineAt: new Date(),
  };

  const built = embedsLib.serverEmbed(hostile).data;

  assert.ok(built.title.length <= 256, `title is ${built.title.length}`);
  (built.fields || []).forEach((field) => {
    assert.ok(field.name.length <= 256, `field name ${field.name.length}`);
    assert.ok(field.value.length <= 1024, `field "${field.name}" is ${field.value.length} characters`);
  });
  assert.ok((built.description || '').length <= 4096, 'description too long');

  const total = JSON.stringify(built).length;
  assert.ok(total < 6000, `embed total ${total} exceeds the 6000 character budget`);
});

check('a hostile server cannot blow the list embed', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, address: `10.0.0.${i}:27015`, game: 'counterstrike16', label: null }));
  const snapshots = new Map(rows.map((row) => [row.address, {
    online: true, players: 5, maxPlayers: 32, known: true,
    name: 'N'.repeat(2000), map: 'M'.repeat(2000),
  }]));

  const built = embedsLib.serverListEmbed(rows, snapshots, { title: 'x' }).data;
  assert.ok(built.description.length <= 4096, `description is ${built.description.length}`);
});

check('a long map name cannot overflow the alert state column', () => {
  /*
    discord_alerts.last_state is VARCHAR(32) and Postgres ERRORS rather than
    truncating, so storing the raw map name threw on every tick forever for any
    map called something like cs_assault_winter_extended_v3_final.
  */
  const alert = { alert_type: 'map_change' };
  const long = 'cs_assault_winter_extended_v3_final_'.repeat(10);
  const state = alerts.currentState(alert, { online: true, map: long });

  assert.ok(state.length <= 32, `state is ${state.length} characters, column allows 32`);
  assert.notStrictEqual(state, alerts.currentState(alert, { online: true, map: `${long}x` }), 'different maps must give different states');
  assert.strictEqual(state, alerts.currentState(alert, { online: true, map: long }), 'the same map must be stable');
  assert.strictEqual(alerts.shouldFire(alert, state, alerts.currentState(alert, { online: true, map: 'de_dust2' })), true);
});

check('charts survive absurd player counts without throwing', () => {
  const now = Date.now();
  [0, 1, 999999, 2 ** 31 - 1].forEach((value) => {
    const points = [
      { at: new Date(now - 3600000), players: 0 },
      { at: new Date(now), players: value },
    ];
    const png = chart.renderPlayerChart([{ label: 'x', points }], { rangeKey: '24h', capacity: value });
    assert.ok(Buffer.isBuffer(png) && png.length > 0, `failed at ${value}`);
  });
});

check('a single reading and identical timestamps do not divide by zero', () => {
  const at = new Date();
  const one = chart.renderPlayerChart([{ label: 'x', points: [{ at, players: 3 }] }], { rangeKey: '24h' });
  assert.ok(one.length > 0);

  const flat = chart.renderPlayerChart(
    [{ label: 'x', points: [{ at, players: 3 }, { at, players: 4 }] }],
    { rangeKey: '24h' }
  );
  assert.ok(flat.length > 0);
});

// --- Uptime and reports -----------------------------------------------------

const uptimeCmd = require('../src/commands/uptime');
const reportsLib = require('../src/lib/reports');

check('outages are grouped into incidents, not counted per bucket', () => {
  const at = (i) => new Date(Date.now() - (100 - i) * 300000);
  const points = Array.from({ length: 100 }, (_, i) => ({ at: at(i), uptime: 100 }));

  // One outage six buckets long, and a separate one of two.
  for (let i = 20; i < 26; i += 1) points[i].uptime = 0;
  for (let i = 60; i < 62; i += 1) points[i].uptime = 10;

  const incidents = uptimeCmd.findIncidents(points);
  assert.strictEqual(incidents.length, 2, `expected 2 incidents, got ${incidents.length}`);
  assert.strictEqual(incidents[0].buckets, 6);
  assert.strictEqual(incidents[1].buckets, 2);
});

check('a bucket with no samples is not counted as an outage', () => {
  const at = (i) => new Date(Date.now() - (10 - i) * 300000);
  const points = Array.from({ length: 10 }, (_, i) => ({ at: at(i), uptime: 100 }));
  points[4].uptime = null;
  points[5].uptime = undefined;

  assert.strictEqual(uptimeCmd.findIncidents(points).length, 0, 'missing data must not read as downtime');
});

check('a degraded bucket is not an outage', () => {
  const at = (i) => new Date(Date.now() - (5 - i) * 300000);
  const points = Array.from({ length: 5 }, (_, i) => ({ at: at(i), uptime: 80 }));
  assert.strictEqual(uptimeCmd.findIncidents(points).length, 0, '80% answered is degraded, not down');
});

check('a missing previous window is reported honestly, not as +100%', () => {
  assert.strictEqual(reportsLib.trendText(null), 'no prior window');
  assert.strictEqual(reportsLib.trendText(0.4), 'flat');
  assert.ok(reportsLib.trendText(12).startsWith('+12%'));
  assert.ok(reportsLib.trendText(-30).startsWith('-30%'));
});

check('the uptime chart renders and distinguishes up, down and no data', () => {
  const now = Date.now();
  const points = Array.from({ length: 60 }, (_, i) => ({
    at: new Date(now - (60 - i) * 300000),
    uptime: i > 20 && i < 26 ? 0 : (i > 40 && i < 44 ? null : 100),
  }));

  const png = chart.renderUptimeChart(points, { title: 'x', rangeKey: '24h', rangeLabel: 'Last 24 hours' });
  assert.ok(png.length > 8000, `uptime PNG is only ${png.length} bytes`);

  const empty = chart.renderUptimeChart([], { rangeKey: '24h' });
  assert.ok(Buffer.isBuffer(empty) && empty.length > 0, 'an empty uptime range must still render');
});

// --- Dashboard components ---------------------------------------------------

const dashboardCmd = require('../src/commands/dashboard');

check('every dashboard control id is namespaced so the router can claim it', () => {
  Object.values(dashboardCmd.ID).forEach((id) => {
    assert.ok(id.startsWith('gqd:'), `${id} is not namespaced`);
    assert.ok(id.length <= 100, `${id} exceeds the Discord custom id limit`);
  });
});

check('the component router ignores ids that are not ours', async () => {
  const handled = await dashboardCmd.handleComponent({ customId: 'someone-elses-button' });
  assert.strictEqual(handled, false, 'the router claimed a foreign component');
});

// --- Cross-guild isolation --------------------------------------------------

const storeSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'store.js'), 'utf8');

check('every command-facing read and write is scoped to one guild', () => {
  /*
    A guild admin must never be able to reach another guild's rows. The workers
    legitimately act on a row id they already fetched under a guild scope, so
    they are listed here by name rather than matched loosely.
  */
  const workerOnly = new Set([
    'touchCounter', 'failCounter', 'dropCounter',
    'touchStatusMessage', 'failStatusMessage', 'dropStatusMessage',
    'setAlertState', 'deactivateAlert',
    'markReportSent', 'dueReports',
    'allActiveTrackedServers', 'guildsWithWork',
  ]);

  const functions = storeSource.split(/\nasync function /).slice(1);

  functions.forEach((body) => {
    const name = body.slice(0, body.indexOf('('));

    if (workerOnly.has(name)) {
      return;
    }

    /*
      A function is scoped if it filters on guild_id, or if it INSERTs guild_id
      as its first bound parameter (an insert has nothing to filter, but the
      guild still has to come from the caller rather than from user input).
    */
    const filters = /guild_id = \$1|guild_id = EXCLUDED\.guild_id|[cmat]\.guild_id = \$1|ON CONFLICT \(guild_id,/.test(body);
    const insertsScoped = /INSERT INTO \w+\s*\(\s*guild_id\s*,/.test(body)
      && /String\(guildId\)/.test(body);

    assert.ok(filters || insertsScoped, `store.${name} has no guild_id scope`);
  });
});

check('the alert insert proves the server belongs to the guild', () => {
  const insert = storeSource.slice(storeSource.indexOf('async function addAlert'));
  assert.ok(
    /FROM discord_tracked_servers t\s+WHERE t\.id = \$2 AND t\.guild_id = \$1/.test(insert),
    'addAlert can attach an alert to another guild\'s tracked server'
  );
});

check('upserts cannot rewrite another guild row', () => {
  ['addCounter', 'addStatusMessage'].forEach((name) => {
    const body = storeSource.slice(storeSource.indexOf(`async function ${name}`));
    const upsert = body.slice(0, body.indexOf('RETURNING'));
    assert.ok(upsert.includes('guild_id = EXCLUDED.guild_id'), `${name} has an unguarded ON CONFLICT`);
  });
});

check('no SQL is built by string interpolation', () => {
  /*
    Scans template literals that actually look like SQL, rather than any string
    containing a SQL word: an error message reading "I could not delete the
    channel: ${err}" is English, not a query, and matching it would train
    everyone to ignore this check.
  */
  const fs = require('fs');
  const dir = require('path').join(__dirname, '..', 'src');
  const files = [];

  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((entry) => {
      const full = require('path').join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    });
  })(dir);

  const SQL_START = /^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;

  files.forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const literals = text.match(/`(?:[^`\\]|\\.)*`/g) || [];

    literals.forEach((literal) => {
      const body = literal.slice(1, -1);

      if (!SQL_START.test(body)) {
        return;
      }

      assert.ok(
        !body.includes('${'),
        `${file} interpolates a value into SQL instead of using a parameter:\n${body.slice(0, 120)}`
      );
    });
  });
});

// --- Games catalogue --------------------------------------------------------

const games = require('../src/lib/games');

check('the games catalogue loads and searches', () => {
  games.load();
  assert.ok(games.count() > 100, `only ${games.count()} games loaded`);
  assert.strictEqual(games.isValidGame('counterstrike16'), true);
  assert.strictEqual(games.isValidGame('not-a-game'), false);
  assert.ok(games.search('counter').length > 0);

  // Empty search returns the curated popular list first; every id in it must
  // exist, or autocomplete offers a game the API will reject.
  const defaults = games.search('', 25);
  defaults.forEach((game) => assert.ok(games.isValidGame(game.id), `${game.id} is not in the catalogue`));
});

// --- Result -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll checks passed.');

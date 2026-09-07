'use strict';

/*
  Renders the screenshot gallery for the README and the marketplace listing.

  Every image is produced by the SAME renderer the bot uses in Discord, from
  data shaped like a real day, so the gallery cannot drift from the product. A
  marketing screenshot that no longer matches the software is worse than none.

  Usage: node scripts/render-gallery.js [outputDir]
*/

const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const chart = require('../src/lib/chart');

const OUT = process.argv[2] || path.join(__dirname, '..', 'docs', 'images');
const FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/dejavu';

fs.mkdirSync(OUT, { recursive: true });

GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans.ttf'), 'GQSans');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), 'GQSansBold');

const T = chart.T;

function font(size, bold = false) {
  return `${size}px ${bold ? 'GQSansBold' : 'GQSans'}, sans-serif`;
}

// A day with an evening peak, a lunch bump and one outage. Deterministic, so
// regenerating the gallery does not produce a gratuitous diff.
function seededNoise(i) {
  return Math.sin(i * 1.7) * 1.6 + Math.sin(i * 0.41) * 1.1;
}

function dayOfPlayers({ count = 288, minutes = 5, outage = [150, 166], scale = 1 } = {}) {
  const now = Date.now();

  return Array.from({ length: count }, (_, i) => {
    const at = new Date(now - (count - i) * minutes * 60 * 1000);
    const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
    const evening = ((hour - 20) / 4.5) ** 2;
    const lunch = ((hour - 13) / 3) ** 2;
    const base = (6 + 22 * Math.exp(-evening) + 5 * Math.exp(-lunch)) * scale;
    const down = i > outage[0] && i < outage[1];

    return { at, players: down ? null : Math.max(0, Math.round(base + seededNoise(i))) };
  });
}

function write(name, buffer) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buffer);
  console.log(`${name.padEnd(28)} ${String(buffer.length).padStart(7)} bytes`);
}

// 1. Player graph -------------------------------------------------------------

write('players-24h.png', chart.renderPlayerChart(
  [{ label: 'Main Public', points: dayOfPlayers() }],
  {
    title: 'Main Public',
    subtitle: 'Counter-Strike 1.6 · 203.0.113.10:27015',
    rangeKey: '24h',
    rangeLabel: 'Last 24 hours',
    capacity: 32,
    footer: 'Average 14.2 · peak 31 · reachable 94.4% of checks',
  }
));

// 2. Comparison ---------------------------------------------------------------

write('compare.png', chart.renderPlayerChart(
  [
    { label: 'Main Public', points: dayOfPlayers({ outage: [-1, -1] }) },
    { label: 'Retake #2', points: dayOfPlayers({ outage: [-1, -1], scale: 0.62 }) },
    { label: 'Awp Only', points: dayOfPlayers({ outage: [-1, -1], scale: 0.35 }) },
  ],
  { title: '3 servers compared', subtitle: 'Nexa Community', rangeKey: '24h', rangeLabel: 'Last 24 hours' }
));

// 3. Uptime -------------------------------------------------------------------

const uptimePoints = Array.from({ length: 144 }, (_, i) => {
  const at = new Date(Date.now() - (144 - i) * 10 * 60 * 1000);
  if (i > 30 && i < 36) return { at, uptime: null };
  if (i > 80 && i < 92) return { at, uptime: i === 85 ? 0 : 38 };
  if (i > 110 && i < 115) return { at, uptime: 94 };
  return { at, uptime: 100 };
});

write('uptime.png', chart.renderUptimeChart(uptimePoints, {
  title: 'Main Public',
  subtitle: 'Counter-Strike 1.6 · 203.0.113.10:27015',
  rangeKey: '24h',
  rangeLabel: 'Last 24 hours',
  footer: '2 incidents, 1.2h down',
}));

// 4. Peak hours ---------------------------------------------------------------

write('peak-hours.png', chart.renderHourProfile(
  Array.from({ length: 24 }, (_, hour) => ({
    hour,
    avgPlayers: Math.round(4 + 20 * Math.exp(-(((hour - 20) / 4.5) ** 2)) + 4 * Math.exp(-(((hour - 13) / 3) ** 2))),
    peakPlayers: 32,
  })),
  {
    title: 'Main Public - players by hour',
    subtitle: 'Counter-Strike 1.6 · 203.0.113.10:27015',
    rangeLabel: 'Averaged over 14 days, UTC',
  }
));

// 5. Counter channels ---------------------------------------------------------

function channelList() {
  const W = 760;
  const H = 420;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = T.ink;
  ctx.font = font(19, true);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Channel names are the live player count', 32, 42);

  ctx.fillStyle = T.inkMuted;
  ctx.font = font(13);
  ctx.fillText('Voice or category channels, renamed automatically as the count changes', 32, 65);

  const panelY = 88;
  ctx.fillStyle = T.panel;
  ctx.fillRect(32, panelY, W - 64, H - panelY - 32);
  ctx.strokeStyle = T.lineStrong;
  ctx.strokeRect(32.5, panelY + 0.5, W - 65, H - panelY - 33);

  ctx.fillStyle = T.inkFaint;
  ctx.font = font(11, true);
  ctx.fillText('GAME SERVERS', 52, panelY + 30);

  const rows = [
    ['24/32 online', T.success],
    ['Players: 41', T.success],
    ['de_dust2 · 18/24', T.success],
    ['Retake #2 · 9/20', T.success],
    ['-- offline', T.danger],
  ];

  rows.forEach(([label, dot], index) => {
    const y = panelY + 60 + index * 42;

    ctx.fillStyle = T.raised;
    ctx.fillRect(46, y - 18, W - 92, 34);

    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(66, y - 1, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = T.ink;
    ctx.font = font(15);
    ctx.fillText(label, 84, y + 4);
  });

  return canvas.toBuffer('image/png');
}

write('counter-channels.png', channelList());

// 6. Control panel ------------------------------------------------------------

function controlPanel() {
  const W = 860;
  const H = 470;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = T.panel;
  ctx.fillRect(28, 28, W - 56, H - 56);
  ctx.fillStyle = T.accent;
  ctx.fillRect(28, 28, 3, H - 56);
  ctx.strokeStyle = T.lineStrong;
  ctx.strokeRect(28.5, 28.5, W - 57, H - 57);

  ctx.fillStyle = T.ink;
  ctx.font = font(18, true);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Nexa Community · control panel', 52, 62);

  const servers = [
    ['Main Public', '203.0.113.10:27015', 'now 24/32', '24h peak 31', 'up 99.8%', T.success],
    ['Retake #2', '203.0.113.11:27015', 'now 9/20', '24h peak 18', 'up 99.1%', T.success],
    ['Awp Only', '203.0.113.12:27015', 'now --', '24h peak 12', 'up 91.4%', T.danger],
  ];

  servers.forEach(([name, addr, now, peak, up, dot], index) => {
    const y = 100 + index * 74;

    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(60, y + 4, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = T.ink;
    ctx.font = font(15, true);
    ctx.fillText(name, 76, y + 9);

    ctx.fillStyle = T.inkFaint;
    ctx.font = font(12);
    ctx.fillText(`${addr} · ${now} · ${peak} · ${up}`, 76, y + 30);

    ctx.strokeStyle = T.line;
    ctx.beginPath();
    ctx.moveTo(52, y + 48.5);
    ctx.lineTo(W - 52, y + 48.5);
    ctx.stroke();
  });

  ctx.fillStyle = T.inkMuted;
  ctx.font = font(13);
  ctx.fillText('33 players across 2/3 servers', 52, 344);

  ctx.fillStyle = T.inkFaint;
  ctx.font = font(12);
  ctx.fillText('Pro plan · 3/25 servers · 2/10 counters · refresh every 2 min', 52, 366);

  const buttons = [
    ['Refresh', T.raised, T.ink],
    ['Add server', T.accent, '#ffffff'],
    ['Manage plan', T.raised, T.inkMuted],
  ];

  let x = 52;
  buttons.forEach(([label, bg, fg]) => {
    ctx.font = font(13, true);
    const w = ctx.measureText(label).width + 34;
    ctx.fillStyle = bg;
    ctx.fillRect(x, 392, w, 34);
    ctx.fillStyle = fg;
    ctx.fillText(label, x + 17, 413);
    x += w + 10;
  });

  return canvas.toBuffer('image/png');
}

write('control-panel.png', controlPanel());

console.log(`\nwrote ${fs.readdirSync(OUT).length} images to ${OUT}`);

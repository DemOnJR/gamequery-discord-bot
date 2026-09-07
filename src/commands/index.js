'use strict';

const server = require('./server');
const track = require('./track');
const graph = require('./graph');
const counter = require('./counter');
const live = require('./live');
const alert = require('./alert');
const uptime = require('./uptime');
const dashboard = require('./dashboard');
const report = require('./report');
const account = require('./account');
const extras = require('./extras');

const commands = new Map();

[
  server,
  track,
  graph,
  counter,
  live,
  alert,
  uptime,
  dashboard,
  report,
  account.link,
  account.pro,
  extras.players,
  extras.export,
  extras.games,
  extras.help,
].forEach((command) => {
  commands.set(command.data.name, command);
});

function toJSON() {
  return Array.from(commands.values()).map((command) => command.data.toJSON());
}

function get(name) {
  return commands.get(name) || null;
}

function names() {
  return Array.from(commands.keys());
}

/*
  Buttons, select menus and modals. Only the dashboard uses them today, but the
  router asks this module rather than importing the command directly, so adding
  another interactive command is a change in one place.
*/
async function handleComponent(interaction) {
  return dashboard.handleComponent(interaction);
}

async function handleModal(interaction) {
  return dashboard.handleModal(interaction);
}

module.exports = { commands, toJSON, get, names, handleComponent, handleModal };

// Discord integration plugin for NEXUS bot
// This module connects to a Discord channel, fetches messages, and provides them for analysis/learning.

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');

class DiscordPlugin {
  constructor(token, channelId, outputFile = 'discord_channel_data.json') {
    this.token = token;
    this.channelId = channelId;
    this.outputFile = outputFile;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  async fetchAllMessages() {
    await this.client.login(this.token);
    const channel = await this.client.channels.fetch(this.channelId);
    let messages = [];
    let lastId;
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const fetched = await channel.messages.fetch(options);
      if (fetched.size === 0) break;
      messages = messages.concat(Array.from(fetched.values()));
      lastId = fetched.last().id;
    }
    // Save messages to file
    fs.writeFileSync(this.outputFile, JSON.stringify(messages.map(m => ({ id: m.id, author: m.author.username, content: m.content, timestamp: m.createdTimestamp })), null, 2));
    console.log(`Fetched ${messages.length} messages from Discord channel.`);
    this.client.destroy();
  }
}

module.exports = DiscordPlugin;

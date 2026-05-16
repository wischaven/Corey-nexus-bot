// YouTube Transcript Plugin for NEXUS bot
// Fetches video transcripts from a YouTube channel for analysis/learning
// Requires: npm install googleapis youtube-transcript

const { google } = require('googleapis');
const YoutubeTranscript = require('youtube-transcript').default;
const fs = require('fs');

class YouTubeTranscriptPlugin {
  constructor(apiKey, channelId, outputFile = 'youtube_transcripts.json') {
    this.apiKey = apiKey;
    this.channelId = channelId;
    this.outputFile = outputFile;
    this.youtube = google.youtube({ version: 'v3', auth: apiKey });
  }

  async fetchVideoIds(maxResults = 10) {
    const res = await this.youtube.search.list({
      channelId: this.channelId,
      part: 'id',
      maxResults,
      order: 'date',
      type: 'video',
    });
    return res.data.items.map(item => item.id.videoId);
  }

  async fetchTranscripts(videoIds) {
    const transcripts = [];
    for (const videoId of videoIds) {
      try {
        const transcript = await YoutubeTranscript.fetchTranscript(videoId);
        transcripts.push({ videoId, transcript });
      } catch (e) {
        transcripts.push({ videoId, transcript: null, error: e.message });
      }
    }
    fs.writeFileSync(this.outputFile, JSON.stringify(transcripts, null, 2));
    console.log(`Fetched transcripts for ${transcripts.length} videos.`);
  }

  async run(maxResults = 10) {
    const videoIds = await this.fetchVideoIds(maxResults);
    await this.fetchTranscripts(videoIds);
  }
}

module.exports = YouTubeTranscriptPlugin;

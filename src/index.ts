import { Client, TextChannel, CustomStatus, Message, ActivityOptions } from "discord.js-selfbot-v13";
import { streamLivestreamVideo, MediaUdp, StreamOptions, Streamer, Utils } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import ytdl from '@distube/ytdl-core';
import { getStream, getVod } from 'twitch-m3u8';
import yts from 'play-dl';
import { getVideoParams, ffmpegScreenshot } from "./utils/ffmpeg.js";
import PCancelable, { CancelError } from "p-cancelable";
import logger from './utils/logger.js';
import { Youtube } from './utils/youtube.js';
import { TwitchStream } from './@types/index.js';
import https from 'https';

// Create a new instance of Streamer and Youtube
const streamer = new Streamer(new Client());
const youtube = new Youtube();

// Stream options
const streamOpts: StreamOptions = {
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrateKbps: config.bitrateKbps,
    maxBitrateKbps: config.maxBitrateKbps,
    hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
    videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
    rtcpSenderReportEnabled: true,
    h26xPreset: config.h26xPreset,
    minimizeLatency: true,
    forceChacha20Encryption: false
};

// Ensure directories exist
fs.mkdirSync(config.videosDir, { recursive: true });
fs.mkdirSync(config.previewCacheDir, { recursive: true });

// Read local video files (for "random" command)
const videoFiles = fs.readdirSync(config.videosDir);
let videos = videoFiles.map(file => {
    const fileName = path.parse(file).name;
    return { name: fileName.replace(/ /g, '_'), path: path.join(config.videosDir, file) };
});
logger.info(`Available videos:\n${videos.map(m => m.name).join('\n')}`);

// Global stream status – holds voice connection info
const streamStatus = {
    joined: false,
    joinsucc: false,
    playing: false,
    channelInfo: {
        guildId: config.guildId,
        channelId: config.videoChannelId,
        cmdChannelId: config.cmdChannelId
    }
};

// Global queues: working queue and original queue (for looping)
let videoQueue: { uid: string, link: string }[] = [];
let originalQueue: { uid: string, link: string }[] = [];
let loopEnabled = false;   // When true, if the working queue empties, it is refilled
let isPlayingQueue = false;  // Indicates that the playback loop is running
let stopRequested = false;   // When true, the playback loop will exit

// Global reference to current playback (for cancellation)
let currentPlayback: PCancelable<any> | null = null;

// Status functions now use the logged‑in client so that your custom status is applied.
const status_idle = () => {
    return new CustomStatus(streamer.client)
        .setEmoji('👑')
        .setState('Join Sinister Valley. Link in Bio!');
};

const status_watch = (name: string) => {
    return new CustomStatus(streamer.client)
        .setEmoji('🟣')
        .setState(`Streaming Now!`);
};

// Utility: generate a UID (5-digit number + 3 uppercase letters)
function generateUID(): string {
    const num = Math.floor(10000 + Math.random() * 90000).toString();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randLetters = '';
    for (let i = 0; i < 3; i++) {
        randLetters += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return num + randLetters;
}

// Helper: send plain text message (reply if Message, otherwise send to channel)
async function sendPlain(target: Message | TextChannel, content: string) {
    if (target instanceof Message) {
        await target.reply(content);
    } else {
        await target.send(content);
    }
}
async function sendError(message: Message, errorText: string) {
    await sendPlain(message, `❌ Error: ${errorText}`);
}
async function sendSuccess(message: Message, text: string) {
    await sendPlain(message, `✅ Success: ${text}`);
}
async function sendInfo(message: Message, title: string, description: string) {
    await sendPlain(message, `ℹ️ ${title}: ${description}`);
}
async function sendPlaying(message: Message, title: string) {
    await sendPlain(message, `▶️ Now Playing: ${title}`);
}
async function sendList(message: Message, items: string[], type?: string) {
    const header = type === "ytsearch" ? "📋 Search Results:" :
                   type === "refresh" ? "📋 Video list refreshed:" :
                   "📋 Local Videos List:";
    await sendPlain(message, `${header}\n${items.join('\n')}`);
}
async function sendFinishMessage() {
    const channel = streamer.client.channels.cache.get(config.cmdChannelId.toString()) as TextChannel;
    if (channel) {
        await channel.send("⏹️ Finished playing video.");
    }
}

// Helper: Reads text from an attachment URL.
async function readAttachment(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        https.get(url, (res) => {
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve(data);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Pre-download function: downloads a remote video and returns its local file path.
async function preDownloadVideo(link: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
        try {
            let filePath: string;
            if (ytdl.validateURL(link)) {
                const info = await ytdl.getInfo(link);
                const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
                const fileName = `${title}_${Date.now()}.mp4`;
                filePath = path.join(config.videosDir, fileName);
                const videoStream = ytdl(link, { quality: 'highest' });
                const writeStream = fs.createWriteStream(filePath);
                videoStream.pipe(writeStream);
                writeStream.on('finish', () => resolve(filePath));
                writeStream.on('error', (err) => reject(err));
            } else if (link.includes('twitch.tv')) {
                const twitchUrl = await getTwitchStreamUrl(link);
                if (!twitchUrl) return reject(new Error("Unable to fetch Twitch stream URL."));
                const fileName = `twitch_${Date.now()}.mp4`;
                filePath = path.join(config.videosDir, fileName);
                https.get(twitchUrl, (response: any) => {
                    const writeStream = fs.createWriteStream(filePath);
                    response.pipe(writeStream);
                    writeStream.on('finish', () => resolve(filePath));
                    writeStream.on('error', (err: any) => reject(err));
                }).on('error', (err: any) => reject(err));
            } else {
                // Generic remote URL
                const fileName = `video_${Date.now()}.mp4`;
                filePath = path.join(config.videosDir, fileName);
                https.get(link, (response: any) => {
                    const writeStream = fs.createWriteStream(filePath);
                    response.pipe(writeStream);
                    writeStream.on('finish', () => resolve(filePath));
                    writeStream.on('error', (err: any) => reject(err));
                }).on('error', (err: any) => reject(err));
            }
        } catch (err) {
            reject(err);
        }
    });
}

// Instead of launching separate playback tasks for each video, use a dedicated loop.
async function playQueue() {
    if (isPlayingQueue) return;
    isPlayingQueue = true;
    stopRequested = false;
    let udpConn: MediaUdp;
    try {
        if (!streamStatus.joined) {
            await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
            udpConn = await streamer.createStream(streamOpts);
            streamStatus.joined = true;
        } else {
            udpConn = await streamer.createStream(streamOpts);
        }
    } catch (err) {
        logger.error("Error joining voice channel:", err);
        isPlayingQueue = false;
        return;
    }
    while (!stopRequested) {
        if (videoQueue.length === 0) {
            if (loopEnabled && originalQueue.length > 0) {
                videoQueue = originalQueue.slice();
            } else {
                break;
            }
        }
        const next = videoQueue.shift();
        if (!next) continue;
        if (next.link.startsWith("http")) {
            try {
                const localPath = await preDownloadVideo(next.link);
                next.link = localPath;
            } catch (err) {
                logger.error("Error pre-downloading video:", err);
                continue;
            }
        }
        if (stopRequested) break; // Check one more time before playing
        try {
            logger.info(`Playing next video: ${next.link}`);
            await playVideoWithConnection(next.link, `Queue item [${next.uid}]`, udpConn);
        } catch (err) {
            logger.error("Error playing video:", err);
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    await cleanupStreamStatus();
    isPlayingQueue = false;
    stopRequested = false;
}

// Play a video using an existing voice connection with cancelable playback
async function playVideoWithConnection(video: string, title: string, udpConn: MediaUdp) {
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);
    if (title) {
        await sendPlain(getCommandChannel(), `▶️ Now Playing: ${title}`);
        streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
    }
    try {
        currentPlayback = new PCancelable(async (resolve, reject, onCancel) => {
            onCancel(() => {
                reject(new CancelError('Playback canceled'));
            });
            try {
                const result = await streamLivestreamVideo(video, udpConn);
                resolve(result);
            } catch (err) {
                logger.error("Error occurred while streaming video:", err);
                // Resolve so that the errored video is skipped without disconnecting
                resolve("error skipped");
            }
        });
        const res = await currentPlayback;
        logger.info(`Finished playing video: ${res}`);
    } catch (error) {
        if (!(error instanceof CancelError)) {
            logger.error("Error occurred while playing video:", error);
        }
    } finally {
        udpConn.mediaConnection.setSpeaking(false);
        udpConn.mediaConnection.setVideoStatus(false);
        await sendPlain(getCommandChannel(), "⏹️ Finished playing video.");
        currentPlayback = null;
    }
}

// Command handler (listening to messages from self)
streamer.client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(config.prefix!)) return;
    if (message.channel.id != config.cmdChannelId) return;
    const args = message.content.slice(config.prefix!.length).trim().split(/ +/);
    if (!args.length) return;
    const commandName = args.shift()!.toLowerCase();
    switch (commandName) {
        case 'add': {
            // Use join(" ") so that spaces are preserved.
            const link = args.join(" ");
            if (!link) {
                await sendError(message, "Please provide a video link.");
                return;
            }
            const uid = generateUID();
            const item = { uid, link };
            videoQueue.push(item);
            originalQueue.push(item);
            await sendSuccess(message, `Video added (UID: \`${uid}\`, Link: ${link})`);
            if (!isPlayingQueue) playQueue().catch(err => logger.error(err));
            break;
        }
        case 'batch': {
            // Check if there's an attachment. If so, read its text content.
            let rawText = "";
            if (message.attachments.size > 0) {
                const attachment = message.attachments.find(att =>
                    (att.name && att.name.endsWith('.txt')) ||
                    (att.contentType && att.contentType.includes("text"))
                );
                if (attachment && attachment.url) {
                    try {
                        rawText = await readAttachment(attachment.url);
                    } catch (err) {
                        await sendError(message, "Failed to read the attachment.");
                        return;
                    }
                } else {
                    await sendError(message, "No valid text attachment found.");
                    return;
                }
            } else {
                // Otherwise, use the remaining message content after the command.
                rawText = message.content.slice(config.prefix!.length + commandName.length).trim();
            }
            const links = rawText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
            if (links.length === 0) {
                await sendError(message, "No links found. Please provide multiple links separated by newlines.");
                return;
            }
            for (const link of links) {
                const uid = generateUID();
                const item = { uid, link };
                videoQueue.push(item);
                originalQueue.push(item);
            }
            await sendSuccess(message, `${links.length} videos added to the queue.`);
            if (!isPlayingQueue) playQueue().catch(err => logger.error(err));
            break;
        }
        case 'list': {
            if (videoQueue.length === 0) {
                await sendInfo(message, "Queue Status", "The queue is empty.");
            } else {
                const listStr = videoQueue.map(item => `• \`${item.uid}\`: ${item.link}`).join("\n");
                await sendPlain(message, `📋 Queue Status:\n${listStr}`);
            }
            break;
        }
        case 'remove': {
            const uid = args[0];
            if (!uid) {
                await sendError(message, "Please provide the UID of the video to remove.");
                return;
            }
            const index = videoQueue.findIndex(item => item.uid === uid);
            const originalIndex = originalQueue.findIndex(item => item.uid === uid);
            if (index === -1 || originalIndex === -1) {
                await sendError(message, `No video found with UID \`${uid}\`.`);
            } else {
                const removed = videoQueue.splice(index, 1)[0];
                originalQueue.splice(originalIndex, 1);
                await sendSuccess(message, `Removed video (UID: \`${removed.uid}\`, Link: ${removed.link})`);
            }
            break;
        }
        case 'loop': {
            const mode = args[0]?.toLowerCase();
            if (mode === "on") {
                loopEnabled = true;
                await sendSuccess(message, "Loop mode enabled. The current queue will repeat continuously.");
            } else if (mode === "off") {
                loopEnabled = false;
                await sendSuccess(message, "Loop mode disabled.");
            } else {
                await sendError(message, "Usage: `loop on` or `loop off`");
            }
            break;
        }
        case 'stop': {
            stopRequested = true;
            if (currentPlayback) {
                currentPlayback.cancel();
            }
            videoQueue = [];
            originalQueue = [];
            await cleanupStreamStatus();
            await sendPlain(message, "⏹️ Playback stopped.");
            break;
        }
        case 'random': {
            const localVideoFiles = fs.readdirSync(config.videosDir);
            if (localVideoFiles.length === 0) {
                await sendError(message, "No videos found in the local videos folder.");
                return;
            }
            const randomIndex = Math.floor(Math.random() * localVideoFiles.length);
            const file = localVideoFiles[randomIndex];
            const filePath = path.join(config.videosDir, file);
            await sendPlain(message, `▶️ Now Playing: Random video \`${file}\``);
            if (!streamStatus.joined) {
                await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
            }
            const udpConn = await streamer.createStream(streamOpts);
            streamStatus.joined = true;
            streamStatus.playing = true;
            setImmediate(() => {
                playVideoWithConnection(filePath, file, udpConn).catch(err => logger.error(err));
            });
            break;
        }
        case 'download': {
            const link = args.join(" ");
            if (!link) {
                await sendError(message, "Please provide a video link to download.");
                return;
            }
            downloadVideo(link, message.channel as TextChannel);
            await sendPlain(message, `⏬ Download started: ${link}`);
            break;
        }
        case 'help': {
            const helpText = [
                '📽 Available Commands:',
                '',
                `\`${config.prefix}add <link>\` – Add a video link to the queue (supports spaces).`,
                `\`${config.prefix}batch\` – Add multiple video links at once (each link on a new line, or as a text attachment).`,
                `\`${config.prefix}list\` – Show the current queue (with UID for each item).`,
                `\`${config.prefix}remove <uid>\` – Remove a video from the queue by UID.`,
                `\`${config.prefix}random\` – Play a random local video.`,
                `\`${config.prefix}download <link>\` – Download a video to the videos folder.`,
                `\`${config.prefix}loop on\` – Enable loop mode (repeats the current queue).`,
                `\`${config.prefix}loop off\` – Disable loop mode.`,
                `\`${config.prefix}stop\` – Stop playback and clear the queue.`,
                `\`${config.prefix}help\` – Show this help message.`
            ].join('\n');
            await sendPlain(message, helpText);
            break;
        }
        default: {
            await sendError(message, "Invalid command. Use the `help` command to see available commands.");
            break;
        }
    }
});

// Helper: Get the command channel from config.
function getCommandChannel(): TextChannel {
    const channelId = Array.isArray(config.cmdChannelId) ? config.cmdChannelId[0] : config.cmdChannelId;
    return streamer.client.channels.cache.get(channelId.toString()) as TextChannel;
}

// Cleanup: Leave voice and reset streamStatus (retain channel info for reconnection)
async function cleanupStreamStatus() {
    await streamer.leaveVoice();
    streamer.client.user?.setActivity(status_idle() as ActivityOptions);
    streamStatus.joined = false;
    streamStatus.joinsucc = false;
    streamStatus.playing = false;
    // Brief delay to ensure Discord processes the disconnect
    await new Promise(res => setTimeout(res, 500));
    streamStatus.channelInfo = {
        guildId: config.guildId,
        channelId: config.videoChannelId,
        cmdChannelId: config.cmdChannelId
    };
}

// Download function: Downloads a remote video.
async function downloadVideo(link: string, channel: TextChannel) {
    try {
        const info = await ytdl.getInfo(link);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        const fileName = `${title}_${Date.now()}.mp4`;
        const filePath = path.join(config.videosDir, fileName);
        const videoStream = ytdl(link, { quality: 'highest' });
        const writeStream = fs.createWriteStream(filePath);
        videoStream.pipe(writeStream);
        writeStream.on('finish', async () => {
            await sendPlain(channel, `✅ Download complete: ${fileName}`);
        });
        writeStream.on('error', async (err) => {
            await sendPlain(channel, `❌ Download error: ${err}`);
        });
    } catch (error) {
        await sendPlain(channel, "❌ Download error: Failed to download video.");
    }
}

// Utility functions for links
async function getTwitchStreamUrl(url: string): Promise<string | null> {
    try {
        if (url.includes('/videos/')) {
            const vodId = url.split('/videos/').pop() as string;
            const vodInfo = await getVod(vodId);
            const vod = vodInfo.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || vodInfo[0];
            if (vod?.url) return vod.url;
            logger.error("No VOD URL found");
            return null;
        } else {
            const twitchId = url.split('/').pop() as string;
            const streams = await getStream(twitchId);
            const stream = streams.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || streams[0];
            if (stream?.url) return stream.url;
            logger.error("No Stream URL found");
            return null;
        }
    } catch (error) {
        logger.error("Failed to get Twitch stream URL:", error);
        return null;
    }
}
async function getVideoUrl(videoUrl: string): Promise<string | null> {
    return await youtube.getVideoUrl(videoUrl);
}
async function ytPlayTitle(title: string): Promise<string | null> {
    return await youtube.searchAndPlay(title);
}
async function ytSearch(title: string): Promise<string[]> {
    return await youtube.search(title);
}

// ------------------
// OPTIONAL: Run server if enabled in config
// ------------------
if (config.server_enabled) {
    import('./server.js');
}

// ------------------
// LOGIN TO DISCORD
// ------------------
streamer.client.login(config.token);

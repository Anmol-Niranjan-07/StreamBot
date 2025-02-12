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

// Stream options – unchanged from your original logic
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

// Create required directories
fs.mkdirSync(config.videosDir, { recursive: true });
fs.mkdirSync(config.previewCacheDir, { recursive: true });

// Read local video files (for the "random" command)
const videoFiles = fs.readdirSync(config.videosDir);
let videos = videoFiles.map(file => {
    const fileName = path.parse(file).name;
    return { name: fileName.replace(/ /g, '_'), path: path.join(config.videosDir, file) };
});
logger.info(`Available videos:\n${videos.map(m => m.name).join('\n')}`);

// Global stream status object
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
let loopEnabled = false; // If true, once the working queue is empty, it will be refilled from originalQueue

// Utility: generate a UID (5-digit number + 3 random uppercase letters)
function generateUID(): string {
    const num = Math.floor(10000 + Math.random() * 90000).toString();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randLetters = '';
    for (let i = 0; i < 3; i++) {
        randLetters += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return num + randLetters;
}

// Helper: Send a plain text message
async function sendPlain(target: Message | TextChannel, content: string) {
    if (target instanceof Message) {
        await target.reply(content);
    } else {
        await target.send(content);
    }
}

// Specific helper functions
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
    let header = type === "ytsearch" ? "📋 Search Results:" :
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

// Pre-download function: Downloads a remote video and returns its local file path.
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

// Ready event
streamer.client.on("ready", async () => {
    if (streamer.client.user) {
        logger.info(`${streamer.client.user.tag} is ready`);
        streamer.client.user.setActivity(status_idle() as ActivityOptions);
    }
});

// Voice state update: Maintain streamStatus
streamer.client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.member?.user.id === streamer.client.user?.id && oldState.channelId && !newState.channelId) {
        streamStatus.joined = false;
        streamStatus.joinsucc = false;
        streamStatus.playing = false;
        streamStatus.channelInfo = { guildId: config.guildId, channelId: config.videoChannelId, cmdChannelId: config.cmdChannelId };
        streamer.client.user?.setActivity(status_idle() as ActivityOptions);
    }
    if (newState.member?.user.id === streamer.client.user?.id && newState.channelId && !oldState.channelId) {
        streamStatus.joined = true;
        if (newState.guild.id === streamStatus.channelInfo.guildId && newState.channelId === streamStatus.channelInfo.channelId) {
            streamStatus.joinsucc = true;
        }
    }
});

// Command handler (listens to messages from self)
streamer.client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(config.prefix!)) return;
    const args = message.content.slice(config.prefix!.length).trim().split(/ +/);
    if (!args.length) return;
    const commandName = args.shift()!.toLowerCase();

    switch (commandName) {
        case 'add': {
            // Use args.join(" ") so that links with spaces are preserved.
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
            if (!streamStatus.playing) processQueue().catch(err => logger.error(err));
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
            await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
            const udpConn = await streamer.createStream(streamOpts);
            streamStatus.joined = true;
            streamStatus.playing = true;
            setImmediate(() => {
                playVideo(filePath, udpConn, file).catch(err => logger.error(err));
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
                `\`${config.prefix}list\` – Show the current queue (with UID for each item).`,
                `\`${config.prefix}remove <uid>\` – Remove a video from the queue by UID.`,
                `\`${config.prefix}random\` – Play a random local video.`,
                `\`${config.prefix}download <link>\` – Download a video to the videos folder.`,
                `\`${config.prefix}loop on\` – Enable loop mode (repeats the current queue).`,
                `\`${config.prefix}loop off\` – Disable loop mode.`,
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

// ------------------
// QUEUE & PLAYBACK FUNCTIONS
// ------------------
let command: PCancelable<string> | undefined;

async function processQueue() {
    if (videoQueue.length === 0 && loopEnabled && originalQueue.length > 0) {
        videoQueue = originalQueue.slice(0);
    }
    if (videoQueue.length > 0) {
        const next = videoQueue.shift()!;
        // If the link is remote, pre-download it.
        if (next.link.startsWith("http")) {
            try {
                const localPath = await preDownloadVideo(next.link);
                next.link = localPath;
            } catch (err) {
                logger.error("Error pre-downloading video:", err);
                // If pre-download fails, skip to the next video.
                return processQueue();
            }
        }
        if (!streamStatus.joined) {
            await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
        }
        const udpConn = await streamer.createStream(streamOpts);
        streamStatus.joined = true;
        streamStatus.playing = true;
        setImmediate(() => {
            playVideo(next.link, udpConn, `Queue item [${next.uid}]`).catch(err => logger.error(err));
        });
    } else {
        await cleanupStreamStatus();
    }
}

// Play a local video file
async function playVideo(video: string, udpConn: MediaUdp, title?: string) {
    logger.info("Started playing video");
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);
    try {
        if (title) {
            sendPlain(getCommandChannel(), `▶️ Now Playing: ${title}`);
            streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
        }
        command = PCancelable.fn<string, string>(() => streamLivestreamVideo(video, udpConn))(video);
        const res = await command;
        logger.info(`Finished playing video: ${res}`);
    } catch (error) {
        if (!(error instanceof CancelError)) {
            logger.error("Error occurred while playing video:", error);
        }
    } finally {
        udpConn.mediaConnection.setSpeaking(false);
        udpConn.mediaConnection.setVideoStatus(false);
        sendPlain(getCommandChannel(), "⏹️ Finished playing video.");
        // Use a short delay before processing the next video.
        setTimeout(() => {
            processQueue().catch(err => logger.error(err));
        }, 1000);
    }
}

// Helper to get the command channel
function getCommandChannel(): TextChannel {
    const channelId = Array.isArray(config.cmdChannelId) ? config.cmdChannelId[0] : config.cmdChannelId;
    return streamer.client.channels.cache.get(channelId.toString()) as TextChannel;
}

// ------------------
// DOWNLOAD FUNCTION
// ------------------
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

// ------------------
// UTILITY FUNCTIONS FOR LINKS
// ------------------
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
// STATUS FUNCTIONS
// ------------------
const status_idle = () => {
    return new CustomStatus(new Client())
        .setEmoji('👑')
        .setState('Join Sinister Valley. Link in Bio!');
};

const status_watch = (name: string) => {
    return new CustomStatus(new Client())
        .setEmoji('🟣')
        .setState(`Streaming Now!`);
};

// ------------------
// CLEANUP FUNCTION
// ------------------
async function cleanupStreamStatus() {
    streamer.leaveVoice();
    streamer.client.user?.setActivity(status_idle() as ActivityOptions);
    streamStatus.joined = false;
    streamStatus.joinsucc = false;
    streamStatus.playing = false;
    streamStatus.channelInfo = { guildId: "", channelId: "", cmdChannelId: "" };
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

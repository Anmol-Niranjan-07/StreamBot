import { Client, TextChannel, CustomStatus, Message, MessageAttachment, ActivityOptions, MessageEmbed } from "discord.js-selfbot-v13";
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

// Create a new instance of Streamer and Youtube
const streamer = new Streamer(new Client());
const youtube = new Youtube();

// Stream options – same as before
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

// (Local videos list – used for the random command)
let videoFiles = fs.readdirSync(config.videosDir);
let videos = videoFiles.map(file => {
    const fileName = path.parse(file).name;
    return { name: fileName.replace(/ /g, '_'), path: path.join(config.videosDir, file) };
});
logger.info(`Available videos:\n${videos.map(m => m.name).join('\n')}`);

// Global stream status – reused mostly as before
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

// Global queue for links
let videoQueue: { uid: string, link: string }[] = [];

// Utility: Generate a UID (5 digits + 3 random letters)
function generateUID(): string {
    const num = Math.floor(10000 + Math.random() * 90000).toString();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randLetters = '';
    for (let i = 0; i < 3; i++) {
        randLetters += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return num + randLetters;
}

// Utility: Send an embed message
async function sendEmbed(target: Message | TextChannel, title: string, description: string, emoji: string) {
    const embed = new MessageEmbed()
        .setTitle(`${emoji} ${title}`)
        .setDescription(description)
        .setColor('#0099ff')
        .setTimestamp();
    if (target instanceof Message) {
        await target.reply({ embeds: [embed] });
    } else {
        await target.send({ embeds: [embed] });
    }
}

// When the client is ready
streamer.client.on("ready", async () => {
    if (streamer.client.user) {
        logger.info(`${streamer.client.user.tag} is ready`);
        streamer.client.user.setActivity(status_idle() as ActivityOptions);
    }
});

// (Keep voice state update listener so that streamStatus is updated)
streamer.client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.member?.user.id === streamer.client.user?.id) {
        if (oldState.channelId && !newState.channelId) {
            streamStatus.joined = false;
            streamStatus.joinsucc = false;
            streamStatus.playing = false;
            streamStatus.channelInfo = {
                guildId: config.guildId,
                channelId: config.videoChannelId,
                cmdChannelId: config.cmdChannelId
            };
            streamer.client.user?.setActivity(status_idle() as ActivityOptions);
        }
    }
    if (newState.member?.user.id === streamer.client.user?.id) {
        if (newState.channelId && !oldState.channelId) {
            streamStatus.joined = true;
            if (newState.guild.id === streamStatus.channelInfo.guildId && newState.channelId === streamStatus.channelInfo.channelId) {
                streamStatus.joinsucc = true;
            }
        }
    }
});

// ------------------
// NEW COMMAND HANDLING
// ------------------

// Listen for all messages (including those from the bot itself) that start with the prefix
streamer.client.on('messageCreate', async (message) => {
    if (!message.content.startsWith(config.prefix!)) return;

    // Remove old filtering so commands from the bot account are processed
    const args = message.content.slice(config.prefix!.length).trim().split(/ +/);
    if (args.length === 0) return;
    const commandName = args.shift()!.toLowerCase();

    switch (commandName) {
        case 'add': {
            // Usage: <prefix>add <video_link>
            const link = args[0];
            if (!link) {
                await sendEmbed(message, "Error", "Please provide a video link.", "❌");
                return;
            }
            const uid = generateUID();
            videoQueue.push({ uid, link });
            await sendEmbed(message, "Video Added", `UID: \`${uid}\`\nLink: ${link}`, "✅");
            // If nothing is playing, start processing the queue immediately.
            if (!streamStatus.playing) {
                processQueue();
            }
            break;
        }
        case 'list': {
            // Show the current queue status
            if (videoQueue.length === 0) {
                await sendEmbed(message, "Queue Status", "The queue is empty.", "ℹ️");
            } else {
                const listStr = videoQueue
                    .map(item => `• \`${item.uid}\`: ${item.link}`)
                    .join("\n");
                await sendEmbed(message, "Queue Status", listStr, "📋");
            }
            break;
        }
        case 'remove': {
            // Usage: <prefix>remove <uid>
            const uid = args[0];
            if (!uid) {
                await sendEmbed(message, "Error", "Please provide the UID of the video to remove.", "❌");
                return;
            }
            const index = videoQueue.findIndex(item => item.uid === uid);
            if (index === -1) {
                await sendEmbed(message, "Error", `No video found with UID \`${uid}\`.`, "❌");
            } else {
                const removed = videoQueue.splice(index, 1)[0];
                await sendEmbed(message, "Video Removed", `Removed video with UID \`${removed.uid}\` and link:\n${removed.link}`, "✅");
            }
            break;
        }
        case 'random': {
            // Play a random video from the local videos folder immediately
            videoFiles = fs.readdirSync(config.videosDir);
            if (videoFiles.length === 0) {
                await sendEmbed(message, "Error", "No videos found in the local videos folder.", "❌");
                return;
            }
            const randomIndex = Math.floor(Math.random() * videoFiles.length);
            const file = videoFiles[randomIndex];
            const filePath = path.join(config.videosDir, file);
            await sendEmbed(message, "Now Playing", `Playing random video: \`${file}\``, "▶️");
            // Join and create a stream
            await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
            const udpConn = await streamer.createStream(streamOpts);
            streamStatus.joined = true;
            streamStatus.playing = true;
            playVideo(filePath, udpConn, file);
            break;
        }
        case 'download': {
            // Usage: <prefix>download <video_link>
            const link = args[0];
            if (!link) {
                await sendEmbed(message, "Error", "Please provide a video link to download.", "❌");
                return;
            }
            // Start the download in background
            downloadVideo(link, message.channel as TextChannel);
            await sendEmbed(message, "Download Started", `Downloading video from: ${link}`, "⏬");
            break;
        }
        case 'help': {
            const helpText = [
                '📽 **Available Commands**',
                '',
                `\`${config.prefix}add <link>\` – Add a video link to the queue.`,
                `\`${config.prefix}list\` – Show the current queue (with UID for each item).`,
                `\`${config.prefix}remove <uid>\` – Remove a video from the queue by UID.`,
                `\`${config.prefix}random\` – Play a random video from the local videos folder.`,
                `\`${config.prefix}download <link>\` – Download a video to the videos folder in the background.`,
                `\`${config.prefix}help\` – Show this help message.`
            ].join('\n');
            await sendEmbed(message, "Help", helpText, "📋");
            break;
        }
        default: {
            await sendEmbed(message, "Error", "Invalid command. Use the `help` command to see the list of available commands.", "❌");
            break;
        }
    }
});

// ------------------
// QUEUE & PLAYBACK FUNCTIONS
// ------------------

let command: PCancelable<string> | undefined;

// This function checks the queue and starts playing the next video if available
async function processQueue() {
    if (videoQueue.length > 0) {
        const next = videoQueue.shift()!;
        // Ensure we are joined
        if (!streamStatus.joined) {
            await streamer.joinVoice(config.guildId, config.videoChannelId, streamOpts);
        }
        const udpConn = await streamer.createStream(streamOpts);
        streamStatus.joined = true;
        streamStatus.playing = true;
        await playLink(next.link, udpConn, `Queue item [${next.uid}]`);
    } else {
        await cleanupStreamStatus();
    }
}

// Function to play a link (handles YouTube, Twitch, or fallback)
async function playLink(link: string, udpConn: MediaUdp, displayName?: string) {
    logger.info(`Started playing link: ${link}`);
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);
    try {
        if (ytdl.validateURL(link)) {
            const [videoInfo, yturl] = await Promise.all([
                ytdl.getInfo(link),
                getVideoUrl(link).catch(error => {
                    logger.error("Error getting YouTube URL:", error);
                    return null;
                })
            ]);
            if (yturl) {
                if (!displayName) displayName = videoInfo.videoDetails.title;
                await sendEmbed(getCommandChannel(), "Now Playing", `Playing: ${displayName}`, "▶️");
                command = PCancelable.fn<string, string>(() => streamLivestreamVideo(yturl, udpConn))(yturl);
            }
        } else if (link.includes('twitch.tv')) {
            const twitchId = link.split('/').pop() as string;
            const twitchUrl = await getTwitchStreamUrl(link);
            if (twitchUrl) {
                if (!displayName) displayName = `${twitchId}'s Twitch Stream`;
                await sendEmbed(getCommandChannel(), "Now Playing", `Playing: ${displayName}`, "▶️");
                command = PCancelable.fn<string, string>(() => streamLivestreamVideo(twitchUrl, udpConn))(twitchUrl);
            }
        } else {
            if (!displayName) displayName = "URL";
            await sendEmbed(getCommandChannel(), "Now Playing", `Playing: ${displayName}`, "▶️");
            command = PCancelable.fn<string, string>(() => streamLivestreamVideo(link, udpConn))(link);
        }
        const res = await command;
        logger.info(`Finished playing link: ${res}`);
    } catch (error) {
        if (!(error instanceof CancelError)) {
            logger.error("Error occurred while playing link:", error);
        }
    } finally {
        udpConn.mediaConnection.setSpeaking(false);
        udpConn.mediaConnection.setVideoStatus(false);
        await sendEmbed(getCommandChannel(), "Finished", "Finished playing video.", "⏹️");
        await processQueue();
    }
}

// Function to play a local video file (modified to process the queue after finishing)
async function playVideo(video: string, udpConn: MediaUdp, title?: string) {
    logger.info("Started playing video");
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);
    try {
        if (title) {
            await sendEmbed(getCommandChannel(), "Now Playing", `Playing: ${title}`, "▶️");
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
        await sendEmbed(getCommandChannel(), "Finished", "Finished playing video.", "⏹️");
        await processQueue();
    }
}

// Helper to get the command channel (assumes the first channel in config.cmdChannelId)
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
        // Remove illegal characters from title
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        const fileName = `${title}_${Date.now()}.mp4`;
        const filePath = path.join(config.videosDir, fileName);
        const videoStream = ytdl(link, { quality: 'highest' });
        const writeStream = fs.createWriteStream(filePath);
        videoStream.pipe(writeStream);
        writeStream.on('finish', async () => {
            await sendEmbed(channel, "Download Complete", `Video downloaded as: \`${fileName}\``, "✅");
        });
        writeStream.on('error', async (err) => {
            await sendEmbed(channel, "Download Error", `Error downloading video: ${err}`, "❌");
        });
    } catch (error) {
        await sendEmbed(channel, "Download Error", "Failed to download video.", "❌");
    }
}

// ------------------
// UTILITY FUNCTIONS FOR LINKS (from your original code)
// ------------------

async function getTwitchStreamUrl(url: string): Promise<string | null> {
    try {
        if (url.includes('/videos/')) {
            const vodId = url.split('/videos/').pop() as string;
            const vodInfo = await getVod(vodId);
            const vod = vodInfo.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || vodInfo[0];
            if (vod?.url) {
                return vod.url;
            }
            logger.error("No VOD URL found");
            return null;
        } else {
            const twitchId = url.split('/').pop() as string;
            const streams = await getStream(twitchId);
            const stream = streams.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || streams[0];
            if (stream?.url) {
                return stream.url;
            }
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
// STATUS FUNCTIONS (unchanged mostly)
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
    streamStatus.channelInfo = {
        guildId: "",
        channelId: "",
        cmdChannelId: "",
    };
}

// ------------------
// OPTIONAL: Run server if enabled in config
// ------------------

if (config.server_enabled) {
    import('./server.js');
}

// ------------------
// Login to Discord
// ------------------
streamer.client.login(config.token);

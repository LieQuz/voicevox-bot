import "dotenv/config";
import {
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Message,
  VoiceBasedChannel
} from "discord.js";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX ?? "!";
const voicevoxBaseUrl = process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021";
const defaultSpeaker = Number.parseInt(process.env.DEFAULT_SPEAKER ?? "1", 10);
const defaultSpeedScale = Number.parseFloat(process.env.DEFAULT_SPEED_SCALE ?? "1.2");

if (!token) {
  throw new Error("DISCORD_TOKEN is not set.");
}

if (Number.isNaN(defaultSpeaker)) {
  throw new Error("DEFAULT_SPEAKER must be a number.");
}

if (Number.isNaN(defaultSpeedScale) || defaultSpeedScale <= 0) {
  throw new Error("DEFAULT_SPEED_SCALE must be a positive number.");
}

type VoicevoxAudioQuery = {
  speedScale: number;
  [key: string]: unknown;
};

type VoicevoxSpeaker = {
  name: string;
  styles: Array<{
    id: number;
    name: string;
  }>;
};

type QueueItem = {
  text: string;
};

type GuildState = {
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: QueueItem[];
  processing: boolean;
  speaker: number;
  textChannelId: string;
  currentTempFile?: string;
};

const guildStates = new Map<string, GuildState>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) {
    return;
  }

  if (message.content.startsWith(prefix)) {
    await handleCommand(message);
    return;
  }

  const state = guildStates.get(message.guild.id);
  if (!state || message.channel.id !== state.textChannelId) {
    return;
  }

  const text = normalizeForSpeech(message.content);
  if (!text) {
    return;
  }

  state.queue.push({
    text
  });

  await processQueue(message.guild.id);
});

async function handleCommand(message: Message): Promise<void> {
  const [rawCommand, ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();

  if (!command) {
    return;
  }

  if (command === "join") {
    await joinCommand(message);
    return;
  }

  if (command === "leave") {
    await leaveCommand(message);
    return;
  }

  if (command === "speaker") {
    const speaker = Number.parseInt(rest[0] ?? "", 10);
    if (Number.isNaN(speaker) || speaker <= 0) {
      await message.reply("`!speaker <number>` で話者IDを指定してください。");
      return;
    }

    const state = guildStates.get(message.guild!.id);
    if (!state) {
      await message.reply("先に `!join` してください。");
      return;
    }

    state.speaker = speaker;
    await message.reply(`話者IDを ${speaker} に変更しました。`);
    return;
  }

  if (command === "help") {
    let speakerLines: string[];
    try {
      speakerLines = await fetchSpeakerListForHelp();
    } catch (error) {
      console.error("Failed to fetch speaker list:", error);
      speakerLines = ["- 話者一覧の取得に失敗しました（VOICEVOX接続を確認してください）"];
    }

    const helpText = [
      "コマンド一覧:",
      `- \`${prefix}join\` : 自分がいるVCにBotを参加`,
      `- \`${prefix}leave\` : BotをVCから退出`,
      `- \`${prefix}speaker <number>\` : VOICEVOXの話者IDを変更`,
      "",
      "話者ID一覧:",
      ...speakerLines
    ].join("\n");

    await message.reply(
      helpText.length > 1800 ? `${helpText.slice(0, 1790)}\n...（省略）` : helpText
    );
  }
}

async function joinCommand(message: Message): Promise<void> {
  const voiceChannel = message.member?.voice.channel;
  if (!voiceChannel || !isJoinableVoiceChannel(voiceChannel)) {
    await message.reply("先にあなたがボイスチャンネルへ参加してください。");
    return;
  }

  const existing = guildStates.get(message.guild!.id);
  if (existing) {
    existing.textChannelId = message.channel.id;
    await message.reply("すでに接続中です。読み上げ対象テキストチャンネルを更新しました。");
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const player = createAudioPlayer();
  connection.subscribe(player);

  guildStates.set(message.guild!.id, {
    connection,
    player,
    queue: [],
    processing: false,
    speaker: defaultSpeaker,
    textChannelId: message.channel.id
  });

  await message.reply("VCへ参加しました。このチャンネルのメッセージを読み上げます。");
}

async function leaveCommand(message: Message): Promise<void> {
  const state = guildStates.get(message.guild!.id);
  if (!state) {
    await message.reply("接続していません。");
    return;
  }

  state.queue.length = 0;
  state.connection.destroy();
  guildStates.delete(message.guild!.id);
  await cleanupTempFile(state.currentTempFile);
  await message.reply("VCから退出しました。");
}

async function processQueue(guildId: string): Promise<void> {
  const state = guildStates.get(guildId);
  if (!state || state.processing) {
    return;
  }

  const next = state.queue.shift();
  if (!next) {
    return;
  }

  state.processing = true;

  try {
    const wav = await synthesizeVoice(next.text, state.speaker);
    const filePath = await saveTempWav(wav);
    state.currentTempFile = filePath;

    const resource = createAudioResource(filePath);
    state.player.play(resource);
    await entersState(state.player, AudioPlayerStatus.Playing, 10_000);

    await new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        state.player.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        state.player.off(AudioPlayerStatus.Idle, onIdle);
        reject(error);
      };

      state.player.once(AudioPlayerStatus.Idle, onIdle);
      state.player.once("error", onError);
    });
  } catch (error) {
    console.error("Failed to process queue item:", error);
  } finally {
    await cleanupTempFile(state.currentTempFile);
    state.currentTempFile = undefined;
    state.processing = false;
    await processQueue(guildId);
  }
}

async function synthesizeVoice(text: string, speaker: number): Promise<Buffer> {
  const params = new URLSearchParams({
    text,
    speaker: String(speaker)
  });

  const queryResponse = await fetch(`${voicevoxBaseUrl}/audio_query?${params.toString()}`, {
    method: "POST"
  });

  if (!queryResponse.ok) {
    throw new Error(`VOICEVOX audio_query failed: ${queryResponse.status} ${queryResponse.statusText}`);
  }

  const audioQuery = (await queryResponse.json()) as VoicevoxAudioQuery;
  audioQuery.speedScale = defaultSpeedScale;

  const synthesisResponse = await fetch(`${voicevoxBaseUrl}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(audioQuery)
  });

  if (!synthesisResponse.ok) {
    throw new Error(`VOICEVOX synthesis failed: ${synthesisResponse.status} ${synthesisResponse.statusText}`);
  }

  const audioBuffer = await synthesisResponse.arrayBuffer();
  return Buffer.from(audioBuffer);
}

async function fetchSpeakerListForHelp(): Promise<string[]> {
  const response = await fetch(`${voicevoxBaseUrl}/speakers`);
  if (!response.ok) {
    throw new Error(`VOICEVOX speakers failed: ${response.status} ${response.statusText}`);
  }

  const speakers = (await response.json()) as VoicevoxSpeaker[];
  const lines = speakers.flatMap((speaker) =>
    speaker.styles.map((style) => `- ${style.id}: ${speaker.name}（${style.name}）`)
  );

  return lines.length > 0 ? lines : ["- 話者一覧が空です"];
}

async function saveTempWav(audio: Buffer): Promise<string> {
  const tempDir = join(tmpdir(), "voicevox-bot");
  await mkdir(tempDir, { recursive: true });

  const filePath = join(tempDir, `${randomUUID()}.wav`);
  await writeFile(filePath, audio);
  return filePath;
}

async function cleanupTempFile(filePath?: string): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    await unlink(filePath);
  } catch (error) {
    console.error(`Failed to remove temp file ${filePath}:`, error);
  }
}

function normalizeForSpeech(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const withoutUrls = trimmed.replace(/https?:\/\/\S+/g, "URL");
  return withoutUrls.slice(0, 120);
}

function isJoinableVoiceChannel(channel: VoiceBasedChannel): boolean {
  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

client.login(token).catch((error) => {
  console.error("Failed to login Discord client:", error);
  process.exit(1);
});

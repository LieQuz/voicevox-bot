import "dotenv/config";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
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
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  VoiceBasedChannel
} from "discord.js";
import nodeEmoji = require("node-emoji");
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.DISCORD_TOKEN;
const commandGuildId = process.env.DISCORD_GUILD_ID;
const voicevoxBaseUrl = process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021";
const defaultSpeaker = Number.parseInt(process.env.DEFAULT_SPEAKER ?? "1", 10);
const defaultSpeedScale = Number.parseFloat(process.env.DEFAULT_SPEED_SCALE ?? "1.2");
const speakerCacheTtlMs = Number.parseInt(process.env.SPEAKER_CACHE_TTL_MS ?? "300000", 10);

if (!token) {
  throw new Error("DISCORD_TOKEN is not set.");
}

if (Number.isNaN(defaultSpeaker)) {
  throw new Error("DEFAULT_SPEAKER must be a number.");
}

if (Number.isNaN(defaultSpeedScale) || defaultSpeedScale <= 0) {
  throw new Error("DEFAULT_SPEED_SCALE must be a positive number.");
}

if (Number.isNaN(speakerCacheTtlMs) || speakerCacheTtlMs < 0) {
  throw new Error("SPEAKER_CACHE_TTL_MS must be zero or a positive number.");
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
  speaker: number;
};

type SpeakerSelectOption = {
  value: string;
  label: string;
  description: string;
};

type PronunciationRule = {
  pattern: string;
  replacement: string;
};

type GuildState = {
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: QueueItem[];
  processing: boolean;
  speaker: number;
  textChannelId: string;
  voiceChannelId: string;
  currentTempFile?: string;
};

const guildStates = new Map<string, GuildState>();
let db: Database;
let cachedSpeakers: VoicevoxSpeaker[] | null = null;
let speakersCachedAt = 0;
let speakerFetchInFlight: Promise<VoicevoxSpeaker[]> | null = null;
const pronunciationRuleCache = new Map<string, PronunciationRule[]>();
const speakerSelectPageSize = 25;
const speakerSelectIdPrefix = "speaker-select";
const speakerSelectPageIdPrefix = "speaker-select-page";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

const slashCommands = [
  new SlashCommandBuilder().setName("join").setDescription("自分がいるVCにBotを参加させます"),
  new SlashCommandBuilder().setName("leave").setDescription("BotをVCから退出させます"),
  new SlashCommandBuilder().setName("speaker").setDescription("プルダウンで話者を選択します"),
  new SlashCommandBuilder()
    .setName("dict")
    .setDescription("読み替え辞書を管理します")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("読み替え辞書を追加または更新")
        .addStringOption((option) => option.setName("from").setDescription("置換元").setRequired(true))
        .addStringOption((option) => option.setName("to").setDescription("置換先").setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("読み替え辞書を削除")
        .addStringOption((option) => option.setName("from").setDescription("削除する置換元").setRequired(true))
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("読み替え辞書の一覧を表示")),
  new SlashCommandBuilder().setName("help").setDescription("使い方と主要話者一覧を表示します"),
  new SlashCommandBuilder().setName("speakers").setDescription("話者一覧を表示します")
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  client.user?.setActivity("/help | /join | /speaker | /dict", {
    type: ActivityType.Listening
  });

  if (commandGuildId) {
    const guild = await client.guilds.fetch(commandGuildId);
    await guild.commands.set(slashCommands);
    console.log(`Registered slash commands for guild ${guild.id} (${guild.name})`);
    return;
  }

  await client.application?.commands.set(slashCommands);
  console.log("Registered global slash commands");
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) {
    return;
  }

  const state = guildStates.get(message.guild.id);
  if (!state || message.channel.id !== state.textChannelId) {
    return;
  }

  if (message.content.trim().toLowerCase() === "s") {
    state.queue.length = 0;
    state.player.stop(true);
    return;
  }

  const text = await normalizeForSpeech(message.guild.id, message.content, message, message.attachments.size > 0);
  if (!text) {
    return;
  }

  const speaker = (await getUserSpeaker(message.guild.id, message.author.id)) ?? state.speaker;

  state.queue.push({
    text,
    speaker
  });

  await processQueue(message.guild.id);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${speakerSelectIdPrefix}:`)) {
    const parsed = parseSpeakerComponentId(interaction.customId, speakerSelectIdPrefix);
    if (!interaction.guild || !parsed) {
      return;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({ content: "このプルダウンはコマンド実行者のみ操作できます。", ephemeral: true });
      return;
    }

    const speaker = Number.parseInt(interaction.values[0] ?? "", 10);
    if (Number.isNaN(speaker) || speaker <= 0) {
      await interaction.reply({ content: "話者IDの読み取りに失敗しました。", ephemeral: true });
      return;
    }

    await setUserSpeaker(interaction.guild.id, interaction.user.id, speaker);
    await interaction.update({
      content: `あなたの話者IDを ${speaker} に保存しました。`,
      components: []
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith(`${speakerSelectPageIdPrefix}:`)) {
    const parsed = parseSpeakerComponentId(interaction.customId, speakerSelectPageIdPrefix);
    if (!interaction.guild || !parsed) {
      return;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({ content: "このプルダウンはコマンド実行者のみ操作できます。", ephemeral: true });
      return;
    }

    const options = await fetchSpeakerSelectOptions();
    const maxPage = Math.max(Math.ceil(options.length / speakerSelectPageSize) - 1, 0);
    const page = Math.min(Math.max(parsed.page, 0), maxPage);
    const components = buildSpeakerPickerComponents(options, interaction.user.id, page);
    await interaction.update({
      content: "プルダウンから話者を選んでください。",
      components
    });
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.guild) {
    return;
  }

  if (interaction.commandName === "join") {
    await joinCommand(interaction);
    return;
  }

  if (interaction.commandName === "leave") {
    await leaveCommand(interaction);
    return;
  }

  if (interaction.commandName === "speaker") {
    let options: SpeakerSelectOption[];
    try {
      options = await fetchSpeakerSelectOptions();
    } catch (error) {
      console.error("Failed to fetch speaker list:", error);
      await replyPrivate(interaction, "話者一覧の取得に失敗しました（VOICEVOX接続を確認してください）。");
      return;
    }

    if (options.length === 0) {
      await replyPrivate(interaction, "話者一覧が空です。");
      return;
    }

    const components = buildSpeakerPickerComponents(options, interaction.user.id, 0);
    await interaction.reply({
      content: "プルダウンから話者を選んでください。",
      components,
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "dict") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "add") {
      const from = interaction.options.getString("from", true).trim();
      const to = interaction.options.getString("to", true).trim();
      if (!from || !to) {
        await replyPrivate(interaction, "`from` と `to` は空文字にできません。");
        return;
      }

      await upsertPronunciationRule(interaction.guild.id, from, to);
      await replyPrivate(interaction, `辞書を保存しました: \`${from}\` → \`${to}\``);
      return;
    }

    if (subcommand === "remove") {
      const from = interaction.options.getString("from", true).trim();
      if (!from) {
        await replyPrivate(interaction, "`from` は空文字にできません。");
        return;
      }

      const removed = await removePronunciationRule(interaction.guild.id, from);
      await replyPrivate(
        interaction,
        removed ? `辞書から削除しました: \`${from}\`` : `辞書に見つかりませんでした: \`${from}\``
      );
      return;
    }

    if (subcommand === "list") {
      const rules = await listPronunciationRules(interaction.guild.id);
      if (rules.length === 0) {
        await replyPrivate(interaction, "読み替え辞書はまだ登録されていません。");
        return;
      }

      const lines = rules.map((rule) => `- ${rule.pattern} -> ${rule.replacement}`);
      await replyInChunks(interaction, "読み替え辞書一覧:", lines);
      return;
    }
  }

  if (interaction.commandName === "help") {
    let speakerLines: string[];
    try {
      speakerLines = await fetchSpeakerSummaryLines(8);
    } catch (error) {
      console.error("Failed to fetch speaker list:", error);
      speakerLines = ["- 話者一覧の取得に失敗しました（VOICEVOX接続を確認してください）"];
    }

    const helpText = [
      "コマンド一覧:",
      "- `/join` : 自分がいるVCにBotを参加",
      "- `/leave` : BotをVCから退出",
      "- `/speaker` : プルダウンであなたの話者IDを保存",
      "- `/dict` : 読み替え辞書を管理（管理者向け）",
      "- `/speakers` : 話者一覧を見やすく表示",
      "",
      "操作の流れ:",
      "1) `/join` でVC参加",
      "2) `/speaker` でプルダウンから自分の話者を設定",
      "3) テキストを送信すると読み上げ",
      "",
      "話者ID一覧（先頭8件）:",
      ...speakerLines
    ].join("\n");

    await replyPrivate(interaction, helpText.length > 1800 ? `${helpText.slice(0, 1790)}\n...（省略）` : helpText);
    return;
  }

  if (interaction.commandName === "speakers") {
    let lines: string[];
    try {
      lines = await fetchSpeakerDetailedLines();
    } catch (error) {
      console.error("Failed to fetch speaker list:", error);
      await replyPrivate(interaction, "話者一覧の取得に失敗しました（VOICEVOX接続を確認してください）。");
      return;
    }

    await replyInChunks(interaction, "話者ID一覧（キャラクターごと）:", lines, true);
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild.id;
  const state = guildStates.get(guildId);
  if (!state) {
    return;
  }

  const botUserId = client.user?.id;
  const botWasInManagedChannel = oldState.id === botUserId && oldState.channelId === state.voiceChannelId;
  const botLeftManagedChannel = newState.channelId !== state.voiceChannelId;
  if (botWasInManagedChannel && botLeftManagedChannel) {
    await disconnectGuildInternal(guildId, true);
    await notifyTextChannel(state.textChannelId, "⚠️ 右クリック等で強制切断されたため、読み上げを停止しました。");
    return;
  }

  const changedVoiceState =
    oldState.channelId === state.voiceChannelId || newState.channelId === state.voiceChannelId;
  if (!changedVoiceState) {
    return;
  }

  const voiceChannel = newState.guild.channels.cache.get(state.voiceChannelId);
  if (!voiceChannel) {
    return;
  }

  if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
    return;
  }

  const joinedManagedChannel =
    oldState.channelId !== state.voiceChannelId && newState.channelId === state.voiceChannelId;
  if (joinedManagedChannel && newState.member && !newState.member.user.bot) {
    const joinSpeaker = (await getUserSpeaker(guildId, newState.member.id)) ?? state.speaker;
    state.queue.push({
      text: `${newState.member.displayName}が参加しました`,
      speaker: joinSpeaker
    });
    await processQueue(guildId);
  }

  const leftManagedChannel = oldState.channelId === state.voiceChannelId && newState.channelId !== state.voiceChannelId;
  if (leftManagedChannel && oldState.member && !oldState.member.user.bot) {
    const leaveSpeaker = (await getUserSpeaker(guildId, oldState.member.id)) ?? state.speaker;
    state.queue.push({
      text: `${oldState.member.displayName}が退出しました`,
      speaker: leaveSpeaker
    });
    await processQueue(guildId);
  }

  const humanMemberCount = [...voiceChannel.members.values()].filter((member) => !member.user.bot).length;
  if (humanMemberCount === 0) {
    await disconnectGuild(guildId);
  }
});

async function joinCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || !isJoinableVoiceChannel(voiceChannel)) {
    await replyPrivate(interaction, "先にあなたがボイスチャンネルへ参加してください。");
    return;
  }

  const existing = guildStates.get(interaction.guild!.id);
  if (existing) {
    const existingStatus = existing.connection.state.status;
    if (
      existingStatus === VoiceConnectionStatus.Destroyed ||
      existingStatus === VoiceConnectionStatus.Disconnected
    ) {
      await disconnectGuildInternal(interaction.guild!.id, false);
    } else {
      existing.textChannelId = interaction.channelId;
      await replyPrivate(interaction, "すでに接続中です。読み上げ対象テキストチャンネルを更新しました。");
      return;
    }
  }

  const refreshedState = guildStates.get(interaction.guild!.id);
  if (refreshedState) {
    refreshedState.textChannelId = interaction.channelId;
    await replyPrivate(interaction, "すでに接続中です。読み上げ対象テキストチャンネルを更新しました。");
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

  guildStates.set(interaction.guild!.id, {
    connection,
    player,
    queue: [],
    processing: false,
    speaker: defaultSpeaker,
    textChannelId: interaction.channelId,
    voiceChannelId: voiceChannel.id
  });

  await replyPrivate(interaction, "VCへ参加しました。このチャンネルのメッセージを読み上げます。");
}

async function leaveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!guildStates.has(interaction.guild!.id)) {
    await replyPrivate(interaction, "接続していません。");
    return;
  }

  await disconnectGuild(interaction.guild!.id);
  await replyPrivate(interaction, "VCから退出しました。");
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
    const wav = await synthesizeVoice(next.text, next.speaker);
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

async function fetchVoicevoxSpeakers(): Promise<VoicevoxSpeaker[]> {
  const now = Date.now();
  const isCacheValid = cachedSpeakers !== null && now - speakersCachedAt < speakerCacheTtlMs;
  if (isCacheValid && cachedSpeakers) {
    return cachedSpeakers;
  }

  if (!speakerFetchInFlight) {
    speakerFetchInFlight = (async () => {
      const response = await fetch(`${voicevoxBaseUrl}/speakers`);
      if (!response.ok) {
        throw new Error(`VOICEVOX speakers failed: ${response.status} ${response.statusText}`);
      }

      const speakers = (await response.json()) as VoicevoxSpeaker[];
      cachedSpeakers = speakers;
      speakersCachedAt = Date.now();
      return speakers;
    })();
  }

  try {
    return await speakerFetchInFlight;
  } finally {
    speakerFetchInFlight = null;
  }
}

async function fetchSpeakerSummaryLines(limit?: number): Promise<string[]> {
  const speakers = await fetchVoicevoxSpeakers();
  const lines = speakers.map((speaker) => {
    const styles = speaker.styles.map((style) => `${style.id}:${style.name}`).join(", ");
    return `- ${speaker.name}: ${styles}`;
  });

  if (lines.length === 0) {
    return ["- 話者一覧が空です"];
  }

  if (!limit) {
    return lines;
  }

  return lines.slice(0, limit);
}

async function fetchSpeakerSelectOptions(): Promise<SpeakerSelectOption[]> {
  const speakers = await fetchVoicevoxSpeakers();
  const options: SpeakerSelectOption[] = [];

  for (const speaker of speakers) {
    for (const style of speaker.styles) {
      const label = `${speaker.name} / ${style.name}`.slice(0, 100);
      const description = `話者ID: ${style.id}`.slice(0, 100);
      options.push({
        value: String(style.id),
        label,
        description
      });
    }
  }

  return options;
}

function buildSpeakerPickerComponents(
  options: SpeakerSelectOption[],
  userId: string,
  page: number
): Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> {
  const maxPage = Math.max(Math.ceil(options.length / speakerSelectPageSize) - 1, 0);
  const currentPage = Math.min(Math.max(page, 0), maxPage);
  const start = currentPage * speakerSelectPageSize;
  const pageOptions = options.slice(start, start + speakerSelectPageSize);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${speakerSelectIdPrefix}:${userId}:${currentPage}`)
    .setPlaceholder(`話者を選択 (${currentPage + 1}/${maxPage + 1})`)
    .addOptions(pageOptions);

  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
  ];

  if (maxPage > 0) {
    const prevButton = new ButtonBuilder()
      .setCustomId(`${speakerSelectPageIdPrefix}:${userId}:${currentPage - 1}`)
      .setLabel("前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0);

    const nextButton = new ButtonBuilder()
      .setCustomId(`${speakerSelectPageIdPrefix}:${userId}:${currentPage + 1}`)
      .setLabel("次へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= maxPage);

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton));
  }

  return rows;
}

function parseSpeakerComponentId(
  customId: string,
  prefix: string
): { userId: string; page: number } | undefined {
  const [parsedPrefix, userId, pageText] = customId.split(":");
  if (parsedPrefix !== prefix || !userId || !pageText) {
    return undefined;
  }

  const page = Number.parseInt(pageText, 10);
  if (Number.isNaN(page)) {
    return undefined;
  }

  return { userId, page };
}

async function fetchSpeakerDetailedLines(): Promise<string[]> {
  const speakers = await fetchVoicevoxSpeakers();
  if (speakers.length === 0) {
    return ["- 話者一覧が空です"];
  }

  const lines: string[] = [];
  for (const speaker of speakers) {
    lines.push(`【${speaker.name}】`);
    for (const style of speaker.styles) {
      lines.push(`- ${style.id}: ${style.name}`);
    }
    lines.push("");
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

async function replyInChunks(
  interaction: ChatInputCommandInteraction,
  title: string,
  lines: string[],
  includeSpeakerTotals = false
): Promise<void> {
  const splitLine = (line: string, limit: number): string[] => {
    if (line.length <= limit) {
      return [line];
    }

    const parts: string[] = [];
    let start = 0;
    while (start < line.length) {
      parts.push(line.slice(start, start + limit));
      start += limit;
    }
    return parts;
  };

  let chunk = `${title}\n`;
  for (const line of lines) {
    const parts = splitLine(line, 1700);
    for (const part of parts) {
      const candidate = `${chunk}${part}\n`;
      if (candidate.length > 1800) {
        await replyPrivate(interaction, chunk.trimEnd());
        chunk = `${part}\n`;
        continue;
      }

      chunk = candidate;
    }
  }

  if (chunk.trim().length > 0) {
    await replyPrivate(interaction, chunk.trimEnd());
  }

  if (includeSpeakerTotals) {
    const totalCharacters = lines.filter((line) => line.startsWith("【")).length;
    const totalStyles = lines.filter((line) => /^- \d+:/.test(line)).length;
    await replyPrivate(interaction, `合計 ${totalCharacters} キャラクター / ${totalStyles} スタイル`);
  }
}

async function initDatabase(): Promise<void> {
  const dataDir = join(process.cwd(), "data");
  await mkdir(dataDir, { recursive: true });

  db = await open({
    filename: join(dataDir, "voicevox-bot.sqlite3"),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_speakers (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      speaker INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS pronunciation_rules (
      guild_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      replacement TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, pattern)
    );
  `);
}

async function setUserSpeaker(guildId: string, userId: string, speaker: number): Promise<void> {
  await db.run(
    `
      INSERT INTO user_speakers (guild_id, user_id, speaker)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id)
      DO UPDATE SET speaker = excluded.speaker, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    userId,
    speaker
  );
}

async function getUserSpeaker(guildId: string, userId: string): Promise<number | undefined> {
  const row = await db.get<{ speaker: number }>(
    `
      SELECT speaker
      FROM user_speakers
      WHERE guild_id = ? AND user_id = ?;
    `,
    guildId,
    userId
  );
  return row?.speaker;
}

async function getPronunciationRules(guildId: string): Promise<PronunciationRule[]> {
  const cached = pronunciationRuleCache.get(guildId);
  if (cached) {
    return cached;
  }

  const rows = await db.all<PronunciationRule[]>(
    `
      SELECT pattern, replacement
      FROM pronunciation_rules
      WHERE guild_id = ?
      ORDER BY LENGTH(pattern) DESC, pattern ASC;
    `,
    guildId
  );
  pronunciationRuleCache.set(guildId, rows);
  return rows;
}

async function upsertPronunciationRule(guildId: string, pattern: string, replacement: string): Promise<void> {
  await db.run(
    `
      INSERT INTO pronunciation_rules (guild_id, pattern, replacement)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, pattern)
      DO UPDATE SET replacement = excluded.replacement, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    pattern,
    replacement
  );
  pronunciationRuleCache.delete(guildId);
}

async function removePronunciationRule(guildId: string, pattern: string): Promise<boolean> {
  const result = await db.run(
    `
      DELETE FROM pronunciation_rules
      WHERE guild_id = ? AND pattern = ?;
    `,
    guildId,
    pattern
  );
  pronunciationRuleCache.delete(guildId);
  return (result.changes ?? 0) > 0;
}

async function listPronunciationRules(guildId: string): Promise<PronunciationRule[]> {
  return getPronunciationRules(guildId);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPronunciationRules(text: string, rules: PronunciationRule[]): string {
  let output = text;
  for (const rule of rules) {
    if (!rule.pattern) {
      continue;
    }
    output = output.replace(new RegExp(escapeRegExp(rule.pattern), "g"), rule.replacement);
  }
  return output;
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

async function disconnectGuild(guildId: string): Promise<void> {
  await disconnectGuildInternal(guildId, true);
}

async function disconnectGuildInternal(guildId: string, destroyConnection: boolean): Promise<void> {
  const state = guildStates.get(guildId);
  if (!state) {
    return;
  }

  state.queue.length = 0;
  if (destroyConnection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    state.connection.destroy();
  }
  guildStates.delete(guildId);
  await cleanupTempFile(state.currentTempFile);
}

async function replyPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }

  await interaction.reply({ content, ephemeral: true });
}

async function notifyTextChannel(textChannelId: string, content: string): Promise<void> {
  const channel = await client.channels.fetch(textChannelId);
  if (channel?.isTextBased() && "send" in channel) {
    await channel.send(content);
  }
}

async function normalizeForSpeech(
  guildId: string,
  content: string,
  message: { mentions: { members: { get(id: string): { displayName: string } | undefined } | null } },
  hasAttachments: boolean
): Promise<string> {
  const trimmed = content.trim();
  if (!trimmed && !hasAttachments) {
    return "";
  }

  const withDisplayNames = trimmed.replace(/<@!?(\d+)>/g, (_match, userId: string) => {
    const member = message.mentions.members?.get(userId);
    return member ? member.displayName : "ユーザー";
  });

  const withLeadingAtRead = withDisplayNames.replace(/^@/, "アット ");
  const withMediaNotice =
    hasAttachments && withLeadingAtRead.length > 0
      ? `${withLeadingAtRead} メディアが投稿されました`
      : hasAttachments
        ? "メディアが投稿されました"
        : withLeadingAtRead;
  const pronunciationRules = await getPronunciationRules(guildId);
  const replacedByDictionary = applyPronunciationRules(withMediaNotice, pronunciationRules);

  const withoutUrls = replacedByDictionary.replace(/https?:\/\/\S+/g, "URL");
  const customEmojiNamed = withoutUrls.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, " $1 ");
  const unicodeEmojiNamed = nodeEmoji.unemojify(customEmojiNamed);
  const shortcodeNamed = unicodeEmojiNamed.replace(/:([a-zA-Z0-9_+-]+):/g, " $1 ");
  const laughNormalized = shortcodeNamed
    .replace(/[wｗ]{2,}/g, " わらわら ")
    .replace(/(?<=[ぁ-んァ-ヶ一-龯ー])[wｗ](?=$|[\s!！?？。、「」、,.])/g, "わら")
    .replace(/(^|[\s!！?？。、「」、,.()（）])([wｗ])(?=$|[\s!！?？。、「」、,.()（）])/g, "$1わら");
  const normalizedSpaces = laughNormalized.replace(/\s+/g, " ").trim();
  return normalizedSpaces.slice(0, 120);
}

function isJoinableVoiceChannel(channel: VoiceBasedChannel): boolean {
  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

async function main(): Promise<void> {
  await initDatabase();
  await client.login(token);
}

main().catch((error) => {
  console.error("Failed to start Discord client:", error);
  process.exit(1);
});

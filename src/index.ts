import "dotenv/config";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildBasedChannel,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  Interaction,
  VoiceState,
  VoiceBasedChannel
} from "discord.js";
import nodeEmoji = require("node-emoji");
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { replaceUnicodeEmojiWithJapanese, replaceUnknownEmojiWithFallback } from "./emoji-japanese";

const token = process.env.DISCORD_TOKEN;
const commandGuildId = process.env.DISCORD_GUILD_ID;
const voicevoxBaseUrl = process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021";
const defaultSpeaker = Number.parseInt(process.env.DEFAULT_SPEAKER ?? "1", 10);
const defaultSpeedScale = Number.parseFloat(process.env.DEFAULT_SPEED_SCALE ?? "1.2");
const speakerCacheTtlMs = Number.parseInt(process.env.SPEAKER_CACHE_TTL_MS ?? "300000", 10);
const voicevoxFetchTimeoutMs = Number.parseInt(process.env.VOICEVOX_FETCH_TIMEOUT_MS ?? "10000", 10);
const voicevoxPrewarmLimit = Number.parseInt(process.env.VOICEVOX_PREWARM_LIMIT ?? "4", 10);
const voicevoxStreamingIdleTimeoutMs = Math.max(voicevoxFetchTimeoutMs, 120_000);
const speechSilencePaddingFrames = 10;
const maxQueueSize = Number.parseInt(process.env.MAX_QUEUE_SIZE ?? "50", 10);
const rateLimitMaxMessages = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "5", 10);
const rateLimitWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "10000", 10);
const streamingSynthesisEnabled = !["false", "0", "no", "off"].includes(
  (process.env.VOICEVOX_STREAMING_SYNTHESIS ?? "true").trim().toLowerCase()
);

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

if (Number.isNaN(voicevoxFetchTimeoutMs) || voicevoxFetchTimeoutMs <= 0) {
  throw new Error("VOICEVOX_FETCH_TIMEOUT_MS must be a positive number.");
}

if (Number.isNaN(voicevoxPrewarmLimit) || voicevoxPrewarmLimit < 0) {
  throw new Error("VOICEVOX_PREWARM_LIMIT must be zero or a positive number.");
}

if (Number.isNaN(maxQueueSize) || maxQueueSize <= 0) {
  throw new Error("MAX_QUEUE_SIZE must be a positive number.");
}

if (Number.isNaN(rateLimitMaxMessages) || rateLimitMaxMessages <= 0) {
  throw new Error("RATE_LIMIT_MAX must be a positive number.");
}

if (Number.isNaN(rateLimitWindowMs) || rateLimitWindowMs <= 0) {
  throw new Error("RATE_LIMIT_WINDOW_MS must be a positive number.");
}

type VoicevoxAudioQuery = {
  speedScale: number;
  outputSamplingRate: number;
  outputStereo: boolean;
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

type SpeechAudio = {
  resource: AudioResource;
  synthesized: Promise<void>;
  dispose: () => void;
};

type PreparedSpeech = {
  item: QueueItem;
  promise: Promise<SpeechAudio>;
  abort: AbortController;
  dispose: () => void;
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
  guildId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: QueueItem[];
  processing: boolean;
  speaker: number;
  textChannelId?: string;
  voiceChannelId: string;
  prepared?: PreparedSpeech;
  activeAudio?: SpeechAudio;
  idleWaiters?: Array<() => void>;
};

const guildStates = new Map<string, GuildState>();
const autoJoinInFlight = new Map<string, Promise<void>>();
const userSpeakerCache = new Map<string, number | null>();
const initializedSpeakers = new Set<number>();
let streamingSynthesisAvailable = streamingSynthesisEnabled;
let db: Database;
let cachedSpeakers: VoicevoxSpeaker[] | null = null;
let speakersCachedAt = 0;
let speakerFetchInFlight: Promise<VoicevoxSpeaker[]> | null = null;
const pronunciationRuleCache = new Map<string, PronunciationRule[]>();
const userRateLimitTimestamps = new Map<string, number[]>();
const queueNotifyCooldownUntil = new Map<string, number>();
let shuttingDown = false;
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
  new SlashCommandBuilder()
    .setName("autojoin")
    .setDescription("ユーザーがVCへ参加したときのBot自動参加を設定します")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("自動参加を有効にするか").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("autojoin-channel")
    .setDescription("自動参加時の読み上げ対象テキストチャンネルを設定します")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("読み上げ対象にするテキストチャンネル")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("vc-notify")
    .setDescription("VC参加/退出の埋め込み通知をON/OFFします（管理者向け）")
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("通知を有効にするか").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("vc-notify-channel")
    .setDescription("VC参加/退出の埋め込み通知先テキストチャンネルを設定します（管理者向け）")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("通知を送るテキストチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    ),
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
  new SlashCommandBuilder().setName("speakers").setDescription("話者一覧を表示します"),
  new SlashCommandBuilder()
    .setName("default-speaker")
    .setDescription("サーバーの標準話者IDを設定します（管理者向け）")
    .addIntegerOption((option) =>
      option.setName("speaker").setDescription("VOICEVOXの話者スタイルID").setRequired(true).setMinValue(0)
    )
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  client.user?.setActivity("/help | /join | /speaker | /dict | /autojoin", {
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
  try {
    if (!message.guild || message.author.bot) {
      return;
    }

    const state = guildStates.get(message.guild.id);
    if (!state || message.channel.id !== state.textChannelId) {
      return;
    }

    if (message.content.trim().toLowerCase() === "s") {
      clearSpeech(state);
      return;
    }

    const hasAttachments = message.attachments.size > 0;
    const hasStickers = message.stickers.size > 0;
    const [text, speakerSetting] = await Promise.all([
      normalizeForSpeech(message.guild.id, message.content, message, hasAttachments, hasStickers),
      getUserSpeaker(message.guild.id, message.author.id)
    ]);
    if (!text || guildStates.get(message.guild.id) !== state) {
      return;
    }

    await enqueueSpeech(
      message.guild.id,
      { text, speaker: speakerSetting ?? state.speaker },
      { userId: message.author.id }
    );
  } catch (error) {
    console.error("messageCreate handler error:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
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
    if (Number.isNaN(speaker) || speaker < 0) {
      await interaction.reply({ content: "話者IDの読み取りに失敗しました。", ephemeral: true });
      return;
    }

    await setUserSpeaker(interaction.guild.id, interaction.user.id, speaker);
    void initializeSpeaker(speaker).catch((error) => {
      console.warn(`Failed to pre-warm VOICEVOX speaker ${speaker}:`, error);
    });
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

  if (interaction.commandName === "autojoin") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const enabled = interaction.options.getBoolean("enabled", true);
    await setGuildAutoJoinEnabled(interaction.guild.id, enabled);
    await replyPrivate(interaction, `VC自動参加を${enabled ? "ON" : "OFF"}にしました。`);
    return;
  }

  if (interaction.commandName === "default-speaker") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const speaker = interaction.options.getInteger("speaker", true);
    await setGuildDefaultSpeaker(interaction.guild.id, speaker);
    const state = guildStates.get(interaction.guild.id);
    if (state) {
      state.speaker = speaker;
    }
    void initializeSpeaker(speaker).catch((error) => {
      console.warn(`Failed to pre-warm VOICEVOX speaker ${speaker}:`, error);
    });
    await replyPrivate(interaction, `サーバーの標準話者IDを ${speaker} に設定しました。`);
    return;
  }

  if (interaction.commandName === "autojoin-channel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    if (channel.type !== ChannelType.GuildText) {
      await replyPrivate(interaction, "テキストチャンネルを指定してください。");
      return;
    }

    await setGuildAutoJoinTextChannel(interaction.guild.id, channel.id);
    await replyPrivate(interaction, `自動参加時の読み上げ対象を <#${channel.id}> に設定しました。`);
    return;
  }

  if (interaction.commandName === "vc-notify") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const enabled = interaction.options.getBoolean("enabled", true);
    await setGuildVcNotifyEnabled(interaction.guild.id, enabled);
    await replyPrivate(interaction, `VC参加/退出の埋め込み通知を${enabled ? "ON" : "OFF"}にしました。`);
    return;
  }

  if (interaction.commandName === "vc-notify-channel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await replyPrivate(interaction, "このコマンドはサーバー管理者（サーバー管理権限）のみ実行できます。");
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
      await replyPrivate(interaction, "テキストチャンネルを指定してください。");
      return;
    }

    await setGuildVcNotifyChannel(interaction.guild.id, channel.id);
    await replyPrivate(interaction, `VC参加/退出の通知先を <#${channel.id}> に設定しました。`);
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
      "- `/autojoin` : ユーザー参加時のVC自動参加をON/OFF（管理者向け）",
      "- `/autojoin-channel` : 自動参加時の読み上げ対象を設定（管理者向け）",
      "- `/vc-notify` : VC参加/退出の埋め込み通知をON/OFF（管理者向け）",
      "- `/vc-notify-channel` : VC参加/退出の通知先テキストチャンネルを設定（管理者向け）",
      "- `/speaker` : プルダウンであなたの話者IDを保存",
      "- `/dict` : 読み替え辞書を管理（管理者向け）",
      "- `/default-speaker` : サーバーの標準話者IDを設定（管理者向け）",
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
  } catch (error) {
    console.error("Interaction handler error:", error);
    await replyInteractionError(interaction, "処理中にエラーが発生しました。");
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
  await notifyGuildVcActivityEmbeds(oldState, newState);

  const guildId = newState.guild.id;
  const humanJoinedVoiceChannel =
    oldState.channelId !== newState.channelId &&
    newState.channelId !== null &&
    newState.member !== null &&
    !newState.member.user.bot;
  if (humanJoinedVoiceChannel && !(guildStates.has(guildId) || autoJoinInFlight.has(guildId))) {
    const autoJoinPromise = tryAutoJoinGuild(guildId, newState);
    autoJoinInFlight.set(guildId, autoJoinPromise);
    try {
      await autoJoinPromise;
    } catch (error) {
      console.error(`Failed to auto-join voice channel in guild ${guildId}:`, error);
    } finally {
      autoJoinInFlight.delete(guildId);
    }
  }

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
    const displayName = await normalizeDisplayNameForSpeech(guildId, newState.member.displayName);
    await enqueueSpeech(
      guildId,
      { text: `${displayName}が参加しました`, speaker: joinSpeaker },
      { skipRateLimit: true }
    );
  }

  const leftManagedChannel = oldState.channelId === state.voiceChannelId && newState.channelId !== state.voiceChannelId;
  if (leftManagedChannel && oldState.member && !oldState.member.user.bot) {
    const leaveSpeaker = (await getUserSpeaker(guildId, oldState.member.id)) ?? state.speaker;
    const displayName = await normalizeDisplayNameForSpeech(guildId, oldState.member.displayName);
    await enqueueSpeech(
      guildId,
      { text: `${displayName}が退出しました`, speaker: leaveSpeaker },
      { skipRateLimit: true }
    );
  }

  const humanMemberCount = [...voiceChannel.members.values()].filter((member) => !member.user.bot).length;
  if (humanMemberCount === 0) {
    // 退出アナウンスを最後まで再生してから切断する。
    await waitForQueueIdle(state, 30_000);
    await disconnectGuild(guildId);
  }
  } catch (error) {
    console.error("voiceStateUpdate handler error:", error);
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

  await interaction.deferReply({ ephemeral: true });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    connection.destroy();
    console.error("Failed to join voice channel:", error);
    await replyPrivate(interaction, "VCへの接続に失敗しました。しばらくしてから再度お試しください。");
    return;
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  const guildSpeaker = await getGuildDefaultSpeaker(interaction.guild!.id);
  guildStates.set(interaction.guild!.id, {
    guildId: interaction.guild!.id,
    connection,
    player,
    queue: [],
    processing: false,
    speaker: guildSpeaker,
    textChannelId: interaction.channelId,
    voiceChannelId: voiceChannel.id
  });

  void initializeSpeaker(guildSpeaker).catch((error) => {
    console.warn(`Failed to pre-warm VOICEVOX speaker ${guildSpeaker}:`, error);
  });

  await replyPrivate(interaction, "VCへ参加しました。このチャンネルのメッセージを読み上げます。");
}

async function tryAutoJoinGuild(guildId: string, voiceState: VoiceState): Promise<void> {
  if (!(await getGuildAutoJoinEnabled(guildId))) {
    return;
  }

  const textChannelId = await getGuildAutoJoinTextChannel(guildId);
  await autoJoinVoiceChannel(guildId, voiceState, textChannelId);
}

async function autoJoinVoiceChannel(
  guildId: string,
  voiceState: VoiceState,
  textChannelId: string | undefined
): Promise<void> {
  const voiceChannel = voiceState.channel;
  if (!voiceChannel || !isJoinableVoiceChannel(voiceChannel) || guildStates.has(guildId)) {
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    connection.destroy();
    throw error;
  }

  const player = createAudioPlayer();
  connection.subscribe(player);
  const guildSpeaker = await getGuildDefaultSpeaker(guildId);
  guildStates.set(guildId, {
    guildId,
    connection,
    player,
    queue: [],
    processing: false,
    speaker: guildSpeaker,
    textChannelId,
    voiceChannelId: voiceChannel.id
  });

  void initializeSpeaker(guildSpeaker).catch((error) => {
    console.warn(`Failed to pre-warm VOICEVOX speaker ${guildSpeaker}:`, error);
  });
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

  state.processing = true;

  try {
    while (true) {
      if (guildStates.get(guildId) !== state) {
        break;
      }

      const next = state.queue[0];
      if (!next) {
        break;
      }

      if (state.prepared && state.prepared.item !== next) {
        state.prepared.dispose();
        state.prepared = undefined;
      }

      if (!state.prepared) {
        beginPreparation(state, next);
      }

      const prepared = state.prepared!;
      let audio: SpeechAudio;
      try {
        audio = await prepared.promise;
      } catch (error) {
        if (state.prepared === prepared) {
          state.prepared = undefined;
        }
        if (state.queue[0] === next) {
          state.queue.shift();
        }
        if (!prepared.abort.signal.aborted) {
          console.error(`Failed to synthesize queue item in guild ${guildId}:`, error);
        }
        continue;
      }

      if (state.prepared === prepared) {
        state.prepared = undefined;
      }

      if (guildStates.get(guildId) !== state || state.queue[0] !== next) {
        audio.dispose();
        continue;
      }

      state.queue.shift();
      state.activeAudio = audio;

      try {
        await playSpeech(state, audio);
      } catch (error) {
        console.error(`Failed to play queue item in guild ${guildId}:`, error);
      } finally {
        if (state.activeAudio === audio) {
          state.activeAudio = undefined;
        }
        audio.dispose();
      }
    }
  } finally {
    state.processing = false;
  }

  if (guildStates.get(guildId) === state && state.queue.length > 0) {
    void processQueue(guildId);
  } else if (state.queue.length === 0) {
    notifyQueueIdle(state);
  }
}

function notifyQueueIdle(state: GuildState): void {
  if (state.processing || state.queue.length > 0) {
    return;
  }

  resolveQueueIdleWaiters(state);
}

function resolveQueueIdleWaiters(state: GuildState): void {
  const waiters = state.idleWaiters;
  if (!waiters || waiters.length === 0) {
    return;
  }

  state.idleWaiters = [];
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForQueueIdle(state: GuildState, timeoutMs: number): Promise<void> {
  if (!state.processing && state.queue.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(finish, timeoutMs);
    (state.idleWaiters ??= []).push(finish);
  });
}

function beginPreparation(state: GuildState, item: QueueItem): PreparedSpeech {
  const abort = new AbortController();
  let audio: SpeechAudio | undefined;
  let cancelled = false;

  const promise = prepareSpeechAudio(item, abort.signal).then((preparedAudio) => {
    audio = preparedAudio;
    if (cancelled) {
      preparedAudio.dispose();
    }
    return preparedAudio;
  });
  promise.catch(() => {
    // Rejections are handled by processQueue when this item is consumed.
  });

  const prepared: PreparedSpeech = {
    item,
    promise,
    abort,
    dispose: () => {
      cancelled = true;
      abort.abort();
      audio?.dispose();
    }
  };

  state.prepared = prepared;
  return prepared;
}

function prepareNext(state: GuildState): void {
  if (!state.processing || state.prepared) {
    return;
  }

  const next = state.queue[0];
  if (!next) {
    return;
  }

  beginPreparation(state, next);
}

function playSpeech(state: GuildState, audio: SpeechAudio): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      state.player.off(AudioPlayerStatus.Idle, onIdle);
      state.player.off("error", onError);
    };
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    state.player.once(AudioPlayerStatus.Idle, onIdle);
    state.player.once("error", onError);

    try {
      state.player.play(audio.resource);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // 次の発話は、現在の音声合成が終わり次第すぐに先読みを開始する。
    void audio.synthesized.then(() => {
      if (state.activeAudio === audio && guildStates.get(state.guildId) === state) {
        prepareNext(state);
      }
    });
  });
}

function clearSpeech(state: GuildState): void {
  state.queue.length = 0;
  if (state.prepared) {
    state.prepared.dispose();
    state.prepared = undefined;
  }

  const activeAudio = state.activeAudio;
  state.activeAudio = undefined;
  state.player.stop(true);
  activeAudio?.dispose();
}

async function prepareSpeechAudio(item: QueueItem, signal: AbortSignal): Promise<SpeechAudio> {
  const audioQuery = await fetchAudioQuery(item.text, item.speaker, signal);

  if (streamingSynthesisAvailable) {
    try {
      return await prepareStreamingSpeech(audioQuery, item.speaker, signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (!(error instanceof StreamingSynthesisUnsupportedError)) {
        throw error;
      }

      streamingSynthesisAvailable = false;
      console.warn(
        "VOICEVOX streaming synthesis is not available. Falling back to /synthesis.",
        error
      );
    }
  }

  return prepareBufferedSpeech(audioQuery, item.speaker, signal);
}

async function fetchAudioQuery(
  text: string,
  speaker: number,
  signal: AbortSignal
): Promise<VoicevoxAudioQuery> {
  const params = new URLSearchParams({
    text,
    speaker: String(speaker)
  });

  const response = await fetch(`${voicevoxBaseUrl}/audio_query?${params.toString()}`, {
    method: "POST",
    signal: voicevoxFetchSignal(signal)
  });

  if (!response.ok) {
    throw new Error(`VOICEVOX audio_query failed: ${response.status} ${response.statusText}`);
  }

  const audioQuery = (await response.json()) as VoicevoxAudioQuery;
  audioQuery.speedScale = defaultSpeedScale;
  // 48kHz stereo PCM は ffmpeg を介さず直接 @discordjs/voice に渡せる。
  audioQuery.outputSamplingRate = 48_000;
  audioQuery.outputStereo = true;
  return audioQuery;
}

class StreamingSynthesisUnsupportedError extends Error {}

const wavHeaderSize = 44;

async function prepareStreamingSpeech(
  audioQuery: VoicevoxAudioQuery,
  speaker: number,
  signal: AbortSignal
): Promise<SpeechAudio> {
  const abortController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let idleTimedOut = false;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      console.error(
        `VOICEVOX streaming_synthesis made no progress for ${voicevoxStreamingIdleTimeoutMs}ms; aborting.`
      );
      abortController.abort(new Error("VOICEVOX streaming_synthesis idle timeout"));
    }, voicevoxStreamingIdleTimeoutMs);
  };

  resetIdleTimer();

  let response: Response;
  try {
    response = await fetch(`${voicevoxBaseUrl}/streaming_synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(audioQuery),
      signal: combineAbortSignals([signal, abortController.signal])
    });
  } catch (error) {
    clearIdleTimer();
    throw error;
  }

  if (response.status === 404 || response.status === 405) {
    clearIdleTimer();
    throw new StreamingSynthesisUnsupportedError(
      `VOICEVOX streaming_synthesis returned ${response.status} ${response.statusText}`
    );
  }

  if (!response.ok) {
    clearIdleTimer();
    throw new Error(`VOICEVOX streaming_synthesis failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    clearIdleTimer();
    throw new Error("VOICEVOX streaming_synthesis returned an empty response body.");
  }

  resetIdleTimer();

  const bodyStream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream
  );
  let disposed = false;
  let headerBuffer: Buffer = Buffer.alloc(0);
  let headerParsed = false;
  let markSynthesized = () => {};

  const synthesized = new Promise<void>((resolve) => {
    markSynthesized = resolve;
  });

  const pcmStream = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdleTimer();

      if (headerParsed) {
        callback(null, chunk);
        return;
      }

      const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      headerBuffer = headerBuffer.length === 0 ? data : Buffer.concat([headerBuffer, data]);
      if (headerBuffer.length < wavHeaderSize) {
        callback();
        return;
      }

      const header = headerBuffer.subarray(0, wavHeaderSize);
      const audioFormat = header.readUInt16LE(20);
      const channels = header.readUInt16LE(22);
      const sampleRate = header.readUInt32LE(24);
      const bitsPerSample = header.readUInt16LE(34);
      if (
        header.toString("ascii", 0, 4) !== "RIFF" ||
        header.toString("ascii", 8, 12) !== "WAVE" ||
        header.toString("ascii", 36, 40) !== "data" ||
        audioFormat !== 1 ||
        channels !== 2 ||
        sampleRate !== 48_000 ||
        bitsPerSample !== 16
      ) {
        callback(
          new Error(
            `VOICEVOX streaming_synthesis returned an unsupported WAV format (${sampleRate} Hz, ${channels} ch, ${bitsPerSample} bit).`
          )
        );
        return;
      }

      headerParsed = true;
      const remainingPcm = headerBuffer.subarray(wavHeaderSize);
      headerBuffer = Buffer.alloc(0);
      if (remainingPcm.length > 0) {
        callback(null, remainingPcm);
      } else {
        callback();
      }
    },
    flush(callback) {
      clearIdleTimer();
      markSynthesized();
      callback();
    }
  });

  pcmStream.once("error", () => {
    clearIdleTimer();
    if (!disposed && !idleTimedOut) {
      console.error("VOICEVOX streaming_synthesis stream failed.");
    }
    markSynthesized();
  });
  pcmStream.once("close", () => {
    clearIdleTimer();
    markSynthesized();
  });

  bodyStream.once("error", (error) => {
    clearIdleTimer();
    pcmStream.destroy(error);
  });
  bodyStream.pipe(pcmStream);

  return {
    resource: createAudioResource(pcmStream, {
      inputType: StreamType.Raw,
      silencePaddingFrames: speechSilencePaddingFrames
    }),
    synthesized,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearIdleTimer();
      abortController.abort();
      bodyStream.destroy();
      pcmStream.destroy();
    }
  };
}

async function prepareBufferedSpeech(
  audioQuery: VoicevoxAudioQuery,
  speaker: number,
  signal: AbortSignal
): Promise<SpeechAudio> {
  const response = await fetch(`${voicevoxBaseUrl}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(audioQuery),
    signal: voicevoxFetchSignal(signal)
  });

  if (!response.ok) {
    throw new Error(`VOICEVOX synthesis failed: ${response.status} ${response.statusText}`);
  }

  const wav = Buffer.from(await response.arrayBuffer());
  const pcm = parseWavPcm(wav);
  const isRawPcm = pcm !== undefined && pcm.sampleRate === 48_000 && pcm.channels === 2;
  const stream = Readable.from([isRawPcm ? pcm.data : wav], { objectMode: false });
  let disposed = false;

  return {
    resource: isRawPcm
      ? createAudioResource(stream, {
          inputType: StreamType.Raw,
          silencePaddingFrames: speechSilencePaddingFrames
        })
      : createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
          silencePaddingFrames: speechSilencePaddingFrames
        }),
    synthesized: Promise.resolve(),
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stream.destroy();
    }
  };
}

function parseWavPcm(
  wav: Buffer
): { data: Buffer; sampleRate: number; channels: number } | undefined {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + chunkSize, wav.length);

    if (chunkId === "fmt " && dataStart + 16 <= wav.length) {
      audioFormat = wav.readUInt16LE(dataStart);
      channels = wav.readUInt16LE(dataStart + 2);
      sampleRate = wav.readUInt32LE(dataStart + 4);
      bitsPerSample = wav.readUInt16LE(dataStart + 14);
    } else if (chunkId === "data") {
      if (audioFormat !== 1 || bitsPerSample !== 16 || channels === 0 || sampleRate === 0) {
        return undefined;
      }
      return { data: wav.subarray(dataStart, dataEnd), sampleRate, channels };
    }

    const nextOffset = dataStart + chunkSize + (chunkSize & 1);
    if (nextOffset <= offset) {
      return undefined;
    }
    offset = nextOffset;
  }

  return undefined;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function voicevoxFetchSignal(extraSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(voicevoxFetchTimeoutMs);
  return extraSignal ? combineAbortSignals([extraSignal, timeoutSignal]) : timeoutSignal;
}

async function initializeSpeaker(speaker: number): Promise<void> {
  if (initializedSpeakers.has(speaker)) {
    return;
  }

  const params = new URLSearchParams({ speaker: String(speaker) });
  const response = await fetch(`${voicevoxBaseUrl}/initialize_speaker?${params.toString()}`, {
    method: "POST",
    signal: AbortSignal.timeout(Math.max(voicevoxFetchTimeoutMs, 30_000))
  });

  if (!response.ok) {
    throw new Error(`VOICEVOX initialize_speaker failed: ${response.status} ${response.statusText}`);
  }

  initializedSpeakers.add(speaker);
}

async function prewarmStoredSpeakers(): Promise<void> {
  if (voicevoxPrewarmLimit <= 0) {
    return;
  }

  const speakers = new Set<number>([defaultSpeaker]);

  try {
    const userRows = await db.all<Array<{ speaker: number }>>(
      "SELECT speaker FROM user_speakers GROUP BY speaker ORDER BY MAX(updated_at) DESC LIMIT 8;"
    );
    for (const row of userRows) {
      speakers.add(row.speaker);
    }

    const guildRows = await db.all<Array<{ default_speaker: number }>>(
      `
        SELECT default_speaker
        FROM guild_settings
        WHERE default_speaker IS NOT NULL
        GROUP BY default_speaker
        ORDER BY MAX(updated_at) DESC
        LIMIT 8;
      `
    );
    for (const row of guildRows) {
      speakers.add(row.default_speaker);
    }
  } catch (error) {
    console.error("Failed to load stored speakers for pre-warming:", error);
  }

  for (const speaker of [...speakers].slice(0, voicevoxPrewarmLimit)) {
    try {
      await initializeSpeaker(speaker);
    } catch (error) {
      console.warn(`Failed to pre-warm VOICEVOX speaker ${speaker}:`, error);
    }
  }
}

async function fetchVoicevoxSpeakers(): Promise<VoicevoxSpeaker[]> {
  const now = Date.now();
  const isCacheValid = cachedSpeakers !== null && now - speakersCachedAt < speakerCacheTtlMs;
  if (isCacheValid && cachedSpeakers) {
    return cachedSpeakers;
  }

  if (!speakerFetchInFlight) {
    speakerFetchInFlight = (async () => {
      const response = await fetch(`${voicevoxBaseUrl}/speakers`, { signal: voicevoxFetchSignal() });
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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL PRIMARY KEY,
      autojoin_enabled INTEGER NOT NULL DEFAULT 0 CHECK (autojoin_enabled IN (0, 1)),
      autojoin_text_channel_id TEXT,
      default_speaker INTEGER,
      vc_notify_enabled INTEGER NOT NULL DEFAULT 0 CHECK (vc_notify_enabled IN (0, 1)),
      vc_notify_channel_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    await db.exec(`ALTER TABLE guild_settings ADD COLUMN default_speaker INTEGER;`);
  } catch {
    // column already exists
  }

  try {
    await db.exec(`ALTER TABLE guild_settings ADD COLUMN vc_notify_enabled INTEGER NOT NULL DEFAULT 0;`);
  } catch {
    // column already exists
  }

  try {
    await db.exec(`ALTER TABLE guild_settings ADD COLUMN vc_notify_channel_id TEXT;`);
  } catch {
    // column already exists
  }
}

async function setGuildDefaultSpeaker(guildId: string, speaker: number): Promise<void> {
  await db.run(
    `
      INSERT INTO guild_settings (guild_id, default_speaker)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET default_speaker = excluded.default_speaker, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    speaker
  );
}

async function getGuildDefaultSpeaker(guildId: string): Promise<number> {
  const row = await db.get<{ default_speaker: number | null }>(
    "SELECT default_speaker FROM guild_settings WHERE guild_id = ?;",
    guildId
  );
  if (row?.default_speaker !== null && row?.default_speaker !== undefined) {
    return row.default_speaker;
  }
  return defaultSpeaker;
}

async function setGuildAutoJoinEnabled(guildId: string, enabled: boolean): Promise<void> {
  await db.run(
    `
      INSERT INTO guild_settings (guild_id, autojoin_enabled)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET autojoin_enabled = excluded.autojoin_enabled, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    enabled ? 1 : 0
  );
}

async function getGuildAutoJoinEnabled(guildId: string): Promise<boolean> {
  const row = await db.get<{ autojoin_enabled: number }>(
    "SELECT autojoin_enabled FROM guild_settings WHERE guild_id = ?;",
    guildId
  );
  return row?.autojoin_enabled === 1;
}

async function setGuildAutoJoinTextChannel(guildId: string, channelId: string): Promise<void> {
  await db.run(
    `
      INSERT INTO guild_settings (guild_id, autojoin_text_channel_id)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET autojoin_text_channel_id = excluded.autojoin_text_channel_id, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    channelId
  );
}

async function getGuildAutoJoinTextChannel(guildId: string): Promise<string | undefined> {
  const row = await db.get<{ autojoin_text_channel_id: string | null }>(
    "SELECT autojoin_text_channel_id FROM guild_settings WHERE guild_id = ?;",
    guildId
  );
  return row?.autojoin_text_channel_id ?? undefined;
}

async function setGuildVcNotifyEnabled(guildId: string, enabled: boolean): Promise<void> {
  await db.run(
    `
      INSERT INTO guild_settings (guild_id, vc_notify_enabled)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET vc_notify_enabled = excluded.vc_notify_enabled, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    enabled ? 1 : 0
  );
}

async function getGuildVcNotifyEnabled(guildId: string): Promise<boolean> {
  const row = await db.get<{ vc_notify_enabled: number }>(
    "SELECT vc_notify_enabled FROM guild_settings WHERE guild_id = ?;",
    guildId
  );
  return row?.vc_notify_enabled === 1;
}

async function setGuildVcNotifyChannel(guildId: string, channelId: string): Promise<void> {
  await db.run(
    `
      INSERT INTO guild_settings (guild_id, vc_notify_channel_id)
      VALUES (?, ?)
      ON CONFLICT(guild_id)
      DO UPDATE SET vc_notify_channel_id = excluded.vc_notify_channel_id, updated_at = CURRENT_TIMESTAMP;
    `,
    guildId,
    channelId
  );
}

async function getGuildVcNotifyChannel(guildId: string): Promise<string | undefined> {
  const row = await db.get<{ vc_notify_channel_id: string | null }>(
    "SELECT vc_notify_channel_id FROM guild_settings WHERE guild_id = ?;",
    guildId
  );
  return row?.vc_notify_channel_id ?? undefined;
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
  userSpeakerCache.set(`${guildId}:${userId}`, speaker);
}

async function getUserSpeaker(guildId: string, userId: string): Promise<number | undefined> {
  const cacheKey = `${guildId}:${userId}`;
  const cached = userSpeakerCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const row = await db.get<{ speaker: number }>(
    `
      SELECT speaker
      FROM user_speakers
      WHERE guild_id = ? AND user_id = ?;
    `,
    guildId,
    userId
  );
  userSpeakerCache.set(cacheKey, row?.speaker ?? null);
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

async function disconnectGuild(guildId: string): Promise<void> {
  await disconnectGuildInternal(guildId, true);
}

async function disconnectGuildInternal(guildId: string, destroyConnection: boolean): Promise<void> {
  const state = guildStates.get(guildId);
  if (!state) {
    return;
  }

  clearSpeech(state);
  guildStates.delete(guildId);
  resolveQueueIdleWaiters(state);
  if (destroyConnection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    state.connection.destroy();
  }
}

function rateLimitKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function isWithinRateLimit(guildId: string, userId: string): boolean {
  const key = rateLimitKey(guildId, userId);
  const now = Date.now();
  const timestamps = userRateLimitTimestamps.get(key) ?? [];
  const recent = timestamps.filter((timestamp) => now - timestamp < rateLimitWindowMs);
  userRateLimitTimestamps.set(key, recent);
  return recent.length < rateLimitMaxMessages;
}

function recordRateLimit(guildId: string, userId: string): void {
  const key = rateLimitKey(guildId, userId);
  const timestamps = userRateLimitTimestamps.get(key) ?? [];
  timestamps.push(Date.now());
  userRateLimitTimestamps.set(key, timestamps);
}

async function notifyTextChannelThrottled(
  guildId: string,
  textChannelId: string | undefined,
  content: string
): Promise<void> {
  const now = Date.now();
  const cooldownKey = `${guildId}:${content}`;
  const cooldownUntil = queueNotifyCooldownUntil.get(cooldownKey) ?? 0;
  if (now < cooldownUntil) {
    return;
  }

  queueNotifyCooldownUntil.set(cooldownKey, now + rateLimitWindowMs);
  await notifyTextChannel(textChannelId, content);
}

async function enqueueSpeech(
  guildId: string,
  item: QueueItem,
  options: { userId?: string; skipRateLimit?: boolean } = {}
): Promise<void> {
  const state = guildStates.get(guildId);
  if (!state) {
    return;
  }

  if (!options.skipRateLimit && options.userId) {
    if (!isWithinRateLimit(guildId, options.userId)) {
      await notifyTextChannelThrottled(
        guildId,
        state.textChannelId,
        "読み上げが多すぎるため、しばらくスキップします。"
      );
      return;
    }
    recordRateLimit(guildId, options.userId);
  }

  if (state.queue.length >= maxQueueSize) {
    await notifyTextChannelThrottled(
      guildId,
      state.textChannelId,
      `読み上げキューが上限（${maxQueueSize}件）に達したため、メッセージを破棄しました。`
    );
    return;
  }

  state.queue.push(item);
  // 再生中に届いたメッセージは、現在の再生が終わる前に合成を開始しておく。
  if (state.processing) {
    prepareNext(state);
  }
  void processQueue(guildId);
}

async function replyPrivate(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content });
    return;
  }

  if (interaction.replied) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }

  await interaction.reply({ content, ephemeral: true });
}

async function replyInteractionError(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content });
      return;
    }

    if (!interaction.replied) {
      await interaction.reply({ content, ephemeral: true });
      return;
    }

    await interaction.followUp({ content, ephemeral: true });
  } catch (replyError) {
    console.error("Failed to send interaction error response:", replyError);
  }
}

async function notifyTextChannel(textChannelId: string | undefined, content: string): Promise<void> {
  if (!textChannelId) {
    return;
  }
  const channel = await client.channels.fetch(textChannelId);
  if (channel?.isTextBased() && "send" in channel) {
    await channel.send(content);
  }
}

async function resolveVoiceChannel(
  voiceState: VoiceState,
  channelId: string | null
): Promise<VoiceBasedChannel | null> {
  if (!channelId) {
    return null;
  }

  const cached = voiceState.guild.channels.cache.get(channelId);
  if (cached && isJoinableVoiceChannel(cached)) {
    return cached;
  }

  const fetched = await voiceState.guild.channels.fetch(channelId).catch(() => null);
  if (fetched && isJoinableVoiceChannel(fetched)) {
    return fetched;
  }

  return null;
}

async function sendVcActivityEmbed(
  textChannelId: string,
  member: GuildMember,
  voiceChannel: VoiceBasedChannel,
  kind: "join" | "leave"
): Promise<void> {
  const channel = await client.channels.fetch(textChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return;
  }

  const action = kind === "join" ? "参加しました" : "退出しました";
  const embed = new EmbedBuilder()
    .setColor(kind === "join" ? 0x57f287 : 0xed4245)
    .setDescription(`${member} が VCチャンネル <#${voiceChannel.id}> に${action}。`)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function notifyGuildVcActivityEmbeds(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const guildId = newState.guild.id;
  if (!(await getGuildVcNotifyEnabled(guildId))) {
    return;
  }

  const notifyChannelId = await getGuildVcNotifyChannel(guildId);
  if (!notifyChannelId) {
    return;
  }

  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) {
    return;
  }

  if (oldState.channelId === newState.channelId) {
    return;
  }

  if (newState.channelId && oldState.channelId !== newState.channelId) {
    const joinedChannel = await resolveVoiceChannel(newState, newState.channelId);
    if (joinedChannel) {
      try {
        await sendVcActivityEmbed(notifyChannelId, member, joinedChannel, "join");
      } catch (error) {
        console.error(`Failed to send VC join embed in guild ${guildId}:`, error);
      }
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const leftChannel = await resolveVoiceChannel(oldState, oldState.channelId);
    if (leftChannel) {
      try {
        await sendVcActivityEmbed(notifyChannelId, member, leftChannel, "leave");
      } catch (error) {
        console.error(`Failed to send VC leave embed in guild ${guildId}:`, error);
      }
    }
  }
}

type SpeechMessageContext = {
  mentions: { members: { get(id: string): { displayName: string } | undefined } | null };
  guild: { channels: { cache: { get(id: string): { name: string } | undefined } } } | null;
};

function applyLaughNormalization(text: string): string {
  return text
    .replace(/[wｗ]{2,}/g, " わらわら ")
    .replace(/(?<=[ぁ-んァ-ヶ一-龯ー])[wｗ](?=$|[\s!！?？。、「」、,.])/g, "わら")
    .replace(/(^|[\s!！?？。、「」、,.()（）])([wｗ])(?=$|[\s!！?？。、「」、,.()（）])/g, "$1わら");
}

async function applyEmojiAndDictionaryTransform(guildId: string, text: string): Promise<string> {
  const pronunciationRules = await getPronunciationRules(guildId);
  const replacedByDictionary = applyPronunciationRules(text, pronunciationRules);
  const withJapaneseEmoji = replaceUnicodeEmojiWithJapanese(replacedByDictionary);
  const customEmojiNamed = withJapaneseEmoji.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, " カスタム絵文字 ");
  const unicodeEmojiNamed = nodeEmoji.unemojify(customEmojiNamed);
  const shortcodeNamed = unicodeEmojiNamed.replace(/:([a-zA-Z0-9_+-]+):/g, " $1 ");
  const withFallbackEmoji = replaceUnknownEmojiWithFallback(shortcodeNamed);
  return applyLaughNormalization(withFallbackEmoji).replace(/\s+/g, " ").trim();
}

const speechTextLimit = 80;
const speechOmissionSuffix = "以下略...";
const speechOmissionSeparator = "、";
const trailingPausePattern = /[。、，．！？!?…,.]$/;

function truncateForSpeech(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= speechTextLimit) {
    return text;
  }

  const suffixLength = Array.from(speechOmissionSuffix).length;
  const reservedLength = suffixLength + 1;
  const visibleLength = Math.max(0, speechTextLimit - reservedLength);
  const truncated = characters.slice(0, visibleLength).join("").trimEnd();
  const separator = trailingPausePattern.test(truncated) ? "" : speechOmissionSeparator;
  return `${truncated}${separator}${speechOmissionSuffix}`;
}

async function normalizeDisplayNameForSpeech(guildId: string, displayName: string): Promise<string> {
  const transformed = await applyEmojiAndDictionaryTransform(guildId, displayName.trim());
  return truncateForSpeech(transformed);
}

async function normalizeForSpeech(
  guildId: string,
  content: string,
  message: SpeechMessageContext,
  hasAttachments: boolean,
  hasStickers: boolean
): Promise<string> {
  const trimmed = content.trim();
  if (!trimmed && !hasAttachments && !hasStickers) {
    return "";
  }

  if (!trimmed && hasStickers) {
    return "スタンプが投稿されました";
  }

  if (/^```[\s\S]*```$/.test(trimmed)) {
    return "コードブロックが投稿されました";
  }

  let working = trimmed.replace(/```[\s\S]*?```/g, " コードブロック ");
  working = working.replace(/\|\|([\s\S]+?)\|\|/g, " ネタバレを含むメッセージ ");
  working = working.replace(/<#(\d+)>/g, (_match, channelId: string) => {
    const channel = message.guild?.channels.cache.get(channelId);
    return channel ? channel.name : "チャンネル";
  });
  working = working.replace(/<@&(\d+)>/g, " ロール ");
  working = working.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, " タイムスタンプ ");

  const withDisplayNames = working.replace(/<@!?(\d+)>/g, (_match, userId: string) => {
    const member = message.mentions.members?.get(userId);
    return member ? member.displayName : "ユーザー";
  });

  const withLeadingAtRead = withDisplayNames.replace(/^@/, "アット ");
  const withMediaNotice =
    hasAttachments && withLeadingAtRead.length > 0
      ? `${withLeadingAtRead} メディアが投稿されました`
      : hasAttachments
        ? "メディアが投稿されました"
        : hasStickers && withLeadingAtRead.length > 0
          ? `${withLeadingAtRead} スタンプが投稿されました`
          : hasStickers
            ? "スタンプが投稿されました"
            : withLeadingAtRead;

  const withoutUrls = withMediaNotice.replace(/https?:\/\/\S+/g, "URL");
  const normalizedSpaces = await applyEmojiAndDictionaryTransform(guildId, withoutUrls);
  return truncateForSpeech(normalizedSpaces);
}

function isJoinableVoiceChannel(channel: GuildBasedChannel): channel is VoiceBasedChannel {
  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  for (const guildId of [...guildStates.keys()]) {
    await disconnectGuildInternal(guildId, true);
  }

  client.destroy();
  await db.close();
  process.exit(0);
}

async function main(): Promise<void> {
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await initDatabase();
  void prewarmStoredSpeakers();
  await client.login(token);
}

main().catch((error) => {
  console.error("Failed to start Discord client:", error);
  process.exit(1);
});

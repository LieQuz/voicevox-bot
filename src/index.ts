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
  ActivityType,
  ChatInputCommandInteraction,
  ChannelType,
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
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

const emojiJapaneseReadings: Record<string, string> = {
  grin: "にこにこ",
  grinning: "にこにこ",
  smile: "スマイル",
  smiley: "えがお",
  smiling_face_with_3_hearts: "ハートいっぱい",
  smiling_face_with_hearts: "ハートでにこにこ",
  smiling_face_with_smiling_eyes: "にこにこがお",
  smiling_face_with_tear: "うれしなみだ",
  grinning_face_with_big_eyes: "にっこり",
  grinning_face_with_smiling_eyes: "にこにこ",
  grinning_face_with_sweat: "あせわらい",
  rolling_on_the_floor_laughing: "だいばくしょう",
  laughing: "だいしょう",
  sweat_smile: "にがわらい",
  joy: "うれしなみだ",
  rofl: "だいばくしょう",
  blush: "てれがお",
  innocent: "てんし",
  wink: "ウインク",
  heart_eyes: "ハートのめ",
  star_struck: "ほしのめ",
  kissing_heart: "キス",
  face_with_tears_of_joy: "うれしなみだ",
  face_holding_back_tears: "なみだをこらえる",
  melting_face: "とけるかお",
  upside_down_face: "さかさま",
  thinking_face: "かんがえちゅう",
  neutral_face: "むひょうじょう",
  expressionless: "むひょうじょう",
  no_mouth: "くちなし",
  face_with_raised_eyebrow: "うたがいのかお",
  grimacing: "しかめがお",
  pleading_face: "おねがいのかお",
  sleepy: "ねむい",
  drooling_face: "よだれ",
  sleeping: "すやすや",
  mask: "マスク",
  face_with_thermometer: "ねつっぽい",
  face_with_head_bandage: "けが",
  sob: "おおなき",
  cry: "なき",
  disappointed: "がっかり",
  worried: "しんぱい",
  confused: "こんらん",
  astonished: "びっくり",
  flushed: "まっか",
  fear: "おそれ",
  cold_sweat: "あせ",
  weary: "つかれた",
  dizzy_face: "めまい",
  angry: "おこり",
  rage: "げきど",
  scream: "ひめい",
  facepalm: "あたまをかかえる",
  shrug: "しかたない",
  thumbs_up: "いいね",
  thumbs_down: "よくないね",
  punch: "パンチ",
  fist: "こぶし",
  v: "ピース",
  wave: "てをふる",
  raised_hand: "てをあげる",
  waving_hand: "てをふる",
  call_me_hand: "でんわして",
  point_up: "うえをさす",
  point_down: "したをさす",
  point_left: "ひだりをさす",
  point_right: "みぎをさす",
  writing_hand: "かく",
  crossed_fingers: "こううん",
  handshake: "あくしゅ",
  clap: "はくしゅ",
  pray: "おねがい",
  ok_hand: "オーケー",
  muscle: "ちからこぶ",
  mechanical_arm: "きかいのうで",
  mechanical_leg: "きかいのあし",
  brain: "のう",
  eyes: "め",
  eye: "ひとみ",
  ear: "みみ",
  nose: "はな",
  tongue: "した",
  tooth: "は",
  bone: "ほね",
  speaking_head: "はなす",
  fire: "ほのお",
  sun_with_face: "たいよう",
  full_moon_with_face: "まんげつ",
  cloud: "くも",
  cloud_with_rain: "あめ",
  cloud_with_lightning: "かみなり",
  snowflake: "ゆき",
  cyclone: "たいふう",
  rainbow: "にじ",
  sparkle: "きらきら",
  sparkles: "きらきら",
  star: "ほし",
  star2: "ほし",
  dizzy: "きらり",
  comet: "ほうきぼし",
  boom: "どかん",
  collision: "どかん",
  anger: "いかり",
  sweat_drops: "あせ",
  dash: "ダッシュ",
  hole: "あな",
  poop: "うんち",
  skull: "どくろ",
  ghost: "おばけ",
  clown_face: "ピエロ",
  alien: "エイリアン",
  robot: "ロボット",
  jack_o_lantern: "かぼちゃ",
  santa: "サンタ",
  tanabata_tree: "たなばた",
  bamboo: "たけ",
  crossed_flags: "しゅくじつ",
  broken_heart: "われたハート",
  heart: "ハート",
  red_heart: "あかいハート",
  orange_heart: "オレンジハート",
  blue_heart: "あおいハート",
  green_heart: "みどりのハート",
  yellow_heart: "きいろいハート",
  purple_heart: "むらさきのハート",
  white_heart: "しろいハート",
  black_heart: "くろいハート",
  brown_heart: "ちゃいろのハート",
  heartpulse: "どきどきハート",
  two_hearts: "ふたつのハート",
  revolving_hearts: "まわるハート",
  cupid: "やでささるハート",
  gift_heart: "プレゼントハート",
  raised_hands: "ばんざい",
  open_hands: "ひらいたて",
  palms_up_together: "ささげるて",
  folded_hands: "がっしょう",
  tada: "おいわい",
  confetti_ball: "クラッカー",
  party_popper: "パーティー",
  balloon: "ふうせん",
  gift: "プレゼント",
  birthday: "たんじょうびケーキ",
  cake: "ケーキ",
  chocolate_bar: "チョコレート",
  cookie: "クッキー",
  candy: "キャンディー",
  lollipop: "ペロペロキャンディー",
  honey_pot: "はちみつ",
  coffee: "コーヒー",
  tea: "おちゃ",
  beer: "ビール",
  beers: "かんぱい",
  sake: "にほんしゅ",
  wine_glass: "ワイン",
  champagne: "シャンパン",
  fork_and_knife: "フォークとナイフ",
  ramen: "ラーメン",
  curry: "カレー",
  rice_ball: "おにぎり",
  sushi: "すし",
  apple: "りんご",
  green_apple: "あおりんご",
  tangerine: "みかん",
  lemon: "レモン",
  banana: "バナナ",
  watermelon: "すいか",
  grapes: "ぶどう",
  peach: "もも",
  strawberry: "いちご",
  pineapple: "パイナップル",
  tomato: "トマト",
  carrot: "にんじん",
  corn: "とうもろこし",
  brocolli: "ブロッコリー",
  bread: "パン",
  hamburger: "ハンバーガー",
  pizza: "ピザ",
  fries: "ポテト",
  hotdog: "ホットドッグ",
  taco: "タコス",
  burrito: "ブリトー",
  popcorn: "ポップコーン",
  100: "ひゃく",
  zzz: "すやすや",
  exclamation: "びっくり",
  question: "はてな",
  interrobang: "びっくりはてな",
  o: "まる",
  x: "ばつ",
  warning: "けいこく",
  no_entry: "しんにゅうきんし",
  prohibited: "きんし",
  arrow_up: "うえやじるし",
  arrow_down: "したやじるし",
  arrow_left: "ひだりやじるし",
  arrow_right: "みぎやじるし",
  rewind: "まきもどし",
  fast_forward: "はやおくり",
  pause_button: "いちじていし",
  stop_button: "ていし",
  play_or_pause_button: "さいせいまたはていし",
  white_check_mark: "チェック",
  ballot_box_with_check: "チェックずみ",
  heavy_check_mark: "チェック",
  x_button: "ばつ",
  radio_button: "ラジオボタン",
  small_blue_diamond: "あおダイヤ",
  small_orange_diamond: "オレンジダイヤ",
  large_blue_diamond: "おおきいあおダイヤ",
  large_orange_diamond: "おおきいオレンジダイヤ",
  japanese_acceptable_button: "か",
  japanese_not_free_of_charge_button: "ゆうりょう",
  japanese_free_of_charge_button: "むりょう",
  japanese_application_button: "もうしこみ",
  japanese_discount_button: "わりびき",
  japanese_open_for_business_button: "えいぎょうちゅう",
  japanese_bargain_button: "とくか",
  japanese_secret_button: "ひみつ",
  japanese_congratulations_button: "しゅく",
  japanese_passed_button: "ごうかく"
};

const emojiTokenJapaneseReadings: Record<string, string> = {
  face: "かお",
  smiling: "にこにこ",
  smile: "スマイル",
  grin: "えがお",
  laughing: "わらい",
  tears: "なみだ",
  joy: "よろこび",
  heart: "ハート",
  eyes: "め",
  hand: "て",
  hands: "て",
  thumb: "ゆび",
  thumbs: "ゆび",
  up: "アップ",
  down: "ダウン",
  party: "パーティー",
  popper: "クラッカー",
  confetti: "ふぶき",
  fire: "ほのお",
  star: "ほし",
  sparkles: "きらきら",
  sparkle: "きらきら",
  cry: "なき",
  sob: "おおなき",
  angry: "おこり",
  rage: "げきど",
  thinking: "かんがえ",
  clap: "はくしゅ",
  pray: "いのり",
  wave: "てをふる",
  skull: "どくろ",
  ghost: "おばけ",
  poop: "うんち",
  red: "あか",
  blue: "あお",
  green: "みどり",
  yellow: "きいろ",
  purple: "むらさき",
  white: "しろ",
  black: "くろ",
  orange: "オレンジ",
  pink: "ピンク",
  brown: "ちゃいろ",
  light: "うすい",
  medium: "ふつう",
  dark: "こい",
  skin: "スキン",
  tone: "トーン",
  person: "ひと",
  man: "おとこ",
  woman: "おんな",
  boy: "おとこのこ",
  girl: "おんなのこ",
  people: "ひとびと",
  family: "かぞく",
  flag: "はた",
  japan: "にほん",
  us: "アメリカ",
  uk: "イギリス"
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
    .setName("speaker")
    .setDescription("あなたの話者IDを保存します")
    .addIntegerOption((option) => option.setName("id").setDescription("話者ID").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("使い方と主要話者一覧を表示します"),
  new SlashCommandBuilder().setName("speakers").setDescription("話者一覧を表示します")
].map((command) => command.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  client.user?.setActivity("/help | /join | /speaker 3", {
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

  const text = normalizeForSpeech(message.content);
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
    const speaker = interaction.options.getInteger("id", true);
    if (speaker <= 0) {
      await replyPrivate(interaction, "`/speaker id:<number>` で話者IDを指定してください。");
      return;
    }

    await setUserSpeaker(interaction.guild.id, interaction.user.id, speaker);
    await replyPrivate(interaction, `あなたの話者IDを ${speaker} に保存しました。`);
    return;
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
      "- `/speaker id:<number>` : あなたの話者IDを保存",
      "- `/speakers` : 話者一覧を見やすく表示",
      "",
      "操作の流れ:",
      "1) `/join` でVC参加",
      "2) `/speaker id:3` で自分の話者を設定",
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
      lines = await fetchSpeakerSummaryLines();
    } catch (error) {
      console.error("Failed to fetch speaker list:", error);
      await replyPrivate(interaction, "話者一覧の取得に失敗しました（VOICEVOX接続を確認してください）。");
      return;
    }

    await replyInChunks(interaction, "話者ID一覧:", lines);
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

async function replyInChunks(
  interaction: ChatInputCommandInteraction,
  title: string,
  lines: string[]
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

  const totalStyles = lines.reduce(
    (count, line) => count + (line.match(/\d+:/g)?.length ?? 0),
    0
  );
  await replyPrivate(interaction, `合計 ${lines.length} キャラクター / ${totalStyles} スタイル`);
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

function normalizeForSpeech(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  const withoutUrls = trimmed.replace(/https?:\/\/\S+/g, "URL");
  const customEmojiNamed = withoutUrls.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, " $1 ");
  const unicodeEmojiNamed = nodeEmoji.unemojify(customEmojiNamed);
  const shortcodeNamed = unicodeEmojiNamed.replace(/:([a-zA-Z0-9_+-]+):/g, (_, shortcode: string) => {
    return ` ${toJapaneseEmojiReading(shortcode)} `;
  });
  const laughNormalized = shortcodeNamed
    .replace(/[wｗ]{2,}/g, (match) => ` ${"わら".repeat(match.length)} `)
    .replace(/(?<=[ぁ-んァ-ヶ一-龯ー])[wｗ](?=$|[\s!！?？。、「」、,.])/g, "わら")
    .replace(/(^|[\s!！?？。、「」、,.()（）])([wｗ])(?=$|[\s!！?？。、「」、,.()（）])/g, "$1わら");
  const normalizedSpaces = laughNormalized.replace(/\s+/g, " ").trim();
  return normalizedSpaces.slice(0, 120);
}

function toJapaneseEmojiReading(shortcode: string): string {
  const exact = emojiJapaneseReadings[shortcode];
  if (exact) {
    return exact;
  }

  const normalized = shortcode.replace(/-/g, "_");
  const parts = normalized.split("_").filter(Boolean);
  const converted = parts
    .map((part) => {
      if (/^u[0-9a-f]+$/i.test(part)) {
        return "";
      }
      return emojiTokenJapaneseReadings[part] ?? part;
    })
    .filter((part) => part.length > 0);

  if (converted.length > 0) {
    return converted.join(" ");
  }

  return shortcode;
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

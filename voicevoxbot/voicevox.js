import {
	Client,
	GatewayIntentBits,
	ChannelType,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import {
	createAudioPlayer,
	createAudioResource,
	joinVoiceChannel,
	NoSubscriberBehavior,
	getVoiceConnection,
	AudioPlayerStatus,
} from "@discordjs/voice";
import { join } from "path";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	unlinkSync,
} from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// import { handleVvaiCommand } from "./handleVvaiCommand.js";

// 既存のimportステートメントの下に追加
const { googleApiKey } = JSON.parse(
	readFileSync(join(__dirname, "config.json"), "utf8")
);

const gemini = new ChatGoogleGenerativeAI({
	apiKey: googleApiKey,
	modelName: "gemini-pro",
});

const { token, applicationId, guildId } = JSON.parse(
	readFileSync(join(__dirname, "config.json"), "utf8")
);

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const TIMEOUT = 30 * 60 * 1000; // 30分
const voiceTmpPath = join(__dirname, "voiceTmp");
if (!existsSync(voiceTmpPath)) {
	mkdirSync(voiceTmpPath);
}

let voicevoxSpeakers = [];
let timeoutId = null;

async function fetchVoicevoxSpeakers() {
	try {
		const response = await axios.get("http://localhost:50021/speakers");
		voicevoxSpeakers = response.data.flatMap((speaker) =>
			speaker.styles.map((style) => ({
				name: `${speaker.name} (${style.name})`,
				id: style.id,
			}))
		);
		console.log("VOICEVOX speakers loaded:", voicevoxSpeakers.length);
	} catch (error) {
		console.error("Failed to fetch VOICEVOX speakers:", error);
	}
}

async function updateCommands() {
	const normalSpeakers = voicevoxSpeakers.filter((speaker) =>
		speaker.name.includes("ノーマル")
	);
	const limitedSpeakers = normalSpeakers.slice(0, 24);

	const vvCommand = new SlashCommandBuilder()
		.setName("vv")
		.setDescription("指定したボイスチャンネルで文章を読み上げます")
		.addStringOption((option) =>
			option
				.setName("text")
				.setDescription("読み上げる文章")
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName("channelid")
				.setDescription("ボイスチャンネルのID（省略可能）")
				.setRequired(false)
		)
		.addStringOption((option) =>
			option
				.setName("speaker")
				.setDescription("VOICEVOXの話者（選択または入力）")
				.setRequired(false)
				.addChoices(
					{ name: "カスタム", value: "custom" },
					...limitedSpeakers.map((speaker) => ({
						name: speaker.name,
						value: speaker.name,
					}))
				)
		)
		.addStringOption((option) =>
			option
				.setName("custom_speaker")
				.setDescription(
					"カスタム話者名（「話者」で「カスタム」を選択した場合に使用）"
				)
				.setRequired(false)
		)
		.addNumberOption((option) =>
			option
				.setName("speed")
				.setDescription("話速（0.5~2.0、デフォルト: 1.0）")
				.setRequired(false)
				.setMinValue(0.5)
				.setMaxValue(2.0)
		)
		.addNumberOption((option) =>
			option
				.setName("pitch")
				.setDescription("音高（-0.15~0.15、デフォルト: 0）")
				.setRequired(false)
				.setMinValue(-0.15)
				.setMaxValue(0.15)
		)
		.addNumberOption((option) =>
			option
				.setName("intonation")
				.setDescription("抑揚（0~2.0、デフォルト: 1.0）")
				.setRequired(false)
				.setMinValue(0)
				.setMaxValue(2.0)
		)
		.addNumberOption((option) =>
			option
				.setName("volume")
				.setDescription("音量（0~2.0、デフォルト: 1.0）")
				.setRequired(false)
				.setMinValue(0)
				.setMaxValue(2.0)
		);

	const lvvCommand = new SlashCommandBuilder()
		.setName("lvv")
		.setDescription("ボイスチャンネルから退出します");

	const vvaiCommand = new SlashCommandBuilder()
		.setName("vvai")
		.setDescription("AIに質問し、VOICEVOXの声で回答を読み上げます")
		.addStringOption((option) =>
			option
				.setName("question")
				.setDescription("AIへの質問")
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName("speaker")
				.setDescription(
					"VOICEVOXの話者（デフォルト: ずんだもん (ノーマル)）"
				)
				.setRequired(false)
				.addChoices(
					...limitedSpeakers.map((speaker) => ({
						name: speaker.name,
						value: speaker.name,
					}))
				)
		)
		.addStringOption((option) =>
			option
				.setName("channelid")
				.setDescription("ボイスチャンネルのID（省略可能）")
				.setRequired(false)
		);

	const commands = [
		vvCommand.toJSON(),
		vvaiCommand.toJSON(),
		lvvCommand.toJSON(),
	];

	const rest = new REST({ version: "10" }).setToken(token);

	try {
		console.log("Started refreshing application (/) commands.");
		await rest.put(
			Routes.applicationGuildCommands(applicationId, guildId),
			{ body: commands }
		);
		console.log("Successfully reloaded application (/) commands.");
	} catch (error) {
		console.error("Error refreshing commands:", error);
	}
}

client.once("ready", async () => {
	console.log(`Ready! Logged in as ${client.user.tag}`);
	await fetchVoicevoxSpeakers();
	await updateCommands();
});

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isCommand()) return;

	const { commandName } = interaction;

	if (commandName === "vv") {
		const text = interaction.options.getString("text");
		let speakerName =
			interaction.options.getString("speaker") || "ずんだもん (ノーマル)";
		if (speakerName === "custom") {
			speakerName = interaction.options.getString("custom_speaker");
		}

		const guild = interaction.guild;
		let voiceChannel;

		const specifiedChannelId = interaction.options.getString("channelid");
		if (specifiedChannelId) {
			voiceChannel = guild.channels.cache.get(specifiedChannelId);
		} else {
			voiceChannel = interaction.member.voice.channel;
		}

		if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
			await interaction.reply({
				content:
					"有効な音声チャンネルが見つかりません。ボイスチャンネルに入室するか、有効なチャンネルIDを指定してください。",
				ephemeral: true,
			});
			return;
		}

		const speaker = voicevoxSpeakers.find((s) => s.name === speakerName);
		if (!speaker) {
			await interaction.reply({
				content:
					"指定された話者が見つかりません。カスタム話者を使用する場合は、「カスタム」を選択し、custom_speakerオプションで話者名を指定してください。",
				ephemeral: true,
			});
			return;
		}

		try {
			await interaction.deferReply({ ephemeral: true });

			let connection = getVoiceConnection(guild.id);
			if (!connection) {
				connection = joinVoiceChannel({
					channelId: voiceChannel.id,
					guildId: guild.id,
					adapterCreator: guild.voiceAdapterCreator,
					selfDeaf: false,
					selfMute: false,
				});
			}

			const player = createAudioPlayer({
				behaviors: {
					noSubscriber: NoSubscriberBehavior.Pause,
				},
			});

			connection.subscribe(player);

			// VoiceVox APIを使用して音声を生成
			const query = await axios.post(
				"http://localhost:50021/audio_query",
				null,
				{
					params: { text, speaker: speaker.id },
				}
			);

			// 音声パラメータの設定
			const speedScale = interaction.options.getNumber("speed") || 1.0;
			const pitchScale = interaction.options.getNumber("pitch") || 0;
			const intonationScale =
				interaction.options.getNumber("intonation") || 1.0;
			const volumeScale = interaction.options.getNumber("volume") || 1.0;

			query.data.speedScale = speedScale;
			query.data.pitchScale = pitchScale;
			query.data.intonationScale = intonationScale;
			query.data.volumeScale = volumeScale;

			const synthesis = await axios.post(
				"http://localhost:50021/synthesis",
				query.data,
				{
					params: { speaker: speaker.id },
					responseType: "arraybuffer",
				}
			);

			const tempFilePath = join(
				voiceTmpPath,
				`temp_audio_${Date.now()}.wav`
			);
			writeFileSync(tempFilePath, Buffer.from(synthesis.data));

			const resource = createAudioResource(tempFilePath);

			player.play(resource);

			await interaction.editReply({
				content: `読み上げを開始しました。選択された話者: ${speakerName}\n速度: ${speedScale}, 音高: ${pitchScale}, 抑揚: ${intonationScale}, 音量: ${volumeScale}`,
				ephemeral: true,
			});

			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				if (connection) {
					connection.destroy();
					console.log("Timeout: ボイスチャンネルから退出しました。");
				}
			}, TIMEOUT);

			player.on("error", (error) => {
				console.error("Error:", error);
				interaction.followUp({
					content: "音声の再生中にエラーが発生しました。",
					ephemeral: true,
				});
			});

			player.on(AudioPlayerStatus.Idle, () => {
				try {
					unlinkSync(tempFilePath);
					console.log(
						`Temporary file ${tempFilePath} has been deleted.`
					);
				} catch (err) {
					console.error(`Error deleting temporary file: ${err}`);
				}
			});
		} catch (error) {
			console.error("Error in command execution:", error);
			await interaction.editReply({
				content: "読み上げ中にエラーが発生しました。",
				ephemeral: true,
			});
		}
	} else if (commandName === "vvai") {
		const question = interaction.options.getString("question");
		const speakerName =
			interaction.options.getString("speaker") || "ずんだもん (ノーマル)";
		const guild = interaction.guild;
		if (!guild) {
			await interaction.reply({
				content: "このコマンドはサーバー内でのみ使用できます。",
				ephemeral: true,
			});
			return;
		}

		let voiceChannel;
		const specifiedChannelId = interaction.options.getString("channelid");

		if (specifiedChannelId) {
			voiceChannel = guild.channels.cache.get(specifiedChannelId);
		} else {
			voiceChannel = interaction.member.voice.channel;
		}

		if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
			await interaction.reply({
				content:
					"有効な音声チャンネルが見つかりません。ボイスチャンネルに入室するか、有効なチャンネルIDを指定してください。",
				ephemeral: true,
			});
			return;
		}

		const speaker = voicevoxSpeakers.find((s) => s.name === speakerName);
		if (!speaker) {
			await interaction.reply({
				content: "指定された話者が見つかりません。",
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		try {
			console.log("AIに質問:", question);

			// Geminiモデルを使用して回答を生成;
			const aiResponse = await gemini.invoke([
				new HumanMessage(question),
			]);

			const responseText = aiResponse.content;

			let connection = getVoiceConnection(guild.id);
			if (!connection) {
				connection = joinVoiceChannel({
					channelId: voiceChannel.id,
					guildId: guild.id,
					adapterCreator: guild.voiceAdapterCreator,
					selfDeaf: false,
					selfMute: false,
				});
			}

			const player = createAudioPlayer({
				behaviors: {
					noSubscriber: NoSubscriberBehavior.Pause,
				},
			});

			connection.subscribe(player);

			// VoiceVox APIを使用して音声を生成
			const query = await axios.post(
				"http://localhost:50021/audio_query",
				null,
				{
					params: { text: responseText, speaker: speaker.id },
				}
			);

			const synthesis = await axios.post(
				"http://localhost:50021/synthesis",
				query.data,
				{
					params: { speaker: speaker.id },
					responseType: "arraybuffer",
				}
			);

			const tempFilePath = join(
				voiceTmpPath,
				`temp_audio_${Date.now()}.wav`
			);
			writeFileSync(tempFilePath, Buffer.from(synthesis.data));

			const resource = createAudioResource(tempFilePath);

			player.play(resource);

			await interaction.editReply({
				content: `AIの回答: ${responseText}\n\n読み上げを開始しました。選択された話者: ${speakerName}`,
				ephemeral: true,
			});

			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				if (connection) {
					connection.destroy();
					console.log("Timeout: ボイスチャンネルから退出しました。");
				}
			}, TIMEOUT);

			player.on("error", (error) => {
				console.error("Error:", error);
				interaction.followUp({
					content: "音声の再生中にエラーが発生しました。",
					ephemeral: true,
				});
			});

			player.on(AudioPlayerStatus.Idle, () => {
				try {
					unlinkSync(tempFilePath);
					console.log(
						`Temporary file ${tempFilePath} has been deleted.`
					);
				} catch (err) {
					console.error(`Error deleting temporary file: ${err}`);
				}
			});
		} catch (error) {
			console.error("Error in command execution:", error);
			await interaction.editReply({
				content: "AIの回答生成または読み上げ中にエラーが発生しました。",
				ephemeral: true,
			});
		}
	} else if (commandName === "lvv") {
		const guild = interaction.guild;
		const connection = getVoiceConnection(guild.id);

		if (connection) {
			connection.destroy();
			if (timeoutId) clearTimeout(timeoutId);
			await interaction.reply({
				content: "ボイスチャンネルから退出しました。",
				ephemeral: true,
			});
		} else {
			await interaction.reply({
				content: "ボットはボイスチャンネルに接続していません。",
				ephemeral: true,
			});
		}
	}
});

client.login(token);

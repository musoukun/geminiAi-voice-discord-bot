import axios from "axios";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";
import {
	createAudioPlayer,
	createAudioResource,
	NoSubscriberBehavior,
} from "@discordjs/voice";
import { voicevoxSpeakers, voiceTmpPath } from "./index.js";
import { connectToVoiceChannel, setDisconnectTimeout } from "./discordUtils.js";
import { ChannelType } from "discord.js";
import { AudioPlayerStatus } from "@discordjs/voice";
import { completeInteraction } from "./discordUtils.js";

export async function fetchVoicevoxSpeakers() {
	try {
		const response = await axios.get("http://localhost:50021/speakers");
		voicevoxSpeakers.push(
			...response.data.flatMap((speaker) =>
				speaker.styles.map((style) => ({
					name: `${speaker.name} (${style.name})`,
					id: style.id,
				}))
			)
		);
		console.log("VOICEVOX speakers loaded:", voicevoxSpeakers.length);
	} catch (error) {
		console.error("Failed to fetch VOICEVOX speakers:", error);
	}
}

export async function generateVoicevoxAudio(text, speakerId, options = {}) {
	const query = await axios.post("http://localhost:50021/audio_query", null, {
		params: { text, speaker: speakerId },
	});

	// 音声パラメータの設定
	query.data.speedScale = options.speed || 1.0;
	query.data.pitchScale = options.pitch || 0;
	query.data.intonationScale = options.intonation || 1.0;
	query.data.volumeScale = options.volume || 1.0;

	const synthesis = await axios.post(
		"http://localhost:50021/synthesis",
		query.data,
		{
			params: { speaker: speakerId },
			responseType: "arraybuffer",
		}
	);

	const tempFilePath = join(voiceTmpPath, `temp_audio_${Date.now()}.wav`);
	writeFileSync(tempFilePath, Buffer.from(synthesis.data));

	return { tempFilePath, resource: createAudioResource(tempFilePath) };
}

export async function playAudio(interaction, text, speakerName, options = {}) {
	const guild = interaction.guild;
	let voiceChannel = options.channelId
		? guild.channels.cache.get(options.channelId)
		: interaction.member.voice.channel;

	if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
		throw new Error("有効な音声チャンネルが見つかりません。");
	}

	const speaker = voicevoxSpeakers.find((s) => s.name === speakerName);
	if (!speaker) {
		throw new Error("指定された話者が見つかりません。");
	}

	const connection = connectToVoiceChannel(guild, voiceChannel);
	const player = createAudioPlayer({
		behaviors: {
			noSubscriber: NoSubscriberBehavior.Pause,
		},
	});

	connection.subscribe(player);

	const { tempFilePath, resource } = await generateVoicevoxAudio(
		text,
		speaker.id,
		options
	);

	player.play(resource);

	setDisconnectTimeout(connection);

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
			console.log(`Temporary file ${tempFilePath} has been deleted.`);
		} catch (err) {
			console.error(`Error deleting temporary file: ${err}`);
		}
	});

	return { player, connection };
}

export async function handleVVCommand(interaction) {
	const text = interaction.options.getString("text");
	let speakerName =
		interaction.options.getString("speaker") || "ずんだもん (ノーマル)";
	if (speakerName === "custom") {
		speakerName = interaction.options.getString("custom_speaker");
	}

	const options = {
		channelId: interaction.options.getString("channelid"),
		speed: interaction.options.getNumber("speed"),
		pitch: interaction.options.getNumber("pitch"),
		intonation: interaction.options.getNumber("intonation"),
		volume: interaction.options.getNumber("volume"),
	};

	await interaction.deferReply({ ephemeral: true });

	try {
		await playAudio(interaction, text, speakerName, options);
		await interaction.editReply({
			content: `読み上げを開始しました。選択された話者: ${speakerName}\n速度: ${options.speed || 1.0}, 音高: ${options.pitch || 0}, 抑揚: ${options.intonation || 1.0}, 音量: ${options.volume || 1.0}`,
			ephemeral: true,
		});
	} catch (error) {
		console.error("Error in VV command execution:", error);
		await interaction.editReply({
			content: "読み上げ中にエラーが発生しました。",
			ephemeral: true,
		});
	} finally {
		completeInteraction(interaction.user.id);
	}
}

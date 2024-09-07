import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { handleVVCommand } from "./voicevoxUtils.js";
import { handleVVAICommand } from "./aiUtils.js";
import { voicevoxSpeakers, TIMEOUT } from "./index.js";

export async function initializeCommands(applicationId, guildId, token) {
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

export async function handleInteraction(interaction) {
	if (!interaction.isCommand()) return;

	const { commandName } = interaction;

	try {
		if (commandName === "vv") {
			await handleVVCommand(interaction);
		} else if (commandName === "vvai") {
			await handleVVAICommand(interaction);
		} else if (commandName === "lvv") {
			await handleLVVCommand(interaction);
		}
	} catch (error) {
		console.error("Error in command execution:", error);
		await interaction.editReply({
			content: "コマンドの実行中にエラーが発生しました。",
			ephemeral: true,
		});
	}
}

export function connectToVoiceChannel(guild, voiceChannel) {
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
	return connection;
}

export async function handleLVVCommand(interaction) {
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
let timeoutId = null;
export function setDisconnectTimeout(connection) {
	if (timeoutId) clearTimeout(timeoutId);
	timeoutId = setTimeout(() => {
		if (connection) {
			connection.destroy();
			console.log("Timeout: ボイスチャンネルから退出しました。");
		}
	}, TIMEOUT);
}

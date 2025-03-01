import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { handleVVCommand } from "./voicevoxUtils.js";
import { handleVVAICommand } from "./aiUtils.js";
import { voicevoxSpeakers, TIMEOUT } from "./index.js";
import {
	setupVoiceRecognition,
	stopVoiceRecognition,
	recordUserVoice,
} from "./voiceRecognitionUtils.js";

// インタラクションの状態を追跡するためのMap
const interactionQueue = new Map();

// 音声認識の状態を追跡するためのMap
const listeningGuilds = new Map();

// インタラクションの処理状態をチェックし、設定する関数
function checkAndSetInteractionState(interaction) {
	const userId = interaction.user.id;
	if (interactionQueue.has(userId)) {
		return false; // すでに処理中
	}
	interactionQueue.set(userId, true);
	return true; // 処理開始可能
}

// インタラクションの処理完了を記録する関数
export function completeInteraction(userId) {
	interactionQueue.delete(userId);
}

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

	// discordUtils.js の vvaiCommand 部分を修正
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
		)
		.addBooleanOption((option) =>
			option
				.setName("search")
				.setDescription(
					"Google検索を使用するかどうか（デフォルト: false）"
				)
				.setRequired(false)
		);

	// 新しい音声認識コマンドの追加
	const vvListenCommand = new SlashCommandBuilder()
		.setName("vvlisten")
		.setDescription(
			"ボイスチャットでの会話を「ジェミニ」というキーワードで認識し応答します"
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
		);

	// 音声認識を停止するコマンド
	const vvStopListenCommand = new SlashCommandBuilder()
		.setName("vvstoplisten")
		.setDescription("音声認識を停止します");

	// 音声録音コマンド
	const vvRecordCommand = new SlashCommandBuilder()
		.setName("vvrecord")
		.setDescription("ユーザーの音声を録音します")
		.addStringOption((option) =>
			option
				.setName("channelid")
				.setDescription("ボイスチャンネルのID（省略可能）")
				.setRequired(false)
		)
		.addNumberOption((option) =>
			option
				.setName("duration")
				.setDescription("録音時間（秒）（デフォルト: 5秒）")
				.setRequired(false)
				.setMinValue(1)
				.setMaxValue(30)
		)
		.addUserOption((option) =>
			option
				.setName("user")
				.setDescription(
					"録音するユーザー（省略可能、省略時は最初に話したユーザー）"
				)
				.setRequired(false)
		);

	const commands = [
		vvCommand.toJSON(),
		vvaiCommand.toJSON(),
		lvvCommand.toJSON(),
		vvListenCommand.toJSON(),
		vvStopListenCommand.toJSON(),
		vvRecordCommand.toJSON(),
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
	const userId = interaction.user.id;

	if (!checkAndSetInteractionState(interaction)) {
		await interaction.reply({
			content: "前回のコマンドの処理が完了するまでお待ちください。",
			ephemeral: true,
		});
		return;
	}

	try {
		if (commandName === "vv") {
			await handleVVCommand(interaction);
		} else if (commandName === "vvai") {
			await handleVVAICommand(interaction);
		} else if (commandName === "lvv") {
			await handleLVVCommand(interaction);
		} else if (commandName === "vvlisten") {
			await handleVVListenCommand(interaction);
		} else if (commandName === "vvstoplisten") {
			await handleVVStopListenCommand(interaction);
		} else if (commandName === "vvrecord") {
			await handleVVRecordCommand(interaction);
		}
	} catch (error) {
		console.error("Error in command execution:", error);
		await interaction.editReply({
			content: "コマンドの実行中にエラーが発生しました。",
			ephemeral: true,
		});
	} finally {
		completeInteraction(userId);
	}
}

// 新しい音声認識開始コマンドの処理
async function handleVVListenCommand(interaction) {
	try {
		await interaction.deferReply({ ephemeral: true });

		const guild = interaction.guild;
		if (!guild) {
			await interaction.editReply({
				content: "このコマンドはサーバー内でのみ使用できます。",
				ephemeral: true,
			});
			return;
		}

		// ボイスチャンネルの取得
		let voiceChannel = interaction.options.getString("channelid")
			? guild.channels.cache.get(
					interaction.options.getString("channelid")
				)
			: interaction.member.voice.channel;

		if (!voiceChannel) {
			await interaction.editReply({
				content:
					"ボイスチャンネルに入室してから、もう一度コマンドを実行してください。",
				ephemeral: true,
			});
			return;
		}

		// すでに認識中かチェック
		if (listeningGuilds.has(guild.id)) {
			await interaction.editReply({
				content: "すでに音声認識が開始されています。",
				ephemeral: true,
			});
			return;
		}

		// ボイスチャンネルに接続
		const connection = connectToVoiceChannel(guild, voiceChannel);
		listeningGuilds.set(guild.id, {
			connection,
			channelId: voiceChannel.id,
		});

		// 音声認識の初期化
		await setupVoiceRecognition(connection, guild, interaction.client);

		await interaction.editReply({
			content:
				"音声認識を開始しました。「ジェミニ」と話しかけると応答します。",
			ephemeral: true,
		});
	} catch (error) {
		console.error("Error in VVListen command execution:", error);
		await interaction.editReply({
			content: "音声認識の開始中にエラーが発生しました。",
			ephemeral: true,
		});
	}
}

// 音声認識停止コマンドの処理
async function handleVVStopListenCommand(interaction) {
	try {
		await interaction.deferReply({ ephemeral: true });

		const guild = interaction.guild;
		if (!guild) {
			await interaction.editReply({
				content: "このコマンドはサーバー内でのみ使用できます。",
				ephemeral: true,
			});
			return;
		}

		// 認識中でなければエラー
		if (!listeningGuilds.has(guild.id)) {
			await interaction.editReply({
				content: "音声認識は開始されていません。",
				ephemeral: true,
			});
			return;
		}

		// 音声認識を停止
		stopVoiceRecognition(guild.id);
		listeningGuilds.delete(guild.id);

		await interaction.editReply({
			content: "音声認識を停止しました。",
			ephemeral: true,
		});
	} catch (error) {
		console.error("Error in VVStopListen command execution:", error);
		await interaction.editReply({
			content: "音声認識の停止中にエラーが発生しました。",
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

	try {
		if (connection) {
			connection.destroy();
			if (timeoutId) clearTimeout(timeoutId);

			// 音声認識が有効なら停止
			if (listeningGuilds.has(guild.id)) {
				stopVoiceRecognition(guild.id);
				listeningGuilds.delete(guild.id);
			}

			await interaction.reply({
				content: "ボイスチャンネルから退出しました。",
				ephemeral: true,
			});
		} else {
			await interaction.reply({
				content: "ジェミニはボイスチャンネルに接続していません。",
				ephemeral: true,
			});
		}
	} finally {
		completeInteraction(interaction.user.id);
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

// 音声録音コマンドの処理
async function handleVVRecordCommand(interaction) {
	try {
		await interaction.deferReply({ ephemeral: true });

		const guild = interaction.guild;
		if (!guild) {
			await interaction.editReply({
				content: "このコマンドはサーバー内でのみ使用できます。",
				ephemeral: true,
			});
			return;
		}

		// チャンネルIDの取得
		const channelId = interaction.options.getString("channelid");
		let voiceChannel;

		if (channelId) {
			// 指定されたチャンネルIDを使用
			voiceChannel = guild.channels.cache.get(channelId);
			if (!voiceChannel || voiceChannel.type !== 2) {
				await interaction.editReply({
					content: "指定されたIDのボイスチャンネルが見つかりません。",
					ephemeral: true,
				});
				return;
			}
		} else {
			// ユーザーが参加しているボイスチャンネルを使用
			const member = guild.members.cache.get(interaction.user.id);
			voiceChannel = member?.voice?.channel;
			if (!voiceChannel) {
				await interaction.editReply({
					content:
						"ボイスチャンネルに参加してから実行するか、チャンネルIDを指定してください。",
					ephemeral: true,
				});
				return;
			}
		}

		// 録音時間の取得（秒単位）
		const durationSec = interaction.options.getNumber("duration") || 5;
		const durationMs = durationSec * 1000;

		// 録音するユーザーの取得
		const targetUser = interaction.options.getUser("user");
		const targetUserId = targetUser?.id;

		// ボイスチャンネルに接続
		const connection = connectToVoiceChannel(guild, voiceChannel);

		await interaction.editReply({
			content: `${voiceChannel.name} で録音を開始します。録音時間: ${durationSec}秒`,
			ephemeral: true,
		});

		if (targetUserId) {
			// 特定のユーザーを録音
			try {
				const recordingPath = await recordUserVoice(
					connection,
					targetUserId,
					durationMs
				);
				await interaction.followUp({
					content: `録音が完了しました。ファイル: ${recordingPath}`,
					ephemeral: true,
				});
			} catch (error) {
				console.error("録音エラー:", error);
				await interaction.followUp({
					content: "録音中にエラーが発生しました。",
					ephemeral: true,
				});
			}
		} else {
			// 最初に話したユーザーを録音するモード
			await interaction.followUp({
				content:
					"最初に話したユーザーの音声を録音します。誰か話し始めてください...",
				ephemeral: true,
			});

			// 話し始めたユーザーを検出するリスナーを設定
			const speakingHandler = (userId) => {
				// 一度だけ実行するために、リスナーを削除
				connection.receiver.speaking.off("start", speakingHandler);

				// 録音を開始
				recordUserVoice(connection, userId, durationMs)
					.then((recordingPath) => {
						interaction.followUp({
							content: `ユーザー <@${userId}> の録音が完了しました。ファイル: ${recordingPath}`,
							ephemeral: true,
						});
					})
					.catch((error) => {
						console.error("録音エラー:", error);
						interaction.followUp({
							content: "録音中にエラーが発生しました。",
							ephemeral: true,
						});
					});
			};

			// 話し始めイベントのリスナーを追加
			connection.receiver.speaking.on("start", speakingHandler);

			// タイムアウト処理（30秒後に誰も話さなかった場合）
			setTimeout(() => {
				// リスナーがまだ存在するか確認（録音が開始されていない場合）
				if (connection.receiver.speaking.listenerCount("start") > 0) {
					connection.receiver.speaking.off("start", speakingHandler);
					interaction.followUp({
						content:
							"30秒間誰も話さなかったため、録音をキャンセルしました。",
						ephemeral: true,
					});
				}
			}, 30000);
		}
	} catch (error) {
		console.error("Error in VVRecord command execution:", error);
		await interaction.editReply({
			content: "録音の開始中にエラーが発生しました。",
			ephemeral: true,
		});
	}
}

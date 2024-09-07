import {
	Client,
	GatewayIntentBits,
	ChannelType,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import {
	entersState,
	AudioPlayerStatus,
	createAudioPlayer,
	createAudioResource,
	joinVoiceChannel,
	StreamType,
	NoSubscriberBehavior,
} from "@discordjs/voice";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { token, applicationId, guildId } = JSON.parse(
	readFileSync("./config.json", "utf8")
);

const soundPath = join(__dirname, "sounds");
const soundFiles = readdirSync(soundPath).filter(
	(file) => file.endsWith(".mp3") || file.endsWith(".wav")
);
let soundFilePath = {};

for (const file of soundFiles) {
	const extractExtension = file.split(".")[0];
	const filePath = join(soundPath, file);
	soundFilePath[extractExtension] = filePath;
}

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// スラッシュコマンドの定義
const commands = [
	new SlashCommandBuilder()
		.setName("so")
		.setDescription("Play sound in a specific voice channel")
		.addStringOption((option) =>
			option
				.setName("channelid")
				.setDescription("The ID of the voice channel")
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName("sound")
				.setDescription("The name of the sound file to play")
				.setRequired(true)
		),
];

// RESTインスタンスの作成
const rest = new REST({ version: "10" }).setToken(token);

// スラッシュコマンドの登録関数
async function registerCommands() {
	try {
		console.log("Started refreshing application (/) commands.");
		await rest.put(
			Routes.applicationGuildCommands(applicationId, guildId),
			{ body: commands }
		);
		console.log("Successfully reloaded application (/) commands.");
	} catch (error) {
		console.error(error);
	}
}

client.once("ready", () => {
	console.log(`Ready! Logged in as ${client.user?.tag}`);
	console.log(`Application ID: ${applicationId}`);
	console.log(`Guild ID: ${guildId}`);
	console.log("Available sound files:", Object.keys(soundFilePath));
	registerCommands();
});

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isCommand()) return;

	const { commandName } = interaction;

	if (commandName === "so") {
		const channelId = interaction.options.getString("channelid");
		const soundName = interaction.options.getString("sound");
		const guild = client.guilds.cache.get(guildId);
		const voiceChannel = guild.channels.cache.get(channelId);

		if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
			await interaction.reply({
				content: "無効な音声チャンネルIDです。",
				ephemeral: true,
			});
			return;
		}

		try {
			await interaction.reply({ content: "\u200B", ephemeral: true });

			const connection = joinVoiceChannel({
				channelId: voiceChannel.id,
				guildId: guild.id,
				adapterCreator: guild.voiceAdapterCreator,
				selfDeaf: false,
				selfMute: false,
			});

			const player = createAudioPlayer({
				behaviors: {
					noSubscriber: NoSubscriberBehavior.Pause,
				},
			});

			connection.subscribe(player);

			const audioFile = soundFilePath[soundName];
			if (!audioFile || !existsSync(audioFile)) {
				throw new Error(`Audio file not found: ${soundName}`);
			}

			console.log("Audio file path:", audioFile);

			const resource = createAudioResource(audioFile, {
				inputType:
					extname(audioFile) === ".wav"
						? StreamType.Arbitrary
						: StreamType.OggOpus,
			});

			player.play(resource);

			console.log("Starting to play audio");

			await entersState(player, AudioPlayerStatus.Playing, 10 * 1000);
			await entersState(
				player,
				AudioPlayerStatus.Idle,
				24 * 60 * 60 * 1000
			);

			console.log("Finished playing audio");
			connection.destroy();
		} catch (error) {
			console.error("Error in command execution:", error);
			// エラーメッセージを送信せずに、コンソールにのみログを残す
		}
	}
});

client.login(token);

import { Client, GatewayIntentBits } from "discord.js";
import { join } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { initializeCommands, handleInteraction } from "./discordUtils.js";
import { fetchVoicevoxSpeakers } from "./voicevoxUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 設定の読み込み(トークン、アプリケーションID、ギルドID)
// この処理が終わるまで他の処理を行わないようにするため同期的に読み込む
export const { token, applicationId, guildId } = JSON.parse(
	readFileSync(join(__dirname, "config_hanada.json"), "utf8")
);

// 定数
export const TIMEOUT = 30 * 60 * 1000; // 30分
export const voiceTmpPath = join(__dirname, "voiceTmp");

// グローバル変数
export let voicevoxSpeakers = [];
export let timeoutId = null;

// 初期化処理
async function initialize() {
	if (!existsSync(voiceTmpPath)) {
		mkdirSync(voiceTmpPath);
	}

	await fetchVoicevoxSpeakers();
	await initializeCommands(applicationId, guildId, token);
}

// メインの処理
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
	console.log(`Ready! Logged in as ${client.user.tag}`);
	await initialize();
});

client.on("interactionCreate", handleInteraction);

client.login(token);

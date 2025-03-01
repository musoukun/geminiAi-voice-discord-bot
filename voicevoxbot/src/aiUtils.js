import { join } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
	RunnableSequence,
	RunnablePassthrough,
} from "@langchain/core/runnables";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { playAudio } from "./voicevoxUtils.js";
import { completeInteraction } from "./discordUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));

const { googleApiKey } = config;

// インタラクション状態の追跡
const pendingInteractions = new Map();
const chatHistories = {};

export async function generateAIResponse(question, userId, useSearch = false) {
	try {
		console.log(`AI生成開始: ユーザー ${userId}, 質問: "${question}"`);

		// すべてのケースで会話履歴を初期化
		if (!chatHistories[userId]) {
			chatHistories[userId] = [];
			console.log(
				`新しいユーザー ${userId} のチャット履歴を初期化しました。`
			);
		}

		let response;

		if (useSearch) {
			console.log("検索機能を使用します");

			// Gemini 2.0での検索ツール設定
			const model = new ChatGoogleGenerativeAI({
				apiKey: googleApiKey,
				modelName: "gemini-2.0-flash-exp",
			});

			// 文字数制限を設定
			const searchLengthLimit = 160;

			// 検索ツールを定義
			const tools = [
				{
					googleSearch: {},
				},
			];

			// 検索のためのプロンプト形式を改善
			const result = await model.invoke(
				[
					[
						"human",
						`${question}
					
以下の指示に従って回答してください：
1. 最新の情報で詳しく答えてください
2. 回答は必ず日本語で提供してください
3. 回答は${searchLengthLimit}文字以内に要約してください
4. 重要なポイントだけを簡潔に伝えてください
5. 冗長な表現や不要な説明は省いてください
6. 箇条書きなど読みやすい形式を使ってください
7. 「承知しました」「わかりました」などの前置きは一切省き、直接結果だけを回答してください
8. 質問の繰り返しも不要です。直接答えから始めてください`,
					],
				],
				{ tools: tools }
			);

			// 結果から応答テキストを取得
			response = result.content;

			console.log(`検索を使用したAI生成完了`);
		} else {
			console.log("通常の会話モードを使用します");

			// 検索なしの通常の会話向け設定
			const lengthLimit = 250;
			const systemPromptContent = `あなたは質問者の質問に日本語で簡潔にこたえるアシスタントです。
        \n質問内容は要約して${lengthLimit}文字以内で回答してください。
        \nわからない場合は「わかりません」と回答してください。
        \n${lengthLimit}文字以上の文章が長くなりそうな回答を求められた場合は、簡潔に要約して回答してください。
        \n要約できなければ、長文で回答することが難しいことを伝えてください。自身について質問されたら、目的のみを伝えてください。
        \n「了解しました」「わかりました」などの前置きを一切省き、直接結果だけを回答してください。
        \n質問を繰り返す必要はありません。直接答えから始めてください。
        \n会話履歴:{chat_history} 
        \n現在の時刻(MM月DD日 mm時:ss分で回答してください): {now}
        \n入力内容: {input}`;

			const prompt = ChatPromptTemplate.fromMessages([
				["system", systemPromptContent],
				["placeholder", "{chat_history}"],
				["human", "{input}"],
			]);

			// 日本語形式の日時を生成
			const now = new Date();
			const formattedDate = `${String(now.getMonth() + 1).padStart(2, "0")}月${String(now.getDate()).padStart(2, "0")}日 ${String(now.getHours()).padStart(2, "0")}時:${String(now.getMinutes()).padStart(2, "0")}分`;

			const model = new ChatGoogleGenerativeAI({
				apiKey: googleApiKey,
				modelName: "gemini-2.0-flash",
			});

			const chain = RunnableSequence.from([
				RunnablePassthrough.assign({
					chat_history: ({ chat_history }) => chat_history.slice(-10),
				}),
				prompt,
				model,
				new StringOutputParser(),
			]);

			response = await chain.invoke({
				chat_history: chatHistories[userId],
				input: question,
				now: formattedDate,
			});

			console.log(`AI生成完了: "${response.substring(0, 50)}..."`);
		}

		// 会話履歴を更新
		chatHistories[userId].push(new HumanMessage(question));
		chatHistories[userId].push(new AIMessage(response));

		console.log(
			`ユーザー ${userId} のチャット履歴を更新しました。現在の履歴数: ${chatHistories[userId].length}`
		);

		console.log("AI生成 : ", response);
		return response;
	} catch (error) {
		console.error("AI生成エラー:", error);
		// エラー詳細ログ
		if (error.response) {
			console.error("エラーレスポンス:", error.response);
		}
		throw error; // エラーを上位に伝播させる
	}
}

export async function handleVVAICommand(interaction) {
	try {
		// インタラクションが進行中かチェック
		const userId = interaction.user.id;
		if (pendingInteractions.has(userId)) {
			await interaction.reply({
				content: "前回のコマンドの処理が完了するまでお待ちください。",
				ephemeral: true,
			});
			return;
		}

		// 処理中フラグを設定
		pendingInteractions.set(userId, true);

		// 即時応答（3秒以内に応答しないとDiscordがタイムアウトエラーを表示）
		await interaction.deferReply({ ephemeral: true });

		try {
			const question = interaction.options.getString("question");
			const speakerName =
				interaction.options.getString("speaker") ||
				"ずんだもん (ノーマル)";
			const channelId = interaction.options.getString("channelid");
			const useSearch = interaction.options.getBoolean("search") || false;

			if (!interaction.guild) {
				await interaction.editReply({
					content: "このコマンドはサーバー内でのみ使用できます。",
					ephemeral: true,
				});
				pendingInteractions.delete(userId);
				return;
			}

			// ユーザーのボイスチャンネル状態をチェック
			const voiceChannel = interaction.member.voice.channel;
			if (!voiceChannel && !channelId) {
				await interaction.editReply({
					content:
						"ボイスチャンネルに入室してから、もう一度コマンドを実行してください。",
					ephemeral: true,
				});
				pendingInteractions.delete(userId);
				return;
			}

			console.log(
				"AIに質問:",
				question,
				"検索機能:",
				useSearch ? "有効" : "無効"
			);

			// 処理に時間がかかることを通知
			await interaction.editReply({
				content: `質問を処理中です...\n質問: ${question}\n検索機能: ${useSearch ? "有効" : "無効"}`,
				ephemeral: true,
			});

			// 非同期処理
			let responseText;
			try {
				responseText = await generateAIResponse(
					question,
					interaction.user.id,
					useSearch
				);
			} catch (error) {
				console.error("AI応答生成エラー:", error);
				await interaction.editReply({
					content:
						"AIの回答生成中にエラーが発生しました。もう一度お試しください。",
					ephemeral: true,
				});
				pendingInteractions.delete(userId);
				return;
			}

			const options = { channelId };

			// 音声再生処理
			try {
				await playAudio(
					interaction,
					responseText,
					speakerName,
					options
				);
			} catch (error) {
				console.error("音声再生エラー:", error);
				await interaction.editReply({
					content: `質問:${question}\n\n AIの回答: ${responseText}\n\n音声再生中にエラーが発生しました。`,
					ephemeral: true,
				});
				pendingInteractions.delete(userId);
				return;
			}

			// 最終応答
			await interaction.editReply({
				content: `質問:${question}\n\n AIの回答: ${responseText}\n\n読み上げを開始しました。選択された話者: ${speakerName}${useSearch ? "\n(Googleによる情報で補完)" : ""}`,
				ephemeral: true,
			});
		} finally {
			// 処理完了、別の処理の準備ができた状態にフラグを解除
			pendingInteractions.delete(userId);
			completeInteraction(userId);
		}
	} catch (error) {
		// 最終的なエラーハンドリング
		console.error("VVAI command execution error:", error);
		try {
			await interaction.editReply({
				content: "コマンドの実行中に予期しないエラーが発生しました。",
				ephemeral: true,
			});
		} catch (replyError) {
			console.error("Failed to send error reply:", replyError);
		}

		// エラーが発生した場合でも、次のコマンドが処理できるようにする
		if (interaction.user) {
			pendingInteractions.delete(interaction.user.id);
			completeInteraction(interaction.user.id);
		}
	}
}

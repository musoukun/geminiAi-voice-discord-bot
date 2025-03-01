import {
	EndBehaviorType,
	getVoiceConnection,
	VoiceReceiver,
} from "@discordjs/voice";
import { join } from "path";
import { pipeline } from "stream";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import prism from "prism-media";

// ストリームパイプラインをプロミス化
const pipelineAsync = promisify(pipeline);

// 録音の状態を追跡
const voiceRecognitionState = new Map();

// 録音保存用のディレクトリを動的に設定
let RECORDINGS_DIR;

/**
 * 録音機能の初期化
 * @param {string} basePath - 基本となるパス
 */
export function initVoiceRecording(basePath) {
	// 録音保存用のディレクトリを設定
	RECORDINGS_DIR = join(basePath, "recordings");

	// ディレクトリが存在しない場合は作成
	if (!existsSync(RECORDINGS_DIR)) {
		mkdirSync(RECORDINGS_DIR, { recursive: true });
	}

	console.log(
		`Voice recording initialized. Recordings will be saved to: ${RECORDINGS_DIR}`
	);
}

/**
 * WAVファイルのヘッダーを生成する
 * @param {Object} options - WAVヘッダーのオプション
 * @returns {Buffer} WAVヘッダーのバッファ
 */
function createWavHeader(options) {
	const numChannels = options.channels || 2;
	const sampleRate = options.sampleRate || 48000;
	const bitsPerSample = options.bitsPerSample || 16;

	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);

	const buffer = Buffer.alloc(44);

	// RIFFチャンク
	buffer.write("RIFF", 0);
	// ファイルサイズ (後で更新)
	buffer.writeUInt32LE(0, 4);
	buffer.write("WAVE", 8);

	// fmtチャンク
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16); // fmtチャンクのサイズ
	buffer.writeUInt16LE(1, 20); // PCMフォーマット
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);

	// dataチャンク
	buffer.write("data", 36);
	// データサイズ (後で更新)
	buffer.writeUInt32LE(0, 40);

	return buffer;
}

/**
 * WAVファイルのヘッダーを更新する
 * @param {string} filePath - WAVファイルのパス
 * @param {number} fileSize - ファイルの合計サイズ
 */
async function updateWavHeader(filePath, fileSize) {
	const fd = await fs.promises.open(filePath, "r+");
	try {
		const buffer = Buffer.alloc(4);

		// RIFFチャンクのサイズを更新
		buffer.writeUInt32LE(fileSize - 8, 0);
		await fd.write(buffer, 0, 4, 4);

		// dataチャンクのサイズを更新
		buffer.writeUInt32LE(fileSize - 44, 0);
		await fd.write(buffer, 0, 4, 40);
	} finally {
		await fd.close();
	}
}

/**
 * 音声認識のセットアップ
 * @param {VoiceConnection} connection - ボイスコネクション
 * @param {Guild} guild - ディスコードのギルド(サーバー)
 * @param {Client} client - ディスコードのクライアント
 */
export async function setupVoiceRecognition(connection, guild, client) {
	// RECORDINGSディレクトリが初期化されているか確認
	if (!RECORDINGS_DIR) {
		throw new Error(
			"Voice recording hasn't been initialized. Call initVoiceRecording first."
		);
	}

	if (voiceRecognitionState.has(guild.id)) {
		console.log(`Guild ${guild.id} already has voice recognition setup.`);
		return;
	}

	console.log(`Setting up voice recognition for guild ${guild.id}.`);

	const state = {
		connection,
		guild,
		client,
		speakingUsers: new Map(),
		subscriptions: new Map(),
	};

	voiceRecognitionState.set(guild.id, state);

	// 話し始めイベントのリッスン
	connection.receiver.speaking.on("start", (userId) => {
		console.log(`User ${userId} started speaking in guild ${guild.id}.`);
		handleUserSpeaking(guild.id, userId);
	});
}

/**
 * 音声認識の停止
 * @param {string} guildId - ギルドID
 */
export function stopVoiceRecognition(guildId) {
	const state = voiceRecognitionState.get(guildId);
	if (!state) {
		console.log(`No voice recognition setup found for guild ${guildId}.`);
		return;
	}

	console.log(`Stopping voice recognition for guild ${guildId}.`);

	// すべての購読を終了
	for (const [userId, subscription] of state.subscriptions.entries()) {
		console.log(`Unsubscribing from user ${userId} in guild ${guildId}.`);
		subscription.destroy();
	}

	voiceRecognitionState.delete(guildId);
}

/**
 * ユーザーの発言を処理
 * @param {string} guildId - ギルドID
 * @param {string} userId - ユーザーID
 */
function handleUserSpeaking(guildId, userId) {
	const state = voiceRecognitionState.get(guildId);
	if (!state) return;

	// すでに購読済みの場合はスキップ
	if (state.subscriptions.has(userId)) {
		console.log(
			`Already subscribed to user ${userId} in guild ${guildId}.`
		);
		return;
	}

	const connection = state.connection;
	const receiver = connection.receiver;

	// 音声ストリームを取得
	const audioStream = receiver.subscribe(userId, {
		end: {
			behavior: EndBehaviorType.AfterSilence,
			duration: 300, // 300ミリ秒の無音で終了
		},
	});

	state.subscriptions.set(userId, audioStream);

	console.log(`Starting recording for user ${userId} in guild ${guildId}.`);

	// 音声の録音を開始
	recordAudioStream(guildId, userId, audioStream);
}

/**
 * 音声ストリームの録音
 * @param {string} guildId - ギルドID
 * @param {string} userId - ユーザーID
 * @param {AudioReceiveStream} audioStream - 音声受信ストリーム
 */
async function recordAudioStream(guildId, userId, audioStream) {
	try {
		const state = voiceRecognitionState.get(guildId);
		if (!state) return;

		// ファイル名の生成
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filePath = join(RECORDINGS_DIR, `${userId}-${timestamp}.wav`);

		console.log(`Recording to ${filePath}`);

		// WAVヘッダーを書き込む
		const wavHeader = createWavHeader({
			channels: 2,
			sampleRate: 48000,
			bitsPerSample: 16,
		});

		fs.writeFileSync(filePath, wavHeader);

		// WAVファイルにデータを追記するストリーム
		const fileStream = fs.createWriteStream(filePath, { flags: "a" });

		let totalBytesWritten = wavHeader.length;
		let packetsProcessed = 0;
		let hasErrors = false;

		// Opusパケットをバッファリング
		const opusChunks = [];

		// データ収集
		audioStream.on("data", (chunk) => {
			opusChunks.push(Buffer.from(chunk));
			packetsProcessed++;

			if (packetsProcessed % 50 === 0) {
				console.log(
					`Collected ${packetsProcessed} Opus packets for user ${userId}`
				);
			}

			// エラーチェック: 無効なOpusデータ
			if (chunk.length === 0) {
				console.warn(`Empty chunk received from user ${userId}`);
			}
		});

		// ストリームエラーの処理
		audioStream.on("error", (err) => {
			console.error(`Error in audio stream for user ${userId}:`, err);
			hasErrors = true;
		});

		// 音声ストリームが終了したとき
		audioStream.on("end", async () => {
			console.log(
				`Audio stream ended for user ${userId}. Processing ${opusChunks.length} chunks.`
			);

			if (opusChunks.length === 0) {
				console.warn(`No audio data collected for user ${userId}`);
				fs.unlinkSync(filePath); // 空のファイルを削除
				state.subscriptions.delete(userId);
				return;
			}

			// 個別にOpusパケットをデコードしてファイルに書き込む
			for (let i = 0; i < opusChunks.length; i++) {
				const chunk = opusChunks[i];
				try {
					// 各チャンク用に新しいデコーダーを作成
					const opusDecoder = new prism.opus.Decoder({
						frameSize: 960,
						channels: 2,
						rate: 48000,
					});

					// 単一パケットをデコード
					const decoded = opusDecoder.decode(chunk);

					if (decoded) {
						// バッファ内に異常なデータがないかチェック
						const pcmData = new Int16Array(
							decoded.buffer,
							decoded.byteOffset,
							decoded.length / 2
						);

						// サンプルの最小・最大値をチェック
						let min = Infinity;
						let max = -Infinity;
						let hasNaN = false;
						let zeroCount = 0;

						for (let j = 0; j < pcmData.length; j++) {
							const sample = pcmData[j];
							if (isNaN(sample)) {
								hasNaN = true;
							} else {
								min = Math.min(min, sample);
								max = Math.max(max, sample);
								if (sample === 0) zeroCount++;
							}
						}

						// サンプリングデータのデバッグログ
						if (i % 50 === 0) {
							console.log(
								`PCM stats for chunk ${i}/${opusChunks.length}:`
							);
							console.log(
								`- Min: ${min}, Max: ${max}, Zero count: ${zeroCount}/${pcmData.length}`
							);
							console.log(
								`- Has NaN: ${hasNaN}, Buffer size: ${decoded.length} bytes`
							);
						}

						if (hasNaN) {
							console.error(
								`NaN values detected in PCM data for chunk ${i}!`
							);
							hasErrors = true;
							continue; // NaN値を含むデータはスキップ
						}

						// ほとんどがゼロのデータはスキップ（無音）
						if (zeroCount > pcmData.length * 0.95) {
							if (i % 50 === 0) {
								console.warn(
									`Chunk ${i} is mostly silence (${zeroCount}/${pcmData.length} zeros), skipping`
								);
							}
							continue;
						}

						// ファイルに書き込み
						fileStream.write(decoded);
						totalBytesWritten += decoded.length;
					}
				} catch (decodeError) {
					console.error(
						`Error decoding opus packet ${i}:`,
						decodeError
					);
					hasErrors = true;
					// エラーが発生しても続行
				}
			}

			// ファイルストリームを閉じる
			fileStream.end();

			// ファイルストリームが完全に閉じられるのを待つ
			await new Promise((resolve) => {
				fileStream.on("close", resolve);
			});

			try {
				// WAVヘッダーの更新
				await updateWavHeader(filePath, totalBytesWritten);

				console.log(
					`Recording completed for user ${userId}. Total bytes: ${totalBytesWritten}, chunks processed: ${opusChunks.length}`
				);

				// エラーがあった場合の警告メッセージ
				if (hasErrors) {
					console.warn(
						`Recording completed with errors for user ${userId}. The file may be corrupted.`
					);
				}
			} catch (headerError) {
				console.error(`Error updating WAV header:`, headerError);
			}

			// 購読の終了
			state.subscriptions.delete(userId);
		});

		return filePath;
	} catch (error) {
		console.error(`Failed to record audio for user ${userId}:`, error);
		// 購読の終了を確保
		const state = voiceRecognitionState.get(guildId);
		if (state) {
			state.subscriptions.delete(userId);
		}
		throw error;
	}
}

/**
 * 特定のユーザーの音声を指定時間録音する
 * @param {VoiceConnection} connection - ボイスコネクション
 * @param {string} userId - 録音するユーザーID
 * @param {number} duration - 録音時間（ミリ秒）
 * @returns {Promise<string>} 録音ファイルのパス
 */
export async function recordUserVoice(connection, userId, duration = 5000) {
	// RECORDINGSディレクトリが初期化されているか確認
	if (!RECORDINGS_DIR) {
		throw new Error(
			"Voice recording hasn't been initialized. Call initVoiceRecording first."
		);
	}

	console.log(`Starting recording for user ${userId} for ${duration}ms`);

	return new Promise((resolve, reject) => {
		try {
			// 音声ストリームを取得
			const audioStream = connection.receiver.subscribe(userId, {
				end: {
					behavior: EndBehaviorType.Manual,
				},
			});

			if (!audioStream) {
				reject(
					new Error(`Could not subscribe to user ${userId}'s voice`)
				);
				return;
			}

			// ファイル名の生成
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const filePath = join(
				RECORDINGS_DIR,
				`recording-${userId}-${timestamp}.wav`
			);

			console.log(`Recording to file: ${filePath}`);

			// WAVヘッダーを書き込む
			const wavHeader = createWavHeader({
				channels: 2,
				sampleRate: 48000,
				bitsPerSample: 16,
			});

			fs.writeFileSync(filePath, wavHeader);

			// ファイルストリーム
			const fileStream = fs.createWriteStream(filePath, { flags: "a" });

			// デバッグカウンター
			let totalBytesWritten = wavHeader.length;
			let packetsProcessed = 0;
			let hasErrors = false;

			// データバッファリング用の配列
			const opusChunks = [];

			// データ収集
			audioStream.on("data", (chunk) => {
				opusChunks.push(Buffer.from(chunk));
				packetsProcessed++;

				if (packetsProcessed % 50 === 0) {
					console.log(
						`Collected ${packetsProcessed} Opus packets for user ${userId}`
					);
				}
			});

			// 録音完了のリスナー
			let recordingTimeout;

			// 録音が完了した時の処理
			const finishRecording = async () => {
				try {
					console.log(
						`Recording completed. Collected ${opusChunks.length} opus packets`
					);

					if (opusChunks.length === 0) {
						console.warn(
							"No audio data collected. User may not have spoken."
						);
						fs.unlinkSync(filePath); // 空のファイルを削除
						resolve(null);
						return;
					}

					// Opusパケットをデコードしてファイルに書き込む
					for (const chunk of opusChunks) {
						try {
							// OpusデコーダーとPCMフォーマッタの設定
							const opusDecoder = new prism.opus.Decoder({
								frameSize: 960,
								channels: 2,
								rate: 48000,
							});

							// 各チャンクをデコードしてファイルに書き込む
							const decoded = opusDecoder.decode(chunk);

							if (decoded) {
								// バッファ内に異常なデータがないかチェック
								const pcmData = new Int16Array(
									decoded.buffer,
									decoded.byteOffset,
									decoded.length / 2
								);

								// サンプルの最小・最大値をチェック
								let min = Infinity;
								let max = -Infinity;
								let hasNaN = false;
								let zeroCount = 0;

								for (let i = 0; i < pcmData.length; i++) {
									const sample = pcmData[i];
									if (isNaN(sample)) {
										hasNaN = true;
									} else {
										min = Math.min(min, sample);
										max = Math.max(max, sample);
										if (sample === 0) zeroCount++;
									}
								}

								// サンプリングデータのログ
								if (hasNaN) {
									console.error(
										`NaN values detected in PCM data for packet ${opusChunks.indexOf(chunk)}!`
									);
									hasErrors = true;
								}

								// デバッグログ
								if (opusChunks.indexOf(chunk) % 50 === 0) {
									console.log(
										`PCM stats for packet ${opusChunks.indexOf(chunk)}:`
									);
									console.log(
										`- Min: ${min}, Max: ${max}, Zero count: ${zeroCount}/${pcmData.length}`
									);
									console.log(
										`- Has NaN: ${hasNaN}, Buffer size: ${decoded.length} bytes`
									);
								}

								fileStream.write(decoded);
								totalBytesWritten += decoded.length;
							}
						} catch (decodeError) {
							console.error(
								`Error decoding opus packet:`,
								decodeError
							);
							hasErrors = true;
							// エラーが発生しても続行
						}
					}

					// ファイルストリームを閉じる
					fileStream.end();

					// WAVヘッダーの更新を待つ
					await new Promise((resolve) => {
						fileStream.on("close", resolve);
					});

					// WAVヘッダーを更新
					await updateWavHeader(filePath, totalBytesWritten);

					console.log(
						`Recording saved to ${filePath}. Total bytes: ${totalBytesWritten}`
					);

					if (hasErrors) {
						console.warn(
							`Recording completed with errors. The file may be corrupted.`
						);
					}

					resolve(filePath);
				} catch (error) {
					console.error(`Error finalizing recording:`, error);
					reject(error);
				}
			};

			// エラーハンドリング
			audioStream.on("error", (err) => {
				console.error(`Error in audio stream:`, err);
				hasErrors = true;
				// エラーがあっても続行して、収集したデータを処理する
			});

			// 指定時間後に録音を終了
			recordingTimeout = setTimeout(() => {
				console.log(`Ending recording after ${duration}ms`);
				try {
					audioStream.destroy();
				} catch (error) {
					console.error(`Error destroying audio stream:`, error);
				}

				finishRecording();
			}, duration);

			// ストリームが閉じられた場合
			audioStream.on("close", () => {
				console.log(`Audio stream closed`);
				clearTimeout(recordingTimeout);
				finishRecording();
			});

			// ストリームがエンドした場合
			audioStream.on("end", () => {
				console.log(`Audio stream ended`);
				clearTimeout(recordingTimeout);
				finishRecording();
			});
		} catch (error) {
			console.error(`Failed to setup recording:`, error);
			reject(error);
		}
	});
}

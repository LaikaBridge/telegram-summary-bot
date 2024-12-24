//import TelegramBot, { TelegramApi } from '@codebam/cf-workers-telegram-bot';
import { GenerationConfig, GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, SchemaType } from '@google/generative-ai';
import { Buffer } from 'node:buffer';
import { isJPEGBase64 } from './isJpeg';
import { extractAllOGInfo } from "./og"
import { MockBot, Reply, R, getMessageLink, CtxCommandData} from "./bot"
async function dispatchContent(content: string) {
	if (content.startsWith("data:image/jpeg;base64,")) {
		return {
			inlineData: {
				data: content.slice("data:image/jpeg;base64,".length),
				mimeType: "image/jpeg",
			},
		}
	}
	if (content.startsWith("http") && !content.includes(" ")) {
		return await extractAllOGInfo(content);
	}
	return content;
}

function telegramifyMarkdown(x: string, ...args: string[]){
	return x
}

function getSendTime(r: R) {
	return new Date(r.timeStamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
/**
 * 将数字转换为上标数字
 * @param {number} num - 要转换的数字
 * @returns {string} 上标形式的数字
 */
export function toSuperscript(num: number) {
	const superscripts: Record<string, string> = {
		'0': '⁰',
		'1': '¹',
		'2': '²',
		'3': '³',
		'4': '⁴',
		'5': '⁵',
		'6': '⁶',
		'7': '⁷',
		'8': '⁸',
		'9': '⁹'
	};

	return String(num).split('').map(digit => superscripts[digit]).join('');
}
/**
 * 处理 Markdown 文本中的重复链接，将其转换为顺序编号的格式
 * @param {string} text - 输入的 Markdown 文本
 * @param {Object} options - 配置选项
 * @param {string} options.prefix - 链接文本的前缀，默认为"链接"
 * @param {boolean} options.useEnglish - 是否使用英文(link1)而不是中文(链接1)，默认为 false
 * @returns {string} 处理后的 Markdown 文本
 */
export function processMarkdownLinks(text: string, options: { prefix: string, useEnglish: boolean } = {
	prefix: '引用',
	useEnglish: false
}) {
	const {
		prefix,
		useEnglish
	} = options;

	// 用于存储已经出现过的链接
	const linkMap = new Map();
	let linkCounter = 1;

	// 匹配 markdown 链接的正则表达式
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	return text.replace(linkPattern, (match, displayText, url) => {
		// 只处理显示文本和 URL 完全相同的情况
		if (displayText !== url) {
			return match; // 保持原样
		}

		// 如果这个 URL 已经出现过，使用已存在的编号
		if (!linkMap.has(url)) {
			linkMap.set(url, linkCounter++);
		}
		const linkNumber = linkMap.get(url);

		// 根据选项决定使用中文还是英文格式
		const linkPrefix = useEnglish ? 'link' : prefix;

		// 返回新的格式 [链接1](原URL) 或 [link1](原URL)
		return `[${linkPrefix}${toSuperscript(linkNumber)}](${url})`;
	});
}



function getGenModel(env: Env) {
	const model = "gemini-2.0-flash-exp";
	const gateway_name = env.cf_ai_gateway_name;
	const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
	const account_id = env.account_id;
	// TODO
	const generationConfig: GenerationConfig = {
		responseMimeType: "application/json",
		responseSchema: {
			type: SchemaType.OBJECT,
			properties: {
				text: {
					type: SchemaType.STRING,
				},
				promptFeedback: {
					type: SchemaType.OBJECT,
					properties: {
						blockReason: {
							type: SchemaType.STRING,
						},
					},
				},
			},
		},
	}
	const safetySettings = [
		{
			category: HarmCategory.HARM_CATEGORY_HARASSMENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
		{
			category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
			threshold: HarmBlockThreshold.BLOCK_NONE,
		},
	];
	return genAI.getGenerativeModel(
		{
			model, safetySettings, // generationConfig
		},
		{ baseUrl: `https://gateway.ai.cloudflare.com/v1/${account_id}/${gateway_name}/google-ai-studio`, timeout: 99999999999 }
	);
}

function getCommandVar(str: string, delim: string) {
	return str.slice(str.indexOf(delim) + delim.length);
}

function messageTemplate(s: string) {
	return `下面由免费 Gemini 2.0 概括群聊信息\n` + s + `本开源项目[地址](https://github.com/asukaminato0721/telegram-summary-bot)与[Fork地址](https://github.com/LaikaBridge/telegram-summary-bot)`;
}

export default {
	
	fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
		const resp = await new MockBot(env)
			.on('status', async (ctx) => {
				const res = (await ctx.reply('我家还蛮大的'))!;
				if (!res.ok) {
					console.error(`Error sending message:`, res);
				}
				return new Response('ok');
			})
			.on("query", async (ctx) => {
				const groupId = ctx.update.message!.chat.id;
				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('请输入要查询的关键词'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					SELECT * FROM Messages
					WHERE groupId=? AND content GLOB ?
					ORDER BY timeStamp DESC
					LIMIT 2000`)
					.bind(groupId, `*${messageText.split(" ")[1]}*`)
					.all();
				const reply: Reply = {
					type: "query",
					payload: []
				}
				for(const r of results){
					reply.payload.push({
						groupId: r.groupId as string,
						messageId: (r.messageId ?? "") as string,
						userName: r.userName as string,
						content: r.content as string,
						timeStamp: -1
					})
				}
				/*
				const res = (await ctx.reply(`查询结果:
${results.map((r: any) => `${r.userName}: ${r.content} ${r.messageId == null ? "" : `[link](https://t.me/c/${parseInt(r.groupId.slice(2))}/${r.messageId})`}`).join('\n')}`, "MarkdownV2"))!;
				*/
				const res = await ctx.reply(reply);
				if (!res.ok) {
					console.error(`Error sending message:`, res);
				}
				return new Response('ok');
			})
			.on("ask", async (ctx) => {
				const groupId = ctx.update.message!.chat.id;
				const userId = ctx.update.message!.from!.id;
				const messageText = ctx.update.message!.text || "";
				if (!messageText.split(" ")[1]) {
					const res = (await ctx.reply('请输入要问的问题'))!;
					if (!res.ok) {
						console.error(`Error sending message:`, res);
					}
					return new Response('ok');
				}
				let res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": "bot 已经收到你的问题, 请稍等",
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					await ctx.reply(`请开启和 bot 的私聊, 不然无法接收消息`);
					return new Response('ok');
				}
				const { results } = await env.DB.prepare(`
					WITH latest_1000 AS (
						SELECT * FROM Messages
						WHERE groupId=?
						ORDER BY timeStamp DESC
						LIMIT 1000
					)
					SELECT * FROM latest_1000
					ORDER BY timeStamp ASC
					`)
					.bind(groupId)
					.all();
				let result;
				try {
					result = await getGenModel(env).generateContent([
						`下面是一系列的对话, 格式是 用户名: 对话内容, 发送时间, 消息链接`,
						...((
							await Promise.all(
								results.map(
									async (r: any) => [
										`${r.userName as string}: `,
										await dispatchContent(r.content as string),
										getSendTime(r),
										getMessageLink(r)
									]
								)
							)
						).flat()),
						`基于上面的记录, 用符合上文风格的语气回答这个问题, 并在回答的关键词中用 markdown 的格式引用原对话的链接, 格式为
[引用1](链接本体)
[引用2](链接本体)
[关键字1](链接本体)
[关键字2](链接本体), 在链接的两侧加空格`,
						getCommandVar(messageText, " "),
					], { timeout: 99999999999 });
				} catch (e) {
					console.error(e);
					return new Response('ok');
				}
				let response_text: string;
				if (result.response.promptFeedback?.blockReason) {
					response_text = "无法回答, 理由" + result.response.promptFeedback.blockReason;
				}
				else {
					response_text = processMarkdownLinks(telegramifyMarkdown(result.response.text(), 'keep'));
				}
				res = await ctx.api.sendMessage(ctx.bot.api.toString(), {
					"chat_id": userId,
					"parse_mode": "MarkdownV2",
					"text": response_text,
					reply_to_message_id: -1,
				});
				if (!res.ok) {
					await ctx.reply(`发送失败`);
				}
				return new Response('ok');
			})
			.on("summary", async (bot) => {
				const groupId = bot.update.message!.chat.id;
				if (bot.update.message!.text!.split(" ").length === 1) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514');
					return new Response('ok');
				}
				const summary = bot.update.message!.text!.split(" ")[1];
				let results: Record<string, unknown>[];
				try {
					const test = parseInt(summary);
					if (Number.isNaN(test)) {
						throw new Error("not a number");
					}
					if (test < 0) {
						throw new Error("negative number");
					}
					if (!Number.isFinite(test)) {
						throw new Error("infinite number");
					}
				}
				catch (e: any) {
					await bot.reply('请输入要查询的时间范围/消息数量, 如 /summary 114h 或 /summary 514  ' + e.message);
					return new Response('ok');
				}
				if (summary.endsWith("h")) {
					results = (await env.DB.prepare(`
						SELECT *
						FROM Messages
						WHERE groupId=? AND timeStamp >= ?
						ORDER BY timeStamp ASC
						LIMIT 2000`)
						.bind(groupId, Date.now() - parseInt(summary) * 60 * 60 * 1000)
						.all()).results;
				}
				else {
					results = (await env.DB.prepare(`
						WITH latest_n AS (
							SELECT * FROM Messages
							WHERE groupId=?
							ORDER BY timeStamp DESC
							LIMIT ?
						)
						SELECT * FROM latest_n
						ORDER BY timeStamp ASC
						`)
						.bind(groupId, Math.min(parseInt(summary), 2000))
						.all()).results;
				}
				if (results.length > 0) {
					try {
						const result = await getGenModel(env).generateContent(
							[
								`用符合风格的语气概括下面的对话, 对话格式为 用户名: 发言内容, 相应链接, 如果对话里出现了多个主题, 请分条概括, 涉及到的图片也要提到相关内容, 并在回答的关键词中用 markdown 的格式引用原对话的链接, 格式为
[引用1](链接本体)
[引用2](链接本体)
[关键字1](链接本体)
[关键字2](链接本体)`,
								`群聊总结如下:`,
								...
								(
									await Promise.all(
										results.map(
											async (r: any) => [
												`${r.userName}:`, await dispatchContent(r.content), getMessageLink(r)
											]
										)
									)
								).flat(),
							]
						);
						await bot.reply(processMarkdownLinks(telegramifyMarkdown(result.response.text(), 'keep')), 'MarkdownV2');
					}
					catch (e) {
						console.error(e);
					}
				}

				return new Response('ok');
			})
			.on(':message', async (bot) => {
				if (!bot.update.message!.chat.type.includes('group')) {
					await bot.reply('I am a bot, please add me to a group to use me.');
					return new Response('ok');
				}
				function getUserName(msg: CtxCommandData['update']['message']) {
					if (msg.from?.username === "Channel_Bot" && msg.from?.is_bot) {
						return msg.sender_chat.title as string;
					}
					return msg.from?.first_name as string || "anonymous";
				}
				switch (bot.update_type) {
					case 'message': {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const content = msg.text || "";
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						await env.DB.prepare(`
							INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
							.bind(
								crypto.randomUUID(),
								groupId,
								timeStamp,
								userName, // not interested in user id
								content,
								messageId,
								groupName
							)
							.run();
						return new Response('ok');

					}
					case "photo": {
						const msg = bot.update.message!;
						const groupId = msg.chat.id;
						const messageId = msg.message_id;
						const groupName = msg.chat.title || "anonymous";
						const timeStamp = Date.now();
						const userName = getUserName(msg);
						const photo = msg.photo![msg.photo!.length - 1];
						const file = await bot.getFile(photo.file_id).then((response) => response.arrayBuffer());
						if (!(isJPEGBase64(Buffer.from(file).toString("base64")).isValid)) {
							console.error("not a jpeg");
							return new Response('ok');
						}
						await env.DB.prepare(`
							INSERT INTO Messages(id, groupId, timeStamp, userName, content, messageId, groupName) VALUES (?, ?, ?, ?, ?, ?, ?)`)
							.bind(
								crypto.randomUUID(),
								groupId,
								timeStamp,
								userName, // not interested in user id
								"data:image/jpeg;base64," + Buffer.from(file).toString("base64"),
								messageId,
								groupName
							)
							.run();
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.on(":schedule", async (ctx)=>{
				await env.DB.prepare(`
					CREATE INDEX IF NOT EXISTS idx_messages_groupid_timestamp
					ON Messages(groupId, timeStamp DESC);
				  `).run();
				// Clean up oldest 4000 messages
				await env.DB.prepare(`
							DELETE FROM Messages
							WHERE id IN (
								SELECT id
								FROM (
									SELECT
										id,
										ROW_NUMBER() OVER (
											PARTITION BY groupId
											ORDER BY timeStamp DESC
										) as row_num
									FROM Messages
								) ranked
								WHERE row_num > 4000
							);`)
					.run();
				const { results: groups } = await env.DB.prepare(`
					SELECT DISTINCT groupId
					FROM Messages
					ORDER BY groupId`).all();
		
				const batch = Math.floor((new Date()).getUTCMinutes() / 10); // 0 <= batch < 6
		
				for (const [id, group] of groups.entries()) {
					if (id % 6 !== batch) {
						continue;
					}
					const { results } = await env.DB.prepare('SELECT * FROM Messages WHERE groupId=? AND timeStamp >= ? ORDER BY timeStamp ASC LIMIT 2000')
						.bind(group.groupId, Date.now() - 24 * 60 * 60 * 1000)
						.all();
		
					if (results.length > 0) {
						const result = await getGenModel(env).generateContent([
							`用符合风格的语气概括下面的对话, 对话格式为 用户名: 发言内容, 相应链接, 如果对话里出现了多个主题, 请分条概括, 涉及到的图片也要提到相关内容, 并在回答的关键词中用 markdown 的格式引用原对话的链接, 格式为
		[引用1](链接本体)
		[引用2](链接本体)
		[关键字1](链接本体)
		[关键字2](链接本体)`,
							`概括的开头是: 本日群聊总结如下：`,
							...((await Promise.all(
								results.map(
									async (r: any) => [
										`${r.userName}:`, await dispatchContent(r.content), getMessageLink(r)
									]
								)
							)
							).flat())]);
						if ([-1001687785734].includes(parseInt(group.groupId as string))) {
							// todo: use cloudflare r2 to store skip list
							continue;
						}
		
						ctx.reply(messageTemplate(result.response.text()));
						// Use fetch to send message directly to Telegram API
						/*
						const res = await fetch(`https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/sendMessage`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								chat_id: group.groupId,
								text: processMarkdownLinks(telegramifyMarkdown(messageTemplate(result.response.text()), 'keep')),
								parse_mode: "MarkdownV2",
							}),
						});
						*/
						// clean up old images
						await env.DB.prepare(`
								DELETE
								FROM Messages
								WHERE groupId=? AND timeStamp < ? AND content LIKE 'data:image/jpeg;base64,%'`)
							.bind(group.groupId, Date.now() - 2 * 24 * 60 * 60 * 1000)
							.run();
					}
				}
				console.log("cron processed");
			})
			.handle(request.clone());
		if(resp instanceof Response){
			return resp;
		}else{
			return new Response('ok');
		}
	},
};

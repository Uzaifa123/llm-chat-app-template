/**
 * LLM Chat Application Template (Upgraded with D1 Chat History)
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") {
				return handleChatRequest(request, env, ctx);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests with history persistence
 */
async function handleChatRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		// 1. Extract or generate a Session ID
		const sessionId = request.headers.get("x-session-id") || crypto.randomUUID();

		// Parse the latest user message from the body
		const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
		const latestUserMessage = messages[messages.length - 1];

		if (!latestUserMessage || latestUserMessage.role !== "user") {
			return new Response("Invalid message format", { status: 400 });
		}

		// 2. Fetch past conversation history from Cloudflare D1
		const history = await env.DB.prepare(
			"SELECT role, message as content FROM chats WHERE session_id = ? ORDER BY id ASC"
		)
			.bind(sessionId)
			.all<ChatMessage>();

		const dbMessages = history.results || [];

		// 3. Build the full context payload for the LLM
		const finalMessages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			...dbMessages,
			latestUserMessage, // Append the new message the user just sent
		];

		// 4. Save the user's message to D1 immediately
		await env.DB.prepare(
			"INSERT INTO chats (session_id, role, message) VALUES (?, ?, ?)"
		)
			.bind(sessionId, "user", latestUserMessage.content)
			.run();

		// 5. Query Workers AI for a streaming response
		const stream = await env.AI.run(MODEL_ID, {
			messages: finalMessages,
			max_tokens: 1024,
			stream: true,
		});

		// 6. Safely read the stream, parse SSE text chunks, and save the final output
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let accumulatedAssistantText = "";

		const transformStream = new ReadableStream({
			async start(controller) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					// Enqueue the raw chunk to the frontend so the UI still streams live
					controller.enqueue(value);

					// Parse SSE data string chunks to harvest clean text for DB storage
					const textChunk = decoder.decode(value, { stream: true });
					const lines = textChunk.split("\n");
					
					for (const line of lines) {
						if (line.startsWith("data: ") && line !== "data: [DONE]") {
							try {
								const parsed = JSON.parse(line.slice(6));
								if (parsed.response) {
									accumulatedAssistantText += parsed.response;
								}
							} catch (e) {
								// Ignore half-formed or empty JSON chunks safely
							}
						}
					}
				}

				// Async wait until response completes, then write clean text to D1
				ctx.waitUntil(
					env.DB.prepare(
						"INSERT INTO chats (session_id, role, message) VALUES (?, ?, ?)"
					)
						.bind(sessionId, "assistant", accumulatedAssistantText)
						.run()
				);

				controller.close();
			},
		});

		// Return stream response with an added custom header exposing the Session ID
		return new Response(transformStream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				"connection": "keep-alive",
				"x-session-id": sessionId, // Send back so frontend can remember it
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(JSON.stringify({ error: "Failed to process request" }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}
}

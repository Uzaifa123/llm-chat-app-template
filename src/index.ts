/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		const sessionId = getSessionId(request);

		// 1. Load previous chat history from D1
		const history = await env.DB.prepare(
			"SELECT role, message FROM chats WHERE session_id = ? ORDER BY id ASC"
		)
			.bind(sessionId)
			.all();

		// 2. Convert DB history into LLM format
		const dbMessages =
			history.results?.map((row: any) => ({
				role: row.role,
				content: row.message,
			})) || [];

		// 3. Add system prompt
		const finalMessages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			...dbMessages,
			...messages,
		];

		// 4. Save latest user message
		const lastUserMessage = messages[messages.length - 1];
		if (lastUserMessage?.role === "user") {
			await env.DB.prepare(
				"INSERT INTO chats (session_id, role, message) VALUES (?, ?, ?)"
			)
				.bind(sessionId, "user", lastUserMessage.content)
				.run();
		}

		// 5. Call AI model
		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages: finalMessages,
				max_tokens: 1024,
				stream: true,
			}
		);

		// 6. Capture assistant response (non-stream wrapper)
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let fullResponse = "";

		const readable = new ReadableStream({
			async start(controller) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value);
					fullResponse += chunk;
					controller.enqueue(value);
				}

				controller.close();

				// Save assistant response to DB
				await env.DB.prepare(
					"INSERT INTO chats (session_id, role, message) VALUES (?, ?, ?)"
				)
					.bind(sessionId, "assistant", fullResponse)
					.run();
			},
		});

		return new Response(readable, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			}
		);
	}
}

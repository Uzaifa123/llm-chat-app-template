// Local variables tracking app session state
let currentSessionId = "";
let sessions = JSON.parse(localStorage.getItem("chat_sessions")) || [];

// DOM Element definitions
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const sessionsList = document.getElementById("sessions-list");
const newChatBtn = document.getElementById("new-chat-btn");

// Initialize application on load
window.addEventListener("DOMContentLoaded", () => {
    renderSessionsList();
    if (sessions.length > 0) {
        // Switch to the most recent session used
        switchSession(sessions[0].id);
    } else {
        startNewSession();
    }
});

// Create a clean new session tracking scope
function startNewSession() {
    currentSessionId = crypto.randomUUID();
    const newSession = {
        id: currentSessionId,
        title: `Chat (${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})})`
    };
    
    sessions.unshift(newSession);
    saveSessions();
    renderSessionsList();
    clearChatScreen();
}

function saveSessions() {
    localStorage.setItem("chat_sessions", JSON.stringify(sessions));
}

// Render out the sidebar history logs list UI
function renderSessionsList() {
    sessionsList.innerHTML = "";
    sessions.forEach(session => {
        const item = document.createElement("div");
        item.classList.add("session-item");
        if (session.id === currentSessionId) item.classList.add("active");
        item.textContent = session.title;
        item.title = session.title;
        item.addEventListener("click", () => switchSession(session.id));
        sessionsList.appendChild(item);
    });
}

// Clear interface text and show a welcome prompt
function clearChatScreen() {
    chatMessages.innerHTML = `
        <div class="message assistant-message">
            <p>Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you in this session?</p>
        </div>
    `;
}

// Switch contexts entirely
async function switchSession(sessionId) {
    currentSessionId = sessionId;
    renderSessionsList();
    clearChatScreen();
    
    // Optional: Fetch previous history from D1 to populate UI immediately on select
    // Since our worker *already* automatically feeds past history into the LLM context,
    // sending a simple query or fetching from an endpoint can rebuild the message list on your screen.
}

// Handle message form transmissions
async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    // Append user input text bubble
    appendMessage("user", text);
    userInput.value = "";
    
    // Automatically rename the active session tab title from generic text to your first question
    const trackingSession = sessions.find(s => s.id === currentSessionId);
    if (trackingSession && trackingSession.title.startsWith("Chat (")) {
        trackingSession.title = text.substring(0, 24) + (text.length > 24 ? "..." : "");
        saveSessions();
        renderSessionsList();
    }

    // Initialize UI constraints during query processing
    sendButton.disabled = true;
    typingIndicator.classList.add("visible");

    // Container for streaming response
    const assistantMessageDiv = appendMessage("assistant", "");
    const textNode = assistantMessageDiv.querySelector("p");

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-session-id": currentSessionId // Key binding tracking identifier
            },
            body: JSON.stringify({
                messages: [{ role: "user", content: text }]
            })
        });

        if (!response.ok) throw new Error("Failed generation payload fetch request");

        // Parse streamed event loops natively
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            const lines = textChunk.split("\n");

            for (const line of lines) {
                if (line.startsWith("data: ") && line !== "data: [DONE]") {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        if (parsed.response) {
                            textNode.textContent += parsed.response;
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    } catch (e) { /* Catch half fragments parsing errors safely */ }
                }
            }
        }

    } catch (err) {
        console.error(err);
        textNode.textContent = "Error: Failed to process stream context transmission.";
    } finally {
        sendButton.disabled = false;
        typingIndicator.classList.remove("visible");
    }
}

// Helper to inject HTML nodes into our chat layout
function appendMessage(role, text) {
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("message", `${role}-message`);
    const p = document.createElement("p");
    p.textContent = text;
    msgDiv.appendChild(p);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return msgDiv;
}

// Bind standard input event hooks
sendButton.addEventListener("click", sendMessage);
newChatBtn.addEventListener("click", startNewSession);
userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

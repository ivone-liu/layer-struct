const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const details = document.querySelector("#details");
const status = document.querySelector("#status");

const sessionId = crypto.randomUUID();

void refreshHealth();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) {
    return;
  }

  input.value = "";
  appendMessage("user", message);
  const assistantBubble = appendMessage("assistant", "");
  setBusy(true);

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sessionId })
    });

    if (!response.ok || !response.body) {
      const payload = await response.json();
      throw new Error(payload.error || "请求失败");
    }

    for await (const event of readSse(response.body)) {
      if (event.type === "assistant_delta") {
        assistantBubble.textContent += event.content;
        messages.scrollTop = messages.scrollHeight;
      }

      if (event.type === "status") {
        status.textContent = event.message;
        status.className = "status warn";
      }

      if (event.type === "metadata" || event.type === "done") {
        renderDetails(event);
      }

      if (event.type === "error") {
        throw new Error(event.error || "流式响应失败");
      }
    }
  } catch (error) {
    assistantBubble.textContent ||= error instanceof Error ? error.message : "未知错误";
  } finally {
    setBusy(false);
    void refreshHealth();
  }
});

async function refreshHealth() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    const configured = payload.ai?.embeddingConfigured && payload.ai?.chatConfigured;
    status.textContent = configured ? "已配置" : "待配置";
    status.className = `status ${configured ? "ok" : "warn"}`;
  } catch {
    status.textContent = "离线";
    status.className = "status warn";
  }
}

async function* readSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      const event = parseSseEvent(rawEvent);
      if (event) {
        yield event;
      }
    }
  }

  buffer += decoder.decode();
  const event = parseSseEvent(buffer);
  if (event) {
    yield event;
  }
}

function parseSseEvent(rawEvent) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return undefined;
  }

  return JSON.parse(dataLines.join("\n"));
}

function appendMessage(role, content) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;

  article.appendChild(bubble);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function renderDetails(payload) {
  details.textContent = JSON.stringify(
    {
      routePlan: payload.routePlan,
      executionResult: payload.executionResult,
      evidencePack: payload.evidencePack
    },
    null,
    2
  );
}

function setBusy(busy) {
  form.querySelector("button").disabled = busy;
  input.disabled = busy;
}

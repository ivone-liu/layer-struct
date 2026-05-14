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
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, sessionId })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "请求失败");
    }

    appendMessage("assistant", payload.answer);
    details.textContent = JSON.stringify(
      {
        routePlan: payload.routePlan,
        executionResult: payload.executionResult,
        evidencePack: payload.evidencePack
      },
      null,
      2
    );
  } catch (error) {
    appendMessage("assistant", error instanceof Error ? error.message : "未知错误");
  } finally {
    setBusy(false);
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

function appendMessage(role, content) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;

  article.appendChild(bubble);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(busy) {
  form.querySelector("button").disabled = busy;
  input.disabled = busy;
}

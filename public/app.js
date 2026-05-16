const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const messages = document.querySelector("#messages");
const details = document.querySelector("#details");
const status = document.querySelector("#status");
const conversationList = document.querySelector("#conversation-list");
const newConversationButton = document.querySelector("#new-conversation");
const currentTitle = document.querySelector("#current-title");

const draftStorageKey = "layer-struct.activeDrafts.v1";
const selectedSessionStorageKey = "layer-struct.selectedSessionId.v1";

let currentSessionId;
let conversations = [];
let activeDrafts = loadActiveDrafts();
let activeDraftViews = new Map();
let liveStreamingSessions = new Set();
let pollingTimer;

void init();

newConversationButton.addEventListener("click", async () => {
  const conversation = await createConversation();
  currentSessionId = conversation.id;
  localStorage.setItem(selectedSessionStorageKey, currentSessionId);
  messages.innerHTML = "";
  activeDraftViews.clear();
  upsertConversation(conversation, { keepCurrentTitle: false });
  renderCurrentTitle(conversation);
  appendWelcome();
  updateComposerState();
  stopPolling();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || isCurrentSessionRunning()) return;

  const conversation = currentSessionId ? conversations.find((item) => item.id === currentSessionId) : await createConversation(titleFromMessage(message));
  if (!currentSessionId) {
    currentSessionId = conversation.id;
    localStorage.setItem(selectedSessionStorageKey, currentSessionId);
    upsertConversation(conversation, { keepCurrentTitle: false });
  }

  const sessionId = currentSessionId;
  input.value = "";
  removeWelcome();
  appendMessage("user", message);

  const draft = {
    sessionId,
    runId: `pending-${crypto.randomUUID()}`,
    answer: "",
    progress: [],
    status: "streaming",
    details: undefined,
    updatedAt: new Date().toISOString()
  };
  setDraft(sessionId, draft);
  renderDraft(draft);
  liveStreamingSessions.add(sessionId);
  updateComposerState();

  let sseErrorReceived = false;
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
      if (event.type === "error") sseErrorReceived = true;
      await handleStreamEvent(sessionId, event);
      if (event.type === "error") break;
    }
  } catch (error) {
    if (!sseErrorReceived) {
      const draft = getDraft(sessionId);
      const message = error instanceof Error ? error.message : "网络请求失败，请稍后重试。";
      if (draft) {
        draft.status = "failed";
        draft.answer = draft.answer || message;
        upsertDraftProgress(draft, "error", message, "failed");
        setDraft(sessionId, draft);
        renderDraftIfCurrent(sessionId);
      }
      if (currentSessionId === sessionId) setStatus("失败", "error");
    }
  } finally {
    liveStreamingSessions.delete(sessionId);
    updateComposerState();
    void refreshHealth();
    if (currentSessionId === sessionId) {
      schedulePollingIfNeeded(sessionId);
    }
  }
});

async function init() {
  await refreshHealth();
  await refreshConversations();
  const selectedSessionId = localStorage.getItem(selectedSessionStorageKey);
  const initialConversation = conversations.find((item) => item.id === selectedSessionId) || conversations[0];
  if (initialConversation) {
    await openConversation(initialConversation.id);
  } else {
    updateComposerState();
  }
}

async function createConversation(title) {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title })
  });
  const payload = await response.json();
  return payload.conversation;
}

async function refreshConversations() {
  const response = await fetch("/api/conversations?limit=30");
  const payload = await response.json();
  conversations = payload.conversations || [];
  renderConversationList();
}

async function openConversation(sessionId, options = {}) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(sessionId)}/messages`);
  const payload = await response.json();
  currentSessionId = sessionId;
  localStorage.setItem(selectedSessionStorageKey, sessionId);
  activeDraftViews.clear();
  messages.innerHTML = "";

  const payloadMessages = payload.messages || [];
  reconcileDraftFromMessages(sessionId, payloadMessages);
  const draft = getDraft(sessionId);
  for (const message of payloadMessages) {
    if (draft && message.role === "assistant" && message.runId === draft.runId && isStreamingMetadata(message.metadata)) {
      continue;
    }
    appendStoredMessage(message);
  }
  if (draft) {
    renderDraft(draft);
  }
  if (!payloadMessages.length && !draft) appendWelcome();

  renderCurrentTitle(payload.conversation);
  upsertConversation(payload.conversation, { keepCurrentTitle: true });
  updateComposerState();
  schedulePollingIfNeeded(sessionId);
  if (!options.preserveScroll) messages.scrollTop = messages.scrollHeight;
}

async function handleStreamEvent(sessionId, event) {
  const draft = getDraft(sessionId);
  if (!draft) return;

  if (event.runId && draft.runId.startsWith("pending-")) {
    const pendingView = activeDraftViews.get(draft.runId);
    activeDraftViews.delete(draft.runId);
    draft.runId = event.runId;
    if (pendingView) activeDraftViews.set(draft.runId, pendingView);
  }
  if (event.conversation) {
    upsertConversation(event.conversation, { keepCurrentTitle: currentSessionId !== event.conversation.id });
  }

  if (event.type === "run_started") {
    upsertDraftProgress(draft, "intake", event.visibleMessage, "running");
    if (currentSessionId === sessionId) setStatus("处理中", "warn");
  }
  if (event.type === "conversation_created" || event.type === "conversation_updated") {
    upsertDraftProgress(draft, event.type, event.visibleMessage, "done");
  }
  if (event.type === "context_compression_started") upsertDraftProgress(draft, "context-compression", event.visibleMessage, "running");
  if (event.type === "context_compression_completed") upsertDraftProgress(draft, "context-compression", event.visibleMessage, "done");
  if (event.type === "memory_started") upsertDraftProgress(draft, "memory", event.visibleMessage, "running");
  if (event.type === "memory_completed") upsertDraftProgress(draft, "memory", event.visibleMessage, "done");
  if (event.type === "document_resolved" || event.type === "document_ambiguous") upsertDraftProgress(draft, event.type, event.visibleMessage, "done");
  if (event.type === "step_started") upsertDraftProgress(draft, event.step, event.visibleMessage, "running");
  if (event.type === "step_completed") upsertDraftProgress(draft, event.step, event.visibleMessage, "done");
  if (event.type === "step_failed") upsertDraftProgress(draft, event.step, event.visibleMessage || event.error, "failed");
  if (["skill_plan", "skill_started", "skill_completed", "skill_failed", "observation"].includes(event.type)) {
    const state = event.type === "skill_failed" ? "failed" : event.type === "skill_started" ? "running" : "done";
    upsertDraftProgress(draft, progressEventKey(event), event.visibleMessage || event.type, state);
    draft.details = event;
  }
  if (event.type === "metadata") {
    if (event.visibleMessage) upsertDraftProgress(draft, metadataProgressKey(event), event.visibleMessage, "done");
    draft.details = event;
  }
  if (event.type === "assistant_delta") {
    draft.answer += event.content;
  }
  if (event.type === "done") {
    draft.answer = event.answer || draft.answer;
    draft.status = event.status;
    draft.details = event;
    setDraft(sessionId, draft);
    if (currentSessionId === sessionId) {
      renderDetails(event);
      setStatus(event.status === "completed_with_fallback" ? "已降级" : "已完成", event.status === "completed_with_fallback" ? "warn" : "ok");
    }
    clearDraft(sessionId);
    await refreshConversations();
    if (currentSessionId === sessionId) await openConversation(sessionId, { preserveScroll: true });
    return;
  }
  if (event.type === "error") {
    const friendlyMessage = event.friendlyMessage || event.error || "生成模型响应超时，请稍后重试或缩短问题。";
    draft.status = "failed";
    draft.answer = draft.answer || friendlyMessage;
    upsertDraftProgress(draft, "error", friendlyMessage, "failed");
    if (currentSessionId === sessionId) setStatus(event.recoverable ? "已降级" : "失败", event.recoverable ? "warn" : "error");
  }

  draft.updatedAt = new Date().toISOString();
  setDraft(sessionId, draft);
  renderDraftIfCurrent(sessionId);
  if (currentSessionId === sessionId && draft.details) renderDetails(draft.details);
}

function renderConversationList() {
  conversationList.innerHTML = "";
  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${conversation.id === currentSessionId ? " active" : ""}`;
    button.innerHTML = `<span class="conversation-title"></span><span class="conversation-preview"></span><time></time>`;
    button.querySelector(".conversation-title").textContent = conversation.title || "新对话";
    button.querySelector(".conversation-preview").textContent = conversation.lastMessagePreview || "暂无消息";
    button.querySelector("time").textContent = formatTime(conversation.lastMessageAt || conversation.updatedAt);
    button.addEventListener("click", () => void openConversation(conversation.id));
    conversationList.appendChild(button);
  }
}

function upsertConversation(conversation, options = {}) {
  if (!conversation) return;
  const existingIndex = conversations.findIndex((item) => item.id === conversation.id);
  if (existingIndex >= 0) {
    conversations = conversations.map((item) => item.id === conversation.id ? conversation : item);
  } else {
    conversations = [...conversations, conversation];
  }
  conversations.sort(compareConversationsByActivity);
  if (!options.keepCurrentTitle && conversation.id === currentSessionId) renderCurrentTitle(conversation);
  renderConversationList();
}

function compareConversationsByActivity(left, right) {
  return conversationSortTime(right) - conversationSortTime(left);
}

function conversationSortTime(conversation) {
  const value = conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function renderCurrentTitle(conversation) {
  currentTitle.textContent = conversation?.title || "个人采集与对话中心";
}

function appendWelcome() {
  messages.innerHTML = `<article class="message assistant welcome-message"><div class="bubble">这是一个空对话，直接输入即可开始。</div></article>`;
}

function removeWelcome() {
  messages.querySelector(".welcome-message")?.remove();
}

async function refreshHealth() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    const configured = payload.ai?.embeddingConfigured && payload.ai?.chatConfigured;
    if (!isCurrentSessionRunning()) setStatus(configured ? "已配置" : "待配置", configured ? "ok" : "warn");
  } catch {
    if (!isCurrentSessionRunning()) setStatus("离线", "warn");
  }
}

function setStatus(text, kind) {
  status.textContent = text;
  status.className = `status ${kind}`;
}

async function* readSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() ?? "";
    for (const rawEvent of events) {
      const event = parseSseEvent(rawEvent);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  const event = parseSseEvent(buffer);
  if (event) yield event;
}

function parseSseEvent(rawEvent) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return undefined;
  return JSON.parse(dataLines.join("\n"));
}

function appendStoredMessage(message) {
  appendMessage(message.role, message.content || streamingPlaceholder(message), {
    renderMarkdown: message.role === "assistant",
    streaming: message.role === "assistant" && isStreamingMetadata(message.metadata)
  });
}

function appendMessage(role, content, options = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (options.streaming) bubble.classList.add("streaming-bubble");

  if (options.renderMarkdown) {
    bubble.classList.add("markdown-body");
    renderMarkdownInto(bubble, content);
  } else {
    bubble.textContent = content;
  }

  article.appendChild(bubble);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function renderDraft(draft) {
  let view = activeDraftViews.get(draft.runId);
  if (!view) {
    const article = document.createElement("article");
    article.className = "message assistant";

    const bubble = document.createElement("div");
    bubble.className = "bubble assistant-composite";

    const progress = document.createElement("div");
    progress.className = "run-progress";
    progress.setAttribute("aria-label", "执行过程");

    const answer = document.createElement("div");
    answer.className = "answer markdown-body";

    bubble.append(progress, answer);
    article.appendChild(bubble);
    messages.appendChild(article);
    view = { article, progress, answer };
    activeDraftViews.set(draft.runId, view);
  }

  view.progress.innerHTML = "";
  for (const item of draft.progress) {
    addProgressItem(view.progress, item.key, item.message, item.state);
  }
  renderMarkdownInto(view.answer, draft.answer || (draft.status === "streaming" ? "正在生成回答..." : ""));
  messages.scrollTop = messages.scrollHeight;
  return view;
}

function renderDraftIfCurrent(sessionId) {
  if (currentSessionId !== sessionId) return;
  const draft = getDraft(sessionId);
  if (draft) renderDraft(draft);
}

function updateProgressItem(container, key, message, state) {
  const existing = container.querySelector(`[data-progress-key="${cssEscape(key)}"]`);
  if (existing) {
    existing.querySelector(".progress-text").textContent = message;
    existing.dataset.state = state;
    return existing;
  }
  return addProgressItem(container, key, message, state);
}

function addProgressItem(container, key, message, state) {
  const item = document.createElement("div");
  item.className = "progress-item";
  item.dataset.progressKey = key;
  item.dataset.state = state;

  const dot = document.createElement("span");
  dot.className = "progress-dot";
  dot.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "progress-text";
  text.textContent = message;

  item.append(dot, text);
  container.appendChild(item);
  return item;
}

function upsertDraftProgress(draft, key, message, state) {
  const existing = draft.progress.find((item) => item.key === key);
  if (existing) {
    existing.message = message;
    existing.state = state;
  } else {
    draft.progress.push({ key, message, state });
  }
}

function metadataProgressKey(event) {
  const progressType = event.payload?.progress?.type;
  return progressType ? `metadata-${progressType}` : `metadata-${crypto.randomUUID()}`;
}

function progressEventKey(event) {
  if (event.type === "skill_started") return `skill-${event.call?.id || crypto.randomUUID()}`;
  if (event.type === "skill_completed" || event.type === "skill_failed") return `skill-${event.result?.callId || crypto.randomUUID()}`;
  return `${event.type}-${crypto.randomUUID()}`;
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/"/g, "\\\"");
}

function appendMarkdownDelta(element, delta) {
  const nextMarkdown = (element.dataset.markdown ?? "") + delta;
  renderMarkdownInto(element, nextMarkdown);
}

function renderMarkdownInto(element, markdown) {
  element.dataset.markdown = markdown;
  element.innerHTML = renderMarkdown(markdown);
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType;
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = undefined;
  };
  const openList = (type) => {
    if (listType === type) return;
    flushParagraph();
    flushList();
    listType = type;
    html.push(`<${type}>`);
  };
  const flushCodeBlock = () => {
    const languageClass = codeLanguage ? ` class="language-${escapeAttribute(codeLanguage)}"` : "";
    html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeLanguage = "";
    codeLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fenceMatch) {
      if (inCodeBlock) flushCodeBlock();
      else {
        flushParagraph();
        flushList();
        inCodeBlock = true;
        codeLanguage = fenceMatch[1] ?? "";
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }
    if (isTableHeader(line, lines[index + 1])) {
      flushParagraph();
      flushList();
      const headers = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]).map(parseTableAlignment);
      const rows = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      html.push(renderTable(headers, alignments, rows));
      continue;
    }
    const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      openList("ul");
      html.push(`<li>${renderInline(unorderedMatch[1])}</li>`);
      continue;
    }
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      openList("ol");
      html.push(`<li>${renderInline(orderedMatch[1])}</li>`);
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.+)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(quoteMatch[1])}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }

  if (inCodeBlock) flushCodeBlock();
  flushParagraph();
  flushList();
  return html.join("");
}

function isTableHeader(line, nextLine) {
  return isTableRow(line) && typeof nextLine === "string" && isTableDelimiter(nextLine);
}

function isTableRow(line) {
  return line.includes("|") && splitTableRow(line).length > 1;
}

function isTableDelimiter(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseTableAlignment(cell) {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  if (trimmed.startsWith(":")) return "left";
  return undefined;
}

function renderTable(headers, alignments, rows) {
  const alignmentAttribute = (index) => {
    const alignment = alignments[index];
    return alignment ? ` style="text-align: ${alignment}"` : "";
  };
  const thead = headers.map((header, index) => `<th${alignmentAttribute(index)}>${renderInline(header)}</th>`).join("");
  const tbody = rows
    .map((row) => {
      const cells = headers.map((_, index) => `<td${alignmentAttribute(index)}>${renderInline(row[index] ?? "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

function renderInline(text) {
  const codePlaceholders = [];
  let html = text.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `\u0000CODE${codePlaceholders.length}\u0000`;
    codePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  html = escapeHtml(html);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const safeUrl = escapeAttribute(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|\s)\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|\s)_([^_]+)_/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\n/g, "<br>");

  codePlaceholders.forEach((code, index) => {
    html = html.replace(`\u0000CODE${index}\u0000`, code);
  });
  return html;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function renderDetails(payload) {
  details.textContent = JSON.stringify(
    {
      runId: payload.runId,
      routePlan: payload.routePlan ?? payload.payload?.routePlan,
      skillPlan: payload.skillPlan ?? payload.payload?.skillPlan,
      skillResults: payload.skillResults ?? payload.payload?.skillResults,
      observation: payload.observation ?? payload.payload?.observation,
      executionResult: payload.executionResult ?? payload.payload?.executionResult,
      evidencePack: payload.evidencePack ?? payload.payload?.evidencePack
    },
    null,
    2
  );
}

function setBusy(busy) {
  form.querySelector("button").disabled = busy;
  input.disabled = busy;
}

function updateComposerState() {
  setBusy(isCurrentSessionRunning());
}

function isCurrentSessionRunning() {
  return Boolean(currentSessionId && (liveStreamingSessions.has(currentSessionId) || getDraft(currentSessionId)?.status === "streaming"));
}

function loadActiveDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftStorageKey) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveActiveDrafts() {
  localStorage.setItem(draftStorageKey, JSON.stringify(activeDrafts));
}

function getDraft(sessionId) {
  return sessionId ? activeDrafts[sessionId] : undefined;
}

function setDraft(sessionId, draft) {
  activeDrafts[sessionId] = draft;
  saveActiveDrafts();
}

function clearDraft(sessionId) {
  delete activeDrafts[sessionId];
  saveActiveDrafts();
}

function reconcileDraftFromMessages(sessionId, payloadMessages) {
  const draft = getDraft(sessionId);
  const streamingMessage = [...payloadMessages].reverse().find((message) => message.role === "assistant" && isStreamingMetadata(message.metadata));
  const latestMessage = payloadMessages[payloadMessages.length - 1];
  const completedSameRun = draft
    ? payloadMessages.some((message) => message.role === "assistant" && message.runId === draft.runId && !isStreamingMetadata(message.metadata))
    : false;
  const completedPendingRun = draft?.runId?.startsWith("pending-") && latestMessage?.role === "assistant" && !isStreamingMetadata(latestMessage.metadata);
  if (completedSameRun || completedPendingRun) {
    clearDraft(sessionId);
    return;
  }
  if (streamingMessage) {
    const nextDraft = draft || {
      sessionId,
      runId: streamingMessage.runId || `restored-${crypto.randomUUID()}`,
      answer: "",
      progress: [],
      status: "streaming",
      details: undefined,
      updatedAt: new Date().toISOString()
    };
    nextDraft.runId = streamingMessage.runId || nextDraft.runId;
    if ((streamingMessage.content || "").length > (nextDraft.answer || "").length) {
      nextDraft.answer = streamingMessage.content;
    }
    nextDraft.status = "streaming";
    setDraft(sessionId, nextDraft);
  }
}

function isStreamingMetadata(metadata) {
  return metadata?.status === "streaming";
}

function streamingPlaceholder(message) {
  return isStreamingMetadata(message.metadata) ? "正在生成回答..." : "";
}

function schedulePollingIfNeeded(sessionId) {
  stopPolling();
  if (!sessionId || liveStreamingSessions.has(sessionId)) return;
  const draft = getDraft(sessionId);
  if (!draft || draft.status !== "streaming") return;
  pollingTimer = setInterval(() => {
    if (currentSessionId === sessionId && !liveStreamingSessions.has(sessionId)) {
      void openConversation(sessionId, { preserveScroll: true });
    }
  }, 2500);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function titleFromMessage(message) {
  return message.replace(/\s+/g, " ").trim().slice(0, 30) || "新对话";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

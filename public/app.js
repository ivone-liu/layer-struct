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
  const assistantMessage = appendAssistantMessage();
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
      if (event.type === "run_started") {
        addProgressItem(assistantMessage.progress, "intake", event.visibleMessage, "running");
        status.textContent = "处理中";
        status.className = "status warn";
      }

      if (event.type === "step_started") {
        updateProgressItem(assistantMessage.progress, event.step, event.visibleMessage, "running");
      }

      if (event.type === "step_completed") {
        updateProgressItem(assistantMessage.progress, event.step, event.visibleMessage, "done");
      }

      if (event.type === "step_failed") {
        updateProgressItem(assistantMessage.progress, event.step, event.visibleMessage || event.error, "failed");
      }

      if (["skill_plan", "skill_started", "skill_completed", "skill_failed", "observation"].includes(event.type)) {
        const state = event.type === "skill_failed" ? "failed" : event.type === "skill_started" ? "running" : "done";
        addProgressItem(assistantMessage.progress, progressEventKey(event), event.visibleMessage || event.type, state);
        renderDetails(event);
      }

      if (event.type === "metadata") {
        if (event.visibleMessage) {
          addProgressItem(assistantMessage.progress, metadataProgressKey(event), event.visibleMessage, "done");
        }
        if (event.routePlan || event.payload?.routePlan) {
          renderDetails(event);
        }
      }

      if (event.type === "assistant_delta") {
        appendMarkdownDelta(assistantMessage.answer, event.content);
        messages.scrollTop = messages.scrollHeight;
      }

      if (event.type === "done") {
        renderDetails(event);
        status.textContent = "已完成";
        status.className = "status ok";
      }

      if (event.type === "error") {
        addProgressItem(assistantMessage.progress, "error", event.error || "流式响应失败", "failed");
        throw new Error(event.error || "流式响应失败");
      }
    }
  } catch (error) {
    if (!assistantMessage.answer.dataset.markdown) {
      renderMarkdownInto(assistantMessage.answer, error instanceof Error ? error.message : "未知错误");
    }
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

function appendMessage(role, content, options = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

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

function appendAssistantMessage() {
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
  messages.scrollTop = messages.scrollHeight;
  return { article, progress, answer };
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
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function metadataProgressKey(event) {
  const progressType = event.payload?.progress?.type;
  return progressType ? `metadata-${progressType}` : `metadata-${crypto.randomUUID()}`;
}

function progressEventKey(event) {
  if (event.type === "skill_started") {
    return `skill-${event.call?.id || crypto.randomUUID()}`;
  }
  if (event.type === "skill_completed" || event.type === "skill_failed") {
    return `skill-${event.result?.callId || crypto.randomUUID()}`;
  }
  return `${event.type}-${crypto.randomUUID()}`;
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return CSS.escape(value);
  }
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
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) {
      return;
    }
    html.push(`</${listType}>`);
    listType = undefined;
  };

  const openList = (type) => {
    if (listType === type) {
      return;
    }
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
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
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

  if (inCodeBlock) {
    flushCodeBlock();
  }
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
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  if (trimmed.endsWith(":")) {
    return "right";
  }
  if (trimmed.startsWith(":")) {
    return "left";
  }
  return undefined;
}

function renderTable(headers, alignments, rows) {
  const alignmentAttribute = (index) => {
    const alignment = alignments[index];
    return alignment ? ` style="text-align: ${alignment}"` : "";
  };
  const thead = headers
    .map((header, index) => `<th${alignmentAttribute(index)}>${renderInline(header)}</th>`)
    .join("");
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

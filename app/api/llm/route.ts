import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ALLOWED_SCHEMES = ["http:", "https:"];
const BLOCKED_HOSTS = ["169.254.169.254", "metadata.google.internal"];

function validateApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return "Only HTTP and HTTPS URLs are allowed";
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTS) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return `URL hostname "${hostname}" is not allowed`;
    }
  }

  return null;
}

function sanitizeErrorMessage(message: string): string {
  let sanitized = message.replace(/\/[^\s"']+/g, "[path]");
  sanitized = sanitized.replace(/(?:api[_-]?key|token|secret|password|bearer)\s*[=:]\s*\S+/gi, "[redacted]");
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip]");
  return sanitized.slice(0, 500);
}

function sanitizePromptText(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/\[INST\]/gi, "")
    .replace(/\[\/INST\]/gi, "")
    .replace(/<s>/gi, "")
    .replace(/<\/s>/gi, "")
    .replace(/<<<[\s\S]*?>>>/g, "")
    .replace(/```system[\s\S]*?```/gi, "")
    .slice(0, 100000);
}

interface LLMRequestBody {
  apiUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

function validateRequestBody(body: LLMRequestBody): string | null {
  if (!body || typeof body !== "object") {
    return "Request body must be an object";
  }

  if (!body.model || typeof body.model !== "string") {
    return "Model is required";
  }

  if (!Array.isArray(body.messages)) {
    return "Messages must be an array";
  }

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string" || typeof msg.content !== "string") {
      return "Messages must contain role and content strings";
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return NextResponse.json({ error: "Cross-origin requests are not allowed" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }
  }

  try {
    const body: LLMRequestBody = await request.json();

    const urlError = validateApiUrl(body.apiUrl);
    if (urlError) {
      return NextResponse.json({ error: urlError }, { status: 400 });
    }

    const bodyError = validateRequestBody(body);
    if (bodyError) {
      return NextResponse.json({ error: bodyError }, { status: 400 });
    }

    for (const msg of body.messages) {
      if (msg.content) {
        msg.content = sanitizePromptText(msg.content);
      }
    }

    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (body.apiKey) {
      requestHeaders.Authorization = `Bearer ${body.apiKey}`;
    }

    const baseUrl = body.apiUrl.replace(/\/+$/, "");

    const { apiUrl: _apiUrl, apiKey: _apiKey, ...forwardBody } = body;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(forwardBody),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`LLM API error (${response.status}): ${sanitizeErrorMessage(errorText)}`);
      return NextResponse.json({ error: `LLM API returned status ${response.status}` }, { status: response.status });
    }

    if (body.stream) {
      return new NextResponse(response.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return NextResponse.json({ error: "Request aborted" }, { status: 499 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`LLM proxy error: ${sanitizeErrorMessage(message)}`);
    return NextResponse.json({ error: "Internal proxy error" }, { status: 500 });
  }
}

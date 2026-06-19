export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/\[INST\]/gi, "")
    .replace(/\[\/INST\]/gi, "")
    .replace(/<s>/gi, "")
    .replace(/<\/s>/gi, "")
    .replace(/<<<[\s\S]*?>>>/g, "")
    .replace(/```system[\s\S]*?```/gi, "")
    .replace(/\b(system|assistant|user|instruction)\s*:\s*/gi, "")
    .slice(0, 100000);
}

export function sanitizeForDisplay(text: string): string {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "")
    .slice(0, 100000);
}

export function sanitizeErrorMessage(message: string): string {
  let sanitized = message.replace(/\/[^\s"']+/g, "[path]");
  // Redact credential-like patterns. The separator is optional so bare "bearer <token>"
  // is caught, and an optional "bearer " prefix is consumed so the token following
  // "Authorization: Bearer <token>" is redacted rather than leaked.
  sanitized = sanitized.replace(
    /(?:api[_-]?key|authorization|token|secret|password|bearer)\s*[:=]?\s*(?:bearer\s+)?\S+/gi,
    "[redacted]",
  );
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip]");
  return sanitized.slice(0, 500);
}

export function sanitizeImageUrlSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "");
}

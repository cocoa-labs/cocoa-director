export type NormalizedProviderError = {
  code: string;
  userMessage: string;
  suggestedPrompt?: string;
  retryable: boolean;
};

export function normalizeProviderError(error: unknown, provider: string): NormalizedProviderError {
  const candidate = error as {
    body?: { detail?: { status?: string; prompt_suggestion?: string; composition_plan_suggestion?: unknown } };
    error?: { code?: string; message?: string };
    status?: number;
    message?: string;
  };
  const serialized = safelySerializeError(error);
  const elevenStatus = candidate.body?.detail?.status;
  if (provider === "elevenlabs" && elevenStatus === "bad_prompt") {
    return {
      code: "elevenlabs_bad_prompt",
      userMessage: "The music prompt was rejected. Try the suggested rewrite before retrying.",
      suggestedPrompt: candidate.body?.detail?.prompt_suggestion,
      retryable: true,
    };
  }
  if (provider === "elevenlabs" && elevenStatus === "bad_composition_plan") {
    return {
      code: "elevenlabs_bad_composition_plan",
      userMessage: "The music composition plan was rejected. Adjust the section plan before retrying.",
      suggestedPrompt: stringifySuggestion(candidate.body?.detail?.composition_plan_suggestion),
      retryable: true,
    };
  }
  if (provider === "openai" && /moderation|content/i.test(candidate.error?.code ?? candidate.message ?? "")) {
    return {
      code: "openai_moderation",
      userMessage: "This prompt was blocked by content filters. Please rephrase and try again.",
      retryable: false,
    };
  }
  if (provider === "fal" && /likeness|biometric|private information|real[- ]?person|authorized[- ]?likeness|privacy|identity/i.test(serialized)) {
    return {
      code: "fal_likeness_policy",
      userMessage: "The video provider declined this visual under its likeness or privacy policy. Cocoa retained the successful assets and can generate an identity-safe replacement for this beat.",
      retryable: false,
    };
  }
  if (provider === "fal" && candidate.status === 429) {
    return {
      code: "fal_rate_limited",
      userMessage: "The video provider is busy. Please retry in a moment.",
      retryable: true,
    };
  }
  if (provider === "fal" && (Number(candidate.status) >= 500 || /timed? out|timeout|temporar|connection|unavailable|overloaded/i.test(serialized))) {
    return {
      code: "fal_transient_error",
      userMessage: "The video provider encountered a temporary problem. Cocoa will retry this operation safely.",
      retryable: true,
    };
  }
  return {
    code: `${provider}_provider_error`,
    userMessage: error instanceof Error ? error.message : "The provider request failed. Please try again.",
    retryable: true,
  };
}

function safelySerializeError(error: unknown) {
  if (error instanceof Error) {
    const candidate = error as Error & { body?: unknown; error?: unknown; status?: unknown };
    return [candidate.message, JSON.stringify(candidate.body), JSON.stringify(candidate.error), String(candidate.status ?? "")].join(" ");
  }
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stringifySuggestion(value: unknown) {
  if (!value) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

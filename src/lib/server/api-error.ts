import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function apiErrorResponse(error: unknown, _fallbackMessage: string): NextResponse {
  void _fallbackMessage;
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Malformed JSON request.", code: "invalid_json" }, { status: 400 });
  }
  if (error instanceof Response) return new NextResponse(error.body, error);
  if (error instanceof ApiRequestError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const message = first
      ? `${first.path.join(".") || "request"}: ${first.message}`
      : "Invalid request";
    return NextResponse.json(
      { error: message, code: "invalid_request", issues: error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ event: "api_request_failed", requestId, errorType: error instanceof Error ? error.name : "unknown" }));
  return NextResponse.json({ error: "The request could not be completed. Please try again.", code: "request_failed", requestId }, { status: 500 });
}

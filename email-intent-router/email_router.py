"""
Email Intent Router
===================
Classifies incoming emails as "actionable" (reply) or "passive" (suppress)
using Claude with prompt caching on the static classifier system prompt.

Environment variables (see README.md for full list):
  ANTHROPIC_API_KEY      — required
  DRY_RUN                — "true" to log decisions without sending replies
  CONFIDENCE_THRESHOLD   — float 0–1, below which a human is asked (default 0.7)
  CLASSIFIER_MODEL       — Anthropic model ID (default claude-haiku-4-5)
  LOG_LEVEL              — DEBUG | INFO | WARNING | ERROR (default INFO)
"""

from __future__ import annotations

import json
import logging
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

import anthropic

# ─── Intent taxonomy ──────────────────────────────────────────────────────────

ACTIONABLE_INTENTS = {"Question", "Request", "Scheduling", "Problem"}

PASSIVE_INTENTS = {
    "Information/FYI",
    "Transactional",
    "System Alert",
    "Auto-Response",
    "Promotional",
}

ALL_INTENTS = ACTIONABLE_INTENTS | PASSIVE_INTENTS

# ─── Automated-email header rules (RFC 3834, RFC 2369) ────────────────────────
# Maps lowercase header name → callable(value) → True means SUPPRESS
SUPPRESS_HEADER_RULES: dict[str, object] = {
    # auto-submitted: "auto-generated" | "auto-replied" | ... (anything except "no")
    "auto-submitted": lambda v: v.lower().strip() != "no",
    # presence alone is enough for these
    "x-auto-response-suppress": lambda v: bool(v),
    "x-autoreply": lambda v: bool(v),
    "x-autorespond": lambda v: bool(v),
    # bulk/list mailers
    "precedence": lambda v: v.lower().strip() in ("bulk", "list", "junk"),
    "list-unsubscribe": lambda v: bool(v),
    "list-id": lambda v: bool(v),
}

# ─── Static classifier system prompt ─────────────────────────────────────────
# NEVER interpolate dynamic data (dates, user names, email content) here —
# doing so would break prompt caching since the prefix would change per-request.
# All per-email context goes into the user message instead.
CLASSIFIER_SYSTEM_PROMPT = """You are an email intent classifier. Your job is to read an incoming email and determine:

1. The primary **intent** of the sender — choose exactly one:
   ACTIONABLE (sender expects or wants a response):
   - Question       — asking something that requires an answer
   - Request        — asking for an action to be taken
   - Scheduling     — proposing, confirming, or changing a meeting/appointment/booking
   - Problem        — reporting an issue, complaint, or urgent situation

   PASSIVE (no reply expected or appropriate):
   - Information/FYI — sharing information, no engagement needed
   - Transactional  — automated receipt, invoice, order confirmation, shipping notice
   - System Alert   — server alert, monitoring notification, CI/CD build report
   - Auto-Response  — out-of-office reply, vacation auto-responder, auto-acknowledgement
   - Promotional    — newsletter, marketing, sales pitch, product announcement

2. Whether to **reply** or **suppress**:
   - "reply"    → Question, Request, Scheduling, Problem
   - "suppress" → Information/FYI, Transactional, System Alert, Auto-Response, Promotional

3. Your confidence as a decimal from 0.0 (no idea) to 1.0 (completely certain).

Strict rules:
- If the email looks like an out-of-office or vacation reply → "Auto-Response" + "suppress".
- If the email is a newsletter, digest, or promo → "Promotional" + "suppress".
- If the subject or body contains "no-reply" or "do not reply" in the sender address → "suppress".
- Only choose "reply" if a real human is clearly seeking a response.
- When in doubt between actionable and passive, lean toward "suppress" to avoid reply loops.

Output format — respond with ONLY a valid JSON object, no markdown, no code fences, no extra text:
{
  "intent": "<one of the nine intent names above>",
  "confidence": <float 0.0–1.0>,
  "action": "<reply|suppress>",
  "reason": "<one concise sentence explaining the decision>"
}"""

# ─── Data types ───────────────────────────────────────────────────────────────

@dataclass
class Email:
    """Normalised representation of an incoming email."""
    message_id: str
    from_address: str
    subject: str
    body: str
    headers: dict[str, str]
    raw: Optional[object] = None  # original message object from your mail source

@dataclass
class ClassificationResult:
    """Structured output from the classifier pipeline."""
    intent: str        # one of ALL_INTENTS
    category: str      # "actionable" | "passive"
    confidence: float  # 0.0–1.0
    action: str        # "reply" | "suppress"
    reason: str


# ─── EmailProcessor ───────────────────────────────────────────────────────────

class EmailProcessor:
    """
    Full email classification pipeline:
      1. Header-based fast-path suppression (free, instant)
      2. LLM classification with Claude + prompt caching
      3. Human-in-the-loop review for low-confidence results
      4. Reply trigger (or dry-run logging)

    Instantiate once and call .process(email) or .process_batch(emails).
    """

    def __init__(self) -> None:
        self.client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

        self.dry_run = os.getenv("DRY_RUN", "false").lower() == "true"
        self.confidence_threshold = float(os.getenv("CONFIDENCE_THRESHOLD", "0.7"))
        self.model = os.getenv("CLASSIFIER_MODEL", "claude-haiku-4-5")

        log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
        log_level = getattr(logging, log_level_name, logging.INFO)
        logging.basicConfig(
            level=log_level,
            format="%(asctime)s [%(levelname)s] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%SZ",
        )
        self.logger = logging.getLogger("email_router")

        if self.dry_run:
            self.logger.info("DRY RUN mode active — no replies will be sent")

        self.logger.info(
            "EmailProcessor ready | model=%s threshold=%.0f%%",
            self.model, self.confidence_threshold * 100
        )

    # ── 1. Header-based pre-filter ────────────────────────────────────────────

    def _check_headers(self, headers: dict[str, str]) -> Optional[str]:
        """
        Returns a reason string if any header definitively marks this email as
        automated/passive. Returns None if the email should proceed to LLM.
        """
        for header_name, rule in SUPPRESS_HEADER_RULES.items():
            value = headers.get(header_name, "")
            if value and rule(value):
                return f"Header '{header_name}: {value}' marks email as automated"
        return None

    # ── 2. LLM classification ─────────────────────────────────────────────────

    def classify(self, email: Email) -> ClassificationResult:
        """
        Call Claude to classify the email.
        The static system prompt is cached; only the per-email user message varies.
        """
        # Dynamic content goes in the user message — NOT in the system prompt
        user_message = (
            f"From: {email.from_address}\n"
            f"Subject: {email.subject}\n\n"
            f"{email.body[:4000]}"  # guard against very long bodies
        )

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=256,
                # system as a list of content blocks so we can attach cache_control
                system=[
                    {
                        "type": "text",
                        "text": CLASSIFIER_SYSTEM_PROMPT,
                        # Cache the static prompt for 1 hour — reduces cost by ~90%
                        # after the first request (cache write is 2× base; reads are 0.1×)
                        "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    }
                ],
                messages=[{"role": "user", "content": user_message}],
            )

            # Log cache metrics so you can verify caching is working
            usage = response.usage
            self.logger.debug(
                "LLM tokens — input: %d | cache_write: %d | cache_read: %d | output: %d",
                usage.input_tokens,
                getattr(usage, "cache_creation_input_tokens", 0),
                getattr(usage, "cache_read_input_tokens", 0),
                usage.output_tokens,
            )

            # Extract the text block
            raw_text = next(
                (b.text.strip() for b in response.content if b.type == "text"),
                "{}"
            )

            parsed = json.loads(raw_text)
            intent = str(parsed.get("intent", "Information/FYI"))
            confidence = float(parsed.get("confidence", 0.5))
            action = str(parsed.get("action", "suppress"))
            reason = str(parsed.get("reason", ""))

            # Normalise / validate
            if intent not in ALL_INTENTS:
                self.logger.warning("Unknown intent %r — defaulting to Information/FYI", intent)
                intent = "Information/FYI"
            if action not in ("reply", "suppress"):
                action = "reply" if intent in ACTIONABLE_INTENTS else "suppress"

            category = "actionable" if intent in ACTIONABLE_INTENTS else "passive"
            return ClassificationResult(intent, category, confidence, action, reason)

        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            self.logger.error("Failed to parse LLM response: %s", exc)
            # Fail open — missed replies are worse than extra ones
            return ClassificationResult(
                intent="Question",
                category="actionable",
                confidence=0.0,
                action="reply",
                reason=f"Parse error ({exc}) — defaulting to reply",
            )
        except anthropic.RateLimitError as exc:
            self.logger.error("Rate limited: %s", exc)
            return ClassificationResult(
                intent="Question",
                category="actionable",
                confidence=0.0,
                action="reply",
                reason="Rate limit — defaulting to reply",
            )
        except anthropic.APIError as exc:
            self.logger.error("Anthropic API error: %s", exc)
            return ClassificationResult(
                intent="Question",
                category="actionable",
                confidence=0.0,
                action="reply",
                reason=f"API error ({exc}) — defaulting to reply",
            )

    # ── 3. Human-in-the-loop ──────────────────────────────────────────────────

    def _ask_human(self, email: Email, result: ClassificationResult) -> ClassificationResult:
        """
        Block and ask an operator to review a low-confidence classification.

        For async/production flows, swap this for a queue message, Slack notification,
        or webhook — anything that lets a human respond out-of-band.
        """
        print("\n" + "=" * 64)
        print("⚠️  LOW CONFIDENCE — HUMAN REVIEW REQUIRED")
        print("=" * 64)
        print(f"From:        {email.from_address}")
        print(f"Subject:     {email.subject}")
        print(f"Classified:  {result.intent} (confidence: {result.confidence:.0%})")
        print(f"Reason:      {result.reason}")
        print(f"Proposed:    {result.action.upper()}")
        print("-" * 64)
        body_preview = (email.body[:500] + "…") if len(email.body) > 500 else email.body
        print(f"Body preview:\n{body_preview}")
        print("=" * 64)

        while True:
            try:
                choice = input("Action? [r]eply / [s]uppress / [skip] → ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                # Non-interactive environment — keep the proposed action
                self.logger.warning("Non-interactive — keeping proposed action: %s", result.action)
                break

            if choice in ("r", "reply"):
                result.action = "reply"
                result.reason += " [human override → reply]"
                break
            elif choice in ("s", "suppress"):
                result.action = "suppress"
                result.reason += " [human override → suppress]"
                break
            elif choice in ("skip", ""):
                self.logger.info("Human skipped — keeping proposed action: %s", result.action)
                break
            else:
                print("  Please enter  r, s, or skip")

        return result

    # ── 4. Decision recording ─────────────────────────────────────────────────

    def _record(self, email: Email, result: ClassificationResult) -> None:
        """Emit a structured JSON audit log line for every decision."""
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": email.message_id,
            "from": email.from_address,
            "subject": email.subject,
            **asdict(result),
        }
        self.logger.info("DECISION %s", json.dumps(entry))

    # ── 5. Reply trigger (override this in your integration) ─────────────────

    def _trigger_reply(self, email: Email, result: ClassificationResult) -> None:
        """
        Called when the pipeline decides a reply should be generated.

        Override or call super() then extend to plug in your reply generator:

            class MyProcessor(EmailProcessor):
                def _trigger_reply(self, email, result):
                    draft = my_llm_reply_generator(email)
                    my_smtp_client.send(to=email.from_address, body=draft)
        """
        if self.dry_run:
            self.logger.info("[DRY RUN] Would generate reply for message_id=%s", email.message_id)
            return
        # Default stub — replace with your actual reply logic
        self.logger.info("REPLY TRIGGERED for message_id=%s", email.message_id)

    # ── Public API ────────────────────────────────────────────────────────────

    def process(self, email: Email) -> ClassificationResult:
        """
        Run the full pipeline for a single email.

        Steps:
          1. Header check (instant, free)
          2. LLM classification (Claude + prompt caching)
          3. Human-in-the-loop if confidence < threshold
          4. Record decision + trigger reply if actionable

        Returns the final ClassificationResult.
        """
        self.logger.info(
            "Processing id=%s from=%r subject=%r",
            email.message_id, email.from_address, email.subject,
        )

        # Step 1 — header fast-path
        header_reason = self._check_headers(email.headers)
        if header_reason:
            result = ClassificationResult(
                intent="Auto-Response",
                category="passive",
                confidence=1.0,
                action="suppress",
                reason=header_reason,
            )
            self.logger.info("SUPPRESSED by header | %s", header_reason)
            self._record(email, result)
            return result

        # Step 2 — LLM classification
        result = self.classify(email)
        self.logger.info(
            "Classified: %s (%.0f%%) → %s | %s",
            result.intent, result.confidence * 100, result.action.upper(), result.reason,
        )

        # Step 3 — human review for low confidence
        if result.confidence < self.confidence_threshold:
            self.logger.warning(
                "Confidence %.0f%% < threshold %.0f%% — requesting human review",
                result.confidence * 100, self.confidence_threshold * 100,
            )
            result = self._ask_human(email, result)

        # Step 4 — record + act
        self._record(email, result)
        if result.action == "reply":
            self._trigger_reply(email, result)

        return result

    def process_batch(self, emails: list[Email]) -> list[ClassificationResult]:
        """Process a list of emails in order. Returns results in the same order."""
        return [self.process(email) for email in emails]


# ─── Helper: build an Email from a raw dict ──────────────────────────────────

def email_from_dict(raw: dict) -> Email:
    """
    Convert a raw dict (IMAP fetch, webhook payload, etc.) into an Email object.
    Normalises header keys to lowercase.

    Adjust the field-name lookups to match your mail source's schema.
    """
    headers = {k.lower(): str(v) for k, v in raw.get("headers", {}).items()}
    return Email(
        message_id=raw.get("message_id") or raw.get("id") or "",
        from_address=raw.get("from") or raw.get("from_address") or "",
        subject=raw.get("subject") or "",
        body=raw.get("body") or raw.get("text") or raw.get("snippet") or "",
        headers=headers,
        raw=raw,
    )


# ─── CLI demo ─────────────────────────────────────────────────────────────────

def _demo() -> None:
    """Quick smoke-test with four representative emails."""
    processor = EmailProcessor()

    samples = [
        {
            "message_id": "msg-001",
            "from": "alice@example.com",
            "subject": "Question about your weekend availability",
            "body": "Hi there, do you have any appointments available this Saturday? Thanks, Alice",
            "headers": {},
        },
        {
            "message_id": "msg-002",
            "from": "noreply@slack.com",
            "subject": "Your weekly Slack activity digest",
            "body": "Here's a summary of your Slack workspace activity this week...",
            "headers": {"x-auto-response-suppress": "OOF, DR, RN, NRN"},
        },
        {
            "message_id": "msg-003",
            "from": "john.smith@company.com",
            "subject": "Out of Office: Back on Monday",
            "body": "I am currently out of the office until Monday. I will respond when I return.",
            "headers": {"auto-submitted": "auto-replied"},
        },
        {
            "message_id": "msg-004",
            "from": "bob@client.com",
            "subject": "Move our Tuesday session?",
            "body": "Hey, could we push our 3 pm slot to 4 pm on Tuesday? Let me know if that works.",
            "headers": {},
        },
    ]

    print("\n" + "=" * 64)
    print("  Email Intent Router — Demo")
    print(f"  model={processor.model} | dry_run={processor.dry_run} | threshold={processor.confidence_threshold:.0%}")
    print("=" * 64 + "\n")

    for raw in samples:
        email = email_from_dict(raw)
        result = processor.process(email)
        icon = "✅ REPLY   " if result.action == "reply" else "🚫 SUPPRESS"
        print(f"{icon} | {result.intent:<20} {result.confidence:.0%}  | {email.subject}")
        print(f"            {result.reason}\n")


if __name__ == "__main__":
    _demo()

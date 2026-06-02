# Email Intent Router

Classifies incoming emails as **actionable** (reply) or **passive** (suppress) to prevent unnecessary automated replies, OOO loops, and newsletter responses.

## How it works

```
Incoming email
      │
      ▼
┌─────────────────────────┐
│  1. Header pre-filter   │  Free & instant — suppress immediately if automated
│  (RFC 3834 / RFC 2369)  │  headers are present (Auto-Submitted, X-Auto-Response-
└────────────┬────────────┘  Suppress, List-Id, Precedence: bulk, …)
             │ no suppression headers found
             ▼
┌─────────────────────────┐
│  2. Claude classifier   │  Calls Anthropic API with prompt caching.
│  (LLM intent routing)   │  Static system prompt cached for 1 h → ~90% cost saving
└────────────┬────────────┘  after the first request.
             │
             ▼
┌─────────────────────────┐
│  3. Confidence gate     │  If confidence < CONFIDENCE_THRESHOLD (default 70%),
│  (human-in-the-loop)    │  block and ask a human operator to approve/override.
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  4. Act                 │  "reply"    → call _trigger_reply() (or DRY_RUN log)
│                         │  "suppress" → log decision, do nothing
└─────────────────────────┘
```

### Intent taxonomy

| Intent | Category | Action |
|---|---|---|
| Question | Actionable | reply |
| Request | Actionable | reply |
| Scheduling | Actionable | reply |
| Problem | Actionable | reply |
| Information/FYI | Passive | suppress |
| Transactional | Passive | suppress |
| System Alert | Passive | suppress |
| Auto-Response | Passive | suppress |
| Promotional | Passive | suppress |

---

## Setup

```bash
# 1. Create a virtual environment
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment variables (see section below)
cp .env.example .env
# edit .env with your keys

# 4. Run the built-in demo
python email_router.py
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Your Anthropic API key |
| `DRY_RUN` | | `false` | Set to `true` to log decisions without triggering replies |
| `CONFIDENCE_THRESHOLD` | | `0.7` | Float 0–1. Classifications below this ask a human |
| `CLASSIFIER_MODEL` | | `claude-haiku-4-5` | Anthropic model ID. `claude-haiku-4-5` is fast and cheap for classification; use `claude-opus-4-7` for highest accuracy |
| `LOG_LEVEL` | | `INFO` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |

Create a `.env` file (never commit it):

```ini
ANTHROPIC_API_KEY=sk-ant-...
DRY_RUN=false
CONFIDENCE_THRESHOLD=0.7
CLASSIFIER_MODEL=claude-haiku-4-5
LOG_LEVEL=INFO
```

Load it in Python with `python-dotenv`:

```python
from dotenv import load_dotenv
load_dotenv()

from email_router import EmailProcessor, email_from_dict
processor = EmailProcessor()
```

---

## Integration

### Minimal example

```python
from dotenv import load_dotenv
load_dotenv()

from email_router import EmailProcessor, Email

processor = EmailProcessor()

email = Email(
    message_id="abc-123",
    from_address="customer@example.com",
    subject="Can I reschedule my appointment?",
    body="Hi, I need to move my booking from Tuesday to Wednesday. Is that possible?",
    headers={},
)

result = processor.process(email)
# result.action  → "reply"
# result.intent  → "Scheduling"
# result.confidence → 0.95
# result.reason  → "Sender is requesting to reschedule an existing appointment"
```

### Plugging in your reply generator

Override `_trigger_reply` in a subclass:

```python
class MyEmailProcessor(EmailProcessor):
    def _trigger_reply(self, email, result):
        if self.dry_run:
            return
        draft = my_llm_reply_generator(email.subject, email.body)
        my_smtp_client.send(
            to=email.from_address,
            subject=f"Re: {email.subject}",
            body=draft,
        )
```

### IMAP polling loop

```python
import time
from imaplib import IMAP4_SSL
from email import message_from_bytes
from email_router import EmailProcessor, Email

processor = EmailProcessor()

with IMAP4_SSL("imap.gmail.com") as imap:
    imap.login("you@gmail.com", "app-password")
    while True:
        imap.select("INBOX")
        _, data = imap.search(None, "UNSEEN")
        for uid in data[0].split():
            _, msg_data = imap.fetch(uid, "(RFC822)")
            msg = message_from_bytes(msg_data[0][1])
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode()
                        break
            else:
                body = msg.get_payload(decode=True).decode()

            email = Email(
                message_id=msg["Message-ID"] or uid.decode(),
                from_address=msg["From"],
                subject=msg["Subject"] or "",
                body=body,
                headers={k.lower(): v for k, v in msg.items()},
            )
            processor.process(email)
            imap.store(uid, "+FLAGS", "\\Seen")
        time.sleep(30)
```

---

## Prompt caching

The static classifier system prompt (~400 tokens) is marked with `cache_control: {type: "ephemeral", ttl: "1h"}`. After the first request writes it to Anthropic's cache, subsequent requests pay only ~10% of the normal input cost for those tokens.

Verify caching is working by setting `LOG_LEVEL=DEBUG` — you'll see:

```
LLM tokens — input: 12 | cache_write: 412 | cache_read: 0 | output: 48   ← first request
LLM tokens — input: 12 | cache_write: 0   | cache_read: 412 | output: 51  ← cache hit ✅
```

If `cache_read` stays at 0, check that `CLASSIFIER_MODEL` hasn't changed between requests — the cache is model-scoped.

---

## Cost estimate

Using `claude-haiku-4-5` with prompt caching enabled:

| | Per-email cost |
|---|---|
| First request (cache write) | ~$0.0001 |
| Subsequent requests (cache read) | ~$0.00001 |

For 10,000 emails/month: **< $0.15/month**.

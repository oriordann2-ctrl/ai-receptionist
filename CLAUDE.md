# Sprimal — Claude Session Notes

## Ideas List
There is a persistent ideas list at `IDEAS.md` in the project root. 
- **When the user mentions a new idea**, add it to `IDEAS.md` immediately.
- **When an idea gets built**, update its status in `IDEAS.md`.
- Check `IDEAS.md` at the start of sessions if the user asks about the backlog.

## Security Constraint (NEVER BYPASS)
**Monkstown** is a real active client with real customers.
- NEVER seed test data against the `monkstown` tenant
- NEVER run Stripe live operations against it using test keys
- NEVER run `seedTennisClubFlows` or any seed function targeting Monkstown in production
- Test Stripe only against `lakewood-tennis-club` with `sk_test_...` keys

## Project Overview
Sprimal is an AI receptionist / chat widget SaaS. Key files:
- `index.js` — main Express server, all API routes, seed functions, crawl logic
- `public/widget.js` — the embeddable chat widget (vanilla JS, no framework)
- `public/cosy-cafe-demo.html` — single design demo for Cosy Café
- `public/cosy-cafe-designs.html` — 4-theme design showcase with live switcher

## Stack
- Node.js / Express backend on Render
- Supabase (Postgres + pgvector for embeddings)
- OpenAI for embeddings + chat completions
- Stripe for payments
- Static files served from `public/` → `https://app.sprimal.com/`

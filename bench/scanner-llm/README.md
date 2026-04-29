# P16 — Bench Scanner LLM EU Providers

Compare 6 providers RGPD-friendly sur la tâche de sélection de momentum du scanner Gainers SmartVest.

## Providers

| ID | Modèle | Hébergement |
|---|---|---|
| `codestral` | codestral-latest | Mistral La Plateforme (FR) |
| `scaleway` | llama-3.3-70b-instruct | Scaleway PAR-1 (FR) |
| `gemini-flash` | gemini-2.5-flash | Google AI (europe-west1) |
| `gemini-flash-lite` | gemini-2.5-flash-lite | Google AI (europe-west1) |
| `gpt-4.1-mini` | gpt-4.1-mini | OpenAI (DPA RGPD) |
| `gpt-4.1-nano` | gpt-4.1-nano | OpenAI (DPA RGPD) |

## Setup

```bash
cp bench/scanner-llm/.env.example bench/scanner-llm/.env.bench
# remplir les clés API dans .env.bench
npm run bench:scanner-eu
```

## Résultat

- `bench/scanner-llm/results/results-{provider}-{ts}.jsonl` — résultats bruts
- `bench/scanner-llm/REPORT.md` — tableau comparatif + recommandation routing

## Variables d'environnement

| Variable | Provider |
|---|---|
| `MISTRAL_API_KEY` | Codestral |
| `SCALEWAY_API_KEY` | Scaleway Llama |
| `SCALEWAY_BASE_URL` | Scaleway base URL (défaut: https://api.scaleway.ai/v1) |
| `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`) | Gemini Flash / Flash-Lite |
| `OPENAI_API_KEY` | GPT-4.1-mini / nano |

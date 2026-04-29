# P16 Bench — LLM EU Providers — Scanner Gainers
_Generated: 2026-04-29T06:19:41.033Z_

## Résultats

| Provider | Precision | Recall | AssetClass Acc | JSON Valid | p50 ms | Cost/prompt $ | Composite ▼ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-flash-lite | 80.0% | 96.7% | 90.0% | 100.0% | 1032 | 0.00011 | 0.66 |
| gpt-4.1-nano | 73.3% | 81.7% | 89.7% | 100.0% | 1112 | 0.00009 | 0.62 |
| codestral | 70.0% | 75.0% | 85.2% | 100.0% | 1036 | 0.00025 | 0.61 |
| gpt-4.1-mini | 76.7% | 93.3% | 90.0% | 100.0% | 2383 | 0.00042 | 0.54 |
| gemini-flash | 16.7% | 20.0% | 100.0% | 20.0% | 1864 | 0.00013 | 0.37 |
| scaleway | 0.0% | 0.0% | 0.0% | 0.0% | 6364 | 0.00000 | 0.33 |

## Champion absolute cost (Top 2)
- **scaleway** — $0.00000/prompt
- **gpt-4.1-nano** — $0.00009/prompt

## Champion best value (composite)
**gemini-flash-lite** — score 0.66 (qualité 88.3%, coût $0.00011/prompt)

## Recommandation routing SmartVest

| Cas d'usage | Provider recommandé | Raison |
|---|---|---|
| Scanner gainers temps réel (latence critique) | gemini-flash-lite | p50 le plus bas |
| Thesis generation (qualité max) | gemini-flash-lite | composite score #1 |
| News screening (coût × volume) | scaleway | coût/prompt minimal |
| Fallback EU souverain RGPD strict | scaleway ou codestral | datacenter FR certifié |

# JET7 2.0.0

Servidor JET7 + página JET7 no mesmo endereço, instalável como app (PWA) no telemóvel e no computador.

## Novidades da 2.0.0
- **Página integrada**: abra o endereço do servidor (ex.: https://jet7-server.onrender.com) e a página JET7 aparece. O servidor padrão da página passa a ser esse próprio endereço; pode colar outro URL no campo "URL do servidor".
- **Instalar como app**: no Chrome/Edge (Android, Windows, Mac) aparece o botão **Instalar app**; no iPhone use Partilhar → "Adicionar ao ecrã principal". O service worker só guarda os ficheiros da página; a API (`/api`, `/client`, `/public/*`) nunca fica em cache.
- **Base de dados Postgres (Supabase)**, ativa quando existe `DATABASE_URL`. As tabelas são criadas sozinhas no arranque: `users`, `api_keys` (chaves encriptadas com MASTER_KEY, como antes), `trades` (histórico e simulações, incluindo `fiat_sim`), `payments`, `licenses`, `settings` (autobot, botão de emergência, inventário simulado) e `daily_stats`.
  - Na primeira vez, com a BD vazia e `GITHUB_TOKEN`, importa os dados dos Gists (histórico, autobot, pagamentos, contas) e dos ficheiros locais.
  - Escritas em lote a cada ~2,5 s, só com o que mudou; pool com no máximo 3 ligações (Render Free 512 MB).
  - Cópia de segurança diária da BD para o Gist (com `GITHUB_TOKEN`), nos mesmos ficheiros da 1.x — pode voltar à 1.x sem perder dados.
  - Sem `DATABASE_URL`, tudo funciona exatamente como na 1.16 (Gist + ficheiros).
- `GET /api/health` mostra `storage: "postgres" | "gist"` e o estado da BD. Novos: `GET /api/daily-stats?days=30`, `POST /api/backup`, `GET /ping`.

## Regras que não mudam
- `DRY_RUN=true` por defeito: só simulação, nenhuma ordem real.
- Sem P2P fiat (USDT/fiat só no livro spot e só em simulação). DEX só em vigilância (sem carteira).

## Supabase em 3 passos
1. Crie um projeto em supabase.com (região UE, ex.: Frankfurt).
2. Project Settings → Database → Connection string → copie o URI (de preferência o "Session/Transaction pooler") com a palavra-passe da BD.
3. No Render → Environment → `DATABASE_URL` = esse URI → guardar. No arranque, o servidor cria as tabelas e importa os Gists.

---

# Servidor JET7 — Modo Real (guia da 1.x, continua válido)

Este servidor liga o Modo Real da página JET7 às corretoras. As chaves API ficam encriptadas aqui, nunca no telemóvel.

Como funciona: o saldo fica em cada corretora (por exemplo, USDT na KuCoin e USDC na Gate). Só pares entre stablecoins, sem moeda local, por isso funciona a partir de Angola. Quando o preço difere, o servidor compra numa e vende na outra ao mesmo tempo. Não há saques entre corretoras.

## Proteção anti-perda
- Antes de cada ordem, recalcula com o livro de ofertas atual, incluindo taxas e slippage.
- Só envia ordens se o lucro líquido for ≥ MIN_PROFIT_PCT. Caso contrário, tenta 3 vezes e depois desiste sem operar.
- As ordens são LIMIT IOC no preço recalculado, por isso nunca executam a um preço pior.
- Limite por operação: MAX_ORDER_QUOTE. Botão de emergência: POST /api/stop.
- Risco que fica: se uma das duas ordens falhar, fica uma perna aberta e é preciso reequilibrar à mão. O servidor avisa quando isso acontece.

## Pôr a correr (Render, grátis para testar)
1. Crie uma conta no GitHub e envie esta pasta para um repositório privado.
2. Em render.com: New → Web Service → escolha o repositório. **Região: Frankfurt (EU)**, porque a Binance e a Bybit bloqueiam servidores nos EUA. Build: `npm install`. Start: `npm start`.
3. Localmente ou no Shell do Render, corra `npm run gerar-chaves` e copie ACCESS_TOKEN e MASTER_KEY para as Environment Variables. Copie também as restantes variáveis do `.env.example`.
4. Abra o JET7 → REAL → cole o URL do Render e o ACCESS_TOKEN → Testar ligação.
5. Guarde as chaves de cada corretora no painel.

Nota: no plano grátis do Render o disco não é permanente, por isso as chaves e o histórico perdem-se quando o servidor reinicia. Para uso a sério, use uma VPS ou adicione um disco persistente.

## Chaves API nas corretoras
- Ative apenas **Leitura + Trading Spot**. **Nunca ative saques.**
- Restrinja a chave ao IP do servidor, se a corretora permitir.
- KuCoin e Bitget pedem também a Passphrase.

## Passar a ordens reais
1. Deixe correr alguns dias com DRY_RUN=true e veja no Histórico se os lucros simulados se confirmam.
2. Mude DRY_RUN=false com MAX_ORDER_QUOTE baixo (ex.: 50).
3. Só depois aumente os valores.

## API (todas com cabeçalho `Authorization: Bearer ACCESS_TOKEN`)
GET /api/health · POST /api/keys · DELETE /api/keys/:exchange · GET /api/balances · GET /api/opportunities?amount=50 · POST /api/execute · POST /api/stop · POST /api/resume · GET /api/history

## Notas
- A página publicada em https (Netlify) só consegue falar com um servidor https. O Render já dá https.
- "Sem oportunidades no servidor agora" é normal: significa que nenhuma rota tem lucro líquido depois das taxas. A proteção está a fazer o seu trabalho.
- Depois da paragem de emergência, carregue em "Testar ligação" para retomar.
- Se uma ordem executar só de um lado, o servidor pára sozinho até reequilibrar os saldos.

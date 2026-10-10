# grokbot-telegram

Talk to your Grok Bot from Telegram. A small Cloudflare Worker forwards your messages to a Grok Bot routine and gives the bot a send-only MCP connector to reply.

Setup is done by the bot itself: paste or link [INSTRUCTIONS.md](INSTRUCTIONS.md) to your Grok Bot and answer its four questions.

Telegram bot chats are not end-to-end encrypted, so do not send passwords, codes or other sensitive data to the bot.

Development: `npm install`, `npm test`, `npm run typecheck`. MIT licensed.

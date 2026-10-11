The setup instructions for your Grok Bot now live in the [README](README.md#setup-instructions-for-the-grok-bot).

When you ask your human for the routine values, send direct links to the routine sidebar fields, not just the Routines tab. Replace `<routine folder id>` with the routine's folder id and send both as markdown links with descriptive text, for example `[Copy the Webhook URL](grokbot://app/v1/sidebar?tab=routines&automation=<routine folder id>&target=webhook-url)` and `[Copy the Authorization header](grokbot://app/v1/sidebar?tab=routines&automation=<routine folder id>&target=webhook-header)`. Tell them exactly where each value goes: the Webhook URL into the `GROKBOT_WEBHOOK_URL` masked field, and the Authorization header into the `GROKBOT_WEBHOOK_AUTH` masked field.

The routine prompt template is in [step 1](README.md#1-create-the-routine). It describes the batch payload, a `messages` list holding text, photos, voice messages, audio, documents and albums, and the media the bot may send back. [Message batching](README.md#message-batching) explains the per-chat wait and how to change `DEBOUNCE_MS`. [Photos, voice messages and files](README.md#photos-voice-messages-and-files) covers the media fields and send tools. Neither feature needs a new secret, so `scripts/setup.sh` is unchanged. A deploy from the repo creates the Durable Object.

## Reactions

Reactions work both ways, and they go through the same allowlist and per-chat wait as messages.

### Reading inbound reactions

When your human adds or removes a reaction, the batch gets an entry like this one.

    { "type": "reaction", "message_id": 42, "date": 1760180000, "from": { "id": 111, "first_name": "Ada" }, "emoji": "👍", "removed": false }

- `message_id` is the message they reacted to. Usually that is one of your own replies.
- `emoji` is one standard Telegram reaction emoji. Custom emoji and paid reactions are not forwarded.
- `removed: true` means they took the reaction back, and `emoji` is the one they removed.
- Entries are in message order. A reaction sits right after the message it is on, so it can come before newer text in the same batch.
- If they change a reaction on one message several times within the wait, you get only the final state.

Read a reaction as a short reply to that message. 👍 on your question means yes. 👎 means no or not that. 👀 means they are looking at it. A reaction on its own usually asks for nothing, so a batch that holds only reactions often needs no reply at all.

### Reacting instead of replying

Use `send_telegram_reaction` with the payload's `chat_id` and the `message_id` of the last entry when a plain acknowledgement is all a reply would say. Thanks, ok, got it, and done all count. 👍 is the default, ❤ fits thanks, and 🙏 fits a favour. It still counts as the one send that ends the run, so never send a reaction and a message for the same thing.

Reply with a message whenever there is anything to say, a question to answer, or work to report. Only the 73 standard reaction emoji from the Bot API are accepted. Pass an empty `emoji` to clear the bot's reaction.

### Upgrading an existing install

After the reactions PR is merged into `main`, run these four steps in order.

1. Deploy from an up-to-date clone of `main`.

        git pull
        npm ci
        npx wrangler deploy --name <your worker name>

2. Re-run `POST /setup`, so Telegram starts sending `message_reaction` updates. Telegram keeps the previous `allowed_updates` until the webhook is set again. With `WORKER_URL` and `MCP_BEARER_TOKEN` in the environment, run the command below. It should print `{"ok":true,"description":"Webhook was set"}`.

        printf 'header = "Authorization: Bearer %s"\n' "$MCP_BEARER_TOKEN" \
          | curl -sS -X POST --config /dev/stdin "$WORKER_URL/setup"

3. Refresh the MCP connector's tools and confirm `send_telegram_reaction` is listed.
4. Replace the routine prompt with the one in [step 1](README.md#1-create-the-routine). Rules 2, 7 and 10 changed for reactions.

// Thin Telegram Bot API helpers for Cloudflare Workers.

export function tg(env) {
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }
  return {
    sendMessage: (chat_id, text, extra = {}) =>
      call("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra }),
    answerCallbackQuery: (id, extra = {}) =>
      call("answerCallbackQuery", { callback_query_id: id, ...extra }),
    editMessageText: (chat_id, message_id, text, extra = {}) =>
      call("editMessageText", { chat_id, message_id, text, parse_mode: "HTML", ...extra }),
    sendPhoto: (chat_id, photo, extra = {}) =>
      call("sendPhoto", { chat_id, photo, ...extra }),
    call,
  };
}

// Inline keyboard builder: rows of [{text, data}] -> Telegram markup.
export function keyboard(rows) {
  return {
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.data }))
      ),
    },
  };
}

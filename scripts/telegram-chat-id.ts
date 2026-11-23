/**
 * Averigua el numero del chat donde debe escribir el bot.
 *
 * Un bot no puede empezar una conversacion: solo responde a un chat que ya le
 * ha hablado. Por eso el orden es escribirle primero y preguntar despues.
 *
 * Lee el token del `.env`, que no entra en git, y **no lo imprime nunca**:
 * lo unico que sale por pantalla es el numero del chat y de quien es.
 *
 * Uso:  npm run telegram-id
 */

const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();

if (token === undefined || token === '') {
  console.log('Falta TELEGRAM_BOT_TOKEN en .env. Pega ahi el token de @BotFather.');
  process.exit(1);
}

interface Chat {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
}

const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
  signal: AbortSignal.timeout(15_000),
});
const d = (await r.json()) as {
  ok: boolean;
  description?: string;
  result?: { message?: { chat?: Chat }; channel_post?: { chat?: Chat } }[];
};

if (!d.ok) {
  // El mensaje de Telegram puede traer la URL con el token dentro.
  console.log(`Telegram responde: ${(d.description ?? 'error').split(token).join('***')}`);
  process.exit(1);
}

const chats = new Map<number, Chat>();
for (const u of d.result ?? []) {
  const c = u.message?.chat ?? u.channel_post?.chat;
  if (c !== undefined) chats.set(c.id, c);
}

if (chats.size === 0) {
  console.log('El bot no ha recibido ningun mensaje todavia.');
  console.log('Abre Telegram, buscalo por su nombre de usuario, mandale "hola" y repite.');
  process.exit(0);
}

console.log('Chats que le han escrito al bot:\n');
for (const c of chats.values()) {
  const quien = c.title ?? c.username ?? c.first_name ?? 'sin nombre';
  console.log(`  TELEGRAM_CHAT_ID=${c.id}    ${c.type}  ${quien}`);
}
console.log('\nCopia la linea del chat que quieras y pegala en .env.');

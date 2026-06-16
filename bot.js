require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fetch = require('node-fetch');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const CHANNELS = [process.env.DISCORD_CHANNEL_1, process.env.DISCORD_CHANNEL_2].filter(Boolean);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY;
const MARKET_URL = process.env.MARKET_URL || 'http://localhost:3000';

client.once('ready', () => {
  console.log(`Бот ${client.user.tag} запущен, слушаю каналы: ${CHANNELS.join(', ')}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!CHANNELS.includes(message.channel.id)) return;
  const content = message.content.trim();
  if (!content) return;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        messages: [
          { role: 'system', content: 'Ты анализируешь новости для сообщества The Zone (проект в Minecraft и не только). Оцени влияние новости на цену внутренней валюты (алмазов) в процентах. Верни только число с плавающей точкой от -15 до +15. Если новость экстраординарная, можно выйти за пределы. Не пиши ничего кроме числа.' },
          { role: 'user', content }
        ],
        max_tokens: 10,
        temperature: 0.3,
      }),
    });
    const data = await response.json();
    const rawImpact = parseFloat(data.choices?.[0]?.message?.content?.trim());
    if (isNaN(rawImpact)) {
      console.log('Не удалось извлечь влияние из:', data.choices?.[0]?.message?.content);
      return;
    }
    const impact = Math.max(-20, Math.min(20, rawImpact));
    const title = content.substring(0, 100);
    const body = `Автоматическая новость. Влияние: ${impact > 0 ? '+' : ''}${impact.toFixed(2)}%`;

    await fetch(`${MARKET_URL}/api/bot/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: BOT_SECRET_KEY, title, body, impact }),
    });
    console.log(`Новость добавлена: "${title}" (${impact}%)`);
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

import { Telegraf, Markup } from 'telegraf';
import mongoose from 'mongoose';
import { google } from 'googleapis';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { session } from 'telegraf'; // Используем встроенную поддержку сессий
import axios from 'axios';
import dotenv from 'dotenv';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
const REDIRECT_URL = 'https://fytt.hopto.org:3000/oauth2callback';
const LEMNOS_API_URL = 'https://yt.lemnoslife.com/channels';
const MODERATOR_CHAT_ID = process.env.MODERATOR_CHAT_ID;


// Подключение к MongoDB
await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const certDir = `/etc/letsencrypt/live`;
const domain = `fytt.hopto.org`;

const options = {
    key: fs.readFileSync(`${certDir}/${domain}/privkey.pem`),
    cert: fs.readFileSync(`${certDir}/${domain}/fullchain.pem`)
};

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();
const server = https.createServer(options, app);

// Определение схем и моделей
const channelSchema = new mongoose.Schema({
    name: String,
    youtube_url: { type: String, unique: true }, // Обеспечиваем уникальность youtube_url
    telegram_url: String,
    requested_times: { type: Number, default: 0 }
});

const pendingChannelSchema = new mongoose.Schema({
    name: String,
    youtube_url: { type: String, unique: true }, // Обеспечиваем уникальность youtube_url
    telegram_url: String,
    submitted_by: mongoose.Schema.Types.Mixed
});

const Channel = mongoose.model('Channel', channelSchema);
const PendingChannel = mongoose.model('PendingChannel', pendingChannelSchema);

// Настройка сессий
bot.use(session());

// Генерация ссылки для авторизации
async function generateAuthUrl(chatId) {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_id, client_secret } = credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URL);
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        state: chatId.toString()
    });
    return authUrl;
}

// Начальная команда
bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const authUrl = await generateAuthUrl(chatId);
    await setBotCommands()
    ctx.replyWithHTML('<b>Приветствуем вас в нашем сервисе поиска Телеграмм каналов ютуберов!</b>\nОтветы на вопросы: /faq (или пишите @vitosperansky)\n\nВыберите опцию:', Markup.inlineKeyboard([
        [Markup.button.callback('Найти YouTube-каналы в Telegram', 'find_channels')],
        [Markup.button.callback('Связать YouTube-канал с Telegram-каналом', 'link_channel')]
    ]));
});

// Обработка нажатий на кнопку "Найти YouTube-каналы в Telegram"
const find_channels = async (ctx) => {
    const chatId = ctx.chat.id;
    const authUrl = await generateAuthUrl(chatId);
    ctx.replyWithHTML('<b>Нажмите кнопку ниже для авторизации на Youtube и получения списка ваших подписок:</b>\n\n<i>Процесс займет время: ~50 секунд. (в зависимости от количества ваших подписок)</i>', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Авторизоваться и найти подписки', url: authUrl }]
            ]
        }
    });
};

bot.action('find_channels', async (ctx) => {
    ctx.answerCbQuery(); 
    await find_channels(ctx)
})

bot.command('find_channels', async (ctx) => {
    await find_channels(ctx)
})

bot.command('faq', async (ctx) => {
    ctx.replyWithMarkdown(`**Ответы на вопросы о проекте:**\n\nКакова цель проекта?\n— Максимально упростить поиск Телеграмм каналов ваших любимых авторов.\n\nУ меня не украдут Google Аккаунт?\n— Нет, бот имеет открытый исходный код, который может посмотреть каждый желающий на Github - https://github.com/VitoSperansky/FromYoutubeToTelegram.\n\nКак работает бот?\n— Бот просит вас авторизоваться в свой Google аккаунт, чтобы получить список ваших подписок на YouTube. Затем система обращается к своей базе данных, где хранятся соответствия YouTube-каналов и их Телеграмм-каналов. Если бот находит соответствия в базе данных, он записывает их в список найденных каналов. Если YouTube-каналы, на которые вы подписаны, отсутствуют в нашей базе данных, бот отправляет запрос в YouTube на получение ссылок социальных сетей, привязанных к каналу. Среди этих ссылок бот ищет ссылку на Телеграмм. Найдя новую ссылку на Телеграмм-канал, бот добавляет её в базу данных. В итоге, пользователь получает список YouTube-каналов с их Телеграмм-каналами.\n\nОстались вопросы? - Пишите @vitosperansky`)
})

// Установка команд для отображения в меню
async function setBotCommands() {
    await bot.telegram.setMyCommands([
        { command: 'start', description: 'Запуск бота и показ главного меню' },
        { command: 'find_channels', description: 'Найти YouTube-каналы в Telegram' },
        { command: 'link_channel', description: 'Связать YouTube-канал с Telegram-каналом' }
    ]);
}

// Функция для получения ссылок из описания канала с помощью стороннего API
async function getChannelLinksFromDescription(channelId) {
    try {
        const response = await axios.get(`${LEMNOS_API_URL}?part=about&id=${channelId}`);
        return response.data;
    } catch (error) {
        console.error('Error getting channel info from Lemnos Life API:', error);
        return null;
    }
}

// Поиск Telegram ссылки
function findTelegramLink(links) {
    if (!Array.isArray(links)) {
        console.error('Expected an array of links but received:', links);
        return null;
    }

    for (const link of links) {
        if (link && typeof link === 'object' && link.url) {
            if (link.url.includes('t.me/')) {
                return link.url;
            }
        }
    }
    return null;
}

// Функция для проверки и добавления новых каналов
async function checkAndAddNewChannels(subscriptions, youtubeApiKey, chatId) {
    const youtubeUrls = subscriptions.map(sub => `https://www.youtube.com/channel/${sub.channelId}`);
    const foundChannels = await Channel.find({ youtube_url: { $in: youtubeUrls } });
    const foundUrls = new Set(foundChannels.map(ch => ch.youtube_url));
    // Фильтрация не найденных каналов
    const notFoundChannels = subscriptions.filter(sub => !foundUrls.has(`https://www.youtube.com/channel/${sub.channelId}`));

    for (const sub of notFoundChannels) {
        const youtubeUrl = `https://www.youtube.com/channel/${sub.channelId}`;
        try {
            // Получаем информацию о канале из YouTube API
            //const channelInfo = await getYouTubeChannelInfo(sub.channelId, youtubeApiKey);

            // Получаем ссылки из описания канала с помощью стороннего API
            const channelInfo = await getChannelLinksFromDescription(sub.channelId);

            if (channelInfo && channelInfo.items && channelInfo.items.length > 0) {
                const links = channelInfo.items[0].about.links || [];
                const telegramLink = findTelegramLink(links);

                if (telegramLink) {
                    // Добавляем новый канал в базу данных
                    await Channel.create({
                        name: sub.title,
                        youtube_url: youtubeUrl,
                        telegram_url: telegramLink,
                        requested_times: 0
                    });

                    await bot.telegram.sendMessage(MODERATOR_CHAT_ID, `Найден новый канал:\nYouTube: ${youtubeUrl}\nTelegram: ${telegramLink}`);
                }
            }
        } catch (error) {
            console.error('Ошибка получения информации о канале:', error);
        }
    }

    const newfoundChannels = await Channel.find({ youtube_url: { $in: youtubeUrls } });
    const newfoundUrls = new Set(newfoundChannels.map(ch => ch.youtube_url));
    // Фильтрация не найденных каналов
    const newnotFoundChannels = subscriptions.filter(sub => !newfoundUrls.has(`https://www.youtube.com/channel/${sub.channelId}`));

    // Группировка каналов по Telegram URL
    const groupedChannels = newfoundChannels.reduce((acc, ch) => {
        const telegramUrl = ch.telegram_url.split('/').pop();
        if (!acc[telegramUrl]) {
            acc[telegramUrl] = [];
        }
        acc[telegramUrl].push(`[${ch.name}](${ch.youtube_url})`);
        return acc;
    }, {});

    // Формирование сообщения для найденных каналов
    const foundChannelsMessage = Object.entries(groupedChannels).map(([telegramUrl, channels]) => {
        return `${channels.join(', ')} - [@${telegramUrl}](https://t.me/${telegramUrl})`;
    }).join('\n') || 'Не найдено';

    // Формирование сообщения для не найденных каналов
    
    const notFoundChannelsMessage = newnotFoundChannels.length > 0
        ? newnotFoundChannels.map(sub => `[${sub.title}](https://www.youtube.com/channel/${sub.channelId})`).join('\n')
        : 'Не найдено';
        
    // Формирование окончательного сообщения
    const message = `Найденные каналы в Telegram:\n${foundChannelsMessage}\n\nНе найденные каналы в Telegram:\n${notFoundChannelsMessage}`;

    // Отправка сообщения пользователю
    await bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    });
}


// Обработка редиректа после авторизации
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const chatId = req.query.state;

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_id, client_secret } = credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URL);

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        const subscriptions = await listSubscriptions(oAuth2Client);
        await checkAndAddNewChannels(subscriptions, oAuth2Client, chatId);

        res.send('Авторизация успешна! Вы можете закрыть это окно.');
    } catch (error) {
        console.error('Ошибка получения токена', error);
        res.send('Ошибка авторизации.');
    }
});

// Получение списка подписок пользователя
async function listSubscriptions(auth) {
    try {
        const service = google.youtube('v3');
        const response = await service.subscriptions.list({
            auth: auth,
            part: 'snippet',
            mine: true,
            maxResults: 50
        });

        const subscriptions = response.data.items.map(item => ({
            title: item.snippet.title,
            channelId: item.snippet.resourceId.channelId
        }));

        return subscriptions;
    } catch (error) {
        console.error('Ошибка получения подписок', error);
        return [];
    }
}

// Обработка нажатий на кнопку "Связать YouTube-канал с Telegram-каналом"
const link_channel = (ctx) => {
    ctx.reply('Пожалуйста, отправьте URL-адрес YouTube-канала, к которому хотите привязать Telegram-канал.');
    ctx.session = ctx.session || {}; // Инициализация сессии, если она отсутствует
    ctx.session.awaitingYouTubeUrl = true; // Установка состояния ожидания YouTube URL
};

bot.action('link_channel', async (ctx) => {
    ctx.answerCbQuery(); 
    await link_channel(ctx)
})

bot.command('link_channel', async (ctx) => {
    await link_channel(ctx)
})

// Функция для получения ссылок из описания канала с помощью стороннего API
async function convertUsernameToStandardUrl(username) {
    try {
        const response = await axios.get(`${LEMNOS_API_URL}?part=about&handle=@${username}`);
        let url = `https://www.youtube.com/channel/${response.data.items[0].id}`
        return url
    } catch (error) {
        console.error('Error getting channel info from Lemnos Life API:', error);
        return null;
    }
}
  
  // Получение сообщений от пользователя
  bot.on('text', async (ctx) => {
    console.log('Received text:', ctx.message.text); // Логирование текста сообщения
    console.log('Session state:', ctx.session); // Логирование состояния сессии
  
    if (ctx.session.awaitingYouTubeUrl) {
      ctx.session.youtubeUrl = ctx.message.text;
      ctx.session.awaitingYouTubeUrl = false;
      ctx.session.awaitingTelegramUrl = true;
      ctx.reply('Введите URL Telegram-канала, к которому будет привязан YouTube-канал.');
    } else if (ctx.session.awaitingTelegramUrl) {
      ctx.session.telegramUrl = ctx.message.text;
      ctx.session.awaitingTelegramUrl = false;
  
      let youtubeUrl = ctx.session.youtubeUrl;
      const telegramUrl = ctx.session.telegramUrl;
  
      // Проверяем, содержит ли URL username
      const usernameMatch = youtubeUrl.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([^\/?]+)/);
      if (usernameMatch) {
        const username = usernameMatch[1];
        youtubeUrl = await convertUsernameToStandardUrl(username);
        if (!youtubeUrl) {
          ctx.reply('Не удалось преобразовать username в стандартный URL. Пожалуйста, проверьте URL и попробуйте снова.');
          return;
        }
      }
  
      // Получение идентификатора канала из URL
      const channelIdMatch = youtubeUrl.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/channel\/([^\/?]+)/);
      const channelId = channelIdMatch ? channelIdMatch[1] : null;
      if (!channelId) {
        ctx.reply('Не удалось извлечь идентификатор канала из URL. Пожалуйста, проверьте URL и попробуйте снова.');
        return;
      }
  
      // Получение названия YouTube-канала
      const service = google.youtube('v3');
      try {
        const response = await axios.get(`${LEMNOS_API_URL}?part=community&id=${channelId}`);
        if (response.data && response.data.items && response.data.items.length > 0) {
          const channelName = response.data.items[0].community[0].channelName;
          
  
          if (channelName) {
            await PendingChannel.create({
              name: channelName,
              youtube_url: youtubeUrl,
              telegram_url: telegramUrl,
              submitted_by: ctx.from.id
            });
  
            ctx.reply('Спасибо! Информация отправлена на модерацию.');
            bot.telegram.sendMessage(MODERATOR_CHAT_ID, `Новый запрос на привязку канала:\nYouTube: ${youtubeUrl}\nTelegram: ${telegramUrl}`, Markup.inlineKeyboard([
              [Markup.button.callback('Одобрить', `approve_${youtubeUrl}`)],
              [Markup.button.callback('Удалить', `delete_${youtubeUrl}`)],
            ]));
          } else {
            ctx.reply('Не удалось найти канал на YouTube. Пожалуйста, проверьте URL и попробуйте снова.');
          }
        } else {
          ctx.reply('Не удалось найти канал на YouTube. Пожалуйста, проверьте URL и попробуйте снова.');
        }
      } catch (error) {
        console.error('Error fetching YouTube channel:', error);
        ctx.reply('Произошла ошибка при обработке запроса. Пожалуйста, попробуйте снова.');
      }
    }
  });

// Модерация
bot.action(/^approve_/, async (ctx) => {
    const youtubeUrl = ctx.match.input.split('_')[1];
    try {
        const channel = await PendingChannel.findOne({ youtube_url: youtubeUrl });

        if (channel) {
            // Проверяем, существует ли такой канал по youtube_url
            const existingChannel = await Channel.findOne({ youtube_url: channel.youtube_url });

            if (!existingChannel) {
                // Создаем новый канал с помощью save()
                const newChannel = new Channel({
                    name: channel.name,
                    youtube_url: channel.youtube_url,
                    telegram_url: channel.telegram_url,
                    requested_times: channel.requested_times
                });

                await newChannel.save(); // Используем save() для сохранения
                await PendingChannel.deleteOne({ youtube_url: youtubeUrl });
                ctx.reply(`Канал "${channel.name}" успешно добавлен.`);
            } else {
                ctx.reply(`Канал с URL "${youtubeUrl}" уже существует.`);
            }
        } else {
            ctx.reply(`Не удалось найти канал для одобрения.`);
        }
    } catch (error) {
        console.error('Error approving channel:', error);
        ctx.reply('Произошла ошибка при одобрении канала.');
    }
});

bot.action(/^delete_/, async (ctx) => {
    const youtubeUrl = ctx.match.input.split('_')[1];
    try {
        const result = await PendingChannel.deleteOne({ youtube_url: youtubeUrl });

        if (result.deletedCount > 0) {
            ctx.reply(`Канал с URL "${youtubeUrl}" успешно удалён.`);
        } else {
            ctx.reply(`Не удалось найти канал для удаления.`);
        }
    } catch (error) {
        console.error('Error deleting channel:', error);
        ctx.reply('Произошла ошибка при удалении канала.');
    }
});

// Запуск веб-сервера и бота

server.listen(3000, () => {
    console.log('Сервер запущен на http://91.108.243.132:3000');
});
bot.launch();

// Остановка сервера и бота при завершении работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
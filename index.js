'use strict';

const {
    makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    DisconnectReason,
    getContentType,
    normalizeMessageContent,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(__dirname, 'auth_info'));
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'));

function asBoolean(value, fallback = false) {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clean(value) {
    return String(value || '').trim();
}

function parseJidList(value) {
    return new Set(
        String(value || '')
            .split(',')
            .map(clean)
            .filter(Boolean),
    );
}

function normalizePhoneNumber(value) {
    // Baileys wants digits only and the country code. Accept Arabic numerals too.
    const arabic = '٠١٢٣٤٥٦٧٨٩';
    const persian = '۰۱۲۳۴۵۶۷۸۹';
    const converted = String(value || '')
        .split('')
        .map((character) => {
            const arabicIndex = arabic.indexOf(character);
            if (arabicIndex !== -1) return String(arabicIndex);
            const persianIndex = persian.indexOf(character);
            if (persianIndex !== -1) return String(persianIndex);
            return character;
        })
        .join('');

    return converted.replace(/\D/g, '');
}

const PHONE_NUMBER = normalizePhoneNumber(process.env.PHONE_NUMBER);
const USE_PAIRING_CODE = asBoolean(process.env.USE_PAIRING_CODE, Boolean(PHONE_NUMBER));
const TARGET_CHANNEL_INPUT = clean(process.env.TARGET_CHANNEL);
const MONITORED_CHANNEL_INPUTS = parseJidList(process.env.MONITORED_CHANNELS);
const DISCOVERY_MODE = asBoolean(process.env.DISCOVERY_MODE, false);
const AUTO_FOLLOW_CHANNELS = asBoolean(process.env.AUTO_FOLLOW_CHANNELS, false);

// يمكن أن تكون القيم IDs مباشرة أو روابط قنوات واتساب عامة.
let targetChannel = TARGET_CHANNEL_INPUT;
let monitoredChannels = new Set(MONITORED_CHANNEL_INPUTS);
let channelConfigResolved = false;
let channelConfigResolutionInProgress = false;
const autoFollowAttempted = new Set();
const SAVE_DOWNLOADS = asBoolean(process.env.SAVE_DOWNLOADS, true);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 5000);
const LOG_LEVEL = clean(process.env.LOG_LEVEL) || 'warn';

const CHANNEL_SUFFIXES = ['@newsletter', '@g.us'];
const announcedJids = new Set();
const processedMessageIds = new Set();

function isChannelOrGroupJid(jid) {
    return typeof jid === 'string' && CHANNEL_SUFFIXES.some((suffix) => jid.endsWith(suffix));
}

function extractInviteCode(value, kind) {
    const patterns = {
        channel: /(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([^/?#\s]+)/i,
        group: /(?:https?:\/\/)?chat\.whatsapp\.com\/([^/?#\s]+)/i,
    };
    const match = String(value || '').match(patterns[kind]);
    return match ? match[1] : null;
}

async function resolveChannelInput(sock, value, label) {
    const input = clean(value);
    const channelInviteCode = extractInviteCode(input, 'channel');
    const groupInviteCode = extractInviteCode(input, 'group');

    if (!channelInviteCode && !groupInviteCode) return input;

    try {
        if (channelInviteCode) {
            if (typeof sock.newsletterMetadata !== 'function') {
                throw new Error('إصدار Baileys الحالي لا يدعم تحويل رابط القناة.');
            }
            const metadata = await sock.newsletterMetadata('invite', channelInviteCode);
            const jid = clean(metadata?.id);
            if (!jid || !jid.endsWith('@newsletter')) {
                throw new Error('لم يرجع واتساب ID صالحًا للقناة.');
            }
            console.log(`🔗 تم تحويل رابط ${label} إلى ID: ${jid}`);
            return jid;
        }

        if (typeof sock.groupGetInviteInfo !== 'function') {
            throw new Error('إصدار Baileys الحالي لا يدعم تحويل رابط الجروب.');
        }
        const metadata = await sock.groupGetInviteInfo(groupInviteCode);
        const jid = clean(metadata?.id);
        if (!jid || !jid.endsWith('@g.us')) {
            throw new Error('لم يرجع واتساب ID صالحًا للجروب.');
        }
        console.log(`🔗 تم تحويل رابط ${label} إلى ID: ${jid}`);
        return jid;
    } catch (error) {
        throw new Error(`لم أستطع قراءة رابط ${label}: ${error.message || error}`);
    }
}

async function resolveConfiguredChannels(sock) {
    if (DISCOVERY_MODE || channelConfigResolved || channelConfigResolutionInProgress) return;

    channelConfigResolutionInProgress = true;
    try {
        targetChannel = await resolveChannelInput(sock, TARGET_CHANNEL_INPUT, 'الدردشة المستهدفة');

        const resolvedChannels = [];
        for (const input of MONITORED_CHANNEL_INPUTS) {
            try {
                const resolved = await resolveChannelInput(sock, input, 'الدردشة المراقبة');
                if (resolved) resolvedChannels.push(resolved);
            } catch (error) {
                // رابط واحد منتهي أو غير متاح لا يجب أن يوقف باقي القنوات.
                console.log(`⚠️ سيتم تجاهل رابط قناة غير متاح: ${error.message || error}`);
            }
        }
        monitoredChannels = new Set(resolvedChannels.filter(Boolean));
        channelConfigResolved = true;
    } finally {
        channelConfigResolutionInProgress = false;
    }
}

async function autoFollowConfiguredChannels(sock) {
    if (!AUTO_FOLLOW_CHANNELS) return;
    if (typeof sock.newsletterFollow !== 'function') {
        console.log('⚠️ هذه النسخة من Baileys لا تدعم المتابعة التلقائية للقنوات.');
        return;
    }

    for (const jid of monitoredChannels) {
        if (!jid.endsWith('@newsletter') || autoFollowAttempted.has(jid)) continue;

        try {
            await sock.newsletterFollow(jid);
            autoFollowAttempted.add(jid);
            console.log(`✅ تم طلب متابعة القناة: ${jid}`);
        } catch (error) {
            console.log(`⚠️ لم أستطع متابعة ${jid} تلقائيًا: ${error.message || error}`);
            console.log('   افتح رابط القناة في واتساب واضغط متابعة يدويًا.');
        }
    }
}

function describeJid(jid) {
    if (jid.endsWith('@newsletter')) return 'قناة واتساب رسمية';
    if (jid.endsWith('@g.us')) return 'جروب واتساب';
    return 'دردشة أخرى';
}

function announceJid(jid, source = 'chat') {
    if (!isChannelOrGroupJid(jid)) return;
    if (announcedJids.has(jid)) return;

    announcedJids.add(jid);
    console.log(`\n🆔 تم العثور على ${describeJid(jid)} (${source}):`);
    console.log(`   ${jid}`);
    console.log('   انسخ السطر ده وضعه في TARGET_CHANNEL أو MONITORED_CHANNELS داخل .env');
}

function getMediaInfo(contentType, media) {
    const byType = {
        imageMessage: { payloadKey: 'image', extension: '.jpg' },
        videoMessage: { payloadKey: 'video', extension: '.mp4' },
        audioMessage: { payloadKey: 'audio', extension: '.ogg' },
        documentMessage: { payloadKey: 'document', extension: '.bin' },
        stickerMessage: { payloadKey: 'sticker', extension: '.webp' },
    };

    const info = byType[contentType];
    if (!info) return null;

    if (contentType === 'documentMessage' && media?.fileName) {
        const originalExtension = path.extname(media.fileName);
        if (originalExtension) info.extension = originalExtension.toLowerCase();
    }

    return info;
}

function safeFilePart(value) {
    return String(value || 'message')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80) || 'message';
}

function getText(content) {
    if (!content) return '';
    if (typeof content.conversation === 'string') return content.conversation;
    if (typeof content.extendedTextMessage?.text === 'string') return content.extendedTextMessage.text;
    if (typeof content.editedMessage?.message?.conversation === 'string') {
        return content.editedMessage.message.conversation;
    }
    return '';
}

async function saveDownloadedMedia(buffer, from, messageId, extension) {
    if (!SAVE_DOWNLOADS) return;

    await fs.ensureDir(DOWNLOAD_DIR);
    const fileName = `${Date.now()}_${safeFilePart(from.split('@')[0])}_${safeFilePart(messageId)}${extension}`;
    const filePath = path.join(DOWNLOAD_DIR, fileName);
    await fs.writeFile(filePath, buffer);
    console.log(`   💾 اتحفظ الملف في downloads/${fileName}`);
}

async function forwardMessage(sock, msg, from) {
    const content = normalizeMessageContent(msg.message);
    const contentType = getContentType(content);

    if (!contentType) {
        console.log('   ⚠️ نوع الرسالة غير معروف، تم تجاهلها.');
        return false;
    }

    const text = getText(content);
    if (text) {
        await sock.sendMessage(targetChannel, { text });
        console.log('   ✅ اتبعت الرسالة النصية.');
        return true;
    }

    const media = content[contentType];
    const mediaInfo = getMediaInfo(contentType, media);
    if (mediaInfo) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        await saveDownloadedMedia(buffer, from, msg.key?.id, mediaInfo.extension);

        const payload = { [mediaInfo.payloadKey]: buffer };

        if (contentType === 'imageMessage' || contentType === 'videoMessage') {
            payload.caption = media?.caption || '📢 محتوى جديد من القنوات';
            if (media?.mimetype) payload.mimetype = media.mimetype;
        } else if (contentType === 'audioMessage') {
            payload.mimetype = media?.mimetype || 'audio/ogg; codecs=opus';
            payload.ptt = Boolean(media?.ptt);
        } else if (contentType === 'documentMessage') {
            payload.mimetype = media?.mimetype || 'application/octet-stream';
            payload.fileName = media?.fileName || `document${mediaInfo.extension}`;
            if (media?.caption) payload.caption = media.caption;
        }

        await sock.sendMessage(targetChannel, payload);
        console.log(`   ✅ اتبعت ${contentType.replace('Message', '')} على القناة المستهدفة.`);
        return true;
    }

    if (contentType === 'locationMessage') {
        const location = content.locationMessage;
        await sock.sendMessage(targetChannel, {
            location: {
                degreesLatitude: location.degreesLatitude,
                degreesLongitude: location.degreesLongitude,
                name: location.name,
                address: location.address,
            },
        });
        console.log('   ✅ اتبعت الموقع.');
        return true;
    }

    console.log(`   ⚠️ نوع الرسالة ${contentType} غير مدعوم حاليًا، تم تجاهلها.`);
    return false;
}

function printConfiguration() {
    console.log(`📂 مجلد الجلسة: ${AUTH_DIR}`);

    if (DISCOVERY_MODE) {
        console.log('🔎 وضع الاكتشاف شغال: سيتم طباعة IDs فقط ولن يتم إعادة النشر.');
        return;
    }

    if (!targetChannel || monitoredChannels.size === 0) {
        console.log('⚠️ لم يتم تفعيل إعادة النشر بعد.');
        console.log('   املأ TARGET_CHANNEL و MONITORED_CHANNELS في .env ثم اجعل DISCOVERY_MODE=false.');
        return;
    }

    console.log(`🎯 القناة المستهدفة: ${targetChannel}`);
    console.log(`👀 عدد القنوات المراقبة: ${monitoredChannels.size}`);
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let reconnectTimer;
    let pairingTimer;
    let closed = false;

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: LOG_LEVEL }),
        // QR fallback. Pairing code is easier when WhatsApp and Termux are on the same tablet.
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('📱 امسح QR من واتساب > الأجهزة المرتبطة.');
        }

        if (connection === 'open') {
            console.log('\n✅ تم الاتصال بواتساب بنجاح!');

            if (!DISCOVERY_MODE && TARGET_CHANNEL_INPUT && MONITORED_CHANNEL_INPUTS.size > 0) {
                resolveConfiguredChannels(sock)
                    .then(() => autoFollowConfiguredChannels(sock))
                    .then(() => {
                        console.log('🔍 جاري مراقبة القنوات وإعادة النشر...');
                    })
                    .catch((error) => {
                        console.error(`❌ مشكلة في إعداد روابط القنوات: ${error.message || error}`);
                        console.log('تأكد أن الروابط عامة وأن الحساب المرتبط يستطيع فتحها.');
                    });
            } else {
                console.log('🔎 افتح/تابع القنوات المطلوبة الآن لكي تظهر IDs في Termux.');
            }
        }

        if (connection === 'close') {
            closed = true;
            if (pairingTimer) clearTimeout(pairingTimer);

            const disconnectError = lastDisconnect?.error;
            const statusCode = disconnectError?.output?.statusCode;
            const reason = disconnectError?.message || 'سبب غير معروف';
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log(`⚠️ الاتصال اتقفل (${reason}${statusCode ? `، الكود ${statusCode}` : ''}). إعادة المحاولة بعد ${RECONNECT_DELAY_MS / 1000} ثواني...`);
                reconnectTimer = setTimeout(() => {
                    startBot().catch((error) => console.error('❌ فشل إعادة الاتصال:', error));
                }, RECONNECT_DELAY_MS);
            } else {
                console.log('🚪 تم تسجيل الخروج. احذف مجلد auth_info ثم شغّل البوت لربط الحساب من جديد.');
            }
        }
    });

    // فتح القناة داخل تطبيق واتساب لا يرسل حدثًا للبوت، لكن مزامنة السجل قد تحتوي على ID القناة.
    sock.ev.on('messaging-history.set', ({ chats = [] }) => {
        for (const chat of chats) announceJid(chat.id, 'history');
    });

    // chats.upsert/update غالبًا يكشفان IDs حتى قبل وصول رسالة جديدة.
    sock.ev.on('chats.upsert', (chats) => {
        for (const chat of chats || []) announceJid(chat.id, 'chat');
    });

    sock.ev.on('chats.update', (chats) => {
        for (const chat of chats || []) announceJid(chat.id, 'chat');
    });

    sock.ev.on('groups.upsert', (groups) => {
        for (const group of groups || []) announceJid(group.id, 'group');
    });

    sock.ev.on('groups.update', (groups) => {
        for (const group of groups || []) announceJid(group.id, 'group');
    });

    // عند فتح دردشة قد تصل read receipts أو تحديثات للرسائل بدل حدث اسمه "فتح القناة".
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates || []) announceJid(update.key?.remoteJid, 'message update');
    });

    sock.ev.on('message-receipt.update', (updates) => {
        for (const update of updates || []) announceJid(update.key?.remoteJid, 'receipt');
    });

    let forwardQueue = Promise.resolve();
    sock.ev.on('messages.upsert', ({ messages = [], type }) => {
        for (const msg of messages) {
            // نطبع ID حتى لو كانت الرسالة جزءًا من السجل القديم (append)، لكن لا نعيد نشر القديم.
            announceJid(msg.key?.remoteJid, type === 'notify' ? 'new message' : 'history message');

            // notify = رسائل وصلت الآن. append عادةً جزء من السجل القديم، فلا نعيد نشره.
            if (type !== 'notify') continue;

            forwardQueue = forwardQueue
                .then(() => handleMessage(sock, msg))
                .catch((error) => console.error('❌ حصل خطأ أثناء معالجة الرسالة:', error));
        }
    });

    if (!state.creds.registered && USE_PAIRING_CODE && PHONE_NUMBER) {
        // ننتظر قليلًا حتى يفتح اتصال الويب قبل طلب كود الربط.
        pairingTimer = setTimeout(async () => {
            if (closed || state.creds.registered) return;

            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n🔐 كود الربط هو:');
                console.log(`   ${code}`);
                console.log('في واتساب: الإعدادات > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف، ثم اكتب الكود.');
                console.log('⚠️ لا تبعت الكود لأي شخص.');
            } catch (error) {
                console.error('❌ لم أستطع استخراج كود الربط:', error.message || error);
                console.log('جرّب node index.js مرة أخرى بعد ثواني.');
            }
        }, 3000);
    } else if (!state.creds.registered && USE_PAIRING_CODE && !PHONE_NUMBER) {
        console.log('ℹ️ USE_PAIRING_CODE=true لكن PHONE_NUMBER فاضي؛ سيتم انتظار QR.');
        console.log('للاستخدام من نفس التابلت، اكتب رقمك الدولي في PHONE_NUMBER داخل .env.');
    }

    return () => {
        closed = true;
        if (pairingTimer) clearTimeout(pairingTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
    };
}

async function handleMessage(sock, msg) {
    if (!msg?.message) return;

    const from = msg.key?.remoteJid;
    if (!from) return;

    if (isChannelOrGroupJid(from)) {
        announceJid(from, 'message');
    }

    // لا نعالج الرسائل القديمة ولا نعيد إرسال القناة إلى نفسها.
    if (!monitoredChannels.has(from) || (targetChannel && from === targetChannel)) return;

    const messageId = msg.key?.id;
    if (messageId && processedMessageIds.has(messageId)) return;
    if (messageId) {
        processedMessageIds.add(messageId);
        if (processedMessageIds.size > 5000) {
            const oldest = processedMessageIds.values().next().value;
            processedMessageIds.delete(oldest);
        }
    }

    console.log(`\n📥 رسالة جديدة من ${from}`);

    if (DISCOVERY_MODE) {
        console.log('   🔎 وضع الاكتشاف شغال؛ لن يتم إعادة النشر.');
        return;
    }

    if (!targetChannel) {
        console.log('   ⚠️ TARGET_CHANNEL فاضي؛ تم تجاهل الرسالة.');
        return;
    }

    await forwardMessage(sock, msg, from);
}

printConfiguration();
startBot().catch((error) => {
    console.error('❌ البوت لم يبدأ:', error);
    process.exitCode = 1;
});

const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const fuzzball = require('fuzzball'); // Add fuzzball for fuzzy matching
const credentials = require('./credentials.json');
require('dotenv').config();

// Initialize bot with environment variable
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Google Sheets setup
async function getSheetsClient() {
    try {
        const auth = await google.auth.getClient({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        return google.sheets({ version: 'v4', auth });
    } catch (error) {
        console.error('Error setting up Google Sheets client:', error);
        throw new Error(`Failed to initialize Google Sheets client: ${error.message}`);
    }
}

const logSpreadsheetId = process.env.LOG_SPREADSHEET_ID;
const skinsSpreadsheetId = process.env.SKIN_SPREADSHEET_ID;

// Cache for skins list
let skinsCache = {
    list: [],
    lastUpdated: 0,
    cacheDuration: 3600000 // 1 hour in ms
};

// ================== CORE FUNCTIONS ================== //

// Function to get the last log from the log spreadsheet
async function getLastLog(sheets) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: logSpreadsheetId,
            range: 'Sheet1!A2:F',
        });
        const rows = response.data.values || [];
        if (rows.length === 0) return 'No previous logs found.';

        const lastDate = rows[rows.length - 1][0];
        const lastSessionRows = rows.filter(row => row[0] === lastDate);

        if (lastSessionRows.length === 0) return 'No previous logs found.';

        let logMessage = `Last Log (Date: ${lastDate}):\n`;
        lastSessionRows.forEach((row, index) => {
            logMessage += `Skin ${index + 1}: ${row[1] || 'N/A'} (${row[2] || 'N/A'})\n`;
        });
        logMessage += `Price Paid: ${lastSessionRows[0][3] || 'N/A'}\n`;
        logMessage += `Account: ${lastSessionRows[0][5] || 'N/A'}`;

        return logMessage;
    } catch (error) {
        console.error('Error fetching last log:', error);
        return 'Error fetching last log. Please try again later.';
    }
}

// Function to append a log to the spreadsheet
async function appendToSpreadsheet(skins, price, account, sheets) {
    try {
        const date = new Date().toISOString().split('T')[0];
        const values = skins.map(skin => [date, skin.name, skin.wear, price, '', account]);
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: logSpreadsheetId,
            range: 'Sheet1!A:F',
            valueInputOption: 'RAW',
            resource: { values },
        });
        return true;
    } catch (error) {
        console.error('Error appending to spreadsheet:', error);
        throw new Error('Failed to save data to spreadsheet');
    }
}

// Fetch skins list from Google Sheet with caching
async function fetchSkinsList(sheets) {
    try {
        // Return cached list if still valid
        if (skinsCache.list.length > 0 && Date.now() - skinsCache.lastUpdated < skinsCache.cacheDuration) {
            return skinsCache.list;
        }

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: skinsSpreadsheetId,
            range: 'Sheet1!A2:B',
        });
        const skinsList = (response.data.values || []).map(row => row[0]).filter(Boolean);

        // Update cache
        skinsCache.list = skinsList;
        skinsCache.lastUpdated = Date.now();

        return skinsList;
    } catch (error) {
        console.error('Error fetching skins list:', error);
        // Fallback to cached list if available
        if (skinsCache.list.length > 0) {
            console.warn('Using cached skins list due to error');
            return skinsCache.list;
        }
        throw new Error(`Failed to fetch skins list: ${error.message}`);
    }
}

// Fuzzy search for skins
function searchSkins(skinsList, searchTerm) {
    const normalizedSearch = searchTerm.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    return skinsList
        .map(skin => ({
            name: skin,
            score: fuzzball.partial_ratio(
                normalizedSearch,
                skin.toLowerCase().replace(/[^a-z0-9\s]/g, '')
            )
        }))
        .filter(result => result.score > 70) // Adjust threshold as needed
        .sort((a, b) => b.score - a.score)
        .map(result => result.name);
}

// ================== ENHANCED FEATURES ================== //

// Statistics function (unchanged)
async function getTradeStatistics(sheets) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: logSpreadsheetId,
            range: 'Sheet1!A2:F',
        });
        const rows = response.data.values || [];
        
        if (rows.length === 0) {
            return {
                totalTrades: 0,
                totalSpent: 0,
                mostTradedSkin: 'N/A',
                mostUsedAccount: 'N/A'
            };
        }

        const totalTrades = rows.length;
        const totalSpent = rows.reduce((sum, row) => sum + (parseFloat(row[3]) || 0), 0);
        
        const skinCounts = {};
        rows.forEach(row => {
            const skin = row[1];
            if (skin) skinCounts[skin] = (skinCounts[skin] || 0) + 1;
        });
        const mostTradedSkin = Object.entries(skinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
        
        const accountCounts = {};
        rows.forEach(row => {
            const account = row[5];
            if (account) accountCounts[account] = (accountCounts[account] || 0) + 1;
        });
        const mostUsedAccount = Object.entries(accountCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

        return {
            totalTrades,
            totalSpent: totalSpent.toFixed(2),
            mostTradedSkin,
            mostUsedAccount
        };
    } catch (error) {
        console.error('Error fetching statistics:', error);
        throw new Error('Failed to fetch trade statistics');
    }
}

// Recent trades function (unchanged)
async function getRecentTrades(sheets, count = 5) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: logSpreadsheetId,
            range: 'Sheet1!A2:F',
        });
        const rows = response.data.values || [];
        
        if (rows.length === 0) return ['No recent trades found.'];
        
        const recentTrades = rows.slice(-count).reverse().map((row, index) => {
            return `Trade ${index + 1}:
Date: ${row[0] || 'N/A'}
Skin: ${row[1] || 'N/A'} (${row[2] || 'N/A'})
Price: ${row[3] || 'N/A'}
Account: ${row[5] || 'N/A'}`;
        });
        
        return recentTrades;
    } catch (error) {
        console.error('Error fetching recent trades:', error);
        throw new Error('Failed to fetch recent trades');
    }
}

// ================== CONSTANTS ================== //
const wearOptions = [
    'Factory New',
    'Minimal Wear',
    'Field-Tested',
    'Well-Worn',
    'Battle-Scarred',
];

const accountOptions = [
    'Panda main',
    'Panda_cs1',
    'Titalium',
    'Maleek'
];

// ================== SESSION MANAGEMENT ================== //
const userSessions = {};

function initializeSession(userId) {
    if (!userSessions[userId]) {
        userSessions[userId] = { 
            skins: [], 
            step: 'addSkin',
            timestamp: Date.now(),
            search: { term: '', results: [], page: 0, pageSize: 5 } // Add pagination data
        };
        
        // Cleanup old sessions
        Object.keys(userSessions).forEach(id => {
            if (Date.now() - userSessions[id].timestamp > 3600000) {
                delete userSessions[id];
            }
        });
    }
    return userSessions[userId];
}

// ================== COMMAND HANDLERS ================== //

// Start command (unchanged)
bot.start(async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const lastLog = await getLastLog(sheets);
        
        await ctx.replyWithMarkdown(`
*Welcome to CS2 Skin Tracker Bot!* 🎮

${lastLog}

*Available Commands:*
/start - Show this menu
/price - Show last trade
/stats - Show trading statistics
/recent - Show recent trades (last 5)
/help - Show help information

You can also use the buttons below to quickly access features.
`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Add New Skin', callback_data: 'add_new_skin' }],
                    [{ text: '📊 View Stats', callback_data: 'show_stats' }],
                    [{ text: '🕒 Recent Trades', callback_data: 'show_recent' }],
                    [{ text: 'ℹ️ Help', callback_data: 'show_help' }]
                ],
            },
        });
        
        initializeSession(ctx.from.id);
    } catch (error) {
        await ctx.reply('Error starting the bot. Please try again later.');
        console.error('Start command error:', error);
    }
});

// Price command (unchanged)
bot.command('price', async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const lastLog = await getLastLog(sheets);
        await ctx.reply(`${lastLog}\n\nClick the button below to add a new skin.`, {
            reply_markup: {
                inline_keyboard: [[{ text: 'Add New Skin', callback_data: 'add_new_skin' }]],
            },
        });
        initializeSession(ctx.from.id);
    } catch (error) {
        await ctx.reply('Error fetching price data. Please try again later.');
        console.error('Price command error:', error);
    }
});

// Help command (unchanged)
bot.command('help', (ctx) => {
    ctx.replyWithMarkdown(`
*CS2 Skin Tracker Bot Help* 🆘

*Commands:*
/start - Main menu
/price - Show last trade
/stats - Show trading statistics
/recent - Show recent trades (last 5)
/help - This help message

*How to log a trade:*
1. Use /start or click "Add New Skin"
2. Search for the skin name
3. Select the wear condition
4. Add more skins or finish
5. Enter total price
6. Select account

*Features:*
- Track all your CS2 skin trades
- View trading statistics
- Access your trade history
- Multiple account support
`);
});

// Stats command (unchanged)
bot.command('stats', async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const stats = await getTradeStatistics(sheets);
        
        await ctx.replyWithMarkdown(`
*Trading Statistics* 📊

*Total Trades:* ${stats.totalTrades}
*Total Spent:* $${stats.totalSpent}
*Most Traded Skin:* ${stats.mostTradedSkin}
*Most Used Account:* ${stats.mostUsedAccount}
`);
    } catch (error) {
        await ctx.reply('Error fetching statistics. Please try again later.');
        console.error('Stats command error:', error);
    }
});

// Recent trades command (unchanged)
bot.command('recent', async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const recentTrades = await getRecentTrades(sheets);
        
        if (recentTrades.length === 1 && recentTrades[0] === 'No recent trades found.') {
            return ctx.reply(recentTrades[0]);
        }
        
        await ctx.reply('*Your Recent Trades* 🕒', { parse_mode: 'Markdown' });
        
        for (const trade of recentTrades) {
            await ctx.reply(trade);
        }
    } catch (error) {
        await ctx.reply('Error fetching recent trades. Please try again later.');
        console.error('Recent command error:', error);
    }
});

// ================== ACTION HANDLERS ================== //

// Handle "Add New Skin" button
bot.action('add_new_skin', (ctx) => {
    const session = initializeSession(ctx.from.id);
    session.step = 'searchSkin';
    session.search = { term: '', results: [], page: 0, pageSize: 5 }; // Reset search
    ctx.reply('🔍 Please type the name of the skin you want to add:');
});

// Handle "Show Stats" button (unchanged)
bot.action('show_stats', async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const stats = await getTradeStatistics(sheets);
        
        await ctx.replyWithMarkdown(`
*Trading Statistics* 📊

*Total Trades:* ${stats.totalTrades}
*Total Spent:* $${stats.totalSpent}
*Most Traded Skin:* ${stats.mostTradedSkin}
*Most Used Account:* ${stats.mostUsedAccount}
`);
    } catch (error) {
        await ctx.reply('Error fetching statistics. Please try again later.');
        console.error('Stats action error:', error);
    }
});

// Handle "Show Recent" button (unchanged)
bot.action('show_recent', async (ctx) => {
    try {
        const sheets = await getSheetsClient();
        const recentTrades = await getRecentTrades(sheets);
        
        if (recentTrades.length === 1 && recentTrades[0] === 'No recent trades found.') {
            return ctx.reply(recentTrades[0]);
        }
        
        await ctx.reply('*Your Recent Trades* 🕒', { parse_mode: 'Markdown' });
        
        for (const trade of recentTrades) {
            await ctx.reply(trade);
        }
    } catch (error) {
        await ctx.reply('Error fetching recent trades. Please try again later.');
        console.error('Recent action error:', error);
    }
});

// Handle "Show Help" button (unchanged)
bot.action('show_help', (ctx) => {
    ctx.replyWithMarkdown(`
*CS2 Skin Tracker Bot Help* 🆘

*Commands:*
/start - Main menu
/price - Show last trade
/stats - Show trading statistics
/recent - Show recent trades (last 5)
/help - This help message

*How to log a trade:*
1. Use /start or click "Add New Skin"
2. Search for the skin name
3. Select the wear condition
4. Add more skins or finish
5. Enter total price
6. Select account

*Features:*
- Track all your CS2 skin trades
- View trading statistics
- Access your trade history
- Multiple account support
`);
});

// Handle pagination buttons
bot.action(/page_(\d+)/, async (ctx) => {
    const session = initializeSession(ctx.from.id);
    const page = parseInt(ctx.match[1]);
    
    try {
        const sheets = await getSheetsClient();
        const { results, pageSize } = session.search;
        
        if (results.length === 0) {
            return ctx.reply('No search results available. Please search again.');
        }

        session.search.page = page;
        const start = page * pageSize;
        const end = start + pageSize;
        const pageSkins = results.slice(start, end);

        if (pageSkins.length === 0) {
            return ctx.reply('No more results to show.');
        }

        const keyboard = pageSkins.map(skin => [
            { text: skin, callback_data: `select_skin_${encodeURIComponent(skin)}` }
        ]);

        // Add pagination buttons
        const navButtons = [];
        if (page > 0) {
            navButtons.push({ text: '⬅️ Previous', callback_data: `page_${page - 1}` });
        }
        if (end < results.length) {
            navButtons.push({ text: 'Next ➡️', callback_data: `page_${page + 1}` });
        }
        if (navButtons.length > 0) {
            keyboard.push(navButtons);
        }

        await ctx.reply(`Search results (Page ${page + 1} of ${Math.ceil(results.length / pageSize)}):`, {
            reply_markup: { inline_keyboard: keyboard },
        });
    } catch (error) {
        await ctx.reply('Error loading page. Please try again later.');
        console.error('Pagination error:', error);
    }
});

// Handle skin search
bot.on('text', async (ctx) => {
    const session = initializeSession(ctx.from.id);
    const text = ctx.message.text.trim();

    if (session.step === 'searchSkin') {
        try {
            const sheets = await getSheetsClient();
            const skinsList = await fetchSkinsList(sheets);
            session.search.term = text;
            session.search.results = searchSkins(skinsList, text);
            session.search.page = 0;

            if (session.search.results.length === 0) {
                return ctx.reply('No skins found. Please try a different search term:');
            }

            const pageSkins = session.search.results.slice(0, session.search.pageSize);
            const keyboard = pageSkins.map(skin => [
                { text: skin, callback_data: `select_skin_${encodeURIComponent(skin)}` }
            ]);

            // Add "Next" button if there are more results
            if (session.search.results.length > session.search.pageSize) {
                keyboard.push([{ text: 'Next ➡️', callback_data: 'page_1' }]);
            }

            await ctx.reply(`Search results (Page 1 of ${Math.ceil(session.search.results.length / session.search.pageSize)}):`, {
                reply_markup: { inline_keyboard: keyboard },
            });
        } catch (error) {
            await ctx.reply(`Error searching for skins: ${error.message}. Please try again later.`);
            console.error('Skin search error:', error);
        }
    } else if (session.step === 'enterPrice') {
        const price = parseFloat(text);
        if (isNaN(price)) {
            return ctx.reply('Please enter a valid number for the price:');
        }
        if (price <= 0) {
            return ctx.reply('Price must be greater than 0. Please enter a valid price:');
        }

        session.price = price;
        session.step = 'selectAccount';
        
        const keyboard = accountOptions.map(account => [
            { text: account, callback_data: `select_account_${encodeURIComponent(account)}` }
        ]);
        
        await ctx.reply('Select the account where the skin was traded:', {
            reply_markup: { inline_keyboard: keyboard },
        });
    } else {
        await ctx.reply('Please use the menu buttons or type /start to begin.');
    }
});

// Handle skin selection (unchanged)
bot.action(/select_skin_(.+)/, (ctx) => {
    const session = initializeSession(ctx.from.id);
    try {
        const skinName = decodeURIComponent(ctx.match[1]);
        session.currentSkin = { name: skinName };
        session.step = 'selectWear';

        const keyboard = wearOptions.map(wear => [
            { text: wear, callback_data: `select_wear_${encodeURIComponent(wear)}` }
        ]);
        
        ctx.reply(`Selected skin: ${skinName}\nChoose the wear:`, {
            reply_markup: { inline_keyboard: keyboard },
        });
    } catch (error) {
        ctx.reply('Error processing your selection. Please try again.');
        console.error('Skin selection error:', error);
    }
});

// Handle wear selection (unchanged)
bot.action(/select_wear_(.+)/, (ctx) => {
    const session = initializeSession(ctx.from.id);
    try {
        const wear = decodeURIComponent(ctx.match[1]);
        if (!wearOptions.includes(wear)) {
            return ctx.reply('Invalid wear selection. Please try again.');
        }

        session.currentSkin.wear = wear;
        session.skins.push(session.currentSkin);
        delete session.currentSkin;
        session.step = 'addSkin';

        ctx.reply(`Added ${wear} ${session.skins[session.skins.length - 1].name}.\nWhat would you like to do next?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Add Another Skin', callback_data: 'add_new_skin' }],
                    [{ text: 'Finish and Enter Price', callback_data: 'finish_log' }],
                ],
            },
        });
    } catch (error) {
        ctx.reply('Error processing wear selection. Please try again.');
        console.error('Wear selection error:', error);
    }
});

// Handle finish log (unchanged)
bot.action('finish_log', (ctx) => {
    const session = initializeSession(ctx.from.id);
    if (session.skins.length === 0) {
        return ctx.reply('No skins added. Please add a skin first.');
    }

    session.step = 'enterPrice';
    ctx.reply('Please enter the total price you paid for these skins:');
});

// Handle account selection (unchanged)
bot.action(/select_account_(.+)/, async (ctx) => {
    const session = initializeSession(ctx.from.id);
    try {
        const account = decodeURIComponent(ctx.match[1]);
        if (!accountOptions.includes(account)) {
            return ctx.reply('Invalid account selection. Please try again.');
        }

        const sheets = await getSheetsClient();
        await appendToSpreadsheet(session.skins, session.price, account, sheets);

        await ctx.reply('✅ Log saved successfully! Click below to start a new log.', {
            reply_markup: {
                inline_keyboard: [[{ text: 'Add New Skin', callback_data: 'add_new_skin' }]],
            },
        });
        
        // Reset session
        userSessions[ctx.from.id] = { skins: [], step: 'addSkin', timestamp: Date.now(), search: { term: '', results: [], page: 0, pageSize: 5 } };
    } catch (error) {
        await ctx.reply('❌ Error saving log. Please try again.');
        console.error('Account selection error:', error);
    }
});

// Catch-all for unexpected messages
bot.on('message', (ctx) => {
    ctx.reply('Please use /start to begin or use the menu buttons.');
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('⚠️ An error occurred. Please try again or contact support if the problem persists.');
});

// Start the bot
bot.launch()
    .then(() => console.log('Bot is running...'))
    .catch(err => console.error('Bot launch failed:', err));

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
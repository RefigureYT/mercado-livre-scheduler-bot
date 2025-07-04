const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const app = express();
const os = require('os');
const axios = require('axios');

// --- Constantes e Configurações ---
const PORT = 38564;
const accountPages = new Map();
app.use(express.json());

// Mantendo suas listas originais para garantir compatibilidade
const USER_AGENTS = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];
const MERCADOLIVRE_DOMAINS = [
    '.mercadolivre.com', '.mercadolivre.com.br', 'myaccount.mercadolivre.com.br',
    '.mercadoshops.com.br', '.mercadopago.com.br', '.google.com', '.youtube.com',
    '.rubiconproject.com', '.adnxs.com', '.creativecdn.com', '.bing.com',
    '.pinterest.com', '.doubleclick.net', 'obs.segreencolumn.com'
];
const COOKIE_ORDER_PREFERENCE = [
    "p_dsid", "p_edsid", "_d2id", "LAST_SEARCH", "_gcl_au", "_ga", "_cq_duid",
    "_pin_unauth", "_fbp", "_tt_enable_cookie", "_ttp", "ttcsid_C9SJ5SBC77UADFMAH8T0",
    "ttcsid", "cto_bundle", "ftid", "orguserid", "orgnickp", "ssid", "orguseridp",
    "_ga_NDJFKMJ2PD", "cookiesPreferencesLoggedFallback", "cookiesPreferencesNotLogged",
    "cp", "_hjSessionUser_492923", "_uetvid", "_hjSessionUser_720738", "_csrf",
    "_hjSessionUser_651094", "nsa_rotok", "cookiesPreferencesLogged", "hide-cookie-banner",
    "_mldataSessionId", "NSESSIONID_fury_fbm-inbound-frontend", "msl_tx", "nonce_sso",
    "c_ui-navigation", "onboarding_cp", "x-meli-session-id", "hide-cookie-banner_1920442195",
    "_hjSession_720738", "__rtbh.uid", "__rtbh.lid", "_uetsid"
];

// --- Funções de Utilidade ---

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName] || [];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1';
}

function getAccountIdentifier(account) {
    return account.sigla || account.name;
}

function humanDelay(minMs = 3000, maxMs = 7000) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (maxMs - minMs) + minMs));
}

async function robustGoto(page, url, options) {
    try {
        await page.goto(url, options);
    } catch (error) {
        console.error(`[ERRO] Falha ao navegar para ${url}:`, error.message);
        throw error;
    }
}

async function loadCookiesFromFile(rawCookieFileName) {
    const cookiesDir = path.join(__dirname, 'cookies');
    const formattedName = rawCookieFileName.replace(/\s+/g, '-');
    const possibleNames = [`${formattedName}-cookies.json`, `${formattedName}.json`, `${rawCookieFileName}-cookies.json`, `${rawCookieFileName}.json`];
    for (const name of possibleNames) {
        const filePath = path.join(cookiesDir, name);
        try {
            await fs.access(filePath);
            const data = await fs.readFile(filePath, 'utf8');
            console.log(`Cookies carregados de: ${filePath}`);
            return { cookies: JSON.parse(data), filePath };
        } catch (e) { /* continua */ }
    }
    throw new Error(`Arquivo de cookies para "${rawCookieFileName}" não encontrado.`);
}

async function saveCookiesToFile(page, cookiesFilePath, identifier) {
    try {
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        await fs.writeFile(cookiesFilePath, JSON.stringify(cookies, null, 2));
        console.log(`[${identifier}][INFO] Cookies atualizados e salvos.`);
    } catch (error) {
        console.error(`[${identifier}][ERRO] Falha ao salvar cookies:`, error.message);
    }
}

async function extractTableData(page) {
    const selector = "#app-root-wrapper > section > div:nth-child(5) > table";
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 30000 });
        return await page.evaluate((sel) => {
            const table = document.querySelector(sel);
            if (!table) return [];
            const rows = Array.from(table.querySelectorAll('tr'));
            const headers = Array.from(rows[0].querySelectorAll('th')).map(th => th.innerText.trim());
            const data = [];
            const colMap = {
                envio: headers.findIndex(h => h.includes('Envio')),
                unidades: headers.findIndex(h => h.includes('Unidades')),
                dataReservada: headers.findIndex(h => h.includes('Data reservada')),
                custoAplicado: headers.findIndex(h => h.includes('Custo aplicado')),
                status: headers.findIndex(h => h.includes('Status')),
            };
            for (let i = 1; i < rows.length; i++) {
                const cells = Array.from(rows[i].querySelectorAll('td'));
                const rowData = cells.map(cell => cell.innerText.trim());
                const hasReservedDate = colMap.dataReservada !== -1 && rowData[colMap.dataReservada] && rowData[colMap.dataReservada] !== '-';
                if (hasReservedDate) {
                    data.push({
                        envioId: rowData[colMap.envio] || 'N/A',
                        unidades: rowData[colMap.unidades] || 'N/A',
                        dataReservada: rowData[colMap.dataReservada] || 'N/A',
                        custoAplicado: rowData[colMap.custoAplicado] || 'N/A',
                        status: rowData[colMap.status] || 'N/A',
                    });
                }
            }
            return data;
        }, selector);
    } catch (error) {
        if (error.name === 'TimeoutError') return [];
        console.error(`[ERRO] Falha ao extrair tabela:`, error);
        return null;
    }
}

async function extractAndFormatRequestData(page, inboundId, identifier) {
    let csrfToken = await page.evaluate(() => window.__PRELOADED_STATE__?.csrfToken || null);
    if (!csrfToken) csrfToken = await page.$eval('meta[name="_csrf"]', el => el.content).catch(() => null);
    if (!csrfToken) csrfToken = await page.$eval('input[name="_csrf"]', el => el.value).catch(() => null);

    if (csrfToken) console.log(`[${identifier}][INFO] x-csrf-token encontrado.`);
    else console.warn(`[${identifier}][WARN] x-csrf-token não encontrado.`);

    const allCookies = await page.cookies();
    const cookieMap = new Map(allCookies.map(c => [c.name, c.value]));
    const orderedCookieParts = [];
    const processedCookieNames = new Set();

    COOKIE_ORDER_PREFERENCE.forEach(name => {
        if (cookieMap.has(name)) {
            orderedCookieParts.push(`${name}=${cookieMap.get(name)}`);
            processedCookieNames.add(name);
        }
    });
    allCookies.forEach(cookie => {
        if (!processedCookieNames.has(cookie.name) && MERCADOLIVRE_DOMAINS.some(domain => cookie.domain.includes(domain))) {
            orderedCookieParts.push(`${cookie.name}=${cookie.value}`);
        }
    });
    const cookieString = orderedCookieParts.join('; ');

    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "pt-BR,pt;q=0.9",
        "cookie": cookieString,
        "origin": "https://myaccount.mercadolivre.com.br",
        "referer": `https://myaccount.mercadolivre.com.br/shipping/inbounds/${inboundId}/hub`,
        "sec-ch-ua": '"Not/A )Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": USER_AGENTS[0], // Usa o User Agent do Linux
        "x-csrf-token": csrfToken || "token-nao-encontrado",
    };
}

// --- Lógica Principal de Inicialização ---

async function run() {
    let browserInstance;
    try {
        const creds = JSON.parse(await fs.readFile(path.join(__dirname, 'cred.json'), 'utf8'));
        const accounts = creds.accounts.sort((a, b) => a.id - b.id);
        if (!accounts.length) throw new Error("Nenhuma conta em cred.json.");

        const launchArgs = [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars',
            '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080', '--lang=pt-BR,pt',
        ];

        console.log("Lançando navegador em modo Headless Stealth...");
        browserInstance = await puppeteer.launch({
            headless: true,
            executablePath: os.platform() === 'linux' ? '/usr/bin/google-chrome' : undefined,
            args: launchArgs,
            ignoreDefaultArgs: ['--enable-automation'],
        });

        const initialPage = (await browserInstance.pages())[0];
        if (initialPage && initialPage.url() === 'about:blank') await initialPage.close();

        for (const account of accounts) {
            const identifier = getAccountIdentifier(account);
            try {
                console.log(`[${identifier}] Criando contexto de navegador...`);
                const context = await browserInstance.createBrowserContext();
                const page = await context.newPage();

                await page.setViewport({ width: 1920, height: 1080 });
                await page.emulateTimezone('America/Sao_Paulo');

                const { cookies, filePath } = await loadCookiesFromFile(account.cookieFileName);
                await page.setCookie(cookies.map(c => ({ ...c, sameSite: c.sameSite === 'Unspecified' ? undefined : c.sameSite })));

                accountPages.set(account.id, { page, context, identifier, loadedCookiesFilePath: filePath });
                page.on('load', () => saveCookiesToFile(page, filePath, identifier));

                await robustGoto(page, 'https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' } );
                console.log(`[${identifier}] Conta pronta.`);
            } catch (error) {
                console.error(`[${identifier}][ERRO] Falha ao processar conta:`, error);
            }
            await humanDelay();
        }
        console.log('Todas as contas processadas. Servidor pronto.');
    } catch (error) {
        console.error('Erro fatal na inicialização:', error);
        if (browserInstance) await browserInstance.close();
        process.exit(1);
    }
}

// --- Endpoints da API ---

app.get('/agendamentos', async (req, res) => {
    const accountId = parseInt(req.query.id);
    const envioId = req.query.envioId;
    if (isNaN(accountId)) return res.status(400).json({ error: 'ID da conta é obrigatório.' });
    const accountInfo = accountPages.get(accountId);
    if (!accountInfo) return res.status(404).json({ error: `Conta ID ${accountId} não encontrada.` });

    const { page, identifier } = accountInfo;
    console.log(`[API][${identifier}] GET /agendamentos | Envio: ${envioId || 'Nenhum'}`);
    try {
        await robustGoto(page, 'https://myaccount.mercadolivre.com.br/shipping/inbounds-v2?status=working', { waitUntil: 'networkidle2' } );
        let agendamentos = await extractTableData(page);
        if (agendamentos === null) return res.status(500).json({ error: 'Falha ao extrair tabela.' });
        if (envioId) agendamentos = agendamentos.filter(ag => ag.envioId === `#${envioId}`);
        res.json({ success: true, account: identifier, agendamentos });
    } catch (error) {
        console.error(`[API][${identifier}][ERRO] /agendamentos:`, error);
        res.status(500).json({ error: 'Erro interno.', details: error.message });
    }
});

app.post('/baixar-pdf-agendamento', async (req, res) => {
    const { id: accountId, numeroAgendamento: inboundId } = req.body;
    if (isNaN(accountId) || !inboundId) return res.status(400).json({ error: 'ID e numeroAgendamento são obrigatórios.' });
    const accountInfo = accountPages.get(parseInt(accountId));
    if (!accountInfo) return res.status(404).json({ error: `Conta ID ${accountId} não encontrada.` });

    const { page, identifier } = accountInfo;
    console.log(`[API][${identifier}] POST /baixar-pdf | Agendamento: ${inboundId}`);
    try {
        await robustGoto(page, `https://myaccount.mercadolivre.com.br/shipping/inbounds/${inboundId}/hub`, { waitUntil: 'networkidle2' } );
        const requestHeaders = await extractAndFormatRequestData(page, inboundId, identifier);
        const downloadUrl = `https://myaccount.mercadolivre.com.br/api/shipping/inbounds/${inboundId}/labels/details/inbound`;
        const response = await axios.post(downloadUrl, {}, { headers: requestHeaders, responseType: 'arraybuffer' } );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="agendamento_${inboundId}.pdf"`);
        res.send(response.data);
    } catch (error) {
        console.error(`[API][${identifier}][ERRO] /baixar-pdf:`, error.message);
        const statusCode = error.response?.status || 500;
        const errorDetails = error.response?.data?.toString() || 'Erro desconhecido.';
        res.status(statusCode).json({ error: 'Falha ao baixar o PDF.', details: errorDetails });
    }
});

// --- Inicialização do Servidor ---
run().then(() => {
    const ip = getLocalIpAddress();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n--- Servidor HTTP iniciado ---`);
        console.log(`Acessível em: http://${ip}:${PORT}` );
        console.log(`Endpoints: /agendamentos (GET), /baixar-pdf-agendamento (POST)`);
        console.log(`--------------------------\n`);
    });
}).catch(err => {
    console.error("Falha crítica na inicialização. Servidor não iniciado.", err);
    process.exit(1);
});

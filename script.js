const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const app = express();
const os = require('os');
const axios = require('axios'); // <-- NOVO: Importa Axios

// Constantes para o mecanismo de retentativa
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

const accountPages = new Map(); // Mapa para armazenar { id: { page, browserInstance, loadedCookiesFilePath, identifier, currentRequestHeaders } }

// --- Configuração e Início do Servidor HTTP ---
const PORT = 38564;
app.use(express.json()); // Para parsear o body das requisições JSON

// Lista de User-Agents comuns para simular navegadores reais
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

// Domínios de cookies que queremos incluir no cabeçalho 'Cookie'
const MERCADOLIVRE_DOMAINS = [
    '.mercadolivre.com',
    '.mercadolivre.com.br',
    'myaccount.mercadolivre.com.br',
    '.mercadoshops.com.br',
    '.mercadopago.com.br',
    '.google.com',
    '.youtube.com',
    '.rubiconproject.com',
    '.adnxs.com',
    '.creativecdn.com',
    '.bing.com',
    '.pinterest.com',
    '.doubleclick.net',
    'obs.segreencolumn.com'
];

// Ordem preferencial dos cookies no cabeçalho 'Cookie'
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


// Função para obter o IP local
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '127.0.0.1';
}

const localIp = getLocalIpAddress();

// --- Funções Reutilizáveis ---

async function getChromeExecutablePath() {
    const paths = {
        win32: [
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
        linux: [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
        ],
    };

    const platform = process.platform;
    if (paths[platform]) {
        for (const p of paths[platform]) {
            try {
                await fs.access(p);
                console.log(`[DEBUG] Chrome encontrado em caminho padrão: ${p}`);
                return p;
            } catch (e) {
                // Caminho não encontrado, tenta o próximo
            }
        }
    }
    try {
        console.log("[DEBUG] Tentando encontrar Chrome via puppeteer.launch temporário...");
        const browserTemp = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const executablePath = browserTemp.executablePath();
        await browserTemp.close();
        if (executablePath && executablePath.includes('chrome')) {
            console.log(`[DEBUG] Chrome encontrado via puppeteer.launch temporário: ${executablePath}`);
            return executablePath;
        }
    } catch (e) {
        console.warn("[DEBUG] Não foi possível encontrar o caminho do executável do Chrome automaticamente via puppeteer.launch temporário.");
    }
    return null;
}

async function saveCookiesToFile(page, cookiesFilePath, accountIdentifier = 'Desconhecido') {
    try {
        const client = await page.target().createCDPSession();
        const allCookies = (await client.send('Network.getAllCookies')).cookies;
        await fs.writeFile(cookiesFilePath, JSON.stringify(allCookies, null, 2));
        console.log(`[${accountIdentifier}][INFO] Cookies atualizados e salvos em: ${cookiesFilePath}`);
    } catch (error) {
        console.error(`[${accountIdentifier}][ERRO] Erro ao salvar cookies em ${cookiesFilePath}:`, error);
    }
}

function getAccountIdentifier(account) {
    return account.sigla || account.name;
}

// Função para extrair dados de uma tabela HTML (mantida como estava)
async function extractTableData(page, selector) { // Removemos o parâmetro 'filterReservedDate'
    try {
        await page.waitForSelector(selector, { visible: true, timeout: 30000 });

        // Removemos 'filter' dos argumentos do page.evaluate
        const tableData = await page.evaluate((sel) => {
            const table = document.querySelector(sel);
            if (!table) return null;

            const rows = Array.from(table.querySelectorAll('tr'));
            const headers = Array.from(rows[0].querySelectorAll('th')).map(th => th.innerText.trim());
            const data = [];

            const reservedDateColIndex = headers.findIndex(header => header.includes('Data reservada'));
            const shippingIdColIndex = headers.findIndex(header => header.includes('Envio'));
            const unitsColIndex = headers.findIndex(header => header.includes('Unidades')); // Adicionado para mais precisão
            const costColIndex = headers.findIndex(header => header.includes('Custo aplicado')); // Adicionado para mais precisão
            const statusColIndex = headers.findIndex(header => header.includes('Status')); // Adicionado para mais precisão

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const cells = Array.from(row.querySelectorAll('td'));
                const rowData = cells.map(cell => cell.innerText.trim());

                // A lógica de filtro agora é fixa: só queremos agendamentos com data.
                const hasReservedDate = reservedDateColIndex !== -1 && rowData[reservedDateColIndex] && rowData[reservedDateColIndex] !== '-';

                if (hasReservedDate) {
                    const agendamento = {
                        envioId: shippingIdColIndex !== -1 ? rowData[shippingIdColIndex] : 'N/A',
                        unidades: unitsColIndex !== -1 ? rowData[unitsColIndex] : 'N/A',
                        dataReservada: reservedDateColIndex !== -1 ? rowData[reservedDateColIndex] : 'N/A',
                        custoAplicado: costColIndex !== -1 ? rowData[costColIndex] : 'N/A',
                        status: statusColIndex !== -1 ? rowData[statusColIndex] : 'N/A',
                    };
                    data.push(agendamento);
                }
            }
            return data;
        }, selector); // Passamos apenas o 'selector'

        return tableData;

    } catch (error) {
        // Se a tabela não for encontrada (pode não haver agendamentos), retorna um array vazio em vez de null.
        if (error.name === 'TimeoutError') {
            console.warn(`[AVISO] A tabela com o seletor "${selector}" não foi encontrada. Retornando lista vazia.`);
            return [];
        }
        console.error(`[ERRO] Não foi possível extrair a tabela com o seletor "${selector}":`, error);
        return null; // Retorna null para outros tipos de erro
    }
}

function humanDelay(minMs, maxMs) {
    const delay = Math.random() * (maxMs - minMs) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

async function robustGoto(page, url, options, maxRetries = 3, retryDelayMs = 3000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await page.goto(url, options);
            return;
        } catch (error) {
            if (error.message.includes('net::ERR_NETWORK_CHANGED') || error.message.includes('net::ERR_INTERNET_DISCONNECTED')) {
                console.warn(`[AVISO] Erro de rede ao navegar para ${url} (tentativa ${i + 1}/${maxRetries}). Retentando em ${retryDelayMs / 1000} segundos...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } else {
                throw error;
            }
        }
    }
    throw new Error(`Falha ao navegar para ${url} após ${maxRetries} tentativas devido a problemas de rede.`);
}

async function loadCookiesFromFile(rawCookieFileName) {
    const cookiesDir = path.join(__dirname, 'cookies');
    let cookiesFilePath;
    let cookies;

    const formattedCookieFileName = rawCookieFileName.replace(/\s+/g, '-');

    const possibleFileNames = [
        `${formattedCookieFileName}-cookies.json`,
        `${formattedCookieFileName}.json`,
        `${rawCookieFileName}-cookies.json`,
        `${rawCookieFileName}.json`
    ];

    for (const name of possibleFileNames) {
        cookiesFilePath = path.join(cookiesDir, name);
        try {
            const data = await fs.readFile(cookiesFilePath, 'utf8');
            cookies = JSON.parse(data);
            console.log(`Cookies carregados de: ${cookiesFilePath}`);
            return { cookies, filePath: cookiesFilePath };
        } catch (e) {
            // Tenta o próximo nome
        }
    }

    throw new Error(`Arquivo de cookies para "${rawCookieFileName}" não encontrado ou inválido em qualquer formato esperado.`);
}

// --- NOVA FUNÇÃO: Extrair e formatar dados de requisição ---
async function extractAndFormatRequestData(page, inboundId, accountIdentifier) {
    let csrfToken = null;
    try {
        csrfToken = await page.evaluate(() => {
            if (window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.csrfToken) {
                return window.__PRELOADED_STATE__.csrfToken;
            }
            return null;
        });
    } catch (e) {
        console.warn(`[${accountIdentifier}][WARN] Erro ao tentar acessar window.__PRELOADED_STATE__.csrfToken:`, e.message);
    }

    if (!csrfToken) {
        try {
            csrfToken = await page.$eval('meta[name="_csrf"]', el => el.content).catch(() => null);
        } catch (e) { /* ignore */ }
        if (!csrfToken) {
            try {
                csrfToken = await page.$eval('input[name="_csrf"]', el => el.value).catch(() => null);
            } catch (e) { /* ignore */ }
        }
        if (!csrfToken) {
            console.warn(`[${accountIdentifier}][WARN] Não foi possível encontrar o x-csrf-token na página usando métodos comuns.`);
            csrfToken = "coloque-manualmente";
        }
    }

    if (csrfToken && csrfToken !== "coloque-manualmente") {
        console.log(`[${accountIdentifier}][INFO] x-csrf-token encontrado: ${csrfToken}`);
    } else {
        console.warn(`[${accountIdentifier}][WARN] x-csrf-token não encontrado ou marcado como 'coloque-manualmente'.`);
    }

    // Obter todos os cookies atuais do navegador
    const allCookies = await page.cookies();

    // Construir a string do cabeçalho 'Cookie' na ordem preferencial
    const cookieMap = new Map();
    allCookies.forEach(cookie => {
        cookieMap.set(cookie.name, cookie.value);
    });

    let orderedCookieParts = [];
    const processedCookieNames = new Set();

    COOKIE_ORDER_PREFERENCE.forEach(cookieName => {
        if (cookieMap.has(cookieName)) {
            orderedCookieParts.push(`${cookieName}=${cookieMap.get(cookieName)}`);
            processedCookieNames.add(cookieName);
        }
    });

    allCookies.forEach(cookie => {
        if (!processedCookieNames.has(cookie.name) && MERCADOLIVRE_DOMAINS.some(domain => cookie.domain.includes(domain))) {
            orderedCookieParts.push(`${cookie.name}=${cookie.value}`);
            processedCookieNames.add(cookie.name);
        }
    });

    const cookieString = orderedCookieParts.join('; ');
    if (!cookieString) {
        console.warn(`[${accountIdentifier}][WARN] Nenhuma string de cookie foi gerada.`);
    }

    // Montar o objeto de cabeçalhos para a requisição final
    const requestHeaders = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-length": "0",
        "cookie": cookieString || "coloque-manualmente",
        "device-memory": "8",
        "downlink": "10",
        "dpr": "1",
        "ect": "4g",
        "origin": "https://myaccount.mercadolivre.com.br",
        "priority": "u=1, i",
        "referer": `https://myaccount.mercadolivre.com.br/shipping/inbounds/${inboundId}/hub`,
        "rtt": "50",
        "sec-ch-ua": "\"Google Chrome\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A  )Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "viewport-width": "1920",
        "x-csrf-token": csrfToken
    };

    return requestHeaders;
}


// --- Lógica Principal ---

async function run() {
    let browserInstance; // Definido no escopo superior para ser acessível no catch
    try {
        const chromePath = await getChromeExecutablePath();

        if (!chromePath) {
            console.error("Erro: Caminho do executável do Chrome não encontrado.");
            return;
        }
        console.log('Caminho do Chrome detectado para launch principal:', chromePath);

        const credPath = path.join(__dirname, 'cred.json');
        const credData = await fs.readFile(credPath, 'utf8');
        const creds = JSON.parse(credData);
        const accounts = creds.accounts;

        if (!accounts || accounts.length === 0) {
            console.error("Erro: Nenhuma conta encontrada em cred.json.");
            return;
        }

        accounts.sort((a, b) => a.id - b.id);

        console.log("Lançando uma única instância do navegador para todas as contas...");
        browserInstance = await puppeteer.launch({
            executablePath: chromePath,
            headless: false, // 'false' para fins de debug
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
            ],
        });

        for (const account of accounts) {
            const identifier = getAccountIdentifier(account);
            try {
                console.log(`[${identifier}] Criando contexto de navegador isolado...`);

                // Cria um contexto, que é como uma sessão de navegador separada e leve
                const context = await browserInstance.createBrowserContext();

                const page = await context.newPage();

                await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);

                const { cookies, filePath: loadedCookiesFilePath } = await loadCookiesFromFile(account.cookieFileName);

                accountPages.set(account.id, {
                    page: page,
                    browserContext: context,
                    loadedCookiesFilePath: loadedCookiesFilePath,
                    identifier: identifier,
                    accountData: account,
                    currentRequestHeaders: null
                });
                console.log(`[${identifier}] Objeto da conta criado no mapa.`);

                page.on('load', async () => {
                    console.log(`[${identifier}][EVENTO] Página carregada/recarregada.`);
                    try {
                        const accountInfo = accountPages.get(account.id);
                        if (accountInfo) {
                            await saveCookiesToFile(page, accountInfo.loadedCookiesFilePath, identifier);
                        }
                    } catch (error) {
                        console.error(`[${identifier}][ERRO] Erro dentro do listener 'page.on(load)':`, error);
                    }
                });

                const filteredCookies = cookies.map(cookie => {
                    const newCookie = {
                        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
                        expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure,
                        sameSite: cookie.sameSite === 'Unspecified' ? undefined : cookie.sameSite,
                    };
                    if (typeof cookie.expires === 'number' && cookie.expires > 0) {
                        newCookie.expires = Math.floor(newCookie.expires);
                    }
                    Object.keys(newCookie).forEach(key => newCookie[key] === undefined && delete newCookie[key]);
                    return newCookie;
                });
                await page.setCookie(...filteredCookies);

                console.log(`[${identifier}] Navegando para a página inicial do Mercado Livre...`);
                await robustGoto(page, 'https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' });
                console.log(`[${identifier}] Página inicial aberta. Conta pronta para uso.`);

            } catch (error) {
                console.error(`[${identifier}][ERRO] Ocorreu um erro ao processar a conta:`, error);
            }
            await humanDelay(3000, 7000);
        }

        console.log('Todas as contas foram processadas e abertas. O servidor está pronto.');

    } catch (error) {
        console.error('Ocorreu um erro geral no script:', error);
        if (browserInstance) {
            await browserInstance.close();
        }
        process.exit(1);
    }
}

// Endpoint GET /agendamentos (mantido como estava)
app.get('/agendamentos', async (req, res) => {
    const accountId = parseInt(req.query.id);
    const envioId = req.query.envioId; // O parâmetro 'filtro' não parecia ser usado, então foi removido para clareza.

    if (isNaN(accountId)) {
        return res.status(400).json({ error: 'Parâmetro "id" da conta é obrigatório e deve ser um número.' });
    }

    const accountInfo = accountPages.get(accountId);
    if (!accountInfo) {
        return res.status(404).json({ error: `Conta com ID ${accountId} não encontrada ou não inicializada.` });
    }

    const { page, identifier } = accountInfo;
    const tableSelector = "#app-root-wrapper > section > div:nth-child(5) > table";

    try {
        console.log(`[API][${identifier}] Requisição GET /agendamentos recebida. Envio ID: ${envioId || 'Nenhum'}`);

        console.log(`[API][${identifier}] Navegando para a página de agendamentos para obter dados atualizados...`);
        await robustGoto(page, 'https://myaccount.mercadolivre.com.br/shipping/inbounds-v2?status=working', { waitUntil: 'networkidle2' });

        // A função agora lida com o filtro internamente
        let agendamentos = await extractTableData(page, tableSelector);

        if (!agendamentos) {
            // Se a extração falhar, retorna um erro.
            return res.status(500).json({ error: 'Falha ao extrair dados da tabela da página.' });
        }

        if (envioId) {
            const originalCount = agendamentos.length;
            agendamentos = agendamentos.filter(agendamento => agendamento.envioId === `#${envioId}`);
            console.log(`[API][${identifier}] Filtrado por Envio ID: ${envioId}. ${agendamentos.length} de ${originalCount} agendamentos correspondem.`);
        }

        console.log(`[API][${identifier}] ${agendamentos.length} agendamentos encontrados.`);
        res.json({ success: true, account: identifier, agendamentos: agendamentos });

    } catch (error) {
        console.error(`[API][${identifier}][ERRO] Erro ao processar requisição /agendamentos:`, error);
        res.status(500).json({ error: 'Erro interno ao processar a requisição.', details: error.message });
    }
});

// --- NOVO ENDPOINT: POST /baixar-pdf-agendamento ---
app.post('/baixar-pdf-agendamento', async (req, res) => {
    // A linha abaixo é a que estava dando erro.
    const { id: accountId, numeroAgendamento: inboundId } = req.body;

    if (isNaN(accountId) || !inboundId) {
        return res.status(400).json({ error: 'Parâmetros "id" (da conta) e "numeroAgendamento" são obrigatórios.' });
    }

    const accountInfo = accountPages.get(parseInt(accountId));
    if (!accountInfo) {
        return res.status(404).json({ error: `Conta com ID ${accountId} não encontrada ou não inicializada.` });
    }

    const { page, identifier } = accountInfo;

    try {
        console.log(`[API][${identifier}] Requisição POST /baixar-pdf-agendamento para agendamento ${inboundId}.`);

        const targetUrl = `https://myaccount.mercadolivre.com.br/shipping/inbounds/${inboundId}/hub`;
        console.log(`[API][${identifier}] Navegando para: ${targetUrl} para obter dados de requisição.`);
        await robustGoto(page, targetUrl, { waitUntil: 'networkidle2' });

        const requestHeaders = await extractAndFormatRequestData(page, inboundId, identifier);

        const downloadUrl = `https://myaccount.mercadolivre.com.br/api/shipping/inbounds/${inboundId}/labels/details/inbound`;
        console.log(`[API][${identifier}] Tentando baixar PDF de: ${downloadUrl}`);

        const response = await axios.post(downloadUrl, {}, {
            headers: requestHeaders,
            responseType: 'arraybuffer'
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="agendamento_${inboundId}.pdf"`);
        res.send(response.data);

        console.log(`[API][${identifier}] PDF do agendamento ${inboundId} enviado com sucesso.`);

    } catch (error) {
        console.error(`[API][${identifier}][ERRO] Erro ao baixar PDF do agendamento ${inboundId}:`, error.message);
        let errorMessage = 'Erro interno ao baixar o PDF.';
        let statusCode = 500;

        if (axios.isAxiosError(error)) {
            if (error.response) {
                try {
                    const errorData = JSON.parse(error.response.data.toString('utf8'));
                    errorMessage = `Erro do Mercado Livre: ${errorData.message || 'Detalhe não especificado.'}`;
                } catch (e) {
                    errorMessage = `Erro do Mercado Livre (Status: ${error.response.status}).`;
                }
                statusCode = error.response.status;
                return res.status(statusCode).json({ error: errorMessage, details: error.response.data.toString('utf8') });
            } else {
                return res.status(500).json({ error: 'Erro de rede ao contatar o Mercado Livre.', details: error.message });
            }
        }
        return res.status(500).json({ error: errorMessage, details: error.message });
    }
});


// Inicia o servidor HTTP após a inicialização do Puppeteer
run().then(() => {
    app.listen(PORT, localIp, () => {
        console.log(`\n--- Servidor HTTP iniciado ---`);
        console.log(`Acesse em: http://${localIp}:${PORT}`);
        console.log(`Endpoint de Agendamentos: http://${localIp}:${PORT}/agendamentos?id=<ID_DA_CONTA>&filtro=<none_ou_vazio>&envioId=<ID_DO_ENVIO>`);
        console.log(`Endpoint de Download PDF: POST http://${localIp}:${PORT}/baixar-pdf-agendamento`);
        console.log(`Body para Download PDF: { "id": <ID_DA_CONTA>, "numeroAgendamento": <NUMERO_DO_AGENDAMENTO> }`);
        console.log(`------------------------------\n`);
    });
}).catch(err => {
    console.error("Falha na inicialização do servidor:", err);
    process.exit(1);
});

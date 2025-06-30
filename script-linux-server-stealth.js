const puppeteer = require('puppeteer-extra'); // <-- MODIFICADO
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // <-- NOVO
puppeteer.use(StealthPlugin()); // <-- NOVO: Habilita o plugin stealth

const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const app = express();
const os = require('os');

// Constantes para o mecanismo de retentativa
const MAX_RETRIES = 3; // Número máximo de tentativas para lançar um navegador
const RETRY_DELAY_MS = 5000; // Atraso entre as tentativas (5 segundos)

const accountPages = new Map(); // Mapa para armazenar { id: { page, browserInstance, loadedCookiesFilePath, identifier } }

// --- Configuração e Início do Servidor HTTP ---
const PORT = 38564;

// Lista de User-Agents comuns para simular navegadores reais
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // Adicione mais User-Agents de diferentes versões e sistemas operacionais
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
    return '127.0.0.1'; // Retorna localhost se não encontrar IP externo
}

const localIp = getLocalIpAddress();

// --- Funções Reutilizáveis ---

// Função para encontrar o caminho do executável do Chrome
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
        // Tenta usar o puppeteer-core para descobrir (menos confiável se não estiver em PATH)
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

// Função para salvar cookies para um arquivo
async function saveCookiesToFile(page, cookiesFilePath, accountIdentifier = 'Desconhecido') { // Renomeado accountName para accountIdentifier
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

// Função para extrair dados de uma tabela HTML
// Adicionado o parâmetro 'filterReservedDate'
async function extractTableData(page, selector, filterReservedDate = true) {
    try {
        // Espera o seletor da tabela estar visível
        await page.waitForSelector(selector, { visible: true, timeout: 30000 }); // Espera até 30 segundos

        const tableData = await page.evaluate((sel, filter) => {
            const table = document.querySelector(sel);
            if (!table) return null;

            const rows = Array.from(table.querySelectorAll('tr'));
            const headers = Array.from(rows[0].querySelectorAll('th')).map(th => th.innerText.trim());
            const data = [];

            const reservedDateColIndex = headers.findIndex(header => header.includes('Data reservada'));
            const shippingIdColIndex = headers.findIndex(header => header.includes('Envio'));

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const cells = Array.from(row.querySelectorAll('td'));
                const rowData = cells.map(cell => cell.innerText.trim());

                const hasReservedDate = reservedDateColIndex !== -1 && rowData[reservedDateColIndex] && rowData[reservedDateColIndex] !== '-';

                // Aplica o filtro aqui
                if (!filter || hasReservedDate) { // Se não for para filtrar OU se tiver data reservada
                    const agendamento = {
                        envioId: shippingIdColIndex !== -1 ? rowData[shippingIdColIndex] : 'N/A',
                        unidades: rowData[1] || 'N/A',
                        dataReservada: rowData[reservedDateColIndex] || 'N/A', // Garante que sempre tenha a propriedade
                        custoAplicado: rowData[reservedDateColIndex + 1] || 'N/A',
                        status: rowData[reservedDateColIndex + 2] || 'N/A',
                    };
                    data.push(agendamento);
                }
            }
            return data;
        }, selector, filterReservedDate); // Passa o parâmetro de filtro para a função no navegador

        return tableData;

    } catch (error) {
        console.error(`[ERRO] Não foi possível extrair a tabela com o seletor "${selector}":`, error);
        return null;
    }
}

// Função auxiliar para atrasos variáveis para simular comportamento humano
function humanDelay(minMs, maxMs) {
    const delay = Math.random() * (maxMs - minMs) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

// Função auxiliar para tentar navegar para uma URL de forma robusta
async function robustGoto(page, url, options, maxRetries = 3, retryDelayMs = 3000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await page.goto(url, options);
            return; // Sucesso, sai da função
        } catch (error) {
            if (error.message.includes('net::ERR_NETWORK_CHANGED') || error.message.includes('net::ERR_INTERNET_DISCONNECTED')) {
                console.warn(`[AVISO] Erro de rede ao navegar para ${url} (tentativa ${i + 1}/${maxRetries}). Retentando em ${retryDelayMs / 1000} segundos...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } else {
                throw error; // Outro tipo de erro, re-lança
            }
        }
    }
    throw new Error(`Falha ao navegar para ${url} após ${maxRetries} tentativas devido a problemas de rede.`);
}

// Função para carregar cookies de um arquivo, tratando o nome
async function loadCookiesFromFile(rawCookieFileName) {
    const cookiesDir = path.join(__dirname, 'cookies');
    let cookiesFilePath;
    let cookies;

    // Formata o nome do arquivo de cookie (substitui espaços por traços)
    const formattedCookieFileName = rawCookieFileName.replace(/\s+/g, '-');

    // Tentativas de encontrar o arquivo de cookie
    const possibleFileNames = [
        `${formattedCookieFileName}-cookies.json`, // Ex: Empresa-JF-(Leandro)-cookies.json
        `${formattedCookieFileName}.json`,         // Ex: Empresa-JF-(Leandro).json
        `${rawCookieFileName}-cookies.json`,       // Ex: Empresa JF (Leandro)-cookies.json (caso o usuário tenha salvo com espaços)
        `${rawCookieFileName}.json`                // Ex: Empresa JF (Leandro).json (caso o usuário tenha salvo com espaços)
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

// --- Lógica Principal ---

async function run() {
    const allBrowsers = []; // Array para armazenar todas as instâncias de navegador
    try {
        const chromePath = await getChromeExecutablePath();

        if (!chromePath) {
            console.error("Erro: Caminho do executável do Chrome não encontrado. Por favor, verifique se o Chrome está instalado e tente novamente, ou especifique o caminho manualmente.");
            return;
        }
        console.log('Caminho do Chrome detectado para launch principal:', chromePath);

        // Ler o cred.json
        const credPath = path.join(__dirname, 'cred.json');
        const credData = await fs.readFile(credPath, 'utf8');
        const creds = JSON.parse(credData);
        const accounts = creds.accounts;

        if (!accounts || accounts.length === 0) {
            console.error("Erro: Nenhuma conta encontrada em cred.json. Por favor, configure as contas.");
            return;
        }

        // Ordenar as contas por ID para garantir a ordem de processamento
        accounts.sort((a, b) => a.id - b.id);

        // --- Processar a primeira conta separadamente ---
        const firstAccount = accounts[0];
        if (firstAccount) {
            let browserInstance;
            let page;
            let loadedCookiesFilePath;
            const identifier = getAccountIdentifier(firstAccount); // <-- NOVA LINHA AQUI

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`[${identifier}] Tentativa ${attempt}/${MAX_RETRIES} de lançar o navegador...`); // <-- MODIFICADO
                    const userDataDir = path.join(__dirname, 'user_data', firstAccount.id.toString());
                    await fs.mkdir(userDataDir, { recursive: true });

                    browserInstance = await puppeteer.launch({
                        executablePath: chromePath,
                        headless: true,
                        defaultViewport: null,
                        userDataDir: userDataDir,
                        args: [
                            '--start-maximized',
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-infobars',
                            // '--disable-blink-features=AutomationControlled', // Removido pelo plugin stealth
                        ],
                    });
                    allBrowsers.push(browserInstance); // Adiciona à lista apenas se o launch for bem-sucedido

                    page = await browserInstance.newPage();
                    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]); // <-- NOVO

                    const { cookies, filePath: loadedCookiesFilePathTemp } = await loadCookiesFromFile(firstAccount.cookieFileName);
                    loadedCookiesFilePath = loadedCookiesFilePathTemp; // Atribui à variável externa

                    const filteredCookies = cookies.map(cookie => {
                        const newCookie = {
                            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
                            expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure,
                            sameSite: cookie.sameSite === 'Unspecified' ? undefined : cookie.sameSite,
                        };
                        Object.keys(newCookie).forEach(key => newCookie[key] === undefined && delete newCookie[key]);
                        return newCookie;
                    });
                    await page.setCookie(...filteredCookies);

                    page.on('load', async () => {
                        console.log(`[${identifier}][EVENTO] Página carregada/recarregada. Verificando e salvando cookies atualizados...`); // <-- MODIFICADO
                        await saveCookiesToFile(page, loadedCookiesFilePath, identifier); // <-- MODIFICADO
                    });

                    console.log(`[${identifier}] Navegando para a página de agendamentos...`);
                    await robustGoto(page, 'https://myaccount.mercadolivre.com.br/shipping/inbounds-v2?status=working', { waitUntil: 'networkidle2' } ); // <-- MODIFICADO
                    console.log(`[${identifier}] Página de agendamentos aberta com cookies.`);

                    console.log(`[${identifier}] Aguardando para simular comportamento humano...`);
                    await humanDelay(8000, 12000); // Espera entre 8 e 12 segundos
                    console.log(`[${identifier}] Continuação após atraso humano.`);


                    // Armazenar a página e o navegador para uso posterior pelo servidor
                    accountPages.set(firstAccount.id, { // Mantém firstAccount.id como chave
                        page: page,
                        browserInstance: browserInstance,
                        loadedCookiesFilePath: loadedCookiesFilePath,
                        identifier: identifier, // Mantém o identifier para logs internos
                        accountData: firstAccount // Adiciona o objeto completo da conta para referência
                    });
                    console.log(`[${identifier}] Página e navegador armazenados para acesso via API.`);

                    break; // Sai do loop de retentativa se tudo deu certo

                } catch (error) {
                    if (error.code === 'ECONNREFUSED' && attempt < MAX_RETRIES) {
                        console.warn(`[${identifier}][AVISO] Falha ao lançar navegador (tentativa ${attempt}/${MAX_RETRIES}). Retentando em ${RETRY_DELAY_MS / 1000} segundos...`); // <-- MODIFICADO
                        if (browserInstance) { // Fecha o navegador se ele parcialmente lançou
                            try {
                                await browserInstance.close();
                                // Remove da lista allBrowsers se foi adicionado
                                const index = allBrowsers.indexOf(browserInstance);
                                if (index > -1) {
                                    allBrowsers.splice(index, 1);
                                }
                            } catch (closeError) {
                                console.error(`[${identifier}][ERRO] Erro ao tentar fechar navegador na retentativa:`, closeError); // <-- MODIFICADO
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                    } else {
                        console.error(`[${identifier}][ERRO] Ocorreu um erro ao processar a primeira conta após ${attempt} tentativas:`, error); // <-- MODIFICADO
                        if (browserInstance) {
                            try {
                                await browserInstance.close();
                                const index = allBrowsers.indexOf(browserInstance);
                                if (index > -1) {
                                    allBrowsers.splice(index, 1);
                                }
                            } catch (closeError) {
                                console.error(`[${identifier}][ERRO] Erro ao tentar fechar o navegador após falha final:`, closeError); // <-- MODIFICADO
                            }
                        }
                        throw error; // Re-lança se não for ECONNREFUSED ou se atingiu o máximo de retentativas
                    }
                }
            }
        }

        // --- Processar as contas restantes sequencialmente ---
        for (let i = 1; i < accounts.length; i++) {
            const account = accounts[i];
            let browserInstance;
            let page;
            let loadedCookiesFilePath;
            const identifier = getAccountIdentifier(account); // <-- NOVA LINHA AQUI

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`[${identifier}] Tentativa ${attempt}/${MAX_RETRIES} de lançar o navegador...`); // <-- MODIFICADO
                    const userDataDir = path.join(__dirname, 'user_data', account.id.toString());
                    await fs.mkdir(userDataDir, { recursive: true });

                    browserInstance = await puppeteer.launch({
                        executablePath: chromePath,
                        headless: true,
                        defaultViewport: null,
                        userDataDir: userDataDir,
                        args: [
                            '--start-maximized',
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-infobars',
                            // '--disable-blink-features=AutomationControlled',
                        ],
                    });
                    allBrowsers.push(browserInstance); // Adiciona à lista apenas se o launch for bem-sucedido

                    page = await browserInstance.newPage();
                    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);

                    const { cookies, filePath: loadedCookiesFilePathTemp } = await loadCookiesFromFile(account.cookieFileName);
                    loadedCookiesFilePath = loadedCookiesFilePathTemp; // Atribui à variável externa

                    const filteredCookies = cookies.map(cookie => {
                        const newCookie = {
                            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
                            expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure,
                            sameSite: cookie.sameSite === 'Unspecified' ? undefined : cookie.sameSite,
                        };
                        Object.keys(newCookie).forEach(key => newCookie[key] === undefined && delete newCookie[key]);
                        return newCookie;
                    });
                    await page.setCookie(...filteredCookies);

                    page.on('load', async () => {
                        console.log(`[${identifier}][EVENTO] Página carregada/recarregada. Verificando e salvando cookies atualizados...`); // <-- MODIFICADO
                        await saveCookiesToFile(page, loadedCookiesFilePath, identifier); // <-- MODIFICADO
                    });

                    console.log(`[${identifier}] Navegando para a página de agendamentos...`);
                    await robustGoto(page, 'https://myaccount.mercadolivre.com.br/shipping/inbounds-v2?status=working', { waitUntil: 'networkidle2' } ); // <-- MODIFICADO
                    console.log(`[${identifier}] Página de agendamentos aberta com cookies.`);

                    // Armazenar a página e o navegador para uso posterior pelo servidor
                    accountPages.set(account.id, { // Mantém account.id como chave
                        page: page,
                        browserInstance: browserInstance,
                        loadedCookiesFilePath: loadedCookiesFilePath,
                        identifier: identifier, // Mantém o identifier para logs internos
                        accountData: account // Adiciona o objeto completo da conta para referência
                    });
                    console.log(`[${identifier}] Página e navegador armazenados para acesso via API.`);

                    break; // Sai do loop de retentativa se tudo deu certo

                } catch (error) {
                    if (error.code === 'ECONNREFUSED' && attempt < MAX_RETRIES) {
                        console.warn(`[${identifier}][AVISO] Falha ao lançar navegador (tentativa ${attempt}/${MAX_RETRIES}). Retentando em ${RETRY_DELAY_MS / 1000} segundos...`); // <-- MODIFICADO
                        if (browserInstance) { // Fecha o navegador se ele parcialmente lançou
                            try {
                                await browserInstance.close();
                                // Remove da lista allBrowsers se foi adicionado
                                const index = allBrowsers.indexOf(browserInstance);
                                if (index > -1) {
                                    allBrowsers.splice(index, 1);
                                }
                            } catch (closeError) {
                                console.error(`[${identifier}][ERRO] Erro ao tentar fechar navegador na retentativa:`, closeError); // <-- MODIFICADO
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                    } else {
                        console.error(`[${identifier}][ERRO] Ocorreu um erro ao processar a conta após ${attempt} tentativas:`, error); // <-- MODIFICADO
                        if (browserInstance) {
                            try {
                                await browserInstance.close();
                                const index = allBrowsers.indexOf(browserInstance);
                                if (index > -1) {
                                    allBrowsers.splice(index, 1);
                                }
                            } catch (closeError) {
                                console.error(`[${identifier}][ERRO] Erro ao tentar fechar o navegador após falha final:`, closeError); // <-- MODIFICADO
                            }
                        }
                        throw error; // Re-lança se não for ECONNREFUSED ou se atingiu o máximo de retentativas
                    }
                }
            }
            // Atraso variável antes de iniciar o próximo navegador para simular comportamento humano
            await humanDelay(3000, 7000); // Espera entre 3 e 7 segundos
        }

        console.log('Todas as contas foram processadas e abertas. Os navegadores permanecerão abertos.');
        // Manter o script ativo indefinidamente
        await new Promise(() => { });

    } catch (error) {
        console.error('Ocorreu um erro geral no script:', error);
        // Em caso de erro geral antes do servidor iniciar, fechar navegadores
        for (const browserInstance of allBrowsers) {
            try {
                await browserInstance.close();
            } catch (closeError) {
                console.error("Erro ao tentar fechar um navegador:", closeError);
            }
        }
    }
    // O script permanecerá ativo devido ao servidor HTTP.
    // Os navegadores serão fechados apenas quando o processo for encerrado (Ctrl+C).
}

run();

// Endpoint GET /agendamentos
app.get('/agendamentos', async (req, res) => {
    const accountId = parseInt(req.query.id); // Pega o ID da conta do query parameter
    const filter = req.query.filtro; // Pega o filtro (ex: 'none')
    const envioId = req.query.envioId; // <-- NOVO: Pega o ID do envio do query parameter

    if (isNaN(accountId)) {
        return res.status(400).json({ error: 'Parâmetro "id" da conta é obrigatório e deve ser um número.' });
    }

    const accountInfo = accountPages.get(accountId);
    if (!accountInfo) {
        return res.status(404).json({ error: `Conta com ID ${accountId} não encontrada ou não inicializada.` });
    }

    const { page, accountData } = accountInfo;
    const identifier = getAccountIdentifier(accountData);
    const tableSelector = "#app-root-wrapper > section > div:nth-child(5) > table";

    try {
        console.log(`[API][${identifier}] Requisição GET /agendamentos recebida. Filtro: ${filter}, Envio ID: ${envioId || 'Nenhum'}`); // <-- MODIFICADO

        // Navegar para a URL de agendamentos para garantir que a página esteja correta
        // Isso também irá disparar o listener 'load' e salvar os cookies atualizados
        console.log(`[API][${identifier}] Recarregando página de agendamentos para obter dados atualizados...`);
        await robustGoto(page, 'https://myaccount.mercadolivre.com.br/shipping/inbounds-v2?status=working', { waitUntil: 'networkidle2' } ); // <-- MODIFICADO

        // Simular scroll antes de extrair dados
        console.log(`[API][${identifier}] Simulando scroll...`);
        try {
            // Scroll aleatório
            await page.evaluate(() => {
                window.scrollTo(0, Math.floor(document.body.scrollHeight * Math.random()));
            });
            await humanDelay(500, 1500); // Pequeno atraso após scroll
        } catch (simError) {
            console.warn(`[API][${identifier}][AVISO] Erro ao simular scroll: ${simError.message}`);
            // Continua a execução mesmo se a simulação falhar
        }
        // REMOVIDO: Simulação de movimento do mouse, pois não é eficaz nem necessária em headless

        const filterReservedDate = (filter !== 'none'); // Se filtro for 'none', não filtra

        let agendamentos = await extractTableData(page, tableSelector, filterReservedDate);

        // NOVO: Filtrar por envioId se ele foi fornecido
        if (envioId) {
            const originalCount = agendamentos.length;
            agendamentos = agendamentos.filter(agendamento => agendamento.envioId === `#${envioId}`);
            console.log(`[API][${identifier}] Filtrado por Envio ID: ${envioId}. ${agendamentos.length} de ${originalCount} agendamentos correspondem.`);
        }

        if (agendamentos && agendamentos.length > 0) {
            console.log(`[API][${identifier}] ${agendamentos.length} agendamentos encontrados (filtrados: ${filterReservedDate}, por Envio ID: ${!!envioId}).`); // <-- MODIFICADO
            res.json({ success: true, account: identifier, agendamentos: agendamentos });
        } else {
            console.log(`[API][${identifier}] Nenhuma agendamento encontrado (filtrados: ${filterReservedDate}, por Envio ID: ${!!envioId}).`); // <-- MODIFICADO
            res.json({ success: true, account: identifier, agendamentos: [] });
        }

    } catch (error) {
        console.error(`[API][${identifier}][ERRO] Erro ao processar requisição /agendamentos:`, error);
        res.status(500).json({ error: 'Erro interno ao processar a requisição.', details: error.message });
    }
});

app.listen(PORT, localIp, () => {
    console.log(`\n--- Servidor HTTP iniciado ---`);
    console.log(`Acesse em: http://${localIp}:${PORT}`);
    console.log(`Endpoint de Agendamentos: http://${localIp}:${PORT}/agendamentos?id=<ID_DA_CONTA>&filtro=<none_ou_vazio>&envioId=<ID_DO_ENVIO>`); // <-- MODIFICADO
    console.log(`------------------------------\n`);
});
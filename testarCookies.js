const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const path = require('path');

// Função para encontrar o caminho do executável do Chrome (reutilizada)
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
                return p;
            } catch (e) {
                // Caminho não encontrado, tenta o próximo
            }
        }
    }
    try {
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const executablePath = browser.executablePath();
        await browser.close();
        if (executablePath && executablePath.includes('chrome')) {
            return executablePath;
        }
    } catch (e) {
        // console.warn("Não foi possível encontrar o caminho do executável do Chrome automaticamente via puppeteer.");
    }
    return null;
}

// Função para carregar cookies de um arquivo
async function loadCookiesFromFile(cookieFileName) {
    const cookiesDir = path.join(__dirname, 'cookies');
    let cookiesFilePath;
    let cookies;

    // Tenta o nome exato (se já tiver a extensão)
    if (cookieFileName.endsWith('.json')) {
        cookiesFilePath = path.join(cookiesDir, cookieFileName);
        try {
            const data = await fs.readFile(cookiesFilePath, 'utf8');
            cookies = JSON.parse(data);
            console.log(`Cookies carregados de: ${cookiesFilePath}`);
            return { cookies, filePath: cookiesFilePath }; // Retorna o caminho também
        } catch (e) {
            console.warn(`Não foi possível carregar cookies de ${cookiesFilePath}. Tentando outras opções...`);
        }
    }

    // Tenta com "-cookies.json"
    const tryCookiesJsonPath = path.join(cookiesDir, `${cookieFileName}-cookies.json`);
    try {
        const data = await fs.readFile(tryCookiesJsonPath, 'utf8');
        cookies = JSON.parse(data);
        console.log(`Cookies carregados de: ${tryCookiesJsonPath}`);
        return { cookies, filePath: tryCookiesJsonPath }; // Retorna o caminho também
    } catch (e) {
        console.warn(`Não foi possível carregar cookies de ${tryCookiesJsonPath}. Tentando com ".json"...`);
    }

    // Tenta com ".json"
    const tryJsonPath = path.join(cookiesDir, `${cookieFileName}.json`);
    try {
        const data = await fs.readFile(tryJsonPath, 'utf8');
        cookies = JSON.parse(data);
        console.log(`Cookies carregados de: ${tryJsonPath}`);
        return { cookies, filePath: tryJsonPath }; // Retorna o caminho também
    } catch (e) {
        console.error(`Erro: Não foi possível carregar cookies de ${tryJsonPath} ou de qualquer outra combinação.`);
        throw new Error('Arquivo de cookies não encontrado ou inválido.');
    }
}

// Função para salvar cookies para um arquivo
async function saveCookiesToFile(page, cookiesFilePath) {
    try {
        const client = await page.target().createCDPSession();
        const allCookies = (await client.send('Network.getAllCookies')).cookies;
        await fs.writeFile(cookiesFilePath, JSON.stringify(allCookies, null, 2));
        console.log(`[INFO] Cookies atualizados e salvos em: ${cookiesFilePath}`);
    } catch (error) {
        console.error(`[ERRO] Erro ao salvar cookies em ${cookiesFilePath}:`, error);
    }
}

async function run() {
    let browser;
    try {
        const chromePath = await getChromeExecutablePath();

        if (!chromePath) {
            console.error("Erro: Caminho do executável do Chrome não encontrado. Por favor, verifique se o Chrome está instalado e tente novamente, ou especifique o caminho manualmente.");
            return;
        }

        // 1. Ler o cred.json
        const credPath = path.join(__dirname, 'cred.json');
        const credData = await fs.readFile(credPath, 'utf8');
        const creds = JSON.parse(credData);
        const cookieFileNameFromCred = creds.cookieFileName;

        if (!cookieFileNameFromCred) {
            console.error("Erro: 'cookieFileName' não encontrado em cred.json.");
            return;
        }

        // 2. Carregar os cookies e obter o caminho do arquivo
        const { cookies, filePath: loadedCookiesFilePath } = await loadCookiesFromFile(cookieFileNameFromCred);

        // FILTRAR OS COOKIES
        const filteredCookies = cookies.map(cookie => {
            const newCookie = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expires,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                // Mapeia 'Unspecified' para undefined, pois page.setCookie não aceita
                sameSite: cookie.sameSite === 'Unspecified' ? undefined : cookie.sameSite,
            };
            // Remove propriedades undefined para evitar erros
            Object.keys(newCookie ).forEach(key => newCookie[key] === undefined && delete newCookie[key]);
            return newCookie;
        });


        // 3. Iniciar o navegador e configurar os cookies
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        const page = await browser.newPage();

        // Define os cookies antes de navegar para o site
        await page.setCookie(...filteredCookies);

        // *** NOVA ADIÇÃO: Listener para salvar cookies a cada carregamento de página ***
        page.on('load', async () => {
            console.log('[EVENTO] Página carregada/recarregada. Verificando e salvando cookies atualizados...');
            await saveCookiesToFile(page, loadedCookiesFilePath);
        });
        // *****************************************************************************

        console.log('Navegando para o Mercado Livre com cookies...');
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' } );

        // Removido o saveCookiesToFile daqui, pois o listener 'load' já o fará.
        // O primeiro save será disparado pelo 'load' da navegação inicial.

        console.log('Mercado Livre aberto com cookies. O navegador permanecerá aberto por 1 minuto.');
        console.log('Tente navegar pelo site. Os cookies serão salvos automaticamente a cada nova página carregada.');
        await new Promise(resolve => setTimeout(resolve, 1 * 60 * 1000)); // Mantém o navegador aberto por 1 minuto

    } catch (error) {
        console.error('Ocorreu um erro:', error);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

run();

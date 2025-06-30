const puppeteer = require('puppeteer-core');
const fs = require('fs').promises; // Apenas para getChromeExecutablePath

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
        const browserTemp = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const executablePath = browserTemp.executablePath();
        await browserTemp.close();
        if (executablePath && executablePath.includes('chrome')) {
            return executablePath;
        }
    } catch (e) {
        // console.warn("Não foi possível encontrar o caminho do executável do Chrome automaticamente via puppeteer.launch temporário.");
    }
    return null;
}

async function runTest() {
    let browser;
    try {
        const chromePath = await getChromeExecutablePath();
        if (!chromePath) {
            console.error("Erro: Caminho do executável do Chrome não encontrado.");
            return;
        }

        console.log(`Tentando lançar Chrome em: ${chromePath}`);
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        console.log('Navegador lançado com sucesso.');
        console.log('Tipo de browser.createIncognitoBrowserContext:', typeof browser.createIncognitoBrowserContext);
        console.log('É uma instância de puppeteer.Browser?', browser instanceof puppeteer.Browser);

        if (typeof browser.createIncognitoBrowserContext === 'function') {
            console.log('createIncognitoBrowserContext está disponível. Tentando criar um contexto anônimo...');
            const context = await browser.createIncognitoBrowserContext();
            const page = await context.newPage();
            await page.goto('https://www.google.com', { waitUntil: 'networkidle2' } );
            console.log('Página no contexto anônimo aberta com sucesso!');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Mantém aberto por 5 segundos
            await context.close(); // Fecha o contexto anônimo
            console.log('Contexto anônimo fechado.');
        } else {
            console.error('Erro: createIncognitoBrowserContext NÃO está disponível. Isso indica uma incompatibilidade.');
        }

    } catch (error) {
        console.error('Ocorreu um erro durante o teste:', error);
    } finally {
        if (browser) {
            await browser.close();
            console.log('Navegador principal fechado.');
        }
    }
}

runTest();

const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

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
                return p;
            } catch (e) {
                // Caminho não encontrado, tenta o próximo
            }
        }
    }
    // Tenta usar o puppeteer-core para descobrir (menos confiável se não estiver em PATH)
    try {
        // Lança um browser temporário em modo headless para obter o path
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const executablePath = browser.executablePath();
        await browser.close();
        if (executablePath && executablePath.includes('chrome')) { // Pequena validação para garantir que é o Chrome
            return executablePath;
        }
    } catch (e) {
        // console.warn("Não foi possível encontrar o caminho do executável do Chrome automaticamente via puppeteer. Por favor, especifique-o manualmente em 'executablePath'.");
    }
    return null; // Retorna null se não encontrar
}

async function run() {
    let browser;
    let rl; // Declara rl fora do try para que possa ser fechado no finally
    try {
        const chromePath = await getChromeExecutablePath();

        if (!chromePath) {
            console.error("Erro: Caminho do executável do Chrome não encontrado. Por favor, verifique se o Chrome está instalado e tente novamente, ou especifique o caminho manualmente.");
            return;
        }

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

        const pages = await browser.pages();
        let page;

        if (pages.length > 0 && pages[0].url() === 'about:blank') {
            page = pages[0];
        } else {
            page = await browser.newPage();
        }

        console.log('Navegando para o Mercado Livre...');
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' } );

        console.log('Mercado Livre aberto. Pressione ENTER no terminal para salvar os cookies...');

        // Cria a interface readline UMA VEZ
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        // Espera o usuário pressionar ENTER
        await new Promise(resolve => {
            rl.question('', () => {
                resolve();
            });
        });

        console.log('ENTER pressionado. Qual o nome para o arquivo de cookies? (Ex: MinhaSessaoML)');

        const cookieName = await new Promise(resolve => {
            rl.question('Nome: ', (name) => {
                resolve(name);
            });
        });

        // Fecha a interface readline APENAS DEPOIS de obter todas as entradas
        rl.close();

        // Formata o nome: substitui espaços por traços e adiciona "-cookies.json"
        const formattedCookieName = cookieName.replace(/\s+/g, '-') + '-cookies.json';
        const cookiesDir = path.join(__dirname, 'cookies');
        const cookiesFilePath = path.join(cookiesDir, formattedCookieName);

        // Cria o diretório 'cookies' se não existir
        await fs.mkdir(cookiesDir, { recursive: true });

        // Obtém os cookies da página
        const client = await page.target().createCDPSession();
        const allCookies = (await client.send('Network.getAllCookies')).cookies;

        // Salva os cookies no arquivo
        await fs.writeFile(cookiesFilePath, JSON.stringify(allCookies, null, 2));

        console.log(`Cookies salvos em: ${cookiesFilePath}`);

    } catch (error) {
        console.error('Ocorreu um erro:', error);
    } finally {
        if (browser) {
            await browser.close();
        }
        if (rl) { // Garante que rl seja fechado mesmo em caso de erro
            rl.close();
        }
    }
}

run();

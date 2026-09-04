import { DEFAULT_CONFIG, ensureDirectoriesExist } from './config';
import { PjeScraper } from './scraper/pjeScraper';
import { startMockServer } from './mock/server';
import { ScraperConfig } from './types';

/**
 * Punto de entrada CLI del Scraper.
 * Soporta ejecución estándar, modo simulación (--mock) y reintento de fallidos (--retry-failed).
 */
async function main() {
  const args = process.argv.slice(2);
  const isMock = args.includes('--mock');
  const isRetryFailed = args.includes('--retry-failed');

  let customUrl: string | undefined;
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    customUrl = args[urlIdx + 1];
  }

  let customMaxPages: number | undefined;
  const pagesIdx = args.indexOf('--max-pages');
  if (pagesIdx !== -1 && args[pagesIdx + 1]) {
    customMaxPages = parseInt(args[pagesIdx + 1], 10);
  }

  const config: ScraperConfig = {
    ...DEFAULT_CONFIG,
    ...(customUrl ? { targetUrl: customUrl } : {}),
    ...(customMaxPages ? { maxPages: customMaxPages } : {})
  };

  ensureDirectoriesExist(config);

  let mockServer: any = null;

  try {
    if (isMock) {
      console.log('🧪 Iniciando en MODO SIMULACIÓN (Mock Server)...');
      const port = 3000;
      mockServer = await startMockServer(port);
      config.targetUrl = `http://localhost:${port}/pjeconsulta/ConsultaPublica/listView.seam`;
    }

    const scraper = new PjeScraper(config);

    if (isRetryFailed) {
      await scraper.retryFailedDownloads();
    } else {
      await scraper.run();
    }
  } catch (error: any) {
    console.error('💥 Ejecución finalizada con error:', error.message);
    process.exitCode = 1;
  } finally {
    if (mockServer) {
      mockServer.close();
      console.log('🛑 Servidor mock detenido.');
    }
  }
}

main();

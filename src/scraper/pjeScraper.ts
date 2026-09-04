import { HttpClient } from '../client/httpClient';
import { RateLimiter } from '../client/rateLimiter';
import { PageParser } from './pageParser';
import { PdfDownloader } from './pdfDownloader';
import { DataStore } from '../storage/dataStore';
import { DeadLetterQueue } from '../storage/deadLetterQueue';
import { ScraperConfig, ProcessoItem } from '../types';

// Controlador principal del scraper de PJe
export class PjeScraper {
  private config: ScraperConfig;
  private httpClient: HttpClient;
  private rateLimiter: RateLimiter;
  private dataStore: DataStore;
  private dlq: DeadLetterQueue;
  private pdfDownloader: PdfDownloader;

  constructor(config: ScraperConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(
      config.baseDelayMs,
      config.maxDelayMs,
      config.maxRetries
    );
    this.httpClient = new HttpClient(this.rateLimiter);
    this.dataStore = new DataStore(config.dataFilePath);
    this.dlq = new DeadLetterQueue(config.failedDownloadsPath);
    this.pdfDownloader = new PdfDownloader(
      this.httpClient,
      config.downloadDir,
      this.dlq
    );
  }

  // Corre el flujo principal: sesion inicial -> busqueda -> paginas -> descarga docs
  public async run(): Promise<void> {
    console.log('--- Iniciando PJe Scraper ---');
    console.log(`Target: ${this.config.targetUrl}`);
    console.log(`Salida: ${this.config.outputDir}`);
    console.log(`Reintentos max: ${this.config.maxRetries} (backoff + jitter)\n`);

    let currentUrl = this.config.targetUrl;
    let pageNum = 1;
    let viewState: string | null = null;

    try {
      // 1. Peticion inicial para cookies de sesion y viewState
      console.log(`[session] Conectando a ${currentUrl}...`);
      const initialResponse = await this.httpClient.get(currentUrl);
      let html = initialResponse.data;

      viewState = PageParser.extractViewState(html);
      console.log(`[session] ViewState: ${viewState ? viewState.slice(0, 25) + '...' : 'no detectado'}`);

      // Revisamos si ya traia tabla de procesos o si hay que disparar busqueda
      let processos = PageParser.parseProcessList(html, currentUrl);

      if (processos.length === 0 && viewState) {
        console.log(`[search] Mandando busqueda por nombre ("${this.config.searchQuery || 'Jose Silva'}")...`);

        // Formulario fPP (TRF5)
        const searchPayload = new URLSearchParams({
          'AJAXREQUEST': '_viewRoot',
          'fPP': 'fPP',
          'fPP:dnp:nomeParte': this.config.searchQuery || 'Jose Silva',
          'fPP:j_id244': 'fPP:j_id244',
          'fPP:searchProcessos': 'Pesquisar',
          'fdtProcesso': 'fdtProcesso',
          'fdtProcesso:btnPesquisar': 'Pesquisar',
          'javax.faces.ViewState': viewState
        });

        try {
          const searchResponse = await this.httpClient.post(currentUrl, searchPayload.toString());
          html = searchResponse.data;
          const updatedViewState = PageParser.extractViewState(html);
          if (updatedViewState) viewState = updatedViewState;
          processos = PageParser.parseProcessList(html, currentUrl);
          console.log(`[search] Procesos encontrados: ${processos.length}`);
        } catch (err: any) {
          console.warn(`[search warn] Fallo el post de busqueda: ${err.message}. Probando con html inicial.`);
        }
      }

      // 2. Loop de paginacion
      while (pageNum <= this.config.maxPages) {
        console.log(`\n=== Pagina ${pageNum} ===`);
        processos = PageParser.parseProcessList(html, currentUrl);
        console.log(`[page ${pageNum}] ${processos.length} procesos detectados`);

        if (processos.length === 0) {
          console.log('[page] No se encontraron mas registros. Terminando.');
          break;
        }

        // Guardamos metadatos en data.json
        this.dataStore.addOrUpdateMany(processos);

        // 3. Descarga de documentos por proceso
        for (const proc of processos) {
          console.log(`\n[proceso] ${proc.numeroProcesso} (${proc.documentos.length} docs)`);

          // Si vino sin documentos en la tabla pero tiene link de detalle/popup
          if (proc.documentos.length === 0 && proc.detalheUrl) {
            try {
              console.log(`[detalle] Abriendo popup: ${proc.detalheUrl}`);
              const detailResp = await this.httpClient.get(proc.detalheUrl);
              proc.documentos = PageParser.parseDocumentDetails(detailResp.data, proc.detalheUrl, proc.numeroProcesso);
              this.dataStore.addOrUpdateMany([proc]);
            } catch (err: any) {
              console.warn(`[detalle warn] No se pudo abrir ${proc.numeroProcesso}: ${err.message}`);
            }
          }

          // Descarga streaming de cada documento
          for (const doc of proc.documentos) {
            await this.pdfDownloader.downloadDocument(proc.numeroProcesso, doc);
            if (this.config.requestDelayMs > 0) {
              await this.rateLimiter.sleep(this.config.requestDelayMs);
            }
          }
        }

        this.dataStore.addOrUpdateMany(processos);

        // Revisamos si hay pagina siguiente en el datascroller
        const pagination = PageParser.parsePaginationInfo(html);
        const totalRecordsMsg = pagination.totalRecords ? ` | total reportado: ${pagination.totalRecords}` : '';
        console.log(`\n[paginacion] Pagina ${pagination.currentPage} de ${pagination.totalPages || '?'}${totalRecordsMsg} (siguiente: ${pagination.hasNextPage})`);

        if (!pagination.hasNextPage || pageNum >= this.config.maxPages) {
          console.log('[paginacion] Fin de paginas o limite alcanzado.');
          break;
        }

        // Avanzamos enviando el post con el viewstate actual
        pageNum++;
        console.log(`[paginacion] Avanzando a pagina ${pageNum}...`);

        if (viewState) {
          const nextPagePayload = new URLSearchParams({
            'fdtProcesso': 'fdtProcesso',
            'javax.faces.ViewState': viewState,
            'fdtProcesso:scroller': String(pageNum),
            'AJAXREQUEST': '_viewRoot'
          });

          const pageResp = await this.httpClient.post(currentUrl, nextPagePayload.toString());
          html = pageResp.data;

          const newViewState = PageParser.extractViewState(html);
          if (newViewState) viewState = newViewState;
        } else {
          // fallback get con param page si aplica
          const urlWithPage = new URL(currentUrl);
          urlWithPage.searchParams.set('page', String(pageNum));
          const pageResp = await this.httpClient.get(urlWithPage.toString());
          html = pageResp.data;
        }

        await this.rateLimiter.sleep(this.config.requestDelayMs);
      }

      console.log('\n----------------------------------------------------');
      console.log('Scraping completado.');
      console.log(`Procesos en data.json: ${this.dataStore.getAll().length}`);
      console.log(`Pendientes en DLQ: ${this.dlq.size()}`);
      console.log(`Datos: ${this.config.dataFilePath}`);
      console.log(`Descargas: ${this.config.downloadDir}`);
      console.log('----------------------------------------------------');
    } catch (error: any) {
      console.error('\nError en ejecucion:', error.message);
      if (error.response) {
        console.error(`HTTP Status: ${error.response.status}`);
      }
      throw error;
    }
  }

  // Reintenta solo los que fallaron y quedaron en failed_downloads.json
  public async retryFailedDownloads(): Promise<void> {
    console.log('--- Reintentando descargas fallidas (DLQ) ---');
    console.log(`Pendientes: ${this.dlq.size()}\n`);

    const failedItems = this.dlq.getAll();
    if (failedItems.length === 0) {
      console.log('No hay items pendientes en DLQ.');
      return;
    }

    let recovered = 0;
    for (const item of failedItems) {
      console.log(`[reintento] ${item.numeroProcesso} - ${item.titulo}`);
      const result = await this.pdfDownloader.downloadDocument(item.numeroProcesso, {
        idDocumento: item.idDocumento,
        titulo: item.titulo,
        url: item.url,
        status: 'pending'
      });

      if (result.success) {
        recovered++;
      }

      await this.rateLimiter.sleep(this.config.requestDelayMs);
    }

    console.log(`\nReintentos listos. Recuperados: ${recovered}/${failedItems.length}`);
    console.log(`Restantes en DLQ: ${this.dlq.size()}`);
  }
}

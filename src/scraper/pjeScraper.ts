import { HttpClient } from '../client/httpClient';
import { RateLimiter } from '../client/rateLimiter';
import { PageParser } from './pageParser';
import { PdfDownloader } from './pdfDownloader';
import { DataStore } from '../storage/dataStore';
import { DeadLetterQueue } from '../storage/deadLetterQueue';
import { ScraperConfig, ProcessoItem } from '../types';

/**
 * Orquestador principal del scraper de PJe.
 * Gestiona el ciclo de vida JSF, la paginación, la extracción y las descargas.
 */
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

  /**
   * Ejecuta el flujo completo de scraping.
   */
  public async run(): Promise<void> {
    console.log('====================================================');
    console.log('🚀 Iniciando PJe Scraper (Senior-Grade)');
    console.log(`🌐 Target: ${this.config.targetUrl}`);
    console.log(`📁 Directorio de salida: ${this.config.outputDir}`);
    console.log(`⏱️  Retries: ${this.config.maxRetries} (Exponential Backoff + Jitter)`);
    console.log('====================================================\n');

    let currentUrl = this.config.targetUrl;
    let pageNum = 1;
    let viewState: string | null = null;

    try {
      // Paso 1: Petición inicial GET para establecer sesión (JSESSIONID) y obtener ViewState
      console.log(`📡 [Paso 1] Estableciendo sesión con GET ${currentUrl}...`);
      const initialResponse = await this.httpClient.get(currentUrl);
      let html = initialResponse.data;

      viewState = PageParser.extractViewState(html);
      console.log(`🔑 ViewState inicial obtenido: ${viewState ? viewState.slice(0, 30) + '...' : 'No detectado (stateless o mock)'}`);

      // Si la página inicial requiere disparar el formulario de búsqueda inicial:
      let processos = PageParser.parseProcessList(html, currentUrl);

      if (processos.length === 0 && viewState) {
        console.log(`🔍 Tabla inicial vacía. Enviando submit de búsqueda en PJe (filtro: "${this.config.searchQuery || 'Jose Silva'}")...`);

        // Formulario fPP (estándar de PJe TRF5) y fallback para mock
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
          console.log(`✅ Procesos encontrados tras búsqueda: ${processos.length}`);
        } catch (err: any) {
          console.warn(`⚠️  Búsqueda con formulario falló: ${err.message}. Continuando con HTML actual.`);
        }
      }

      // Paso 2: Ciclo de navegación por páginas
      while (pageNum <= this.config.maxPages) {
        console.log(`\n📄 === Procesando Página ${pageNum} ===`);
        processos = PageParser.parseProcessList(html, currentUrl);
        console.log(`📋 Procesos detectados en página ${pageNum}: ${processos.length}`);

        if (processos.length === 0) {
          console.log('ℹ️  No se encontraron más registros. Finalizando recorrido de páginas.');
          break;
        }

        // Guardar metadatos en el almacén de datos
        this.dataStore.addOrUpdateMany(processos);

        // Paso 3: Descarga de documentos asociados a cada proceso de la página
        for (const proc of processos) {
          console.log(`\n📂 Proceso: ${proc.numeroProcesso} | Documentos: ${proc.documentos.length}`);

          // Si el proceso tiene una URL de detalle pero no trajo documentos en la tabla principal
          if (proc.documentos.length === 0 && proc.detalheUrl) {
            try {
              console.log(`🔎 Consultando detalle de expediente: ${proc.detalheUrl}`);
              const detailResp = await this.httpClient.get(proc.detalheUrl);
              proc.documentos = PageParser.parseDocumentDetails(detailResp.data, proc.detalheUrl, proc.numeroProcesso);
              this.dataStore.addOrUpdateMany([proc]);
            } catch (err: any) {
              console.warn(`⚠️  No se pudo abrir detalle de ${proc.numeroProcesso}: ${err.message}`);
            }
          }

          // Descargar cada PDF en streaming
          for (const doc of proc.documentos) {
            await this.pdfDownloader.downloadDocument(proc.numeroProcesso, doc);
            // Pequeño delay de cortesía entre descargas de documentos
            if (this.config.requestDelayMs > 0) {
              await this.rateLimiter.sleep(this.config.requestDelayMs);
            }
          }
        }

        // Actualizar almacén con el estado final de documentos
        this.dataStore.addOrUpdateMany(processos);

        // Analizar si hay siguiente página
        const pagination = PageParser.parsePaginationInfo(html);
        console.log(`\n📊 Info Paginación: Página ${pagination.currentPage} de ${pagination.totalPages || 'desconocido'} (Siguiente: ${pagination.hasNextPage})`);

        if (!pagination.hasNextPage || pageNum >= this.config.maxPages) {
          console.log(`🏁 Límite alcanzado o no hay más páginas.`);
          break;
        }

        // Avanzar a la siguiente página mediante POST con ViewState
        pageNum++;
        console.log(`➡️  Avanzando a página ${pageNum}...`);

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
          // Si el endpoint admite GET para paginar
          const urlWithPage = new URL(currentUrl);
          urlWithPage.searchParams.set('page', String(pageNum));
          const pageResp = await this.httpClient.get(urlWithPage.toString());
          html = pageResp.data;
        }

        await this.rateLimiter.sleep(this.config.requestDelayMs);
      }

      console.log('\n====================================================');
      console.log('🎉 Scraping completado con éxito.');
      console.log(`📄 Total procesos registrados: ${this.dataStore.getAll().length}`);
      console.log(`⚠️  Documentos en Dead Letter Queue (pendientes): ${this.dlq.size()}`);
      console.log(`💾 Datos guardados en: ${this.config.dataFilePath}`);
      console.log(`📂 PDFs guardados en: ${this.config.downloadDir}`);
      console.log('====================================================');
    } catch (error: any) {
      console.error('\n💥 Error crítico durante el scraping:', error.message);
      if (error.response) {
        console.error(`Status HTTP: ${error.response.status}`);
      }
      throw error;
    }
  }

  /**
   * Reintenta exclusivamente los documentos que quedaron en la Dead Letter Queue.
   */
  public async retryFailedDownloads(): Promise<void> {
    console.log('====================================================');
    console.log('🔄 Procesando Dead Letter Queue (Reintentos)');
    console.log(`⚠️  Documentos pendientes: ${this.dlq.size()}`);
    console.log('====================================================\n');

    const failedItems = this.dlq.getAll();
    if (failedItems.length === 0) {
      console.log('✅ No hay descargas pendientes en la Dead Letter Queue.');
      return;
    }

    let recovered = 0;
    for (const item of failedItems) {
      console.log(`🔄 Reintentando: ${item.numeroProcesso} - ${item.titulo}`);
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

    console.log(`\n🏁 Reintentos concluidos. Recuperados: ${recovered}/${failedItems.length}`);
    console.log(`⚠️  Restantes en DLQ: ${this.dlq.size()}`);
  }
}

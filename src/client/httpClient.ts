import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { RateLimiter } from './rateLimiter';
import { Readable } from 'stream';

/**
 * Cliente HTTP con estado de sesión (CookieJar persistente) y headers
 * realistas para interactuar con aplicaciones JavaServer Faces / JBoss Seam.
 */
export class HttpClient {
  private client: AxiosInstance;
  public cookieJar: CookieJar;
  public rateLimiter: RateLimiter;

  constructor(rateLimiter?: RateLimiter) {
    this.cookieJar = new CookieJar();
    this.rateLimiter = rateLimiter || new RateLimiter();

    // Axios configurado con soporte nativo para Cookie Jar
    this.client = wrapper(
      axios.create({
        jar: this.cookieJar,
        withCredentials: true,
        timeout: 30000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        }
      })
    );
  }

  /**
   * Petición GET con rate limiting y manejo de reintentos
   */
  public async get<T = string>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.rateLimiter.executeWithRetry(`GET ${url}`, async () => {
      return await this.client.get<T>(url, config);
    });
  }

  /**
   * Petición POST (necesaria para formularios y paginación en JSF)
   */
  public async post<T = string>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.rateLimiter.executeWithRetry(`POST ${url}`, async () => {
      return await this.client.post<T>(url, data, {
        ...config,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(config?.headers || {})
        }
      });
    });
  }

  /**
   * Petición de descarga en modo Stream para evitar saturar la memoria RAM con PDFs grandes
   */
  public async getStream(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<Readable>> {
    return this.rateLimiter.executeWithRetry(`Stream GET ${url}`, async () => {
      return await this.client.get<Readable>(url, {
        ...config,
        responseType: 'stream'
      });
    });
  }
}

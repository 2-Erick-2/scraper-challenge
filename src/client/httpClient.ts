import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { RateLimiter } from './rateLimiter';
import { Readable } from 'stream';

// Cliente HTTP con cookie jar para mantener la sesion de JSF viva entre requests
export class HttpClient {
  private client: AxiosInstance;
  public cookieJar: CookieJar;
  public rateLimiter: RateLimiter;

  constructor(rateLimiter?: RateLimiter) {
    this.cookieJar = new CookieJar();
    this.rateLimiter = rateLimiter || new RateLimiter();

    // Axios con cookie jar automatico y headers de navegador comun
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

  // GET con reintento automatico si tira 429
  public async get<T = string>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.rateLimiter.executeWithRetry(`GET ${url}`, async () => {
      return await this.client.get<T>(url, config);
    });
  }

  // POST urlencoded (para submits y paginacion de JSF)
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

  // Descarga en stream para no cargar archivos pesados en memoria
  public async getStream(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<Readable>> {
    return this.rateLimiter.executeWithRetry(`Stream GET ${url}`, async () => {
      return await this.client.get<Readable>(url, {
        ...config,
        responseType: 'stream'
      });
    });
  }
}

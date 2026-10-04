import type { CloudFrontRequest } from 'aws-lambda';
import type { HTTPAdapter } from '@x402/core/server';

/**
 * CloudFront HTTPAdapter implementation for x402HTTPResourceServer.
 *
 * Adapted from the x402-foundation cloudfront-lambda-edge example.
 */
export class CloudFrontHTTPAdapter implements HTTPAdapter {
  constructor(
    private request: CloudFrontRequest,
    private distributionDomain: string,
    /**
     * Public host to advertise in the x402 challenge `resource.url`. When set
     * (e.g. a custom domain like "pay.example.com"), it overrides the
     * CloudFront distribution domain — which is what `distributionDomainName`
     * always reports, regardless of the alias the viewer actually used.
     */
    private publicHost?: string
  ) {}

  getHeader(name: string): string | undefined {
    const headerName = name.toLowerCase();
    return this.request.headers[headerName]?.[0]?.value;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return this.request.uri;
  }

  getUrl(): string {
    const host = this.publicHost || this.distributionDomain;
    return `https://${host}${this.request.uri}${this.request.querystring ? '?' + this.request.querystring : ''}`;
  }

  /**
   * Always return 'application/json' so x402HTTPResourceServer returns a JSON
   * 402 response instead of an HTML paywall. Lambda@Edge responses are limited
   * to 1MB, making HTML paywalls impractical, and this is a machine-to-machine
   * resource anyway.
   */
  getAcceptHeader(): string {
    return 'application/json';
  }

  getUserAgent(): string {
    return this.getHeader('user-agent') || '';
  }

  getQueryParams(): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};
    if (this.request.querystring) {
      const searchParams = new URLSearchParams(this.request.querystring);
      searchParams.forEach((value, key) => {
        params[key] = value;
      });
    }
    return params;
  }
}

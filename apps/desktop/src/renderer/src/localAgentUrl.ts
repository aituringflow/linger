/** Keep the local service's auth query while selecting an endpoint path. */
export function localAgentUrl(hostUrl: string, pathname: string): string {
  const url = new URL(hostUrl);
  url.pathname = pathname;
  return url.toString();
}

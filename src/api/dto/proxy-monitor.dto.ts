export class ProxyStatusDto {
  instanceId: string;
  instanceName: string;
  currentIp: string | null;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  connectedSince: Date | null;
  totalIpChanges: number;
  lastIpChange: Date | null;
  lastCheck: Date | null;
  connectionStatus: 'connected' | 'disconnected' | 'error' | 'disabled';
  errorMessage?: string;
}

export class ProxyDashboardItemDto extends ProxyStatusDto {
  proxyEnabled: boolean;
}

export class ProxyHistoryDto {
  id: string;
  ip: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

// Struttura del provider nella risposta Oxylabs
export interface OxylabsProvider {
  country: string;
  city: string;
  asn?: string;
  org_name?: string;
  zip_code?: string;
  time_zone?: string;
  time_zone_identifier?: string;
  meta?: string;
}

// Risposta effettiva di https://ip.oxylabs.io/location
export interface OxylabsLocationResponse {
  ip: string;
  providers: {
    dbip?: OxylabsProvider;
    ip2location?: OxylabsProvider;
    ipinfo?: OxylabsProvider;
    maxmind?: OxylabsProvider;
  };
}

// Dati location estratti dai providers
export interface ExtractedLocation {
  ip: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
}
